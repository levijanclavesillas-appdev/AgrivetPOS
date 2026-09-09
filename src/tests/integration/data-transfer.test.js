'use strict';

// FT-705 / FT-706 — the JSON export and the validated import. OPS-101 to OPS-104.
//
// The four named cases are `TC-INT-94` to `TC-INT-97`, and three of them assert that
// **nothing happened**, which is the harder half of every rule in this task:
//
//   `TC-INT-94` — each invalid archive refuses *before a single row is written*. The
//   assertion is a row count taken before and after, not the refusal itself: an import
//   that wrote half the catalogue and then threw would also throw.
//
//   `TC-INT-95` — a failed import leaves the database exactly as it was, and names the
//   pre-import backup. The failure is injected *late*, after most tables have been
//   written, because a rollback that has only been proved on the first table is a
//   rollback by coincidence.
//
//   `TC-INT-96` — SKIP leaves the existing rows untouched and REPLACE overwrites them,
//   and both are checked by reading the rows back rather than by trusting the counts
//   the import reported.
//
// `TC-INT-97` is the odd one out and asserts a positive: two exports of one database
// are byte-identical. Without it, "deterministic" is a claim in a comment.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const server = require('../../server');
const db = require('../../config/database');
const zip = require('../../config/zip');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const customerService = require('../../services/customerService');
const inventoryService = require('../../services/inventoryService');
const shiftService = require('../../services/shiftService');
const saleService = require('../../services/saleService');
const exportService = require('../../services/exportService');
const importService = require('../../services/importService');
const settingsService = require('../../services/settingsService');
const auditService = require('../../services/auditService');
const dataRepository = require('../../repositories/dataRepository');
const temp = require('../helpers/tempdb');

let BASE = null;
const PASSWORD = 'correct-horse-battery';

let instance;
let ref;
const tokens = {};
const sessions = {};
let archive;          // an export of the traded store
let manifest;

const call = (p, { token = null, method = 'GET', body = null } = {}) => fetch(`${BASE}${p}`, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

/** Row counts across every exportable table, for the "nothing was written" assertions. */
const snapshot = () => Object.fromEntries(
  dataRepository.EXPORTABLE.map((table) => [table, dataRepository.countOf(table)])
);

/** Rebuild an archive from entries, so a test can corrupt one file and re-zip. */
function rebuild(entries) {
  return zip.zipMany(entries.map((e) => ({ name: e.name, content: e.content })));
}

const entriesOf = (buffer) => zip.unzipMany(buffer);
const jsonOf = (entries, name) => JSON.parse(
  entries.find((e) => e.name === name).content.toString('utf8')
);
const withEntry = (entries, name, value) => entries.map((e) => (e.name === name
  ? { name, content: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8') }
  : e));

/** A backup folder outside the data directory, so OPS-103's backup can be taken. */
function backupFolder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-xfer-backups-'));
  settingsService.set('backup_folder', dir, sessions.OWNER);
  return dir;
}

test.before(async () => {
  temp.openEmpty('data-transfer');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;
  temp.seedStore({ taxMode: 'NONE', withOwner: false });
  ref = temp.seedCatalog();

  for (const role of ['OWNER', 'MANAGER', 'CASHIER']) {
    const username = role.toLowerCase();
    temp.seedUser({ username, role, password: PASSWORD });
    const signedIn = authService.login({ username, password: PASSWORD });
    tokens[role] = signedIn.token;
    sessions[role] = authService.verifyToken(signedIn.token);
  }
  backupFolder();

  // A store that has actually traded: a product with stock, a customer with credit,
  // a shift, and a sale that ties them together. An export of an empty database
  // round-trips trivially and proves nothing about references.
  const product = productService.create({
    sku: 'XFER-001', name: 'Export Test Feed', categoryId: ref.category.id,
    baseUnitId: ref.kg.id, retailPriceCentavos: 6250,
  }, sessions.OWNER);
  inventoryService.postStandalone({
    productId: product.id, type: 'OPENING', qtyMilli: 100000, unitCostCentavos: 4000,
    actor: sessions.OWNER,
  });
  const customer = customerService.create({
    name: 'Export Test Farm', customerType: 'FARM', priceLevel: 'RETAIL',
    isCreditEligible: true, creditLimitCentavos: 5000000, termsDays: 30,
  }, sessions.OWNER);

  shiftService.open({ actor: sessions.CASHIER, openingFloatCentavos: 100000, confirmed: true });
  saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 2000 }],
    customerId: customer.id,
    tenders: [{ method: 'CASH', amountCentavos: 20000 }],
  }, sessions.CASHIER);

  const built = exportService.build();
  archive = built.archive;
  manifest = built.manifest;
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── OPS-101 — the archive ───────────────────────────────────────────────────

