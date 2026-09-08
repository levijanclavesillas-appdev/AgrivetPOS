'use strict';

// Purchase orders and their lines.
//
// PO-103 is visible here as an absence: nothing in this file touches `inventory`,
// `inventory_movements`, or `products.avg_cost_centavos`. An order is a statement of
// intent, and the only writer of stock remains inventoryService (INV-101).
//
// PO-104's revision is a column on the order rather than a second table. The supplier
// has been told a number, so `po_no` never changes and `revision` moves with it; the
// superseded lines are held by the audit trail, which AUD-601 already requires to
// carry both values on every amendment.

const db = require('../config/database');

const COLUMNS = `
  po.id, po.po_no, po.supplier_id, po.status, po.revision, po.ordered_at, po.expected_at,
  po.reference_no, po.notes, po.total_centavos, po.submitted_at, po.submitted_by,
  po.cancelled_at, po.cancelled_by, po.cancel_reason, po.completed_at,
  po.created_at, po.created_by, po.updated_at, po.updated_by
`;

const JOINED = `${COLUMNS}, s.name AS supplier_name, s.code AS supplier_code, s.terms_days AS supplier_terms_days`;
const FROM = 'FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id';

function findById(id) {
  return db.get().prepare(`SELECT ${JOINED} ${FROM} WHERE po.id = ?`).get(id) || null;
}

function findByNo(poNo) {
  return db.get().prepare(`SELECT ${JOINED} ${FROM} WHERE po.po_no = ?`).get(poNo) || null;
}

function countAll() {
  return db.get().prepare('SELECT COUNT(*) AS n FROM purchase_orders').get().n;
}

/**
 * The list SCR-801 reads: newest first, filterable by supplier and status.
 *
 * `open` is the filter a buyer actually wants — everything that has been sent and not
 * yet fully arrived — expressed as a flag rather than making the screen keep its own
 * copy of which two statuses those are.
 */
function search({
  supplierId = null, status = null, open = false, q = null, from = null, to = null,
  limit = 50, offset = 0,
} = {}) {
  const like = q ? `%${q}%` : null;
  return db.get().prepare(`
    SELECT ${JOINED},
           (SELECT COUNT(*) FROM purchase_order_items i WHERE i.po_id = po.id) AS line_count
      ${FROM}
     WHERE (@supplierId IS NULL OR po.supplier_id = @supplierId)
       AND (@status IS NULL OR po.status = @status)
       AND (@open = 0 OR po.status IN ('PENDING','PARTIALLY_RECEIVED'))
       AND (@from IS NULL OR COALESCE(po.ordered_at, po.created_at) >= @from)
       AND (@to IS NULL OR COALESCE(po.ordered_at, po.created_at) <= @to)
       AND (@q IS NULL
            OR po.po_no LIKE @like COLLATE NOCASE
            OR po.reference_no LIKE @like COLLATE NOCASE
            OR s.name LIKE @like COLLATE NOCASE)
     ORDER BY COALESCE(po.ordered_at, po.created_at) DESC, po.id DESC
     LIMIT @limit OFFSET @offset
  `).all({
    supplierId, status, open: open ? 1 : 0, q, like, from, to, limit, offset,
  });
}

function countSearch({ supplierId = null, status = null, open = false, q = null, from = null, to = null } = {}) {
  const like = q ? `%${q}%` : null;
  return db.get().prepare(`
    SELECT COUNT(*) AS n ${FROM}
     WHERE (@supplierId IS NULL OR po.supplier_id = @supplierId)
       AND (@status IS NULL OR po.status = @status)
       AND (@open = 0 OR po.status IN ('PENDING','PARTIALLY_RECEIVED'))
       AND (@from IS NULL OR COALESCE(po.ordered_at, po.created_at) >= @from)
       AND (@to IS NULL OR COALESCE(po.ordered_at, po.created_at) <= @to)
       AND (@q IS NULL
            OR po.po_no LIKE @like COLLATE NOCASE
            OR po.reference_no LIKE @like COLLATE NOCASE
            OR s.name LIKE @like COLLATE NOCASE)
  `).get({ supplierId, status, open: open ? 1 : 0, q, like, from, to }).n;
}

