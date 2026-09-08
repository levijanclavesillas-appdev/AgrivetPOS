'use strict';

// 05_TECH_SPEC.md §7 — the upgrade path.
//
// "The installer preserves the database, runs pending migrations on first launch, and
// takes a pre-migration backup automatically." The last clause is the one that matters
// and the one small-product installers usually skip: migrations are forward-only and
// are never edited once applied (§8.9), so **the backup is the only way back**. There
// is no down-migration in this product and there never will be — a down-migration that
// drops a column drops the data in it, and a store that upgraded on Tuesday and rolled
// back on Wednesday would lose Tuesday.
//
// Three states, and each is handled differently because each means something different
// to the person standing at the counter:
//
//   * **Fresh** — nothing to preserve. Migrate and open the wizard.
//   * **Behind** — a real upgrade. Back up, verify, migrate. If the backup cannot be
//     verified the migration does not run, because there would be no way back.
//   * **Ahead** — the database was written by a newer build than this one. Refuse,
//     plainly, without touching anything (TASK-001, TC-INST-02). Running an older
//     binary against a newer schema is how a column that exists gets written as if it
//     did not.

const migrate = require('../config/migrate');

/** What the database is, relative to this binary, before anything is done to it. */
function inspect() {
  const binary = migrate.binaryVersion();
  let current = 0;

  try {
    current = migrate.schemaVersion();
  } catch {
    // An unreadable schema table is a fresh or a broken database; migrate() will say
    // which, and this is only deciding whether to take a backup first.
    current = 0;
  }

  return {
    current,
    binary,
    state: current === 0 ? 'FRESH' : (current < binary ? 'BEHIND' : (current > binary ? 'AHEAD' : 'CURRENT')),
    pending: Math.max(0, binary - current),
  };
}

/**
 * Bring the database to this binary's schema, backing it up first if there is anything
 * to lose.
 *
 * Returns rather than throws for the ordinary outcomes, and rethrows only when the
 * database itself cannot be brought up — because the caller is `server.start()`, and
 * the difference between "did not start and here is why" and "crashed" is the whole of
 * what an owner sees on a bad morning.
 */
function onLaunch({ log = () => {} } = {}) {
  const before = inspect();

  if (before.state === 'AHEAD') {
    // migrate() refuses before touching anything; this is the same refusal, reached
    // earlier so no backup is taken of a database that is not going to be changed.
    return { ...before, migrated: false, backup: null, error: aheadMessage(before) };
  }

  if (before.state === 'CURRENT') {
    log(`schema version ${before.current}`);
    return { ...before, migrated: false, backup: null };
  }

  let backup = null;

  if (before.state === 'BEHIND') {
    log(`upgrading the database from schema ${before.current} to ${before.binary}`);

    // §7: automatically, before the first statement runs. Required at this point and
    // nowhere else — a backup taken after a migration is a backup of the new shape.
    backup = require('./backupService').run({ trigger: 'PRE_MIGRATION' });

    if (!backup.ok) {
      // Migrations are forward-only. Without a verified backup there is no way back
      // from a bad one, so the upgrade does not happen and the old database is left
      // exactly as it was — which is a working store on the previous version, not a
      // broken one on this.
      log(`the pre-migration backup failed: ${backup.error}`);
      return {
        ...before,
        migrated: false,
        backup,
        error: 'The database needs upgrading, and a backup of it could not be taken first '
          + `(${backup.error}) Migrations cannot be undone, so the upgrade has not been run and `
          + 'your data is untouched. Fix the backup folder in Settings, or free some disk space, '
          + 'and start the application again.',
        rule_id: 'OPS-001',
      };
    }
    log(`pre-migration backup verified: ${backup.file_name}`);
  }

  try {
    const result = migrate.migrate({ log });
    log(`schema version ${result.to}`);
    recordBackup(backup, log);
    return { ...inspect(), migrated: result.applied.length > 0, applied: result.applied, backup };
  } catch (err) {
    // TASK-001 already guarantees a failing migration leaves the database at its
    // previous version — each file runs in its own transaction. What is added here is
    // saying so, and saying where the copy is.
    log(`the upgrade failed: ${err.message}`);
    return {
      ...inspect(),
      migrated: false,
      backup,
      error: `The database could not be upgraded (${err.message}). It has been left at schema `
        + `version ${inspect().current}, exactly as it was`
        + (backup && backup.ok ? `, and a verified copy is at ${backup.file_name}.` : '.')
        + ' Nothing has been lost. Send this message to your supplier.',
      rule_id: 'OPS-008',
    };
  }
}

/**
 * Put the pre-migration backup into the log, once the log exists.
 *
 * The backup is taken **before** the migrations run, so on an upgrade from any version
 * older than the one that created the `backups` table there is nowhere to record it —
 * including, unavoidably, the upgrade that introduces the table itself. The result was
 * that the single most important backup a store ever takes was the one missing from
 * its log, on the one occasion an owner would go looking.
 *
 * Written afterwards for that reason, and only if it is not already there.
 */
function recordBackup(backup, log) {
  if (!backup || !backup.ok) return;

  const backupRepository = require('../repositories/backupRepository');
  try {
    if (!backupRepository.logExists()) return;
    if (backupRepository.findLog(backup.id || '')) return;

    backupRepository.insertLog({
      id: backup.id || require('../config/ids').uuidv7(),
      filename: backup.file_name,
      path: backup.file_path,
      size_bytes: backup.size_bytes,
      taken_at: backup.at,
      trigger: 'PRE_MIGRATION',
      verified_at: backup.at,
      verification_result: 'OK',
      schema_version: backup.schema_version,
      row_counts: JSON.stringify(backup.row_counts || {}),
      created_by: null,
    });
  } catch (err) {
    // The file is on disk either way; the note about it is not worth failing an
    // upgrade over.
    log(`the pre-migration backup could not be recorded in the log: ${err.message}`);
  }
}

const aheadMessage = ({ current, binary }) => 'This database was written by a newer version of '
  + `Chachi Agrivet POS (it is at version ${current}; this copy of the application understands `
  + `up to ${binary}). Install the newer version again — running the older one would damage the `
  + 'data. Nothing has been changed.';

module.exports = { inspect, onLaunch, aheadMessage, recordBackup };