test('OPS-101: the archive is one JSON file per entity plus a manifest', () => {
  const entries = entriesOf(archive);

  assert.equal(entries[0].name, 'manifest.json', 'the manifest is first, where a reader looks');
  assert.deepEqual(
    entries.slice(1).map((e) => e.name),
    dataRepository.EXPORTABLE.map((t) => `${t}.json`)
  );

  // OPS-101's four manifest facts.
  assert.equal(manifest.schema_version, require('../../config/migrate').schemaVersion());
  assert.ok(manifest.exported_at);
  assert.ok(manifest.row_counts.products >= 1);
  assert.match(manifest.checksum, /^sha256:[0-9a-f]{64}$/);

  // Readable, which is the point of JSON over a SQLite file. Two-space indent, so a
  // person opening it in Notepad sees rows rather than one line.
  const products = entries.find((e) => e.name === 'products.json').content.toString('utf8');
  assert.match(products, /\n {4}"sku": "XFER-001"/);
  assert.equal(JSON.parse(products).length, manifest.row_counts.products);
});

test('SEC-1: no credential is anywhere in the archive', () => {
  const entries = entriesOf(archive);
  const users = jsonOf(entries, 'users.json');
  assert.ok(users.length >= 3);

  for (const column of exportService.SECRET_COLUMNS) {
    assert.equal(column in users[0], false, `${column} is not exported`);
  }

  // Not merely absent from users: absent from the whole archive, so a hash copied into
  // some other table by a future task does not leave the machine unnoticed.
  const whole = Buffer.concat(entries.map((e) => e.content)).toString('utf8');
  assert.equal(/\$2[aby]\$\d{2}\$/.test(whole), false, 'no bcrypt hash anywhere in the bytes');

  // And it is said in the archive, not only in a document that does not travel with it.
  assert.ok(manifest.notes.some((n) => /Credentials are not exported/.test(n)));
});

test('the archive opens in something that did not write it', () => {
  // The same obligation TASK-017 put on the backup format, for the same reason: an
  // interchange format only its own reader accepts is not an interchange format.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-xfer-')), 'export.zip');
  fs.writeFileSync(file, archive);

  const python = spawnSync('python3', ['-c',
    'import zipfile,sys,json\n'
    + 'z=zipfile.ZipFile(sys.argv[1])\n'
    + 'assert z.testzip() is None\n'
    + 'names=z.namelist()\n'
    + 'assert names[0]=="manifest.json", names[0]\n'
    + 'm=json.loads(z.read("manifest.json"))\n'
    + 'assert m["format"]=="chachi-agrivet-pos-export"\n'
    + 'rows=json.loads(z.read("products.json"))\n'
    + 'assert len(rows)==m["row_counts"]["products"]\n'
    + 'sys.exit(0)\n',
    file], { encoding: 'utf8' });

  if (python.error) {
    // Not every machine has python3; the case still asserts what it can.
    assert.ok(archive.length > 0);
  } else {
    assert.equal(python.status, 0, python.stdout + python.stderr);
  }

  const unzip = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
  if (!unzip.error) {
    assert.equal(unzip.status, 0, unzip.stdout + unzip.stderr);
    assert.match(unzip.stdout, /No errors detected/);
  }
});

