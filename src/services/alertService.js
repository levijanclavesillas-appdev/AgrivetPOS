'use strict';

// OPS-007 — the alert list that sits above the dashboard tiles.
//
// Eight alerts are named for v1.0: low stock, overdue credit, credit limit reached,
// backup overdue, unverified backup, shift open too long, cash variance beyond
// tolerance, and clock anomaly. Near-expiry is v1.2 and is deliberately absent —
// legacy/PRD_v1.1.md promised visibility that no v1.0 report produces, and building it
// quietly here is how a version boundary stops meaning anything.
//
// **Two of the eight are not dismissible**: backup overdue and clock anomaly. The rest
// are per-session dismissals held by the renderer, because a low-stock warning a
// cashier has read and acted on should not follow them all afternoon. A backup that
// has not run is different in kind: dismissing it does not make the day any safer, and
// the person who dismisses it is rarely the person who loses the data.
//
// ## Sources
//
// Each alert is produced by a source function, and the list is one service so SCR-601
// and the shell's top bar cannot disagree (TASK-017 requirement 11). A source that
// throws is caught and reported as its own alert rather than taking the dashboard down
// with it — a store whose dashboard is blank because one count failed has lost more
// than the count.
//
// TASK-016 left `BACKUP_OVERDUE`, `BACKUP_UNVERIFIED` and `CLOCK_ANOMALY` behind a
// seam, because the backup log and the OPS-009 check did not exist yet. TASK-017 fills
// them in below, and the seam stays: `install()` still overrides the source, which is
// what the tests use to drive a clock anomaly without setting the machine's clock.
//
// ## Dismissal
//
// Alerts are **derived** — recomputed on every read, never stored — so a dismissal is
// the only part that persists. It is keyed on the alert's identity (kind plus what
// makes this instance different from the next), so dismissing "this shift has been
// open too long" does not dismiss tomorrow's, and it lapses after a window so that a
// dismissed alert comes back if the condition does not go away.

const clock = require('../config/clock');
const ids = require('../config/ids');
const errors = require('./errors');
const settingsService = require('./settingsService');
const inventoryService = require('./inventoryService');
const creditService = require('./creditService');
const shiftService = require('./shiftService');
const backupService = require('./backupService');
const systemService = require('./systemService');
const shiftRepository = require('../repositories/shiftRepository');
const alertRepository = require('../repositories/alertRepository');

/** Alerts that no one may dismiss, and why (OPS-007). */
const UNDISMISSIBLE = Object.freeze(['BACKUP_OVERDUE', 'BACKUP_UNVERIFIED', 'CLOCK_ANOMALY']);

const SEVERITIES = Object.freeze(['CRITICAL', 'WARNING', 'INFO']);
const ORDER = Object.freeze({ CRITICAL: 0, WARNING: 1, INFO: 2 });

/**
 * TASK-017's seam.
 *
 * `install()` hands over a provider that answers the two questions this task cannot:
 * when the last verified backup ran, and whether the clock has moved backwards past
 * the last recorded transaction (OPS-009). Until then `provider` is null and the three
 * alerts simply do not appear — which is honest, because nothing is checking.
 */
let provider = null;

function install(healthProvider) {
  provider = healthProvider || null;
}

function installed() {
  return provider !== null;
}

const alert = (kind, severity, ruleId, message, extra = {}) => ({
  kind,
  severity,
  rule_id: ruleId,
  message,
  dismissible: !UNDISMISSIBLE.includes(kind),
  ...extra,
});

// ── The sources ─────────────────────────────────────────────────────────────

/** INV-109's count, as one line rather than a list — the tile links to the list. */
function lowStockAlerts() {
  const { total } = inventoryService.lowStock({ limit: 1 });
  if (total === 0) return [];

  return [alert(
    'LOW_STOCK', 'WARNING', 'INV-109',
    `${total} product${total === 1 ? ' is' : 's are'} at or below the reorder point.`,
    { count: total }
  )];
}

/**
 * CR-107's overdue accounts, and CR-104's accounts at their limit.
 *
 * Both read one pass of `outstanding()`, which is also what the dashboard's credit
 * tiles use. Two passes would be two chances to disagree.
 */
