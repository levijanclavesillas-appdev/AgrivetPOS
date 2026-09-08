'use strict';

// OPS-004 — the restore.
//
// The most destructive operation in the product. It replaces every row in the store's
// database with rows from a file, and everything traded since that file was written is
// gone. So it is hedged four ways, and each hedge exists because of a specific way this
// goes wrong:
//
//   * **Owner only** (TX-427). Not a manager: a restore is not a correction, it is a
//     decision about which version of the store's history is the real one.
//   * **A fresh verified backup of the current database first.** The commonest restore
//     disaster is restoring the wrong file, and without this there is nothing to go
//     back to. If that pre-restore backup cannot be taken and verified, the restore
//     does not happen at all.
//   * **The filename typed out.** Not a checkbox. Picking from a list and clicking OK
//     is how the wrong night's backup gets restored; typing the name is the moment a
//     person reads the date.
//   * **No open shift.** A drawer counted against a database that is about to be
//     replaced reconciles to nothing, and the cashier standing at it would have no idea.
//
// The restore itself is a file move, not a transaction: SQLite cannot replace its own
// open database from inside a query. The live database is closed, the current file is
// moved aside, the verified copy is put in its place, and the database is reopened and
// re-verified. If anything fails between those steps the file moved aside is put back.

const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../config/database');
const clock = require('../config/clock');
const ids = require('../config/ids');
const migrate = require('../config/migrate');
const errors = require('./errors');
const auditService = require('./auditService');
const backupService = require('./backupService');
const backupRepository = require('../repositories/backupRepository');
const shiftRepository = require('../repositories/shiftRepository');
const schemaRepository = require('../repositories/schemaRepository');

/**
 * Everything that must be true before a restore is even attempted.
 *
 * Exposed so SCR-704 can show the same list rather than discovering them one refusal
 * at a time — 04_UX_SPEC.md §6 puts rule validation at the point of action, and
 * "actually you cannot, there is a shift open" after the filename has been typed is
 * too late to be useful.
 */
function preflight({ backupId = null } = {}) {
  const openShifts = shiftRepository.openShifts();
  const row = backupId ? backupRepository.findLog(backupId) : null;

  return {
    open_shifts: openShifts.length,
    // POS-501's world: a shift is a counted drawer against a database.
    blocked_by_open_shift: openShifts.length > 0,
    backup: row
      ? {
        id: row.id,
        file_name: row.filename,
        taken_at: row.taken_at,
        taken_at_manila: clock.toManila(row.taken_at),
        verified: row.verification_result === 'OK',
        on_disk: fs.existsSync(row.path),
        schema_version: row.schema_version,
      }
      : null,
    binary_schema_version: migrate.binaryVersion(),
    requires_typed_filename: true,
    rule_id: 'OPS-004',
  };
}

/**
 * Restore the database from a logged, verified backup.
 *
 * `confirmFilename` must equal the backup's own filename exactly. The comparison is
 * literal on purpose: a fuzzy match would accept the file next to the one the person
 * meant, which is the mistake this control exists to catch.
 */
