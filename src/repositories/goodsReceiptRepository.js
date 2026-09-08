'use strict';

// Goods receipts and their lines.
//
// PO-206 is visible here as an absence, the way PO-103 is in purchaseOrderRepository:
// there is no `updateFields`, no `deleteItem`, and no path of any kind that changes a
// posted receipt. AUD-605 protects the audit trail the same way and for the same
// reason — the correction for a wrong receipt is an adjustment or a supplier return,
// which leaves both the mistake and its remedy legible afterwards (INV-102).

const db = require('../config/database');

const COLUMNS = `
  g.id, g.gr_no, g.po_id, g.supplier_id, g.supplier_dr_no, g.invoice_no, g.status,
  g.total_centavos, g.has_over_receipt, g.has_cost_variance, g.approved_by,
  g.approval_reason, g.notes, g.received_at, g.created_at, g.created_by
`;

const JOINED = `
  ${COLUMNS},
  s.name AS supplier_name, s.code AS supplier_code,
  po.po_no AS po_no,
  u.username AS created_by_username,
  a.username AS approved_by_username
`;

const FROM = `
  FROM goods_receipts g
  JOIN suppliers s ON s.id = g.supplier_id
  LEFT JOIN purchase_orders po ON po.id = g.po_id
  LEFT JOIN users u ON u.id = g.created_by
  LEFT JOIN users a ON a.id = g.approved_by
`;

function findById(id) {
  return db.get().prepare(`SELECT ${JOINED} ${FROM} WHERE g.id = ?`).get(id) || null;
}

function findByNo(grNo) {
  return db.get().prepare(`SELECT ${JOINED} ${FROM} WHERE g.gr_no = ?`).get(grNo) || null;
}

function countAll() {
  return db.get().prepare('SELECT COUNT(*) AS n FROM goods_receipts').get().n;
}

function search({
  supplierId = null, poId = null, q = null, from = null, to = null,
  flaggedOnly = false, limit = 50, offset = 0,
} = {}) {
  const like = q ? `%${q}%` : null;
  return db.get().prepare(`
    SELECT ${JOINED},
           (SELECT COUNT(*) FROM goods_receipt_items i WHERE i.gr_id = g.id) AS line_count
      ${FROM}
     WHERE (@supplierId IS NULL OR g.supplier_id = @supplierId)
       AND (@poId IS NULL OR g.po_id = @poId)
       AND (@from IS NULL OR g.received_at >= @from)
       AND (@to IS NULL OR g.received_at <= @to)
       AND (@flaggedOnly = 0 OR g.has_over_receipt = 1 OR g.has_cost_variance = 1)
       AND (@q IS NULL
            OR g.gr_no LIKE @like COLLATE NOCASE
            OR g.supplier_dr_no LIKE @like COLLATE NOCASE
            OR g.invoice_no LIKE @like COLLATE NOCASE
            OR s.name LIKE @like COLLATE NOCASE)
     ORDER BY g.received_at DESC, g.id DESC
     LIMIT @limit OFFSET @offset
  `).all({ supplierId, poId, q, like, from, to, flaggedOnly: flaggedOnly ? 1 : 0, limit, offset });
}

function countSearch({ supplierId = null, poId = null, q = null, from = null, to = null, flaggedOnly = false } = {}) {
  const like = q ? `%${q}%` : null;
  return db.get().prepare(`
    SELECT COUNT(*) AS n ${FROM}
     WHERE (@supplierId IS NULL OR g.supplier_id = @supplierId)
       AND (@poId IS NULL OR g.po_id = @poId)
       AND (@from IS NULL OR g.received_at >= @from)
       AND (@to IS NULL OR g.received_at <= @to)
       AND (@flaggedOnly = 0 OR g.has_over_receipt = 1 OR g.has_cost_variance = 1)
       AND (@q IS NULL
            OR g.gr_no LIKE @like COLLATE NOCASE
            OR g.supplier_dr_no LIKE @like COLLATE NOCASE
            OR g.invoice_no LIKE @like COLLATE NOCASE
            OR s.name LIKE @like COLLATE NOCASE)
  `).get({ supplierId, poId, q, like, from, to, flaggedOnly: flaggedOnly ? 1 : 0 }).n;
}

function insert(row) {
  const keys = Object.keys(row);
  db.get().prepare(`
    INSERT INTO goods_receipts (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})
  `).run(row);
  return findById(row.id);
}

function insertItem(row) {
  const keys = Object.keys(row);
  db.get().prepare(`
    INSERT INTO goods_receipt_items (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})
  `).run(row);
  return row;
}

function itemsFor(grId) {
  return db.get().prepare(`
    SELECT i.*, p.sku, u.code AS base_unit_code, ru.code AS receive_unit_code
      FROM goods_receipt_items i
      JOIN products p ON p.id = i.product_id
      JOIN units u ON u.id = p.base_unit_id
      LEFT JOIN units ru ON ru.id = i.receive_unit_id
     WHERE i.gr_id = ?
     ORDER BY i.line_no
  `).all(grId);
}

/** Every delivery of one product, newest first — the purchase history of an item. */
function historyForProduct(productId, { limit = 50, offset = 0 } = {}) {
  return db.get().prepare(`
    SELECT i.id, i.gr_id, i.received_qty_milli, i.damaged_qty_milli, i.sound_qty_milli,
           i.unit_cost_centavos, i.ordered_unit_cost_centavos, i.cost_variance_bp,
           g.gr_no, g.received_at, s.name AS supplier_name
      FROM goods_receipt_items i
      JOIN goods_receipts g ON g.id = i.gr_id
      JOIN suppliers s ON s.id = g.supplier_id
     WHERE i.product_id = ?
     ORDER BY g.received_at DESC, g.id DESC
     LIMIT ? OFFSET ?
  `).all(productId, limit, offset);
}

module.exports = {
  findById, findByNo, countAll, search, countSearch,
  insert, insertItem, itemsFor, historyForProduct,
};
