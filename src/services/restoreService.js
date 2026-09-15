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
//
// ## A backup from another computer (TASK-057)
//
// A store moves computers when the old one dies, and the backup it brings has no row in
// the new one's log. So a restore can also be pointed at a file in the backup folder by
// name, and — on a fresh installation, before the wizard has made a store — at a file
// uploaded to the wizard. Either way the file is unpacked and checked first, exactly as
// a backup is when it is taken (OPS-002), and refused if a newer build wrote it. The
// backup folder is this computer's, not the backup's: the restored store keeps backing
// up to the folder this computer was using, not to a path on the computer that died.

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
const settingsService = require('./settingsService');
const setupService = require('./setupService');
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
function preflight({ backupId = null, fileName = null } = {}) {
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
      : fileName ? describeFile(fileName) : null,
    binary_schema_version: migrate.binaryVersion(),
    requires_typed_filename: true,
    rule_id: 'OPS-004',
  };
}

/**
 * A file nobody here logged, opened and checked so the person can read what it holds
 * before typing its name: which store, when it was last written to, and whether this
 * build can open it.
 */
function describeFile(fileName) {
  const filePath = backupService.folderFile(fileName);
  const check = backupRepository.verify(filePath);
  const problem = check.ok ? refusalFor(check, fileName) : null;
  return {
    id: null,
    file_name: fileName,
    logged: false,
    on_disk: true,
    verified: check.ok,
    restorable: check.ok && !problem,
    error: check.ok ? (problem ? problem.message : null) : check.error,
    store_name: check.storeName || null,
    owners: check.owners || [],
    taken_at: check.lastRecordedAt || null,
    taken_at_manila: check.lastRecordedAt ? clock.toManila(check.lastRecordedAt) : null,
    schema_version: check.schemaVersion || null,
    row_counts: check.rowCounts || null,
  };
}

/**
 * Why a backup that verified still cannot be restored, or null.
 *
 * A newer build wrote it: its migrations are ones this build does not ship, and
 * restoring it would leave a database this build refuses to open at the next launch.
 * Or it holds no store anyone can sign into, which no backup this product wrote does.
 */
function refusalFor(check, fileName) {
  if (check.unknownMigrations && check.unknownMigrations.length > 0) {
    return errors.conflict(
      `${fileName} was made by a newer version of Chachi POS than the one on this computer. `
      + 'Install the newer Chachi POS on this computer first, then restore it.',
      { ruleId: 'OPS-004' }
    );
  }
  if (!check.storeName || !check.owners || check.owners.length === 0) {
    return errors.conflict(
      `${fileName} holds no store with an owner who can sign in, so it cannot be restored.`,
      { ruleId: 'OPS-004' }
    );
  }
  return null;
}

/** OPS-002 at the moment of restoring: the file is checked now, not trusted from its row. */
function assertRestorable(filePath, fileName) {
  const check = backupRepository.verify(filePath);
  if (!check.ok) {
    throw errors.conflict(
      `${fileName} could not be opened and checked (${check.error}), so it cannot be restored.`,
      { ruleId: 'OPS-002' }
    );
  }
  const problem = refusalFor(check, fileName);
  if (problem) throw problem;
  return check;
}

/**
 * Restore the database from a verified backup: one this installation logged
 * (`backupId`), or one in the backup folder that it did not (`fileName`, TASK-057).
 *
 * `confirmFilename` must equal the backup's own filename exactly. The comparison is
 * literal on purpose: a fuzzy match would accept the file next to the one the person
 * meant, which is the mistake this control exists to catch.
 */