function creditAlerts({ now }) {
  const { accounts } = creditService.outstanding({ now });

  const overdue = accounts.filter((a) => a.ageing_status === 'OVERDUE');
  const atLimit = accounts.filter((a) => a.available_centavos <= 0 && a.credit_limit_centavos > 0);
  const out = [];

  if (overdue.length > 0) {
    const worst = overdue.reduce((a, b) => (a.days_overdue > b.days_overdue ? a : b));
    out.push(alert(
      'CREDIT_OVERDUE', 'WARNING', 'CR-107',
      `${overdue.length} account${overdue.length === 1 ? ' is' : 's are'} overdue — the oldest by `
      + `${worst.days_overdue} day${worst.days_overdue === 1 ? '' : 's'} (${worst.customer_name}).`,
      { count: overdue.length }
    ));
  }

  if (atLimit.length > 0) {
    out.push(alert(
      'CREDIT_LIMIT_REACHED', 'WARNING', 'CR-104',
      `${atLimit.length} account${atLimit.length === 1 ? ' has' : 's have'} reached the credit limit `
      + 'and cannot buy on credit without an override.',
      { count: atLimit.length }
    ));
  }

  return out;
}

/** POS-508, already computed by shiftService — read, not re-derived. */
function shiftAlerts({ now }) {
  return shiftService.alerts({ now }).map((row) => alert(
    row.kind, row.severity, row.rule_id, row.message, { shift_id: row.shift_id }
  ));
}

/**
 * POS-511 — a close whose variance was beyond tolerance.
 *
 * The window is a setting rather than a constant (OPS-005): a ₱300 shortage is noticed
 * the morning after at the earliest, so how long the alert keeps nagging is a store's
 * policy, not this file's.
 */
function varianceAlerts({ now }) {
  const tolerance = settingsService.get('cash_variance_tolerance_centavos');
  const windowDays = settingsService.get('variance_alert_window_days');
  const since = new Date(Date.parse(now) - windowDays * 86400000).toISOString();
  const rows = shiftRepository.closingsOverTolerance({ toleranceCentavos: tolerance, sinceAt: since });
  if (rows.length === 0) return [];

  return rows.slice(0, 5).map((row) => alert(
    'CASH_VARIANCE', row.variance_centavos < 0 ? 'CRITICAL' : 'WARNING', 'POS-511',
    `${row.closed_by_name || row.closed_by_username} closed ${clock.toManila(row.closed_at)} `
    + `${row.variance_centavos < 0 ? 'short' : 'over'} by `
    + `₱${(Math.abs(row.variance_centavos) / 100).toFixed(2)}`
    + `${row.variance_reason ? ` — "${row.variance_reason}"` : ''}.`,
    { shift_id: row.shift_id, variance_centavos: row.variance_centavos }
  ));
}

/**
 * OPS-002, OPS-003, OPS-009 — backup freshness and the clock.
 *
 * `install()` overrides this entirely, which is how a test drives a clock anomaly
 * without touching the machine's clock. With nothing installed the real checks run.
 */
function healthAlerts({ now }) {
  if (provider) {
    const rows = provider.alerts ? provider.alerts({ now }) : [];
    return rows.map((row) => alert(row.kind, row.severity, row.rule_id, row.message, row.extra || {}));
  }

  const out = [];

  // FR_7.3 / OPS-007: no verified backup inside the configured period. Never
  // dismissible — dismissing it does not make the day any safer, and the person who
  // dismisses it is rarely the person who loses the data.
  const backup = backupService.overdue({ now });
  if (backup.overdue) {
    out.push(alert('BACKUP_OVERDUE', 'CRITICAL', 'OPS-007', backup.message, {
      last_verified_at: backup.last_verified_at,
      hours_since: backup.hours_since,
    }));
  }

  // OPS-002: a backup was written and did not verify. Distinct from overdue — there
  // may well be an older good one — and distinct in what it means: the folder, the
  // disk or the stick is failing, and the next backup will probably fail too.
  const failed = lastFailedBackup();
  if (failed) {
    out.push(alert('BACKUP_UNVERIFIED', 'CRITICAL', 'OPS-002',
      `The backup attempted ${clock.toManila(failed.taken_at)} did not succeed: `
      + `${failed.error || 'no reason was recorded'} Nothing has been backed up since. `
      + 'Check the backup folder and the drive it is on.',
      { file_name: failed.file_name, taken_at: failed.taken_at }));
  }

  // OPS-009. Selling continues — the sale sequence does not depend on the clock
  // (VR-103) — so this is an alert and never a block.
  const clockState = systemService.checkClock({ now });
  if (clockState.anomaly) {
    out.push(alert('CLOCK_ANOMALY', 'CRITICAL', 'OPS-009',
      `This machine's clock reads ${clockState.now_manila}, which is `
      + `${clockState.behind_by_hours} hours earlier than the last recorded transaction `
      + `(${clockState.latest_recorded_at_manila}). Selling is unaffected — receipt numbers do `
      + 'not come from the clock — but dates on new records will be wrong until it is fixed.',
      { behind_by_hours: clockState.behind_by_hours }));
  }

  return out;
}

