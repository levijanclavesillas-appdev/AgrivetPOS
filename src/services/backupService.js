'use strict';

// OPS-001 – OPS-004 — the automatic backup, its verification, its retention and the
// restore.
//
// This is the task that decides whether a bad day costs an afternoon or a year of
// history, and OPS-002 is the rule that makes the rest of it worth anything: **a
// backup that has not been opened and integrity-checked is not a backup, it is a
// file.** Most backup features in small systems fail exactly there — they write,
// report success, and are discovered unreadable on the day they are needed. So every
// backup here is unpacked, opened read-only, integrity-checked, foreign-key-checked
// and asked for its schema version before it is allowed to count.
//
// A failed verification is not a backup: it does not update "last successful backup",
// it does not satisfy OPS-007's freshness check, it deletes the file it wrote so that
// nobody trusts it later, and it raises an alert. The row stays, because "we tried and
// it failed" is the fact an owner needs.
//
// `run()` never throws. Every caller is a business operation that has already
// succeeded — a shift close, a restore, a migration — and none of them should be
// undone because a USB stick was full. The failure is in the return value.
//
// ## Retention (OPS-003)
//
// Pruning happens **only after a newer backup has verified**, and only ever
// oldest-first. The ordering is the whole rule: a prune that runs first, then fails to
// write the replacement, has turned a full folder into a folder one backup shorter for
// no gain. So the sequence is write, verify, and only then delete — and if any step
// before the last one fails, nothing is deleted at all.

const fs = require('fs');
const path = require('path');
const clock = require('../config/clock');
const ids = require('../config/ids');
const paths = require('../config/paths');
const db = require('../config/database');
const errors = require('./errors');
const settingsService = require('./settingsService');
const auditService = require('./auditService');
const backupRepository = require('../repositories/backupRepository');

/** OPS-001's triggers, matching the backups table's CHECK. */
const TRIGGERS = Object.freeze([
  'SCHEDULED', 'SHIFT_CLOSE', 'MANUAL', 'PRE_RESTORE', 'PRE_IMPORT', 'PRE_MIGRATION',
]);

const FILE_PREFIX = 'agrivet_backup';

function assertTrigger(trigger) {
  if (!TRIGGERS.includes(trigger)) {
    throw new RangeError(`unknown backup trigger: ${trigger} (OPS-001)`);
  }
  return trigger;
}

/**
 * A file name that sorts chronologically and says what caused it.
 *
 * 05_TECH_SPEC.md §7 writes it as `agrivet_backup_YYYY-MM-DD_HH-mm.zip`. The seconds
 * and the short suffix are additions, and they are not cosmetic: minute resolution
 * collides, and a collision here is a lost backup. Two cashiers closing their drawers
 * together at the end of the day is the ordinary case, not a contrived one, and the
 * failure would land on whichever of them pressed the button second. The shape the
 * spec asks for is preserved; the resolution is what a real till needs.
 */
function fileNameFor(trigger, at) {
  const stamp = at.slice(0, 19).replace('T', '_').replace(/:/g, '-');
  return `${FILE_PREFIX}_${stamp}_${trigger.toLowerCase()}_${ids.uuidv7().slice(-6)}.zip`;
}

/**
 * OPS-001: the folder defaults outside the application data directory.
 *
 * Because a backup inside the folder that is being backed up survives exactly the
 * failures that do not matter. It does not survive the disk, the ransomware or the
 * uninstaller, which are the three this exists for.
 */
function folder() {
  return settingsService.get('backup_folder') || null;
}

// ── Taking one ──────────────────────────────────────────────────────────────