function restore({ backupId = null, fileName = null, confirmFilename, actor }) {
  if (!actor || actor.role !== 'OWNER') {
    throw errors.forbidden(
      'Only the owner can restore a backup. A restore replaces everything traded since '
      + 'that backup was taken.',
      { ruleId: 'OPS-004', requiresRole: 'OWNER' }
    );
  }

  const row = backupId ? loggedSource(backupId) : fileSource(fileName);

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

  const check = assertRestorable(row.path, row.filename);
  if (!row.taken_at) row.taken_at = check.lastRecordedAt;

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

  const folderHere = backupService.folder();
  let swapped;
  try {
    swapped = swapIn(row.path);
  } catch (err) {
    throw errors.conflict(
      `The restore failed (${err.message}). The database was put back as it was, and the `
      + `pre-restore backup ${safety.file_name} is in the backup folder.`,
      { ruleId: 'OPS-004' }
    );
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

  // The restorer exists in the restored database only if they existed when the backup
  // was taken — and never, for a backup of another computer's store. The rows below
  // name them either way (AUD-606); only the reference waits for a user who is there.
  const stillExists = schemaRepository.userExists(actor.id);
  const recordedAs = stillExists ? { id: actor.id, username: actor.username } : { id: null, username: actor.username };
  keepFolder(folderHere, recordedAs);
  const migrated = swapped.migrated;

  // AUD-601. Written after the reopen, so it lands in the restored database — which is
  // the one that will be read afterwards, and the one where the row is needed.
  auditService.write({
    actor: recordedAs,
    action: 'BACKUP_RESTORED',
    entityType: 'backup',
    entityId: row.id || row.filename,
    before,
    after: {
      ...after,
      restored_from: row.filename,
      backup_taken_at: row.taken_at,
      store_name: check.storeName,
      pre_restore_backup: safety.file_name,
      migrated_to: migrated ? migrated.to : null,
    },
    reason: `Restored from ${row.filename}${row.taken_at ? ` (${clock.toManila(row.taken_at)})` : ''}`,
    shiftId: null,
  });

  backupRepository.insertEvent({
    id: ids.uuidv7(), kind: 'RESTORE', occurred_at: at, ok: 1,
    detail: JSON.stringify({ from: row.filename, sales_before: before.sales, sales_after: after.sales }),
    actor_id: recordedAs.id,
  });

  // The actor doing the restoring exists only if they existed in the backup too. Say so
  // plainly rather than letting them find out at the login screen.
  return {
    restored: true,
    from: { id: row.id, file_name: row.filename, taken_at: row.taken_at },
    pre_restore_backup: { id: safety.id, file_name: safety.file_name },
    before,
    after,
    migrated_to: migrated ? migrated.to : after.schema_version,
    replaced_database_kept_at: swapped.aside,
    store_name: check.storeName,
    signed_in_user_survives: stillExists,
    message: stillExists
      ? `Restored from ${row.filename}. Everything traded after ${row.taken_at ? clock.toManila(row.taken_at) : 'it was taken'} `
        + `is no longer in the database; it is in ${safety.file_name} if you need it back.`
      : `Restored from ${row.filename}. Your user account is not in that backup, so sign in `
        + `as one that is${check.owners.length ? ` (the owner: ${check.owners.join(', ')})` : ''}.`,
  };
}

function loggedSource(backupId) {
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
  return { id: row.id, filename: row.filename, path: row.path, taken_at: row.taken_at };
}

/** TASK-057: a file in the folder with no row here. Its date is the last thing it recorded. */
function fileSource(fileName) {
  if (!fileName) throw errors.badRequest('Choose a backup to restore.', { ruleId: 'OPS-004' });
  return { id: null, filename: fileName, path: backupService.folderFile(fileName), taken_at: null };
}

/**
 * Put the backup's database in place of the live one, and bring it to this build.
 *
 * The live file and its WAL are moved aside, not deleted, and put back if anything
 * fails — including the migration, which is inside for that reason: a restored
 * database this build cannot bring forward is one the application cannot open.
 */
function swapIn(archivePath) {
  const livePath = db.currentPath();
  const staged = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-restore-')), 'restored.db');
  const asideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-replaced-'));
  const aside = path.join(asideDir, path.basename(livePath));

  try {
    backupRepository.extract(archivePath, staged);
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

      // The restored database is older than this build whenever a migration has landed
      // since. Bringing it forward is the same thing a fresh install does on launch.
      const migrated = migrate.status().pending.length > 0 ? migrate.migrate() : null;
      return { aside, migrated };
    } catch (err) {
      // Put back exactly what was there. A half-restored store is worse than an
      // un-restored one, because nobody can tell which it is.
      try {
        db.close();
        for (const suffix of ['', '-wal', '-shm']) {
          if (fs.existsSync(livePath + suffix)) fs.rmSync(livePath + suffix, { force: true });
          if (fs.existsSync(aside + suffix)) fs.renameSync(aside + suffix, livePath + suffix);
        }
      } catch { /* reported by the caller either way */ }
      if (!db.isOpen()) db.open({ path: livePath });
      throw err;
    }
  } finally {
    try {
      fs.rmSync(path.dirname(staged), { recursive: true, force: true });
    } catch { /* temp */ }
  }
}