// ── TC-INT-97 — determinism ─────────────────────────────────────────────────

test('TC-INT-97: the same database exported twice gives byte-identical archives', () => {
  const first = exportService.build({ at: '2026-01-01T00:00:00.000Z' });
  const second = exportService.build({ at: '2026-01-01T00:00:00.000Z' });
  assert.ok(first.archive.equals(second.archive), 'byte-identical');

  // And the checksum does not move with the clock, which is why `exported_at` is
  // outside it: two exports of the same data at different times still agree about
  // what the data is, so a diff between archives means the data changed.
  const later = exportService.build({ at: '2026-06-30T12:34:56.000Z' });
  assert.equal(later.manifest.checksum, first.manifest.checksum);
  assert.notEqual(later.manifest.exported_at, first.manifest.exported_at);
  assert.equal(later.archive.equals(first.archive), false, 'the bytes differ only by the stamp');

  // A row changes and the checksum moves, which is the other half of the same claim.
  productService.create({
    sku: 'XFER-002', name: 'Second Feed', categoryId: ref.category.id,
    baseUnitId: ref.kg.id, retailPriceCentavos: 5000,
  }, sessions.OWNER);
  assert.notEqual(exportService.build({ at: '2026-01-01T00:00:00.000Z' }).manifest.checksum,
    first.manifest.checksum);
});

// ── TC-INT-94 — OPS-102 ─────────────────────────────────────────────────────

test('TC-INT-94: every invalid archive refuses before a single row is written', () => {
  const entries = entriesOf(archive);
  const before = snapshot();

  const cases = [
    ['a corrupted entity file', () => {
      const products = jsonOf(entries, 'products.json');
      products[0].name = 'Edited by hand';
      return rebuild(withEntry(entries, 'products.json', products));
    }, /checksum does not match/],

    ['a future schema version', () => {
      const m = jsonOf(entries, 'manifest.json');
      m.schema_version = 999;
      return rebuild(withEntry(entries, 'manifest.json', m));
    }, /only knows up to/],

    ['a dangling reference', () => {
      const items = jsonOf(entries, 'sale_items.json');
      items[0].sale_id = 'a-sale-that-is-not-here';
      const patched = withEntry(entries, 'sale_items.json', items);
      // The checksum is recomputed, so this case tests referential integrity rather
      // than accidentally re-testing the checksum.
      const m = jsonOf(entries, 'manifest.json');
      m.checksum = exportService.checksumOf(
        m.entities.map((t) => patched.find((e) => e.name === `${t}.json`))
      );
      return rebuild(withEntry(patched, 'manifest.json', m));
    }, /point at a sales the archive does not contain/],

    ['a manifest whose counts disagree with the files', () => {
      const m = jsonOf(entries, 'manifest.json');
      m.row_counts.products = 999;
      return rebuild(withEntry(entries, 'manifest.json', m));
    }, /says products has 999 rows/],

    ['an archive from another application', () => {
      const m = jsonOf(entries, 'manifest.json');
      m.format = 'something-else';
      return rebuild(withEntry(entries, 'manifest.json', m));
    }, /not written by this application/],

    ['a missing entity file', () => rebuild(entries.filter((e) => e.name !== 'products.json')),
      /no products\.json/],
  ];

  for (const [what, build, expected] of cases) {
    const bad = build();

    // The validation pass says no, with a sentence naming the rule.
    const checked = importService.validate(bad);
    assert.equal(checked.ok, false, what);
    assert.ok(checked.problems.some((p) => expected.test(p.message)),
      `${what}: ${JSON.stringify(checked.problems)}`);

    // And the import refuses rather than starting.
    assert.throws(
      () => importService.run(bad, {}, sessions.OWNER),
      (err) => /cannot be imported/.test(err.message),
      what
    );
  }

  // **The assertion the case exists for.** Six refusals later, not one row anywhere
  // has moved — an import that wrote half the catalogue and then threw would also have
  // thrown, and only the counts tell the two apart.
  assert.deepEqual(snapshot(), before, 'nothing was written by any of the refusals');
});