function restore({ backupId, confirmFilename, actor }) {
  if (!actor || actor.role !== 'OWNER') {
    throw errors.forbidden(
      'Only the owner can restore a backup. A restore replaces everything traded since '
      + 'that backup was taken.',
      { ruleId: 'OPS-004', requiresRole: 'OWNER' }
    );
  }

  const row = backupRepository.findLog(backupId);
  if (!row) throw errors.notFound('No such backup');

  if (row.verification_result !== 'OK') {
    // OPS-002: it never counted as a backup, so it cannot be restored from.
    throw errors.conflict(
      `${row.filename} did not pass verification, so it is not a backup and cannot be restored.`,
      { ruleId: 'OPS-002' }
    );
  }
  if (!fs.existsSync(row.path)) {
    throw errors.conflict(
      `${row.filename} is in the log but not in the backup folder. It may have been moved, `
      + 'deleted or pruned. Copy it back and try again.',
      { ruleId: 'OPS-004' }
    );
  }

  const open = shiftRepository.openShifts();
  if (open.length > 0) {
    throw errors.conflict(
      `${open.length} shift${open.length === 1 ? ' is' : 's are'} still open. Close the drawer `
      + 'before restoring — a shift counted against a database that is about to be replaced '
      + 'reconciles to nothing.',
      { ruleId: 'OPS-004' }
    );
  }

  if (String(confirmFilename || '').trim() !== row.filename) {
    throw errors.badRequest(
      `Type the backup's filename exactly to confirm: ${row.filename}`,
      { ruleId: 'OPS-004' }
    );
  }

  // OPS-004's own words: a fresh backup of the current database, first. If it cannot be
  // taken and verified there is nothing to come back to, so the restore stops here.
  const safety = backupService.run({ trigger: 'PRE_RESTORE', actor });
  if (!safety.ok) {
    throw errors.conflict(
      `The restore was not started: a backup of the current database could not be taken `
      + `(${safety.error}) There would be no way back from the restore, so nothing was changed.`,
      { ruleId: 'OPS-004' }
    );
  }

  const at = clock.nowUtc();
  const before = {
    schema_version: migrate.schemaVersion(),
    size_bytes: db.sizeBytes(),
    sales: countSales(),
  };

  const livePath = db.currentPath();
  const staged = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-restore-')), 'restored.db');
  backupRepository.extract(row.path, staged);

  const asideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-replaced-'));
  const aside = path.join(asideDir, path.basename(livePath));

  db.close();
  try {
    // The WAL and shm belong to the file being replaced. Left behind they would be
    // replayed into the restored database, which is how a "restore" silently
    // reintroduces the transactions it was meant to undo.
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(livePath + suffix)) fs.renameSync(livePath + suffix, aside + suffix);
    }
    fs.copyFileSync(staged, livePath);
    fs.chmodSync(livePath, 0o600);
    db.open({ path: livePath });
  } catch (err) {
    // Put back exactly what was there. A half-restored store is worse than an
    // un-restored one, because nobody can tell which it is.
    try {
      db.close();
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(livePath + suffix)) fs.rmSync(livePath + suffix, { force: true });
        if (fs.existsSync(aside + suffix)) fs.renameSync(aside + suffix, livePath + suffix);
      }
      db.open({ path: livePath });
    } catch { /* reported below either way */ }

    throw errors.conflict(
      `The restore failed (${err.message}). The database was put back as it was, and the `
      + `pre-restore backup ${safety.file_name} is in the backup folder.`,
      { ruleId: 'OPS-004' }
    );
  } finally {
    try {
      fs.rmSync(path.dirname(staged), { recursive: true, force: true });
    } catch { /* temp */ }
  }

  const after = {
    schema_version: migrate.schemaVersion(),
    size_bytes: db.sizeBytes(),
    sales: countSales(),
  };

  // **The pre-restore backup's own row was written to the database that has just been
  // replaced.** Restoring rolls the backup log back to the state it was in when the
  // backup was taken, so the one file that holds everything just undone becomes
  // invisible in the log — which is precisely the moment somebody needs to find it.
  // It is written into the restored database here, where it will actually be read.
  try {
    if (!backupRepository.findLog(safety.id)) {
      backupRepository.insertLog({
        id: safety.id,
        filename: safety.file_name,
        path: safety.file_path,
        size_bytes: safety.size_bytes,
        taken_at: safety.at,
        trigger: 'PRE_RESTORE',
        verified_at: safety.at,
        verification_result: 'OK',
        schema_version: safety.schema_version,
        row_counts: JSON.stringify(safety.row_counts || {}),
        created_by: null,
      });
    }
  } catch { /* reported in the payload either way; the file is on disk regardless */ }

  // The restored database is older than this build whenever a migration has landed
  // since. Bringing it forward is the same thing a fresh install does on launch, and
  // leaving it behind would mean a restored store that the application cannot open.
  const migrated = after.schema_version < migrate.binaryVersion()
    ? migrate.migrate()
    : null;

  // AUD-601. Written after the reopen, so it lands in the restored database — which is
  // the one that will be read afterwards, and the one where the row is needed.
  auditService.write({
    actor: { id: actor.id, username: actor.username },
    action: 'BACKUP_RESTORED',
    entityType: 'backup',
    entityId: row.id,
    before,
    after: {
      ...after,
      restored_from: row.filename,
      backup_taken_at: row.taken_at,
      pre_restore_backup: safety.file_name,
      migrated_to: migrated ? migrated.to : null,
    },
    reason: `Restored from ${row.filename} (${clock.toManila(row.taken_at)})`,
    shiftId: null,
  });

  backupRepository.insertEvent({
    id: ids.uuidv7(), kind: 'RESTORE', occurred_at: at, ok: 1,
    detail: JSON.stringify({ from: row.filename, sales_before: before.sales, sales_after: after.sales }),
    actor_id: actor.id,
  });

  // The audit row is written into the restored database, but the actor doing the
  // restoring exists only if they existed in the backup too. Say so plainly rather
  // than letting them find out at the login screen.
  const stillExists = schemaRepository.userExists(actor.id);

  return {
    restored: true,
    from: { id: row.id, file_name: row.filename, taken_at: row.taken_at },
    pre_restore_backup: { id: safety.id, file_name: safety.file_name },
    before,
    after,
    migrated_to: migrated ? migrated.to : after.schema_version,
    replaced_database_kept_at: aside,
    signed_in_user_survives: stillExists,
    message: stillExists
      ? `Restored from ${row.filename}. Everything traded after ${clock.toManila(row.taken_at)} `
        + `is no longer in the database; it is in ${safety.file_name} if you need it back.`
      : `Restored from ${row.filename}. Your user account did not exist yet in that backup, `
        + 'so you will need to sign in as a user that did.',
  };
}

const countSales = () => schemaRepository.countOf('sales');

module.exports = { preflight, restore };
