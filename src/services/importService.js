'use strict';

// FT-706 — the archive back in, or not at all. OPS-102, OPS-103, OPS-104.
//
// ## The shape of this file is the rule
//
// **`OPS-102`: validate the manifest, the schema version, referential integrity and
// the checksum *before writing anything*.** So `validate()` is a complete pass that
// touches no row, and `run()` calls it again and refuses on anything it returns. An
// import that validated as it wrote would be an import that fails halfway, and a
// half-imported store is worse than an un-imported one because nobody can tell which
// it is by looking.
//
// **`OPS-103`: a full verified backup first, and one transaction.** If the backup
// cannot be taken the import does not run — not "runs with a warning". The whole point
// of the backup is that the operator has somewhere to go back to, and an import that
// proceeds without one has removed the only reason it was safe to try.
//
// **`OPS-104`: never silently overwrite.** Collisions are counted and reported, and
// the operator chooses SKIP, REPLACE or ABORT **for the whole run**. Not per row: a
// per-row prompt at three in the morning is how half a catalogue ends up replaced and
// half skipped, and nobody can afterwards say which half.
//
// ## What an import cannot restore
//
// Credentials. `SEC-1` keeps them out of the archive, so every imported user arrives
// without a password and somebody must set one before anybody can sign in. The summary
// says so in as many words, because discovering it at the counter the next morning is
// the wrong moment.

const db = require('../config/database');
const clock = require('../config/clock');
const zip = require('../config/zip');
const migrate = require('../config/migrate');
const errors = require('./errors');
const permissions = require('./permissions');
const auditService = require('./auditService');
const exportService = require('./exportService');
const dataRepository = require('../repositories/dataRepository');

/** `OPS-104`'s three answers, chosen once for the run. */
const COLLISION_MODES = Object.freeze(['SKIP', 'REPLACE', 'ABORT']);

const MANIFEST = exportService.MANIFEST;

// ── OPS-102 — the validation pass ───────────────────────────────────────────

/**
 * Read the archive and check everything that can be checked without writing.
 *
 * Returns a **report**, never throws for a bad archive: `OPS-102` asks for a summary
 * the operator confirms, and a summary that arrives as an exception is one the screen
 * has to reconstruct from an error message. A genuinely unreadable file — not a zip at
 * all — is the one case that throws, because there is nothing to report about it.
 *
 * The checks are ordered cheapest-first and each one's failure is kept rather than
 * short-circuited, so an operator with three problems learns about three problems
 * instead of fixing one and discovering the next.
 */