function run({ trigger = 'MANUAL', actor = null, now = clock.nowUtc() } = {}) {
  assertTrigger(trigger);
  const at = now;
  const target = folder();

  if (!target) {
    return logFailure({
      trigger, at, actor, filePath: null, filename: null,
      error: 'No backup folder is configured. Set one in Settings before trading (OPS-001).',
      ruleId: 'OPS-001',
    });
  }

  const filename = fileNameFor(trigger, at);
  const filePath = path.join(target, filename);
  let written = null;

  try {
    fs.mkdirSync(target, { recursive: true });
    written = backupRepository.archive(filePath);
  } catch (err) {
    return logFailure({
      trigger, at, actor, filePath, filename,
      error: `The backup could not be written (${err.code || err.message}).`,
      ruleId: 'OPS-001',
    });
  }

  // The row exists before the verification does, and says PENDING. A crash between
  // writing and checking then reads as unverified rather than as success — which is
  // the honest reading, and the one OPS-002 requires.
  const row = logged({
    id: ids.uuidv7(), filename, path: filePath, size_bytes: written.size_bytes,
    taken_at: at, trigger, verification_result: 'PENDING', created_by: actorId(actor),
  });

  const verification = backupRepository.verify(filePath);

  if (!verification.ok) {
    // OPS-002: it did not happen. The file goes, because leaving a corrupt one in the
    // folder is worse than leaving none — the next person to look sees a recent backup
    // and believes it.
    removeQuietly(filePath);
    update(row, {
      verified_at: clock.nowUtc(),
      verification_result: 'FAILED',
      error: verification.error,
      pruned_at: clock.nowUtc(),
    });

    const result = {
      ok: false, id: row ? row.id : null, trigger, at, file_path: filePath, file_name: filename,
      verified: false,
      error: `The backup was written but failed verification (${verification.error}). `
        + 'It has been removed and does not count as a backup.',
      rule_id: 'OPS-002',
    };
    audit(result, actor);
    return result;
  }

  update(row, {
    verified_at: clock.nowUtc(),
    verification_result: 'OK',
    schema_version: verification.schemaVersion,
    row_counts: JSON.stringify(verification.rowCounts),
  });

  // OPS-003, in this order and no other: the prune runs only now, with a verified
  // newer backup already on disk.
  const pruned = prune({ actor });

  return {
    ok: true,
    id: row ? row.id : null,
    trigger,
    at,
    file_path: filePath,
    file_name: filename,
    size_bytes: written.size_bytes,
    uncompressed_bytes: written.raw_bytes,
    verified: true,
    schema_version: verification.schemaVersion,
    row_counts: verification.rowCounts,
    pruned,
    created_by: actor && actor.username ? actor.username : null,
  };
}

const actorId = (actor) => (actor && actor.id && actor.id !== 'system' ? actor.id : null);

function logged(row) {
  if (!backupRepository.logExists()) return null;
  try {
    return backupRepository.insertLog(row);
  } catch {
    // A log that cannot be written must not cost the store its backup.
    return null;
  }
}

function update(row, changes) {
  if (!row) return null;
  try {
    return backupRepository.updateLog(row.id, changes);
  } catch {
    return null;
  }
}

/**
 * Record a backup that did not happen.
 *
 * Logged even when there was never a filename to log. That case — no folder configured
 * — is the one a store is in on its first day and the one that matters most, and an
 * earlier version of this returned early without a row: the alert list then had
 * nothing to notice, so the most exposed state the product has was also its quietest.
 */
function logFailure({ trigger, at, actor, filePath, filename, error, ruleId }) {
  const row = logged({
    id: ids.uuidv7(), filename: filename || null, path: filePath || null, size_bytes: null,
    taken_at: at, trigger, verification_result: 'FAILED', error, created_by: actorId(actor),
    pruned_at: at,
  });

  const result = {
    ok: false, id: row ? row.id : null, trigger, at,
    file_path: filePath, file_name: filename, verified: false, error, rule_id: ruleId,
  };
  audit(result, actor);
  return result;
}

/** AUD-601: a backup that did not happen is a fact worth keeping. */
function audit(result, actor) {
  try {
    auditService.write({
      actor: actor && actor.id ? { id: actor.id, username: actor.username } : auditService.SYSTEM_ACTOR,
      action: 'BACKUP_FAILED',
      entityType: 'backup',
      entityId: result.id || result.file_name || 'backup',
      after: { trigger: result.trigger, file_name: result.file_name, rule_id: result.rule_id },
      reason: result.error,
      shiftId: actor ? actor.shiftId || null : null,
    });
  } catch { /* the alert is the control; a failed audit write must not mask it */ }
}

function removeQuietly(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch { /* a stuck file is not worth a second failure */ }
}

// ── Retention (OPS-003) ─────────────────────────────────────────────────────

/**
 * Keep the configured number of verified backups, oldest deleted first.
 *
 * Only verified ones are counted, so a run of failures cannot push the last good
 * backup out of the window. That is the difference between retention and attrition.
 */
function prune({ actor = null, now = clock.nowUtc() } = {}) {
  if (!backupRepository.logExists()) return { removed: 0, kept: 0 };

  const keep = settingsService.get('backup_retention_count');
  const target = folder();

  // Only what is actually in the folder being managed. A row whose file has been moved
  // away or deleted by hand is not occupying a retention slot, and files left in a
  // folder the operator has since stopped using are not this application's to delete —
  // changing the backup folder must not silently erase the old one.
  const onDisk = backupRepository.verifiedOnDisk()
    .filter((row) => row.path && fs.existsSync(row.path)
      && (!target || path.resolve(path.dirname(row.path)) === path.resolve(target)));

  if (onDisk.length <= keep) return { removed: 0, kept: onDisk.length };

  const doomed = onDisk.slice(0, onDisk.length - keep);
  for (const row of doomed) {
    removeQuietly(row.path);
    // The row survives the file. "There were thirty and now there are twenty-nine
    // because we pruned" is a different fact from "someone deleted them".
    update(row, { pruned_at: now });
  }

  return { removed: doomed.length, kept: keep, removed_files: doomed.map((r) => r.filename) };
}