test('OPS-102: a file that is not an archive at all is refused, with a sentence', () => {
  assert.throws(
    () => importService.validate(Buffer.from('this is not a zip')),
    (err) => err.ruleId === 'OPS-102' && /not a readable export archive/.test(err.message)
  );

  // A truncated archive fails on the end-of-central-directory record, which is the
  // check every other tool would also fail on.
  assert.throws(
    () => importService.validate(archive.subarray(0, archive.length - 40)),
    (err) => err.ruleId === 'OPS-102'
  );
});

// ── TC-INT-96 — OPS-104 ─────────────────────────────────────────────────────

test('TC-INT-96: collisions are reported, and one choice governs the whole run', () => {
  // Every row in the archive already exists here — it was exported from this database.
  const checked = importService.validate(archive, { collisionMode: 'SKIP' });
  assert.equal(checked.ok, true);
  assert.ok(checked.summary.collisions > 0, 'the summary reports them');
  assert.match(checked.summary.collision_effect, /left exactly as they are/);

  const products = checked.summary.entities.find((e) => e.table === 'products');
  assert.equal(products.collisions, products.rows, 'every product collides');

  // ABORT: reported as a problem, so the import will not run at all.
  const aborting = importService.validate(archive, { collisionMode: 'ABORT' });
  assert.equal(aborting.ok, false);
  assert.ok(aborting.problems.some((p) => p.rule_id === 'OPS-104'));
  assert.throws(() => importService.run(archive, { collisionMode: 'ABORT' }, sessions.OWNER));

  // SKIP: the existing rows are left as they are, read back rather than trusted.
  const nameBefore = db.get().prepare('SELECT name FROM products WHERE sku = ?').get('XFER-001').name;
  const skipped = importService.run(archive, { collisionMode: 'SKIP' }, sessions.OWNER);
  assert.equal(skipped.rows_inserted, 0);
  assert.ok(skipped.rows_skipped > 0);
  assert.equal(
    db.get().prepare('SELECT name FROM products WHERE sku = ?').get('XFER-001').name,
    nameBefore
  );

  // REPLACE: the archive's version wins. Proved by changing a row first, so "replaced"
  // is visible rather than being a no-op that looks like success.
  productService.update(
    db.get().prepare('SELECT id FROM products WHERE sku = ?').get('XFER-001').id,
    { name: 'Renamed since the export' },
    sessions.OWNER
  );
  assert.equal(
    db.get().prepare('SELECT name FROM products WHERE sku = ?').get('XFER-001').name,
    'Renamed since the export'
  );

  const replaced = importService.run(archive, { collisionMode: 'REPLACE' }, sessions.OWNER);
  assert.ok(replaced.rows_replaced > 0);
  assert.equal(
    db.get().prepare('SELECT name FROM products WHERE sku = ?').get('XFER-001').name,
    'Export Test Feed',
    'the archive’s version overwrote the local one'
  );

  // An unknown choice is refused rather than defaulted — defaulting a destructive
  // option is how a run ends up doing something nobody chose.
  assert.equal(importService.validate(archive, { collisionMode: 'MERGE' }).ok, false);
});