function validate(archiveBuffer, { collisionMode = 'SKIP' } = {}) {
  const problems = [];
  const warnings = [];

  let entries;
  try {
    entries = zip.unzipMany(archiveBuffer);
  } catch (err) {
    // Not a zip, truncated, or an entry that failed its CRC. Nothing further can be
    // said about it, so this is the one throwing path.
    throw errors.badRequest(
      `That file is not a readable export archive (${err.message}).`,
      { ruleId: 'OPS-102' }
    );
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry.content]));

  // ── The manifest ──
  const manifestRaw = byName.get(MANIFEST);
  if (!manifestRaw) {
    return report({
      problems: [{
        rule_id: 'OPS-101',
        message: `The archive has no ${MANIFEST}, so there is nothing to say what it holds.`,
      }],
      warnings, entities: [], manifest: null, collisionMode,
    });
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestRaw.toString('utf8'));
  } catch (err) {
    return report({
      problems: [{ rule_id: 'OPS-101', message: `${MANIFEST} is not valid JSON (${err.message}).` }],
      warnings, entities: [], manifest: null, collisionMode,
    });
  }

  if (manifest.format !== 'chachi-agrivet-pos-export') {
    problems.push({
      rule_id: 'OPS-101',
      message: 'That archive was not written by this application.',
    });
  }
  if (manifest.format_version > exportService.FORMAT_VERSION) {
    problems.push({
      rule_id: 'OPS-101',
      message: `The archive is format version ${manifest.format_version} and this build reads `
        + `up to ${exportService.FORMAT_VERSION}.`,
    });
  }

  // ── The schema version (requirement 6) ──
  //
  // Refused in the words upgradeService already uses, because it is the same fact
  // about the same kind of file: something newer than this build wrote it.
  const binary = migrate.binaryVersion();
  if (Number.isInteger(manifest.schema_version) && manifest.schema_version > binary) {
    problems.push({
      rule_id: 'OPS-102',
      message: `This archive is at schema version ${manifest.schema_version}, but this version `
        + `of Chachi Agrivet POS only knows up to ${binary}. It was written by a newer `
        + 'installation. Install the current version before importing it — running an older '
        + 'build against newer data loses data.',
    });
  }
  if (Number.isInteger(manifest.schema_version) && manifest.schema_version < binary) {
    warnings.push({
      rule_id: 'OPS-102',
      message: `The archive is from schema version ${manifest.schema_version} and this build is `
        + `at ${binary}. Tables added since will be empty after the import.`,
    });
  }

  // ── The checksum ──
  const files = (manifest.entities || [])
    .map((table) => ({ name: `${table}.json`, content: byName.get(`${table}.json`) }))
    .filter((file) => file.content);

  const missing = (manifest.entities || []).filter((table) => !byName.has(`${table}.json`));
  for (const table of missing) {
    problems.push({
      rule_id: 'OPS-101',
      message: `The manifest lists ${table} but the archive has no ${table}.json.`,
    });
  }

  if (missing.length === 0) {
    const actual = exportService.checksumOf(files);
    if (actual !== manifest.checksum) {
      problems.push({
        rule_id: 'OPS-102',
        message: 'The archive’s checksum does not match its contents. It has been altered or '
          + 'damaged since it was exported, and importing it would write data nobody vouched for.',
      });
    }
  }

  // ── The rows ──
  const parsed = new Map();
  for (const table of manifest.entities || []) {
    const raw = byName.get(`${table}.json`);
    if (!raw) continue;
    try {
      const rows = JSON.parse(raw.toString('utf8'));
      if (!Array.isArray(rows)) throw new Error('not a list of rows');
      parsed.set(table, rows);
    } catch (err) {
      problems.push({ rule_id: 'OPS-101', message: `${table}.json is unreadable (${err.message}).` });
    }
  }

  for (const [table, rows] of parsed) {
    const declared = manifest.row_counts ? manifest.row_counts[table] : undefined;
    if (declared !== undefined && declared !== rows.length) {
      problems.push({
        rule_id: 'OPS-101',
        message: `The manifest says ${table} has ${declared} rows and the file has ${rows.length}.`,
      });
    }
  }

  // ── Referential integrity, against the archive's own contents ──
  problems.push(...danglingReferences(parsed));

  // ── OPS-104 — the collisions ──
  const entities = [];
  let collisions = 0;
  for (const table of manifest.entities || []) {
    const rows = parsed.get(table) || [];
    const clashing = rows.filter((row) => dataRepository.existsByKey(table, row)).length;
    collisions += clashing;
    entities.push({ table, rows: rows.length, collisions: clashing, existing: dataRepository.countOf(table) });
  }

  const mode = String(collisionMode || 'SKIP').toUpperCase();
  if (!COLLISION_MODES.includes(mode)) {
    problems.push({
      rule_id: 'OPS-104',
      message: `The collision choice must be one of ${COLLISION_MODES.join(', ')}.`,
    });
  }
  if (collisions > 0 && mode === 'ABORT') {
    problems.push({
      rule_id: 'OPS-104',
      message: `${collisions} row(s) already exist here and the chosen action is to abort.`,
    });
  }

  // SEC-1's consequence, surfaced before the operator commits rather than the morning
  // after, when nobody can sign in.
  const users = (parsed.get('users') || []).length;
  if (users > 0) {
    warnings.push({
      rule_id: 'SEC-1',
      message: `${users} user account(s) will be imported without passwords — credentials are `
        + 'never exported. Set a password for each before anybody can sign in.',
    });
  }

  return report({ problems, warnings, entities, manifest, collisionMode: mode, collisions, parsed });
}

