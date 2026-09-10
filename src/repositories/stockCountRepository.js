'use strict';

// Stock count sessions and their lines.
//
// The one method in this file worth reading before the rest is `snapshotLines`, which
// is INV-110 expressed as a single INSERT ... SELECT. It writes the expected quantity
// and the average cost of every product in scope in one statement, inside the
// transaction that opens the session, so there is no window in which a sale can land
// between two products being frozen — which would produce a count whose first half was
// measured against 09:00 and whose second half was measured against 09:04.
//
// There is no general update path. `setCounted` writes the three columns a counter
// touches, `setMovement` writes the one INV-111 fills in at posting, and the session's
// own transitions are named methods that write the columns of that transition and no
// others. A posted count is immutable: nothing here can change one.

const db = require('../config/database');

const SESSION_COLUMNS = `
  s.id, s.count_no, s.scope, s.category_id, s.status, s.notes,
  s.opened_at, s.opened_by, s.approved_at, s.approved_by, s.approval_waived,
  s.posted_at, s.posted_by, s.was_stale, s.stale_approved_by,
  s.cancelled_at, s.cancelled_by, s.cancel_reason,
  s.counted_products, s.varying_products, s.variance_value_centavos, s.created_at
`;

const JOINED = `
  ${SESSION_COLUMNS},
  c.name AS category_name,
  o.username AS opened_by_username,
  a.username AS approved_by_username,
  p.username AS posted_by_username,
  t.username AS stale_approved_by_username
`;

const FROM = `
  FROM stock_count_sessions s
  LEFT JOIN categories c ON c.id = s.category_id
  LEFT JOIN users o ON o.id = s.opened_by
  LEFT JOIN users a ON a.id = s.approved_by
  LEFT JOIN users p ON p.id = s.posted_by
  LEFT JOIN users t ON t.id = s.stale_approved_by
`;

/**
 * The line counts every list needs, as one correlated subquery apiece.
 *
 * `counted` and `varying` are computed rather than stored while a session is open,
 * because both change with every keystroke a counter makes; the same two figures are
 * written onto the session at posting, where they become the historical record.
 */
const LINE_TOTALS = `
  (SELECT COUNT(*) FROM stock_count_lines l WHERE l.session_id = s.id) AS line_count,
  (SELECT COUNT(*) FROM stock_count_lines l
    WHERE l.session_id = s.id AND l.counted_milli IS NOT NULL) AS counted_count,
  (SELECT COUNT(*) FROM stock_count_lines l
    WHERE l.session_id = s.id AND l.counted_milli IS NOT NULL
      AND l.counted_milli <> l.expected_milli) AS varying_count
`;

function insert(row) {
  const keys = Object.keys(row);
  db.get().prepare(`
    INSERT INTO stock_count_sessions (${keys.join(', ')})
    VALUES (${keys.map((k) => `@${k}`).join(', ')})
  `).run(row);
  return findById(row.id);
}

function findById(id) {
  return db.get().prepare(`SELECT ${JOINED}, ${LINE_TOTALS} ${FROM} WHERE s.id = ?`).get(id) || null;
}

function findByNo(countNo) {
  return db.get().prepare(`SELECT ${JOINED}, ${LINE_TOTALS} ${FROM} WHERE s.count_no = ?`).get(countNo) || null;
}

const SEARCH_WHERE = `
  WHERE (@status IS NULL OR s.status = @status)
    AND (@openOnly = 0 OR s.status IN ('OPEN','APPROVED'))
    AND (@categoryId IS NULL OR s.category_id = @categoryId)
    AND (@from IS NULL OR s.opened_at >= @from)
    AND (@to IS NULL OR s.opened_at <= @to)
`;

function search({
  status = null, openOnly = false, categoryId = null, from = null, to = null,
  limit = 50, offset = 0,
} = {}) {
  return db.get().prepare(`
    SELECT ${JOINED}, ${LINE_TOTALS}
    ${FROM}
    ${SEARCH_WHERE}
     ORDER BY s.opened_at DESC, s.id DESC
     LIMIT @limit OFFSET @offset
  `).all({ status, openOnly: openOnly ? 1 : 0, categoryId, from, to, limit, offset });
}