// ── Freshness (OPS-007, FR_7.3) ─────────────────────────────────────────────

function lastVerified() {
  if (!backupRepository.logExists()) return null;
  return backupRepository.lastVerified();
}

/**
 * How overdue the store is, if at all.
 *
 * The period is the daily schedule plus a day of slack: a backup is not "overdue"
 * because the hour has not come round yet. What raises the alert is a store that has
 * gone a whole extra day with nothing verified.
 */
function overdue({ now = clock.nowUtc() } = {}) {
  const periodHours = settingsService.get('backup_period_hours');
  const last = lastVerified();

  if (!last) {
    return {
      overdue: true, last_verified_at: null, hours_since: null, period_hours: periodHours,
      // A store that has never had a verified backup is the most exposed state this
      // product has, and it is also the easiest one to be in on day one.
      message: 'No backup has ever been verified on this machine. Run one now, and copy the '
        + 'backup folder to a USB stick before the end of the day.',
    };
  }

  const hours = (Date.parse(now) - Date.parse(last.taken_at)) / 3600000;
  return {
    overdue: hours > periodHours,
    last_verified_at: last.taken_at,
    last_verified_file: last.filename,
    hours_since: Math.floor(hours),
    period_hours: periodHours,
    message: hours > periodHours
      ? `The last verified backup was ${Math.floor(hours)} hours ago (${clock.toManila(last.taken_at)}), `
        + `longer than the ${periodHours}-hour backup period. Run a backup now.`
      : null,
  };
}

// ── Reading (SCR-704) ───────────────────────────────────────────────────────

/**
 * What SCR-704 lists: the log, joined to what is actually on disk.
 *
 * Both halves matter. A row without its file means someone deleted a backup by hand,
 * and a file without a row means one arrived from somewhere this installation did not
 * write it — both are worth seeing, and neither is visible from one source alone.
 */
function list({ limit = 30 } = {}) {
  const target = folder();
  const onDisk = new Map();

  if (target && fs.existsSync(target)) {
    for (const name of fs.readdirSync(target)) {
      if (!name.startsWith(FILE_PREFIX)) continue;
      const stats = fs.statSync(path.join(target, name));
      onDisk.set(name, { size_bytes: stats.size, modified_at: new Date(stats.mtimeMs).toISOString() });
    }
  }

  const rows = backupRepository.logExists() ? backupRepository.listLog({ limit }) : [];
  const known = new Set(rows.map((row) => row.filename).filter(Boolean));

  const logged_ = rows.map((row) => ({
    id: row.id,
    file_name: row.filename,
    file_path: row.path,
    size_bytes: row.size_bytes,
    taken_at: row.taken_at,
    taken_at_manila: clock.toManila(row.taken_at),
    trigger: row.trigger,
    verified: row.verification_result === 'OK',
    verification_result: row.verification_result,
    verified_at: row.verified_at,
    error: row.error,
    schema_version: row.schema_version,
    created_by: row.created_by,
    pruned_at: row.pruned_at,
    on_disk: Boolean(row.filename) && onDisk.has(row.filename),
  }));

  return {
    folder: target,
    // SEC-9, said in plain words wherever the list is shown.
    shared_drive_warning: 'A backup on a shared drive or a USB stick is readable by anyone who '
      + 'has that drive. It contains every price, every customer and every peso the store has '
      + 'taken. Keep it somewhere you would keep the cash box.',
    inside_app_data: target ? isInsideAppData(target) : false,
    backups: logged_,
    // Files nobody here wrote — a copy from another machine, or a restore in progress.
    unrecognised: [...onDisk.keys()].filter((name) => !known.has(name)),
  };
}

function isInsideAppData(target) {
  const data = path.resolve(paths.dataDir());
  const resolved = path.resolve(target);
  return resolved === data || resolved.startsWith(data + path.sep);
}

module.exports = {
  TRIGGERS, FILE_PREFIX,
  assertTrigger, fileNameFor, folder, isInsideAppData,
  run, prune, lastVerified, overdue, list,
};