/**
 * References the archive makes to rows it does not itself carry.
 *
 * Checked against the archive rather than against this database, because the import
 * writes the archive whole: a `sale_items.sale_id` pointing at a sale the archive left
 * out is a broken archive whatever is already here. `dataRepository.foreignKeyViolations`
 * is the second pass, inside the transaction, where SQLite checks the database that
 * actually results.
 *
 * The map is deliberately short. It names the references whose absence produces a row
 * nobody can explain — an orphan sale line, an allocation against no transaction — and
 * not every foreign key in the schema, which the engine checks anyway.
 */
const REFERENCES = Object.freeze([
  ['sale_items', 'sale_id', 'sales'],
  ['sale_tenders', 'sale_id', 'sales'],
  ['sale_discounts', 'sale_id', 'sales'],
  ['sale_return_items', 'return_id', 'sale_returns'],
  ['sale_returns', 'sale_id', 'sales'],
  ['stock_count_lines', 'session_id', 'stock_count_sessions'],
  ['purchase_order_items', 'po_id', 'purchase_orders'],
  ['goods_receipt_items', 'gr_id', 'goods_receipts'],
  ['credit_allocations', 'collection_txn_id', 'customer_credit_transactions'],
  ['credit_allocations', 'sale_txn_id', 'customer_credit_transactions'],
  ['customer_credit_transactions', 'account_id', 'customer_credit_accounts'],
  ['inventory_movements', 'product_id', 'products'],
  ['sale_items', 'product_id', 'products'],
  ['customer_prices', 'customer_id', 'customers'],
  ['customer_prices', 'product_id', 'products'],
  ['product_quantity_breaks', 'product_id', 'products'],
]);

function danglingReferences(parsed) {
  const problems = [];
  const idsOf = (table) => new Set((parsed.get(table) || []).map((row) => row.id));

  for (const [table, column, parent] of REFERENCES) {
    const rows = parsed.get(table);
    if (!rows || rows.length === 0) continue;

    const known = idsOf(parent);
    const dangling = rows.filter((row) => row[column] && !known.has(row[column]));
    if (dangling.length === 0) continue;

    problems.push({
      rule_id: 'OPS-102',
      message: `${dangling.length} row(s) in ${table} point at a ${parent} the archive does not `
        + `contain (first: ${dangling[0][column]}).`,
    });
  }
  return problems;
}

function report({ problems, warnings, entities, manifest, collisionMode, collisions = 0, parsed = null }) {
  return {
    ok: problems.length === 0,
    rule_id: 'OPS-102',
    problems,
    warnings,
    manifest: manifest
      ? {
        format_version: manifest.format_version,
        schema_version: manifest.schema_version,
        app_version: manifest.app_version,
        store_name: manifest.store_name,
        exported_at: manifest.exported_at,
        total_rows: manifest.total_rows,
        checksum: manifest.checksum,
      }
      : null,
    // The summary OPS-102 asks the operator to confirm: what would be written, what
    // already exists, and what the one choice does to the overlap.
    summary: {
      entities,
      total_rows: entities.reduce((sum, e) => sum + e.rows, 0),
      collisions,
      collision_mode: collisionMode,
      collision_effect: collisionEffect(collisionMode, collisions),
    },
    // Kept for `run()` so the archive is parsed once. Not part of the response.
    _parsed: parsed,
  };
}

const collisionEffect = (mode, collisions) => {
  if (collisions === 0) return 'Nothing here collides with the archive.';
  if (mode === 'REPLACE') return `${collisions} existing row(s) will be overwritten by the archive.`;
  if (mode === 'ABORT') return `${collisions} row(s) collide, so the import will not run.`;
  return `${collisions} colliding row(s) will be left exactly as they are, and the archive’s `
    + 'versions of them skipped.';
};

