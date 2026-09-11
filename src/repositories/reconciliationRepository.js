'use strict';

// Saved payment reconciliations (TASK-032, RPT-105).
//
// Its own file rather than a corner of `reportRepository`, which reads and writes
// nothing: every other query in there derives a figure from sales, and this table is
// the one place in the reporting path that holds a human's answer. Mixing them would
// put an INSERT into a file whose whole discipline is that it has none.
//
// **There is no update and no delete.** A reconciliation is a record of what somebody
// was shown and what they concluded; correcting one means reconciling the range again,
// which is a second row and a second reason. The absence is the rule, as it is for
// movements (INV-102) and audit rows (AUD-605).

const db = require('../config/database');

const COLUMNS = `
  r.id, r.from_date, r.to_date, r.method,
  r.recorded_centavos, r.recorded_count, r.actual_centavos, r.variance_centavos,
  r.reference, r.reason, r.created_at, r.created_by
`;

function insert(row) {
  db.get().prepare(`
    INSERT INTO payment_reconciliations
      (id, from_date, to_date, method, recorded_centavos, recorded_count,
       actual_centavos, variance_centavos, reference, reason, created_at, created_by)
    VALUES
      (@id, @from_date, @to_date, @method, @recorded_centavos, @recorded_count,
       @actual_centavos, @variance_centavos, @reference, @reason, @created_at, @created_by)
  `).run(row);
  return findById(row.id);
}

function findById(id) {
  return db.get().prepare(`
    SELECT ${COLUMNS}, u.username AS created_by_username
      FROM payment_reconciliations r
      LEFT JOIN users u ON u.id = r.created_by
     WHERE r.id = ?
  `).get(id) || null;
}

/**
 * Reconciliations of one method whose range intersects the one being asked about.
 *
 * Two reconciliations of one week with different answers is the state requirement 7
 * exists to prevent, and dates as `YYYY-MM-DD` strings compare correctly for it —
 * the overlap test is the ordinary one: **starts before the other ends, and ends after
 * the other starts.**
 */
function overlapping({ method, fromDate, toDate }) {
  return db.get().prepare(`
    SELECT ${COLUMNS}, u.username AS created_by_username
      FROM payment_reconciliations r
      LEFT JOIN users u ON u.id = r.created_by
     WHERE r.method = @method
       AND r.from_date <= @toDate
       AND r.to_date >= @fromDate
     ORDER BY r.from_date
  `).all({ method, fromDate, toDate });
}

/** The history a screen shows, newest first: where the last one left off. */
function list({ method = null, limit = 50, offset = 0 } = {}) {
  return db.get().prepare(`
    SELECT ${COLUMNS}, u.username AS created_by_username
      FROM payment_reconciliations r
      LEFT JOIN users u ON u.id = r.created_by
     WHERE (@method IS NULL OR r.method = @method)
     ORDER BY r.to_date DESC, r.created_at DESC
     LIMIT @limit OFFSET @offset
  `).all({ method, limit, offset });
}

/** The day after the last reconciled one, so the next range starts where it should. */
function lastReconciledTo(method) {
  const row = db.get().prepare(`
    SELECT MAX(to_date) AS to_date FROM payment_reconciliations WHERE method = ?
  `).get(method);
  return row && row.to_date ? row.to_date : null;
}

module.exports = { insert, findById, overlapping, list, lastReconciledTo };
