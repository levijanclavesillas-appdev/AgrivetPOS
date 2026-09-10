'use strict';

// Batches, their derived quantities, and the FEFO read (TASK-029).
//
// The method worth reading before the rest is `withQuantities`, which is INV-201
// expressed as a join rather than as a column. A batch has no stored quantity: its
// balance is SUM(inventory_movements.qty_milli) for that batch, which is the same sum
// INV-101 derives per product, grouped one column finer. That is what makes "the sum
// of batch quantities equals the product on-hand figure" true by construction instead
// of true until something forgets to maintain it.
//
// There is no `update` path for a quantity here, because there is no quantity here to
// update. Stock moves by writing a movement, exactly as it did before this file.

const db = require('../config/database');

const COLUMNS = `
  b.id, b.product_id, b.batch_no, b.supplier_id, b.expiry_date, b.received_date,
  b.unit_cost_centavos, b.gr_item_id, b.notes, b.is_active,
  b.created_at, b.created_by, b.updated_at, b.updated_by
`;

const JOINED = `
  ${COLUMNS},
  s.name AS supplier_name,
  p.name AS product_name,
  p.sku  AS product_sku,
  -- UOM-005: a quantity is never displayed without its unit, so every batch read
  -- carries the product's base unit rather than making each caller fetch it.
  u.code AS base_unit_code
`;

const FROM = `
  FROM product_batches b
  JOIN suppliers s ON s.id = b.supplier_id
  JOIN products  p ON p.id = b.product_id
  JOIN units     u ON u.id = p.base_unit_id
`;

// INV-201. LEFT JOIN, not JOIN: a batch created by a receipt whose movement has not
// been written yet — or one whose stock has moved back to exactly zero — is still a
// batch, and dropping it here would make it invisible to a recall.
const QTY = `
  LEFT JOIN (
    SELECT batch_id, SUM(qty_milli) AS qty_milli
      FROM inventory_movements
     WHERE batch_id IS NOT NULL
     GROUP BY batch_id
  ) q ON q.batch_id = b.id
`;

function insert(row) {
  db.get().prepare(`
    INSERT INTO product_batches
      (id, product_id, batch_no, supplier_id, expiry_date, received_date,
       unit_cost_centavos, gr_item_id, notes, is_active, created_at, created_by)
    VALUES
      (@id, @product_id, @batch_no, @supplier_id, @expiry_date, @received_date,
       @unit_cost_centavos, @gr_item_id, @notes, 1, @created_at, @created_by)
  `).run(row);
  return findById(row.id);
}

function findById(id) {
  return db.get().prepare(`SELECT ${JOINED} ${FROM} WHERE b.id = ?`).get(id) || null;
}

function findByNo(productId, batchNo) {
  return db.get().prepare(
    `SELECT ${JOINED} ${FROM} WHERE b.product_id = ? AND b.batch_no = ?`
  ).get(productId, batchNo) || null;
}

/** One batch with its derived balance (INV-201). */
function withQuantity(id) {
  return db.get().prepare(`
    SELECT ${JOINED}, COALESCE(q.qty_milli, 0) AS qty_milli
    ${FROM} ${QTY}
     WHERE b.id = ?
  `).get(id) || null;
}

/**
 * Every batch of one product, with its balance, earliest expiry first.
 *
 * `includeEmpty` is false for the screens — a shop does not want to scroll past two
 * years of exhausted batches to find the three on the shelf — and true for a recall,
 * which is asking about stock that has already gone.
 */
function forProduct(productId, { includeEmpty = false } = {}) {
  return db.get().prepare(`
    SELECT ${JOINED}, COALESCE(q.qty_milli, 0) AS qty_milli
    ${FROM} ${QTY}
     WHERE b.product_id = @productId
       AND (@includeEmpty = 1 OR COALESCE(q.qty_milli, 0) > 0)
     ORDER BY b.expiry_date, b.batch_no
  `).all({ productId, includeEmpty: includeEmpty ? 1 : 0 });
}

/**
 * INV-204's read, and the reason idx_batches_fefo exists.
 *
 * Earliest expiry first, only batches with stock, and **expired batches are excluded
 * here rather than filtered by the caller** — INV-205 says an expired batch may not be
 * sold, so the allocator must not be able to see one by accident. `asOfDate` is a
 * Manila day: expiry is a date on a box, compared against a date.
 */
function fefoCandidates(productId, asOfDate) {
  return db.get().prepare(`
    SELECT ${JOINED}, COALESCE(q.qty_milli, 0) AS qty_milli
    ${FROM} ${QTY}
     WHERE b.product_id = @productId
       AND b.is_active = 1
       AND b.expiry_date >= @asOfDate
       AND COALESCE(q.qty_milli, 0) > 0
     ORDER BY b.expiry_date, b.batch_no
  `).all({ productId, asOfDate });
}