/**
 * OPS-001 after a restore: the backups go where this computer was sending them.
 *
 * The restored settings name the folder the backup's own computer used. On the same
 * computer that is usually this one; on a new computer it is a path that does not
 * exist, and every backup from then on would fail — quietly, until the alert. So the
 * folder in use before the restore is kept, and the change is recorded.
 */
function keepFolder(folderHere, actor) {
  if (!folderHere || settingsService.get('backup_folder') === folderHere) return;
  db.transaction(() => settingsService.set('backup_folder', folderHere, actor, {
    reason: 'Kept through a restore: the backup folder is this computer\'s, not the backup\'s (OPS-001)',
  }));
}

// ── On a new computer, before setup (TASK-057) ─────────────────────────────

/**
 * The wizard's other way out: this store already exists, on a computer that died.
 *
 * Only while the installation has no store — the same limit as `POST /setup` — so it
 * replaces nothing: there is no trading here to lose, which is why no pre-restore
 * backup is taken and no filename is typed. The backup is checked exactly as a restore
 * checks it; the folder is checked as the wizard checks one; and the first backup on
 * this computer is taken straight after, so the store is protected here from its first
 * minute rather than from its first shift close.
 */
function restoreAtSetup({ archivePath, fileName = null, backupFolder }) {
  setupService.assertNotComplete();
  // TASK-062: a hosted copy's backups go to its own volume, whatever the form said.
  const hostedDir = require('../config/hosting').backupDir();
  const folder = setupService.validateBackupFolder(hostedDir || backupFolder);
  const name = typeof fileName === 'string' && fileName.trim() ? path.basename(fileName.trim()) : 'the backup';
  const check = assertRestorable(archivePath, name);

  let swapped;
  try {
    swapped = swapIn(archivePath);
  } catch (err) {
    throw errors.conflict(`The restore failed (${err.message}). Nothing was changed.`, { ruleId: 'OPS-004' });
  }

  keepFolder(folder, setupService.SETUP_ACTOR);
  const at = clock.nowUtc();
  const after = { schema_version: migrate.schemaVersion(), size_bytes: db.sizeBytes(), sales: countSales() };

  auditService.write({
    actor: setupService.SETUP_ACTOR,
    action: 'BACKUP_RESTORED',
    entityType: 'backup',
    entityId: name,
    before: { sales: 0, note: 'A new installation, before setup' },
    after: {
      ...after,
      restored_from: name,
      store_name: check.storeName,
      last_recorded_at: check.lastRecordedAt,
      backup_folder: folder,
      migrated_to: swapped.migrated ? swapped.migrated.to : null,
    },
    reason: `Moved to this computer: restored from ${name} in the setup wizard (TASK-057)`,
  });
  backupRepository.insertEvent({
    id: ids.uuidv7(), kind: 'RESTORE', occurred_at: at, ok: 1,
    detail: JSON.stringify({ from: name, at_setup: true, sales_after: after.sales }),
    actor_id: null,
  });

  const first = backupService.run({ trigger: 'MANUAL', actor: null });

  return {
    restored: true,
    store_name: check.storeName,
    owners: check.owners,
    last_recorded_at: check.lastRecordedAt,
    last_recorded_at_manila: check.lastRecordedAt ? clock.toManila(check.lastRecordedAt) : null,
    sales: after.sales,
    migrated_to: swapped.migrated ? swapped.migrated.to : after.schema_version,
    backup_folder: folder,
    first_backup: first.ok
      ? { ok: true, file_name: first.file_name }
      : { ok: false, error: first.error },
    message: `${check.storeName} is on this computer. Sign in with the username and password `
      + 'you used on the old computer.',
  };
}

const countSales = () => schemaRepository.countOf('sales');

module.exports = { preflight, restore, restoreAtSetup };