// ── OPS-103 — backup first, then one transaction ────────────────────────────

/**
 * Import the archive.
 *
 * The order is the rule: validate, back up, write. Each step refuses rather than
 * degrading — a failed validation does not import "the good parts", and a failed
 * backup does not import at all.
 */
function run(archiveBuffer, { collisionMode = 'SKIP', reason = null } = {}, actor) {
  if (!permissions.can(actor, 'TX-427')) {
    throw errors.forbidden(
      'You do not have permission to import data.',
      { ruleId: 'TX-427', requiresRole: permissions.rolesHolding('TX-427').join(' or ') }
    );
  }

  // ── 1. OPS-102, in full, before anything ──
  const checked = validate(archiveBuffer, { collisionMode });
  if (!checked.ok) {
    throw errors.badRequest(
      `This archive cannot be imported: ${checked.problems.map((p) => p.message).join(' ')}`,
      { ruleId: checked.problems[0].rule_id }
    );
  }

  // ── 2. OPS-103's backup, and no import without one ──
  //
  // Taken *before* the transaction opens, not inside it: a backup is a file copy of the
  // database, and taking one from inside a write transaction would archive a state that
  // is about to change. The operator's way back is a file that predates every write.
  const backup = require('./backupService').run({ trigger: 'PRE_IMPORT', actor });
  if (!backup.ok) {
    throw errors.conflict(
      `The pre-import backup could not be taken (${backup.error}). The import has not run — `
      + 'a backup is the only way back from an import that turns out to be wrong, and running '
      + 'without one removes the reason it was safe to try (OPS-103).',
      { ruleId: 'OPS-103' }
    );
  }

  const mode = String(collisionMode).toUpperCase();
  const at = clock.nowUtc();

  // ── 3. One transaction (OPS-103) ──
  const written = db.transaction(() => {
    const counts = {};
    let skipped = 0;
    let replaced = 0;

    // In `EXPORTABLE`'s order, which is dependency order — a foreign key's parent is
    // always already written by the time its child is.
    for (const table of dataRepository.EXPORTABLE) {
      const rows = checked._parsed.get(table) || [];
      counts[table] = { inserted: 0, skipped: 0, replaced: 0 };

      for (const row of rows) {
        const collides = dataRepository.existsByKey(table, row);

        if (collides && mode === 'SKIP') {
          counts[table].skipped += 1;
          skipped += 1;
          continue;
        }
        try {
          if (collides && mode === 'REPLACE') {
            dataRepository.replaceRow(table, withoutSecrets(table, row));
            counts[table].replaced += 1;
            replaced += 1;
          } else {
            dataRepository.insertRow(table, withoutSecrets(table, row));
            counts[table].inserted += 1;
          }
        } catch (err) {
          // `OPS-008` runs with foreign keys enforced, so the engine refuses a row
          // pointing at a parent that is not there — at the row, before the check
          // below ever runs. That refusal is correct and arrives as `SQLITE_CONSTRAINT`,
          // which is not a sentence anybody can act on. Turned into one here, naming
          // the table and the rule, with the transaction still open so nothing is kept.
          throw asImportRefusal(err, table, row);
        }
      }
    }

    // OPS-102's referential integrity, checked a second time by the engine against the
    // database that actually resulted. The archive can be self-consistent and still
    // point at rows this store never had — a SKIP that left a parent behind, most
    // obviously — and the transaction is still open, so this refusal costs nothing.
    const violations = dataRepository.foreignKeyViolations();
    if (violations.length > 0) {
      throw errors.conflict(
        `${violations.length} row(s) would be left pointing at data that is not here `
        + `(first: ${violations[0].table}). Nothing has been written. This usually means the `
        + 'archive was imported with "skip" onto a store that already held part of it.',
        { ruleId: 'OPS-102' }
      );
    }

    // AUD-605: the import appends its own row rather than replacing the trail, and the
    // rule says so in its own last sentence.
    auditService.write({
      actor,
      action: 'DATA_IMPORTED',
      entityType: 'import',
      entityId: checked.manifest.checksum,
      before: { pre_import_backup: backup.file_name },
      after: {
        schema_version: checked.manifest.schema_version,
        exported_at: checked.manifest.exported_at,
        store_name: checked.manifest.store_name,
        checksum: checked.manifest.checksum,
        collision_mode: mode,
        rows_inserted: Object.values(counts).reduce((sum, c) => sum + c.inserted, 0),
        rows_skipped: skipped,
        rows_replaced: replaced,
        entities: counts,
      },
      reason: reason || `Data import from ${checked.manifest.store_name || 'an archive'}`,
    });

    return { counts, skipped, replaced };
  }, { immediate: true });

  return {
    ok: true,
    rule_id: 'OPS-103',
    // Named first, because it is the thing an operator needs if this turns out wrong.
    pre_import_backup: {
      file_name: backup.file_name,
      file_path: backup.file_path,
      verified: backup.verified,
    },
    imported_at: at,
    manifest: checked.manifest,
    collision_mode: mode,
    rows_inserted: Object.values(written.counts).reduce((sum, c) => sum + c.inserted, 0),
    rows_skipped: written.skipped,
    rows_replaced: written.replaced,
    entities: written.counts,
    warnings: checked.warnings,
  };
}