/**
 * The most recent failed backup, if it is the most recent backup.
 *
 * Only if it is the newest: a failure a fortnight ago followed by ten good backups is
 * history, not a live condition, and an alert that keeps mentioning it is one people
 * learn to scroll past.
 */
function lastFailedBackup() {
  const recent = backupService.list({ limit: 1 }).backups[0];
  return recent && recent.verification_result === 'FAILED' ? recent : null;
}

const SOURCES = Object.freeze([
  ['low stock', lowStockAlerts],
  ['credit', creditAlerts],
  ['shifts', shiftAlerts],
  ['cash variance', varianceAlerts],
  ['backup and clock', healthAlerts],
]);

/**
 * Every alert that applies right now, most serious first.
 *
 * A source that throws becomes an alert about itself. The alternative is a dashboard
 * that renders blank or, worse, renders a short list that looks complete.
 */
function list({ now = clock.nowUtc(), includeDismissed = false } = {}) {
  const raised = [];

  for (const [name, source] of SOURCES) {
    try {
      raised.push(...source({ now }));
    } catch (err) {
      raised.push(alert(
        'ALERT_SOURCE_FAILED', 'CRITICAL', 'OPS-007',
        `The ${name} check could not run: ${err.message} Treat this screen as incomplete.`
      ));
    }
  }

  const dismissed = dismissedKeys({ now });
  const withKeys = raised.map((a) => ({ ...a, key: keyFor(a) }));
  const showing = includeDismissed
    ? withKeys.map((a) => ({ ...a, dismissed: dismissed.has(a.key) }))
    : withKeys.filter((a) => !dismissed.has(a.key));

  return {
    as_of: now,
    as_of_manila: clock.toManila(now),
    alerts: showing.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]),
    dismissed_count: withKeys.length - showing.filter((a) => !a.dismissed).length,
    health_source_installed: installed(),
  };
}

/**
 * What makes one instance of an alert different from the next.
 *
 * Deliberately not the message: wording changes with the figures in it, and a key
 * built from the message would un-dismiss itself the moment a customer's balance
 * moved by a peso.
 */
function keyFor(a) {
  return [a.kind, a.shift_id || a.file_name || ''].filter(Boolean).join(':');
}

function dismissedKeys({ now }) {
  if (!alertRepository.tableExists()) return new Set();
  const windowDays = settingsService.get('alert_dismissal_window_days');
  const since = new Date(Date.parse(now) - windowDays * 86400000).toISOString();
  return alertRepository.dismissedKeys({ sinceAt: since });
}

/**
 * Dismiss one alert, for this store, until the window lapses.
 *
 * The undismissible three are refused by a CHECK on the table, so this validation is
 * the message rather than the control — the constraint would refuse the insert even if
 * this check were deleted.
 */
function dismiss(alertKey, actor, { now = clock.nowUtc() } = {}) {
  const kind = String(alertKey || '').split(':')[0];

  if (UNDISMISSIBLE.includes(kind)) {
    throw errors.forbidden(
      'This alert cannot be dismissed. It is about whether the store\u2019s data is safe, and '
      + 'hiding it would not make it any safer.',
      { ruleId: 'OPS-007' }
    );
  }
  if (!kind) throw errors.badRequest('Which alert?', { ruleId: 'OPS-007' });

  const existing = alertRepository.findByKey(alertKey);
  if (existing) return { dismissed: true, already: true, alert_key: alertKey };

  alertRepository.insert({
    id: ids.uuidv7(),
    alert_key: alertKey,
    kind,
    dismissed_at: now,
    dismissed_by: actor.id,
  });

  return { dismissed: true, already: false, alert_key: alertKey };
}

function undismiss(alertKey) {
  return { restored: alertRepository.remove(alertKey) > 0, alert_key: alertKey };
}

module.exports = {
  UNDISMISSIBLE, SEVERITIES,
  install, installed, list, dismiss, undismiss, keyFor,
  // Named so the tests can drive one source at a time.
  lowStockAlerts, creditAlerts, shiftAlerts, varianceAlerts, healthAlerts, lastFailedBackup,
};