function countSearch({ status = null, openOnly = false, categoryId = null, from = null, to = null } = {}) {
  return db.get().prepare(`SELECT COUNT(*) AS n ${FROM} ${SEARCH_WHERE}`)
    .get({ status, openOnly: openOnly ? 1 : 0, categoryId, from, to }).n;
}

// ── INV-110 — the freeze ────────────────────────────────────────────────────

/**
 * Write one line per product in scope, with its expected quantity and average cost
 * frozen as at this instant.
 *
 * One statement, deliberately. Reading the products in JavaScript and inserting them
 * one at a time would leave a window between the first row and the last in which a
 * sale could commit, and the session would then hold two different ideas of "now" —
 * which is precisely the corruption INV-110 exists to prevent, reintroduced by the
 * code meant to implement it.
 *
 * Inactive products are included on purpose. INV-105 keeps their stock reportable, and
 * a shelf does not stop holding twelve sacks because somebody deactivated the product
 * — a stocktake that skipped them would leave that stock permanently unverifiable.
 */
function snapshotLines({ sessionId, categoryId = null, at, idFor }) {
  // Both reads happen before either write and inside the caller's transaction, so the
  // whole sheet is frozen at one instant (INV-110). A count whose first half was
  // measured at 09:00 and whose second half at 09:04 is the defect this shape exists
  // to prevent, and two SELECTs against one snapshot are still one instant.
  const products = db.get().prepare(`
    SELECT p.id AS product_id, p.name, p.avg_cost_centavos,
           COALESCE(i.qty_on_hand_milli, 0) AS qty_on_hand_milli
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id
     WHERE (@categoryId IS NULL OR p.category_id = @categoryId)
       AND p.is_batch_tracked = 0
     ORDER BY p.name COLLATE NOCASE
  `).all({ categoryId });

  /**
   * TASK-042: a batch-tracked product is counted one line per batch, because that is
   * what is printed on the box in the counter's hand.
   *
   * **Including batches holding nothing**, which is not an oversight: a batch the
   * system believes is exhausted is exactly the batch that turns up at the back of the
   * fridge, and a sheet that omitted it would have no line to write the discovery on.
   * The balance is the ledger's own sum (INV-201), so this is the same figure the
   * batch list shows, frozen.
   */
  const batches = db.get().prepare(`
    SELECT p.id AS product_id, p.name, b.id AS batch_id, b.batch_no,
           b.unit_cost_centavos,
           COALESCE(q.qty_milli, 0) AS qty_milli
      FROM product_batches b
      JOIN products p ON p.id = b.product_id
      LEFT JOIN (
        SELECT batch_id, SUM(qty_milli) AS qty_milli
          FROM inventory_movements
         WHERE batch_id IS NOT NULL
         GROUP BY batch_id
      ) q ON q.batch_id = b.id
     WHERE (@categoryId IS NULL OR p.category_id = @categoryId)
       AND p.is_batch_tracked = 1
     ORDER BY p.name COLLATE NOCASE, b.expiry_date, b.batch_no
  `).all({ categoryId });

  const insertLine = db.get().prepare(`
    INSERT INTO stock_count_lines
      (id, session_id, product_id, batch_id, product_name_snapshot, batch_no_snapshot,
       expected_milli, avg_cost_centavos, counted_milli, counted_at, counted_by, note, movement_id)
    VALUES (@id, @session_id, @product_id, @batch_id, @product_name_snapshot, @batch_no_snapshot,
            @expected_milli, @avg_cost_centavos, NULL, NULL, NULL, NULL, NULL)
  `);

  // Wrapped so every line is written under one BEGIN even when the caller has not
  // opened a transaction of its own. The service always has; this makes the guarantee
  // a property of the method rather than of its callers.
  const writeAll = db.get().transaction(() => {
    for (const row of products) {
      insertLine.run({
        id: idFor(),
        session_id: sessionId,
        product_id: row.product_id,
        batch_id: null,
        product_name_snapshot: row.name,
        batch_no_snapshot: null,
        expected_milli: row.qty_on_hand_milli,
        avg_cost_centavos: row.avg_cost_centavos,
      });
    }
    for (const row of batches) {
      insertLine.run({
        id: idFor(),
        session_id: sessionId,
        product_id: row.product_id,
        batch_id: row.batch_id,
        product_name_snapshot: row.name,
        batch_no_snapshot: row.batch_no,
        expected_milli: row.qty_milli,
        // MON-004: the batch's own cost, not the product's moving average. Valuing a
        // batch variance at the average would price the loss at stock the store still
        // has.
        avg_cost_centavos: row.unit_cost_centavos,
      });
    }
  });
  writeAll();

  return { lines: products.length + batches.length, batch_lines: batches.length, at };
}