/**
 * A driver error, as a refusal somebody can read.
 *
 * The three that actually reach here are a foreign key with no parent, a unique
 * collision the `OPS-104` check did not see, and a `CHECK` the archive's own data
 * violates. Each is a different sentence because each has a different remedy, and
 * "SQLITE_CONSTRAINT_FOREIGNKEY" has none.
 */
function asImportRefusal(err, table, row) {
  const code = err.code || '';
  const identity = row.id || row.key || row.product_id || '(unidentified row)';

  if (code.includes('FOREIGNKEY')) {
    return errors.conflict(
      `A row in ${table} (${identity}) points at data the archive does not contain, and the `
      + 'import has written nothing. This usually means the archive is partial, or that it was '
      + 'imported with "skip" onto a store that already held part of it.',
      { ruleId: 'OPS-102' }
    );
  }
  if (code.includes('UNIQUE') || code.includes('PRIMARYKEY')) {
    return errors.conflict(
      `A row in ${table} (${identity}) collides with one already here on something other than `
      + 'its identity — a code or a name that must be unique. Nothing has been written. Resolve '
      + 'the duplicate here first, or import into an empty store.',
      { ruleId: 'OPS-104' }
    );
  }
  if (code.includes('CONSTRAINT')) {
    return errors.conflict(
      `A row in ${table} (${identity}) is not valid for this schema (${err.message}). Nothing `
      + 'has been written.',
      { ruleId: 'OPS-102' }
    );
  }
  return err;
}

/**
 * Belt and braces on `SEC-1`.
 *
 * The export never writes these columns, so an archive this application produced has
 * none. An archive is a file somebody can edit, though, and a hand-added
 * `password_hash` would otherwise be written straight into the users table — which is
 * an authentication bypass wearing the clothes of a data import.
 */
function withoutSecrets(table, row) {
  if (table !== 'users') return row;
  const clean = { ...row };
  for (const column of exportService.SECRET_COLUMNS) delete clean[column];
  // The column is NOT NULL, so an imported user needs *something* there. A single
  // impossible value: bcrypt never produces it, so no password can ever match it, and
  // the account is unusable until somebody sets one.
  clean.password_hash = 'IMPORTED-NO-PASSWORD';
  return clean;
}

module.exports = {
  COLLISION_MODES, REFERENCES,
  validate, run, danglingReferences, withoutSecrets, asImportRefusal,
};
