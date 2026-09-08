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
// ## Sources, and the two that are not built yet
//
// Each alert is produced by a source function. TASK-017 owns the backup log and the
// OPS-009 clock check, so `BACKUP_OVERDUE`, `BACKUP_UNVERIFIED` and `CLOCK_ANOMALY`
// read through seams that return nothing until it lands. That is the same shape
// drawerService and documentService used before TASK-014 filled them: the dashboard
// gets its alerts the day the source exists, with no edit to this file or to the
// screen. A source that throws is caught and reported as its own alert rather than
// taking the dashboard down with it — a store whose dashboard is blank because one
// count failed has lost more than the count.

const clock = require('../config/clock');
const settingsService = require('./settingsService');
const inventoryService = require('./inventoryService');
const creditService = require('./creditService');
const shiftService = require('./shiftService');
const shiftRepository = require('../repositories/shiftRepository');

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

/** OPS-002, OPS-009 — through TASK-017's seam, silent until it exists. */
function healthAlerts({ now }) {
  if (!provider) return [];
  const rows = provider.alerts ? provider.alerts({ now }) : [];
  return rows.map((row) => alert(row.kind, row.severity, row.rule_id, row.message, row.extra || {}));
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
function list({ now = clock.nowUtc() } = {}) {
  const alerts = [];

  for (const [name, source] of SOURCES) {
    try {
      alerts.push(...source({ now }));
    } catch (err) {
      alerts.push(alert(
        'ALERT_SOURCE_FAILED', 'CRITICAL', 'OPS-007',
        `The ${name} check could not run: ${err.message} Treat this screen as incomplete.`
      ));
    }
  }

  return {
    as_of: now,
    as_of_manila: clock.toManila(now),
    alerts: alerts.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]),
    health_source_installed: installed(),
  };
}

module.exports = {
  UNDISMISSIBLE, SEVERITIES,
  install, installed, list,
  // Named so the tests can drive one source at a time.
  lowStockAlerts, creditAlerts, shiftAlerts, varianceAlerts, healthAlerts,
};
