'use strict';

// OPS-009 and OPS-006 — what the application checks when it starts, and what the
// health panel reports.
//
// ## The clock (OPS-009, VR-103)
//
// The device clock is not trusted for sequencing. Document numbers come from a
// monotonic per-day sequence in the database, and a clock that moves backwards past
// the last recorded transaction raises an alert and is audited — but **transactions
// continue**. That last part is the rule's own emphasis and it is the hard part to get
// right: the instinct on finding a wrong clock is to stop selling, and stopping a
// store from selling because its BIOS battery died would be the product causing the
// outage it was meant to prevent.
//
// A clock is checked against the newest timestamp any ledger holds. That is a stronger
// signal than checking against "now" from some other source, because there is no other
// source: this machine is offline by design (NFR_3.1).
//
// ## The launch sequence
//
// `onLaunch()` runs once, from server.start(), after migrations. Not from main.js: the
// server runs inside the Electron main process, so a check that lives here also runs
// under `npm start` and inside the test suite, and main.js keeps its single job of
// knowing that Electron exists (05_TECH_SPEC.md §1).

const clock = require('../config/clock');
const ids = require('../config/ids');
const db = require('../config/database');
const migrate = require('../config/migrate');
const auditService = require('./auditService');
const settingsService = require('./settingsService');
const backupService = require('./backupService');
const backupRepository = require('../repositories/backupRepository');
const schemaRepository = require('../repositories/schemaRepository');
const pkg = require('../../package.json');

/**
 * Tolerance before a backwards clock counts as an anomaly.
 *
 * Not zero. Timestamps are written at slightly different moments than they are read,
 * and a machine whose clock is a few seconds behind its own last write is a normal
 * machine, not a tampered one. What OPS-009 is about is a clock set to last month.
 */
const CLOCK_SKEW_TOLERANCE_MS = 60000;

let lastLaunch = null;

/** OPS-009 — is the clock behind the ledger? */
function checkClock({ now = clock.nowUtc() } = {}) {
  const latest = backupRepository.latestRecordedAt();
  if (!latest) {
    return { anomaly: false, now, latest_recorded_at: null, behind_by_ms: 0 };
  }

  const behind = Date.parse(latest) - Date.parse(now);
  return {
    anomaly: behind > CLOCK_SKEW_TOLERANCE_MS,
    now,
    now_manila: clock.toManila(now),
    latest_recorded_at: latest,
    latest_recorded_at_manila: clock.toManila(latest),
    behind_by_ms: Math.max(0, behind),
    behind_by_hours: Math.max(0, Math.round(behind / 3600000)),
    tolerance_ms: CLOCK_SKEW_TOLERANCE_MS,
  };
}

/**
 * The launch checks, run once when the server comes up.
 *
 * Never throws. A store must be able to open its till on a machine whose clock is
 * wrong and whose last backup failed — those are conditions to be told about, not
 * reasons to refuse to trade.
 */
function onLaunch({ now = clock.nowUtc() } = {}) {
  const result = {
    at: now,
    clock: { anomaly: false },
    backup: { overdue: false },
    schema_version: null,
  };

  try {
    result.schema_version = migrate.schemaVersion();
  } catch { /* reported as null */ }

  try {
    result.clock = checkClock({ now });

    if (result.clock.anomaly) {
      // Audited, per OPS-009. Recorded before anything else, because if the clock is
      // wrong then every timestamp written afterwards is suspect and this row is what
      // explains them.
      auditService.write({
        actor: auditService.SYSTEM_ACTOR,
        action: 'CLOCK_ANOMALY',
        entityType: 'system',
        entityId: 'clock',
        after: {
          now: result.clock.now,
          latest_recorded_at: result.clock.latest_recorded_at,
          behind_by_hours: result.clock.behind_by_hours,
        },
        reason: 'The system clock is earlier than the last recorded transaction (OPS-009)',
        shiftId: null,
      });

      backupRepository.insertEvent({
        id: ids.uuidv7(), kind: 'CLOCK_ANOMALY', occurred_at: now, ok: 0,
        detail: JSON.stringify(result.clock), actor_id: null,
      });
    }
  } catch (err) {
    result.clock = { anomaly: false, error: err.message };
  }

  try {
    result.backup = backupService.overdue({ now });
  } catch (err) {
    result.backup = { overdue: false, error: err.message };
  }

  try {
    backupRepository.insertEvent({
      id: ids.uuidv7(), kind: 'LAUNCH', occurred_at: now, ok: 1,
      detail: JSON.stringify({
        app_version: pkg.version,
        schema_version: result.schema_version,
        clock_anomaly: Boolean(result.clock.anomaly),
        backup_overdue: Boolean(result.backup.overdue),
      }),
      actor_id: null,
    });
  } catch { /* the launch happened whether or not it could be recorded */ }

  lastLaunch = result;
  return result;
}

function lastLaunchResult() {
  return lastLaunch;
}

/** For the tests, and for a restore that swaps the database underneath us. */
function reset() {
  lastLaunch = null;
}

// ── OPS-006 — the health panel ──────────────────────────────────────────────

/**
 * An integrity check of the **live** database, on demand.
 *
 * Separate from a backup's verification, which checks the copy. This one answers "is
 * the file we are trading on still sound", which is the question SCR-705 exists for,
 * and its result is recorded so the panel can report when it last ran.
 */
function integrityCheck({ actor = null, now = clock.nowUtc() } = {}) {
  const started = Date.now();
  const integrity = schemaRepository.integrityCheck();
  const foreignKeys = schemaRepository.foreignKeyCheck();
  const ok = integrity.ok && foreignKeys.length === 0;

  const detail = {
    integrity: integrity.ok ? 'ok' : integrity.results.join('; '),
    foreign_key_violations: foreignKeys.length,
    took_ms: Date.now() - started,
  };

  backupRepository.insertEvent({
    id: ids.uuidv7(), kind: 'INTEGRITY_CHECK', occurred_at: now, ok: ok ? 1 : 0,
    detail: JSON.stringify(detail), actor_id: actor ? actor.id : null,
  });

  return { ok, checked_at: now, ...detail };
}

function recordExport({ actor = null, what = null, now = clock.nowUtc() } = {}) {
  try {
    backupRepository.insertEvent({
      id: ids.uuidv7(), kind: 'EXPORT', occurred_at: now, ok: 1,
      detail: JSON.stringify({ what }), actor_id: actor ? actor.id : null,
    });
  } catch { /* the export happened; the note about it is not worth failing over */ }
}

module.exports = {
  CLOCK_SKEW_TOLERANCE_MS,
  checkClock, onLaunch, lastLaunchResult, reset,
  integrityCheck, recordExport,
};