test('OPS-103: every import names the backup it took first, and the audit row keeps it', () => {
  const result = importService.run(archive, { collisionMode: 'SKIP' }, sessions.OWNER);

  assert.ok(result.pre_import_backup.file_name, 'the way back is named');
  assert.equal(result.pre_import_backup.verified, true, 'and it was verified (OPS-002)');
  assert.ok(fs.existsSync(result.pre_import_backup.file_path));

  // AUD-605: the import appends its own row rather than replacing the trail.
  const trail = auditService.browse({ action: 'DATA_IMPORTED' });
  assert.ok(trail.total >= 1);
  assert.equal(trail.rows[0].before.pre_import_backup, result.pre_import_backup.file_name);
  assert.equal(trail.rows[0].after.collision_mode, 'SKIP');
  assert.ok(trail.rows[0].after.checksum);
});

test('OPS-103: no backup, no import', () => {
  const before = snapshot();
  const folder = settingsService.get('backup_folder');
  settingsService.set('backup_folder', '', sessions.OWNER);

  try {
    assert.throws(
      () => importService.run(archive, { collisionMode: 'REPLACE' }, sessions.OWNER),
      (err) => err.ruleId === 'OPS-103' && /has not run/.test(err.message)
    );

    // Not "ran with a warning". The backup is the only way back, and an import without
    // one has removed the reason it was safe to try.
    //
    // Three tables are excluded from the comparison and each for the same reason: the
    // *attempt* is a fact worth keeping. `backupService` records a failed backup as a
    // row rather than silently, which is OPS-002's own reasoning, and the audit trail
    // and the event log follow it. Everything the import itself would have written is
    // asserted unchanged.
    const RECORDS_THE_ATTEMPT = ['backups', 'audit_logs', 'system_events'];
    const business = (counts) => Object.fromEntries(
      Object.entries(counts).filter(([table]) => !RECORDS_THE_ATTEMPT.includes(table))
    );
    assert.deepEqual(business(snapshot()), business(before));

    // And the failure is on the backup log, so "why did the import not run" is
    // answerable afterwards rather than only from the error somebody dismissed.
    const backups = require('../../services/backupService').list();
    assert.ok(backups.backups.some((b) => b.trigger === 'PRE_IMPORT' && !b.verified));
  } finally {
    settingsService.set('backup_folder', folder, sessions.OWNER);
  }
});

test('SEC-6: export is TX-426, import is TX-427, and a manager holds neither', async () => {
  const permissions = require('../../services/permissions');
  assert.deepEqual(permissions.rolesHolding('TX-427'), ['OWNER']);

  const exported = await call('/data/export', { token: tokens.OWNER, method: 'POST' });
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get('content-type'), 'application/zip');
  assert.match(exported.headers.get('content-disposition'), /agrivet_export_.*\.zip/);
  assert.match(exported.headers.get('x-export-checksum'), /^sha256:/);

  const byCashier = await call('/data/export', { token: tokens.CASHIER, method: 'POST' });
  assert.equal(byCashier.status, 403);

  const importedByManager = await call('/data/import', {
    token: tokens.MANAGER, method: 'POST',
    body: { archive: archive.toString('base64') },
  });
  assert.equal(importedByManager.status, 403);
  assert.equal((await importedByManager.json()).error.rule_id, 'TX-427');

  // The validation endpoint answers 200 with the problems rather than a 400: it
  // succeeded at checking, which is a different thing from the archive being good.
  const validated = await call('/data/import/validate', {
    token: tokens.OWNER, method: 'POST',
    body: { archive: archive.toString('base64'), collisionMode: 'ABORT' },
  });
  assert.equal(validated.status, 200);
  const body = await validated.json();
  assert.equal(body.ok, false);
  assert.ok(body.summary.collisions > 0);
  assert.equal('_parsed' in body, false, 'the parsed rows are not the caller’s');
});

// ── TC-INT-95 — the rollback ────────────────────────────────────────────────
//
// Last, deliberately: it opens a database of its own, because proving "the database is
// exactly as it was" needs one whose contents this file has not been changing.