function insert(row) {
  const keys = Object.keys(row);
  db.get().prepare(`
    INSERT INTO purchase_orders (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})
  `).run(row);
  return findById(row.id);
}

const UPDATABLE = [
  'status', 'revision', 'ordered_at', 'expected_at', 'reference_no', 'notes',
  'total_centavos', 'submitted_at', 'submitted_by', 'cancelled_at', 'cancelled_by',
  'cancel_reason', 'completed_at', 'updated_at', 'updated_by',
];

function updateFields(id, fields) {
  const keys = Object.keys(fields).filter((k) => UPDATABLE.includes(k));
  if (keys.length === 0) return findById(id);

  db.get()
    .prepare(`UPDATE purchase_orders SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`)
    .run({ ...fields, id });
  return findById(id);
}

// ── Lines ───────────────────────────────────────────────────────────────────

/**
 * The lines, each with what has been received against it so far.
 *
 * The received figure is summed from `goods_receipt_items` rather than held as a
 * counter on the line, for INV-101's reason applied to a different table: a stored
 * "received so far" is a second figure that must agree with the receipts, and it
 * drifts on exactly the rollback the transaction exists to survive.
 */
function itemsFor(poId) {
  return db.get().prepare(`
    SELECT i.id, i.po_id, i.line_no, i.product_id, i.product_name_snapshot,
           i.qty_milli, i.order_unit_id, i.order_pack_factor_milli,
           i.unit_cost_centavos, i.line_total_centavos, i.notes,
           p.sku, u.code AS base_unit_code, ou.code AS order_unit_code,
           COALESCE((SELECT SUM(gi.received_qty_milli) FROM goods_receipt_items gi
                      WHERE gi.po_item_id = i.id), 0) AS received_qty_milli,
           COALESCE((SELECT SUM(gi.damaged_qty_milli) FROM goods_receipt_items gi
                      WHERE gi.po_item_id = i.id), 0) AS damaged_qty_milli
      FROM purchase_order_items i
      JOIN products p ON p.id = i.product_id
      JOIN units u ON u.id = p.base_unit_id
      LEFT JOIN units ou ON ou.id = i.order_unit_id
     WHERE i.po_id = ?
     ORDER BY i.line_no
  `).all(poId);
}

function findItem(id) {
  return db.get().prepare('SELECT * FROM purchase_order_items WHERE id = ?').get(id) || null;
}

function insertItem(row) {
  const keys = Object.keys(row);
  db.get().prepare(`
    INSERT INTO purchase_order_items (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})
  `).run(row);
  return row;
}

/**
 * Replace every line on an order.
 *
 * The only DELETE in this file, and it is confined to a DRAFT or to the amendment that
 * raises a revision — both of which the service checks before calling. A received line
 * is unreachable from here because a PO with any receipt against it is no longer in
 * either state (PO-102, PO-105).
 */
function deleteItems(poId) {
  db.get().prepare('DELETE FROM purchase_order_items WHERE po_id = ?').run(poId);
}

/** Whether anything at all has been received against this order — PO-105's question. */
function receiptCount(poId) {
  return db.get().prepare('SELECT COUNT(*) AS n FROM goods_receipts WHERE po_id = ?').get(poId).n;
}

function receiptsFor(poId) {
  return db.get().prepare(`
    SELECT id, gr_no, supplier_dr_no, invoice_no, total_centavos,
           has_over_receipt, has_cost_variance, received_at, created_by
      FROM goods_receipts
     WHERE po_id = ?
     ORDER BY received_at, id
  `).all(poId);
}

module.exports = {
  findById, findByNo, countAll, search, countSearch, insert, updateFields,
  itemsFor, findItem, insertItem, deleteItems, receiptCount, receiptsFor,
};
