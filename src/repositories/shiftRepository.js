'use strict';

// Cashier shifts and till movements (POS-501–POS-509).
//
// Written against migration 005. `tableExists` survives from when TASK-003 needed one
// read before the table existed: SEC-2 permits a PIN unlock only while the user has an
// open shift, and before 005 the honest answer to "does this user have an open shift"
// was no, not an error. It stays because migrate.js applies migrations in order and
// nothing here should assume it has already run.

const db = require('../config/database');

const SHIFT_COLUMNS = 'id, user_id, opened_at, opening_float_centavos, closed_at, status';

const TILL_COLUMNS = `
  id, shift_id, direction, amount_centavos, reason, notes, occurred_at, created_by
`;

function tableExists(name = 'cashier_shifts') {
  const row = db.get()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return Boolean(row);
}

// ── Shifts (POS-502) ────────────────────────────────────────────────────────

/** The user's open shift, or null. Null before the shifts table exists (POS-502). */
function findOpenForUser(userId) {
  if (!tableExists()) return null;
  return db.get()
    .prepare(`SELECT ${SHIFT_COLUMNS} FROM cashier_shifts WHERE user_id = ? AND status = 'OPEN'`)
    .get(userId) || null;
}

function findById(id) {
  if (!tableExists()) return null;
  return db.get().prepare(`SELECT ${SHIFT_COLUMNS} FROM cashier_shifts WHERE id = ?`).get(id) || null;
}

function insert(row) {
  db.get().prepare(`
    INSERT INTO cashier_shifts (id, user_id, opened_at, opening_float_centavos, status)
    VALUES (@id, @user_id, @opened_at, @opening_float_centavos, @status)
  `).run(row);
  return findById(row.id);
}

/**
 * The only write to a shift after it opens, and TASK-013 owns it.
 *
 * POS-511 makes a closed shift immutable, so this exists to close one and for nothing
 * else — there is no path here that reopens a shift or edits its float.
 */
function close(id, { closedAt }) {
  db.get()
    .prepare("UPDATE cashier_shifts SET status = 'CLOSED', closed_at = ? WHERE id = ? AND status = 'OPEN'")
    .run(closedAt, id);
  return findById(id);
}

function openShifts() {
  if (!tableExists()) return [];
  return db.get().prepare(`
    SELECT s.${SHIFT_COLUMNS.split(', ').join(', s.')}, u.username, u.full_name
      FROM cashier_shifts s
      JOIN users u ON u.id = s.user_id
     WHERE s.status = 'OPEN'
     ORDER BY s.opened_at
  `).all();
}

function listForUser(userId, { limit = 50, offset = 0 } = {}) {
  return db.get().prepare(`
    SELECT ${SHIFT_COLUMNS} FROM cashier_shifts
     WHERE user_id = ? ORDER BY opened_at DESC LIMIT ? OFFSET ?
  `).all(userId, limit, offset);
}

// ── Till movements (POS-504–POS-506) ────────────────────────────────────────

function insertTillMovement(row) {
  db.get().prepare(`
    INSERT INTO till_movements (${TILL_COLUMNS})
    VALUES (@id, @shift_id, @direction, @amount_centavos, @reason, @notes, @occurred_at, @created_by)
  `).run(row);
  return row;
}

function tillMovementsFor(shiftId) {
  return db.get().prepare(`
    SELECT t.${TILL_COLUMNS.trim().split(/,\s*/).join(', t.')}, u.username AS created_by_username
      FROM till_movements t
      LEFT JOIN users u ON u.id = t.created_by
     WHERE t.shift_id = ?
     ORDER BY t.occurred_at, t.id
  `).all(shiftId);
}