test('TC-INT-95: a failed import rolls back wholly, and the pre-import backup restores', () => {
  temp.openEmpty('data-transfer-rollback');
  require('../../config/migrate').migrate();
  temp.seedStore({ taxMode: 'NONE', withOwner: false });
  temp.seedUser({ username: 'boss', role: 'OWNER', password: PASSWORD });
  const owner = authService.verifyToken(authService.login({ username: 'boss', password: PASSWORD }).token);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-rollback-backups-'));
  settingsService.set('backup_folder', dir, owner);

  // **No seeded catalogue here, deliberately.** Reference data collides on its
  // *natural* keys — `categories.name` and `units.code` are UNIQUE NOCASE — and a
  // store that already has a "Feeds" category refuses the archive's one on the name
  // before the import gets anywhere near a sale. That refusal is correct and is worth
  // having its own case; what this one needs is a failure that happens **late**, so
  // the fixture is a store the archive's reference data can land in cleanly.
  const survivor = customerService.create({
    name: 'A customer who must survive', customerType: 'FARM', priceLevel: 'RETAIL',
  }, owner);

  const before = snapshot();
  const beforeName = db.get().prepare('SELECT name FROM customers WHERE id = ?').get(survivor.id).name;

  // An archive that passes every pre-write check and fails **late**, inside the
  // transaction: a sale citing a customer nobody exported. `REFERENCES` names the
  // handful of pairs whose absence makes a row nobody can explain, and deliberately
  // not every foreign key in the schema — so validation lets this through and SQLite's
  // own `foreign_key_check` catches it after most tables are already written. A
  // rollback proved only on the first table is a rollback by coincidence.
  const entries = entriesOf(archive);
  const sales = jsonOf(entries, 'sales.json');
  assert.ok(sales.length >= 1 && sales[0].customer_id, 'the fixture sale has a customer');
  sales[0].customer_id = 'no-such-customer-at-all';
  const patched = withEntry(entries, 'sales.json', sales);
  const m = jsonOf(entries, 'manifest.json');
  m.checksum = exportService.checksumOf(
    m.entities.map((t) => patched.find((e) => e.name === `${t}.json`))
  );
  const broken = rebuild(withEntry(patched, 'manifest.json', m));

  assert.equal(importService.validate(broken).ok, true, 'it passes every pre-write check');

  let failure = null;
  try {
    importService.run(broken, { collisionMode: 'SKIP' }, owner);
  } catch (err) {
    failure = err;
  }
  assert.ok(failure, 'the import failed');
  assert.equal(failure.ruleId, 'OPS-102');
  // The refusal is a sentence naming the table, not "SQLITE_CONSTRAINT_FOREIGNKEY".
  assert.match(failure.message, /points at data the archive does not contain/);
  assert.match(failure.message, /written nothing/);
  assert.match(failure.message, /^A row in sales/);

  // **The assertion.** Every table is exactly as it was — not merely the first one.
  //
  // `backups` is the single exception, and it is the proof rather than a hole in it:
  // OPS-103's backup is taken *before* the transaction opens, so its row survives the
  // rollback by design. If it were inside the transaction it would vanish with
  // everything else, and the operator's way back would disappear at the moment they
  // needed it.
  const after = snapshot();
  assert.equal(after.backups, before.backups + 1, 'the pre-import backup row stands');
  delete after.backups;
  const expected = { ...before };
  delete expected.backups;
  assert.deepEqual(after, expected);
  assert.equal(
    db.get().prepare('SELECT name FROM customers WHERE id = ?').get(survivor.id).name,
    beforeName
  );

  // And the backup taken before it is on disk and verified, so the operator's way back
  // exists even though this particular failure did not need it.
  const backups = require('../../services/backupService').list();
  const preImport = backups.backups.find((b) => b.trigger === 'PRE_IMPORT');
  assert.ok(preImport, 'the pre-import backup was taken before the transaction opened');
  assert.equal(preImport.verified, true);
  assert.ok(fs.existsSync(path.join(dir, preImport.file_name)));
});