/** Expired batches that still hold stock — what INV-205 expects to leave by EXPIRY. */
function expiredWithStock(asOfDate, { limit = 200 } = {}) {
  return db.get().prepare(`
    SELECT ${JOINED}, COALESCE(q.qty_milli, 0) AS qty_milli
    ${FROM} ${QTY}
     WHERE b.expiry_date < @asOfDate AND COALESCE(q.qty_milli, 0) > 0
     ORDER BY b.expiry_date
     LIMIT @limit
  `).all({ asOfDate, limit });
}

/** OPS-007's near-expiry sweep: expiring on or before `throughDate`, still holding stock. */
function nearExpiry(asOfDate, throughDate, { limit = 200 } = {}) {
  return db.get().prepare(`
    SELECT ${JOINED}, COALESCE(q.qty_milli, 0) AS qty_milli
    ${FROM} ${QTY}
     WHERE b.expiry_date >= @asOfDate AND b.expiry_date <= @throughDate
       AND COALESCE(q.qty_milli, 0) > 0
     ORDER BY b.expiry_date
     LIMIT @limit
  `).all({ asOfDate, throughDate, limit });
}

/**
 * INV-201, asserted rather than asserted-about: every batch-tracked product whose
 * batch quantities do not sum to its on-hand figure. The batch half of
 * inventoryRepository.reconciliationBreaks, and it returns rows only when something is
 * wrong.
 */
function reconciliationBreaks() {
  return db.get().prepare(`
    SELECT p.id AS product_id, p.sku, p.name,
           COALESCE(i.qty_on_hand_milli, 0) AS on_hand_milli,
           COALESCE(b.batched_milli, 0)     AS batched_milli,
           COALESCE(i.qty_on_hand_milli, 0) - COALESCE(b.batched_milli, 0) AS difference_milli
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id
      LEFT JOIN (
        SELECT product_id, SUM(qty_milli) AS batched_milli
          FROM inventory_movements
         WHERE batch_id IS NOT NULL
         GROUP BY product_id
      ) b ON b.product_id = p.id
     WHERE p.is_batch_tracked = 1
       AND COALESCE(i.qty_on_hand_milli, 0) <> COALESCE(b.batched_milli, 0)
     ORDER BY p.sku
  `).all();
}

// ── What a sale line took, per batch (INV-206) ──────────────────────────────

function insertSaleItemBatch(row) {
  db.get().prepare(`
    INSERT INTO sale_item_batches
      (id, sale_item_id, batch_id, qty_milli, unit_cost_centavos, movement_id, created_at)
    VALUES
      (@id, @sale_item_id, @batch_id, @qty_milli, @unit_cost_centavos, @movement_id, @created_at)
  `).run(row);
  return row;
}

function saleItemBatchesFor(saleItemId) {
  return db.get().prepare(`
    SELECT sib.*, b.batch_no, b.expiry_date
      FROM sale_item_batches sib
      JOIN product_batches b ON b.id = sib.batch_id
     WHERE sib.sale_item_id = ?
     ORDER BY b.expiry_date
  `).all(saleItemId);
}

/**
 * Point a batch at the receipt line that brought it, once that line exists.
 *
 * Two writes rather than one because the three rows reference each other in a ring:
 * the receipt line names its movement, the movement names its batch, and the batch
 * names the receipt line. Something has to be written before its target exists, and
 * with foreign keys on, "written as NULL and linked after" is the only order that
 * holds — a batch created with a `gr_item_id` for a row not yet inserted fails on the
 * constraint, which is exactly what it did.
 *
 * Only for a batch this delivery created. A redelivery of an existing batch number is
 * the same batch (INV-202), and its origin is the first delivery, not this one.
 */
function linkReceiptItem(id, grItemId) {
  db.get().prepare('UPDATE product_batches SET gr_item_id = ? WHERE id = ? AND gr_item_id IS NULL')
    .run(grItemId, id);
  return findById(id);
}

function deactivate({ id, updatedAt, updatedBy }) {
  db.get().prepare(
    'UPDATE product_batches SET is_active = 0, updated_at = ?, updated_by = ? WHERE id = ?'
  ).run(updatedAt, updatedBy, id);
  return findById(id);
}

module.exports = {
  insert,
  findById,
  findByNo,
  withQuantity,
  forProduct,
  fefoCandidates,
  expiredWithStock,
  nearExpiry,
  reconciliationBreaks,
  linkReceiptItem,
  insertSaleItemBatch,
  saleItemBatchesFor,
  deactivate,
};
