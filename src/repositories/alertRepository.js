'use strict';

// OPS-007 — the one thing about an alert that is stored.
//
// Alerts are derived. Low stock is a query over inventory, overdue credit a query over
// the ledger, cash variance a query over the closings. Storing them would mean a
// writer somewhere deciding when to raise and when to clear, and a row saying
// LOW_STOCK that stays true for six hours after the delivery arrived. So they are
// recomputed on every read, and what lives in this table is the single fact no query
// can derive: **that a person dismissed one, and when**.
//
// The undismissible three (OPS-007) are enforced by a CHECK on the table rather than
// by a guard in a service. A service check is a promise the next caller can break; a
// CHECK is one that no code path can.

const db = require('../config/database');

function tableExists() {
  return Boolean(db.get()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'alert_dismissals'")
    .get());
}

function insert(row) {
  const keys = Object.keys(row);
  db.get()
    .prepare(`INSERT INTO alert_dismissals (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`)
    .run(row);
  return row;
}

/** The keys dismissed since `sinceAt`, as a Set the alert list can test against. */
function dismissedKeys({ sinceAt }) {
  if (!tableExists()) return new Set();
  return new Set(db.get()
    .prepare('SELECT alert_key FROM alert_dismissals WHERE dismissed_at >= ?')
    .all(sinceAt)
    .map((row) => row.alert_key));
}

function findByKey(alertKey) {
  return db.get()
    .prepare('SELECT id, alert_key, kind, dismissed_at, dismissed_by FROM alert_dismissals WHERE alert_key = ?')
    .get(alertKey) || null;
}

/**
 * Forget a dismissal, so the alert comes back.
 *
 * Used when the dismissal window lapses. A delete is right here for the same reason it
 * was right for a cart: a dismissal is a person's gesture at a moment, not a ledger
 * entry, and nothing reconciles to it.
 */
function remove(alertKey) {
  return db.get().prepare('DELETE FROM alert_dismissals WHERE alert_key = ?').run(alertKey).changes;
}

function expire({ beforeAt }) {
  return db.get().prepare('DELETE FROM alert_dismissals WHERE dismissed_at < ?').run(beforeAt).changes;
}

module.exports = { tableExists, insert, dismissedKeys, findByKey, remove, expire };