/** Cash in and cash out for one shift, as two figures (POS-509's terms 4 and 5). */
function tillTotals(shiftId) {
  const row = db.get().prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN direction = 'IN'  THEN amount_centavos ELSE 0 END), 0) AS cash_in,
      COALESCE(SUM(CASE WHEN direction = 'OUT' THEN amount_centavos ELSE 0 END), 0) AS cash_out
      FROM till_movements WHERE shift_id = ?
  `).get(shiftId);
  return { cashInCentavos: row.cash_in, cashOutCentavos: row.cash_out };
}

// ── The other sources POS-509 sums ──────────────────────────────────────────

/**
 * Cash and non-cash taken as credit collections during this shift (POS-509's term 3,
 * and CR-205: a cash collection is till cash).
 *
 * Grouped by method so the closing report has a per-method expected figure for
 * GCash and QR Ph as well as for cash.
 */
function collectionTotalsByMethod(shiftId) {
  if (!tableExists('customer_credit_transactions')) return {};
  const rows = db.get().prepare(`
    SELECT COALESCE(method, 'CASH') AS method,
           COALESCE(SUM(-amount_centavos), 0) AS total
      FROM customer_credit_transactions
     WHERE shift_id = ? AND txn_type = 'COLLECTION'
     GROUP BY COALESCE(method, 'CASH')
  `).all(shiftId);

  return Object.fromEntries(rows.map((r) => [r.method, r.total]));
}

/**
 * Tenders taken on sales during this shift, by method (POS-509's term 2 and the
 * per-method non-cash totals).
 *
 * `sale_tenders` arrives with TASK-011's migration 006. Before it exists there are no
 * sales, so there are no tenders — which is a true answer at schema version 5, not an
 * assumption. The moment the table exists this starts counting, with no edit here.
 */
function tenderTotalsByMethod(shiftId) {
  if (!tableExists('sale_tenders')) return {};
  const rows = db.get().prepare(`
    SELECT t.method AS method, COALESCE(SUM(t.amount_centavos), 0) AS total
      FROM sale_tenders t
      JOIN sales s ON s.id = t.sale_id
     WHERE s.shift_id = ? AND s.status <> 'VOIDED'
     GROUP BY t.method
  `).all(shiftId);

  return Object.fromEntries(rows.map((r) => [r.method, r.total]));
}

/**
 * Cash paid back out on returns during this shift (POS-509's term 6).
 *
 * Returns are v1.1 (TASK-020). Zero until then, for the same reason as above.
 */
function refundTotalCentavos(shiftId) {
  if (!tableExists('sale_returns')) return 0;
  return db.get().prepare(`
    SELECT COALESCE(SUM(refund_cash_centavos), 0) AS n
      FROM sale_returns WHERE shift_id = ?
  `).get(shiftId).n;
}

/** Change given from the drawer, which is cash out of it (MON-007). */
function changeGivenCentavos(shiftId) {
  if (!tableExists('sales')) return 0;
  return db.get().prepare(`
    SELECT COALESCE(SUM(change_centavos), 0) AS n
      FROM sales WHERE shift_id = ? AND status <> 'VOIDED'
  `).get(shiftId).n;
}

// ── Closings (POS-509–POS-511) ──────────────────────────────────────────────

const CLOSING_COLUMNS = `
  id, shift_id, expected_cash_centavos, actual_cash_centavos, variance_centavos,
  variance_reason, closed_at, closed_by
`;

function insertClosing(row) {
  db.get().prepare(`
    INSERT INTO cashier_closings (${CLOSING_COLUMNS})
    VALUES (@id, @shift_id, @expected_cash_centavos, @actual_cash_centavos, @variance_centavos,
            @variance_reason, @closed_at, @closed_by)
  `).run(row);
  return row;
}

function insertClosingLine(row) {
  db.get().prepare(`
    INSERT INTO closing_method_lines
      (id, closing_id, method, expected_centavos, actual_centavos, variance_centavos)
    VALUES (@id, @closing_id, @method, @expected_centavos, @actual_centavos, @variance_centavos)
  `).run(row);
  return row;
}

function findClosingByShift(shiftId) {
  if (!tableExists('cashier_closings')) return null;
  return db.get()
    .prepare(`SELECT ${CLOSING_COLUMNS} FROM cashier_closings WHERE shift_id = ?`)
    .get(shiftId) || null;
}

function closingLinesFor(closingId) {
  return db.get().prepare(`
    SELECT id, closing_id, method, expected_centavos, actual_centavos, variance_centavos
      FROM closing_method_lines WHERE closing_id = ? ORDER BY method
  `).all(closingId);
}

/**
 * Closings whose variance is beyond tolerance, newest first — OPS-007's cash-variance
 * alert.
 *
 * The tolerance is passed in rather than read here: a repository that reads a setting
 * is a repository that has an opinion, and §8.2 keeps opinions in services.
 */
function closingsOverTolerance({ toleranceCentavos, sinceAt, limit = 20 }) {
  return db.get().prepare(`
    SELECT c.id, c.shift_id, c.variance_centavos, c.variance_reason, c.closed_at,
           u.username AS closed_by_username, u.full_name AS closed_by_name
    FROM cashier_closings c
    JOIN users u ON u.id = c.closed_by
    WHERE ABS(c.variance_centavos) > @toleranceCentavos
      AND c.closed_at >= @sinceAt
    ORDER BY c.closed_at DESC
    LIMIT @limit
  `).all({ toleranceCentavos, sinceAt, limit });
}

module.exports = {
  tableExists, findOpenForUser, findById, insert, close, openShifts, listForUser,
  insertClosing, insertClosingLine, findClosingByShift, closingLinesFor, closingsOverTolerance,
  insertTillMovement, tillMovementsFor, tillTotals,
  collectionTotalsByMethod, tenderTotalsByMethod, refundTotalCentavos, changeGivenCentavos,
};