// ── Lines ───────────────────────────────────────────────────────────────────

const LINE_COLUMNS = `
  l.id, l.session_id, l.product_id, l.batch_id, l.product_name_snapshot,
  l.batch_no_snapshot, l.expected_milli,
  l.avg_cost_centavos, l.counted_milli, l.counted_at, l.counted_by, l.note, l.movement_id
`;

function linesFor(sessionId, { limit = 1000, offset = 0, varyingOnly = false, uncountedOnly = false } = {}) {
  return db.get().prepare(`
    SELECT ${LINE_COLUMNS}, p.sku, u.code AS base_unit_code, cu.username AS counted_by_username,
           b.expiry_date
      FROM stock_count_lines l
      JOIN products p ON p.id = l.product_id
      JOIN units u ON u.id = p.base_unit_id
      LEFT JOIN users cu ON cu.id = l.counted_by
      LEFT JOIN product_batches b ON b.id = l.batch_id
     WHERE l.session_id = @sessionId
       AND (@varyingOnly = 0
            OR (l.counted_milli IS NOT NULL AND l.counted_milli <> l.expected_milli))
       AND (@uncountedOnly = 0 OR l.counted_milli IS NULL)
     -- A product's batch lines sit under their product, earliest expiry first — the
     -- order a counter works a shelf in, and FEFO's own order (INV-204).
     ORDER BY p.name COLLATE NOCASE, b.expiry_date, l.batch_no_snapshot
     LIMIT @limit OFFSET @offset
  `).all({
    sessionId, limit, offset,
    varyingOnly: varyingOnly ? 1 : 0,
    uncountedOnly: uncountedOnly ? 1 : 0,
  });
}

function countLines(sessionId, { varyingOnly = false, uncountedOnly = false } = {}) {
  return db.get().prepare(`
    SELECT COUNT(*) AS n FROM stock_count_lines l
     WHERE l.session_id = @sessionId
       AND (@varyingOnly = 0
            OR (l.counted_milli IS NOT NULL AND l.counted_milli <> l.expected_milli))
       AND (@uncountedOnly = 0 OR l.counted_milli IS NULL)
  `).get({
    sessionId,
    varyingOnly: varyingOnly ? 1 : 0,
    uncountedOnly: uncountedOnly ? 1 : 0,
  }).n;
}

/**
 * One line of a sheet, by the product it counts and — since TASK-042 — the batch.
 *
 * `batchId` of null means the product's own line, which is the only line a product
 * that is not batch-tracked has. `COALESCE` rather than `IS NULL` because SQLite
 * compares NULL to nothing, including to itself: `batch_id = NULL` matches no row and
 * would have made every non-batch line unfindable.
 */
function findLine(sessionId, productId, batchId = null) {
  return db.get().prepare(`
    SELECT ${LINE_COLUMNS} FROM stock_count_lines l
     WHERE l.session_id = ? AND l.product_id = ? AND COALESCE(l.batch_id, '') = COALESCE(?, '')
  `).get(sessionId, productId, batchId) || null;
}

/** By its own id, which is how a sheet with several lines per product addresses one. */
function findLineById(sessionId, lineId) {
  return db.get().prepare(`
    SELECT ${LINE_COLUMNS} FROM stock_count_lines l
     WHERE l.session_id = ? AND l.id = ?
  `).get(sessionId, lineId) || null;
}

/**
 * What a counter writes: the figure, who wrote it and when, and an optional note.
 *
 * `countedMilli` of `null` clears the entry rather than storing a zero — the two are
 * different answers and the schema keeps them apart, so the repository must too. A
 * counter who typed into the wrong row needs a way back to "not counted".
 */
