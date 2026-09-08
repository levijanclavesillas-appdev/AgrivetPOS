'use strict';

// OPS-001 / OPS-002 — the automatic backup and its verification.
//
// TASK-017 owns the whole of this subject: the daily schedule, retention and pruning
// (OPS-003), restore (OPS-004), the backup_log table and the health panel's
// last-successful-backup figure. What is here is the half TASK-013 cannot do without —
// **a shift close writes a backup, and the close reports whether it was written and
// verified** — built so that TASK-017 adds the schedule and the log around it rather
// than replacing it.
//
// OPS-002 is the rule that shapes this: every backup is verified immediately after
// writing by opening it and running an integrity check, and **a failed verification
// raises an alert and does not count as a backup**. A backup nobody has opened is a
// hope, and the day it is needed is the worst day to discover that.
//
// The backup runs **after** the close commits and its failure never reopens the shift
// (the task's own constraint). A drawer that has been counted and signed off is not
// un-counted because a USB stick was full.

const fs = require('fs');
const path = require('path');
const clock = require('../config/clock');
const ids = require('../config/ids');
const settingsService = require('./settingsService');
const backupRepository = require('../repositories/backupRepository');

/** OPS-002's triggers, matching the backup_log CHECK TASK-017 will write against. */
const TRIGGERS = Object.freeze(['SCHEDULED', 'SHIFT_CLOSE', 'MANUAL', 'PRE_RESTORE', 'PRE_IMPORT']);

const FILE_PREFIX = 'agrivet-backup';

function assertTrigger(trigger) {
  if (!TRIGGERS.includes(trigger)) {
    throw new RangeError(`unknown backup trigger: ${trigger} (OPS-001)`);
  }
  return trigger;
}

/**
 * A file name that sorts chronologically and says what caused it.
 *
 * The stamp keeps its milliseconds and carries a short random suffix, because
 * `VACUUM INTO` refuses to overwrite an existing file — two backups in the same second
 * would fail the second one. That is not hypothetical: two cashiers closing their
 * drawers together at the end of the day is the ordinary case, and the failure would
 * land on whichever of them pressed the button second.
 */
function fileNameFor(trigger, at) {
  const stamp = at.replace(/[-:.]/g, '');
  const suffix = ids.uuidv7().slice(-6);
  return `${FILE_PREFIX}-${stamp}-${trigger.toLowerCase()}-${suffix}.db`;
}

/**
 * Take a backup, verify it, and report honestly either way.
 *
 * Never throws. Every caller of this is a business operation that has already
 * succeeded — a shift close, an import, a restore — and none of them should be undone
 * because a disk was full. The failure is in the return value, and the caller surfaces
 * it as an alert (OPS-007).
 *
 * A failed verification **deletes the file it wrote**. OPS-002 says a failed
 * verification does not count as a backup, and leaving a corrupt file in the folder is
 * worse than leaving none: the next person to look sees a recent backup and believes it.
 */
function run({ trigger = 'MANUAL', actor = null } = {}) {
  assertTrigger(trigger);
  const at = clock.nowUtc();

  const folder = settingsService.get('backup_folder');
  if (!folder) {
    return {
      ok: false,
      trigger,
      at,
      file_path: null,
      verified: false,
      error: 'No backup folder is configured. Set one in Settings before trading (OPS-001).',
      rule_id: 'OPS-001',
    };
  }

  const filePath = path.join(folder, fileNameFor(trigger, at));

  try {
    fs.mkdirSync(folder, { recursive: true });
    backupRepository.snapshot(filePath);
  } catch (err) {
    return {
      ok: false, trigger, at, file_path: filePath, verified: false,
      error: `The backup could not be written (${err.code || err.message}).`,
      rule_id: 'OPS-001',
    };
  }

  const verification = backupRepository.verify(filePath);
  if (!verification.ok) {
    // OPS-002: it did not happen. Remove the file so nobody trusts it later.
    try {
      fs.rmSync(filePath, { force: true });
    } catch { /* the alert below is the point; a stuck file is not worth a second failure */ }

    return {
      ok: false, trigger, at, file_path: filePath, verified: false,
      error: `The backup was written but failed verification (${verification.error}). `
        + 'It has been removed and does not count as a backup.',
      rule_id: 'OPS-002',
    };
  }

  const stats = fs.statSync(filePath);
  return {
    ok: true,
    trigger,
    at,
    file_path: filePath,
    file_name: path.basename(filePath),
    size_bytes: stats.size,
    verified: true,
    schema_version: verification.schemaVersion,
    row_counts: verification.rowCounts,
    created_by: actor && actor.username ? actor.username : null,
  };
}

/** OPS-007's alert for a backup that did not happen. */
function alertFor(result) {
  if (result.ok) return null;
  return {
    kind: 'BACKUP_FAILED',
    severity: 'CRITICAL',
    rule_id: result.rule_id || 'OPS-002',
    message: `${result.error} The day's trading is safe, but it is not backed up. `
      + 'Fix the backup folder and run a manual backup.',
  };
}

/** The backups on disk, newest first — what SCR-704 lists until TASK-017's log exists. */
function list({ limit = 30 } = {}) {
  const folder = settingsService.get('backup_folder');
  if (!folder || !fs.existsSync(folder)) return [];

  return fs.readdirSync(folder)
    .filter((name) => name.startsWith(FILE_PREFIX) && name.endsWith('.db'))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((name) => {
      const stats = fs.statSync(path.join(folder, name));
      return {
        file_name: name,
        file_path: path.join(folder, name),
        size_bytes: stats.size,
        modified_at: new Date(stats.mtimeMs).toISOString(),
      };
    });
}

module.exports = { TRIGGERS, FILE_PREFIX, assertTrigger, fileNameFor, run, alertFor, list };