function setCounted({ sessionId, lineId, countedMilli, countedAt, countedBy, note = null }) {
  // By line id since TASK-042: a batch-tracked product has one line per batch, and an
  // update keyed on the product would have written the same figure onto all of them.
  db.get().prepare(`
    UPDATE stock_count_lines
       SET counted_milli = @countedMilli,
           counted_at = @countedAt,
           counted_by = @countedBy,
           note = @note
     WHERE session_id = @sessionId AND id = @lineId
  `).run({
    sessionId,
    lineId,
    countedMilli: countedMilli === null || countedMilli === undefined ? null : countedMilli,
    countedAt: countedMilli === null || countedMilli === undefined ? null : countedAt,
    countedBy: countedMilli === null || countedMilli === undefined ? null : countedBy,
    note,
  });
  return findLineById(sessionId, lineId);
}

/** INV-111's movement, written onto the line that produced it. */
function setMovement(lineId, movementId) {
  db.get().prepare('UPDATE stock_count_lines SET movement_id = ? WHERE id = ?').run(movementId, lineId);
}

// ── The session's own transitions ───────────────────────────────────────────
//
// One method per transition, each writing that transition's columns and nothing else.
// A general `updateFields` here would be a way to mark a session posted without the
// movements, which is the one state this table must never hold.

function approve(sessionId, { approvedAt, approvedBy, waived }) {
  db.get().prepare(`
    UPDATE stock_count_sessions
       SET status = 'APPROVED', approved_at = ?, approved_by = ?, approval_waived = ?
     WHERE id = ? AND status = 'OPEN'
  `).run(approvedAt, approvedBy, waived ? 1 : 0, sessionId);
  return findById(sessionId);
}

function post(sessionId, {
  postedAt, postedBy, wasStale, staleApprovedBy = null,
  countedProducts, varyingProducts, varianceValueCentavos,
}) {
  db.get().prepare(`
    UPDATE stock_count_sessions
       SET status = 'POSTED', posted_at = @postedAt, posted_by = @postedBy,
           was_stale = @wasStale, stale_approved_by = @staleApprovedBy,
           counted_products = @countedProducts, varying_products = @varyingProducts,
           variance_value_centavos = @varianceValueCentavos
     WHERE id = @sessionId AND status = 'APPROVED'
  `).run({
    sessionId,
    postedAt,
    postedBy,
    wasStale: wasStale ? 1 : 0,
    staleApprovedBy,
    countedProducts,
    varyingProducts,
    varianceValueCentavos,
  });
  return findById(sessionId);
}

function cancel(sessionId, { cancelledAt, cancelledBy, reason }) {
  db.get().prepare(`
    UPDATE stock_count_sessions
       SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?
     WHERE id = ? AND status IN ('OPEN','APPROVED')
  `).run(cancelledAt, cancelledBy, reason, sessionId);
  return findById(sessionId);
}

/** Whether this product is already being counted somewhere unposted (INV-110). */
function openSessionsForProduct(productId) {
  return db.get().prepare(`
    SELECT s.id, s.count_no, s.status
      FROM stock_count_lines l
      JOIN stock_count_sessions s ON s.id = l.session_id
     WHERE l.product_id = ? AND s.status IN ('OPEN','APPROVED')
     ORDER BY s.opened_at
  `).all(productId);
}

/** The variance a posted session found, for the report and for a test to sum. */
function varianceTotals(sessionId) {
  return db.get().prepare(`
    SELECT COUNT(*) AS varying_products,
           COALESCE(SUM(l.counted_milli - l.expected_milli), 0) AS variance_milli,
           COALESCE(SUM(
             CASE WHEN l.counted_milli >= l.expected_milli THEN 1 ELSE 0 END
           ), 0) AS surplus_products
      FROM stock_count_lines l
     WHERE l.session_id = ?
       AND l.counted_milli IS NOT NULL
       AND l.counted_milli <> l.expected_milli
  `).get(sessionId);
}

module.exports = {
  insert, findById, findByNo, search, countSearch,
  snapshotLines, linesFor, countLines, findLine, findLineById, setCounted, setMovement,
  approve, post, cancel, openSessionsForProduct, varianceTotals,
};
