'use strict';

// Suppliers. VR-401 makes the name required and unique; VR-304's reasoning — a
// counterparty who has transacted is history — applies on this side of the ledger too,
// so there is no delete path here to reach for.

const db = require('../config/database');

const COLUMNS = `
  id, code, name, contact_person, contact_no, email, address, terms_days,
  notes, is_active, created_at, created_by, updated_at, updated_by
`;

function findById(id) {
  return db.get().prepare(`SELECT ${COLUMNS} FROM suppliers WHERE id = ?`).get(id) || null;
}

/** VR-401's uniqueness, asked before the INSERT so the refusal names the rule. */
function findByName(name) {
  return db.get().prepare(`SELECT ${COLUMNS} FROM suppliers WHERE name = ? COLLATE NOCASE`).get(name) || null;
}

function findByCode(code) {
  return db.get().prepare(`SELECT ${COLUMNS} FROM suppliers WHERE code = ? COLLATE NOCASE`).get(code) || null;
}

function countAll() {
  return db.get().prepare('SELECT COUNT(*) AS n FROM suppliers').get().n;
}

/**
 * Search by name, code or contact — one box, as the customer and product searches are.
 *
 * A buyer looks a supplier up by whatever is in front of them: the name on the sack,
 * the code on the last delivery receipt, or the number they are about to ring.
 */
function search({ q = null, includeInactive = false, limit = 50, offset = 0 } = {}) {
  const like = q ? `%${q}%` : null;
  return db.get().prepare(`
    SELECT ${COLUMNS} FROM suppliers
     WHERE (@includeInactive = 1 OR is_active = 1)
       AND (@q IS NULL
            OR name LIKE @like COLLATE NOCASE
            OR code LIKE @like COLLATE NOCASE
            OR contact_person LIKE @like COLLATE NOCASE
            OR contact_no LIKE @like)
     ORDER BY
       CASE WHEN @q IS NULL THEN 0
            WHEN code = @q COLLATE NOCASE THEN 0
            WHEN name LIKE @prefix COLLATE NOCASE THEN 1
            ELSE 2 END,
       name COLLATE NOCASE
     LIMIT @limit OFFSET @offset
  `).all({
    q, like, prefix: q ? `${q}%` : null,
    includeInactive: includeInactive ? 1 : 0, limit, offset,
  });
}

function countSearch({ q = null, includeInactive = false } = {}) {
  const like = q ? `%${q}%` : null;
  return db.get().prepare(`
    SELECT COUNT(*) AS n FROM suppliers
     WHERE (@includeInactive = 1 OR is_active = 1)
       AND (@q IS NULL
            OR name LIKE @like COLLATE NOCASE
            OR code LIKE @like COLLATE NOCASE
            OR contact_person LIKE @like COLLATE NOCASE
            OR contact_no LIKE @like)
  `).get({ q, like, includeInactive: includeInactive ? 1 : 0 }).n;
}

function insert(row) {
  const keys = Object.keys(row);
  db.get().prepare(`
    INSERT INTO suppliers (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})
  `).run(row);
  return findById(row.id);
}

const UPDATABLE = [
  'code', 'name', 'contact_person', 'contact_no', 'email', 'address',
  'terms_days', 'notes', 'is_active', 'updated_at', 'updated_by',
];

function updateFields(id, fields) {
  const keys = Object.keys(fields).filter((k) => UPDATABLE.includes(k));
  if (keys.length === 0) return findById(id);

  db.get()
    .prepare(`UPDATE suppliers SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`)
    .run({ ...fields, id });
  return findById(id);
}

/** Whether a supplier has been transacted with — orders raised or goods delivered. */
function transactionCount(supplierId) {
  const orders = db.get()
    .prepare('SELECT COUNT(*) AS n FROM purchase_orders WHERE supplier_id = ?').get(supplierId).n;
  const receipts = db.get()
    .prepare('SELECT COUNT(*) AS n FROM goods_receipts WHERE supplier_id = ?').get(supplierId).n;
  return orders + receipts;
}

/**
 * What this supplier last charged for a product — the question v1.0 could not answer.
 *
 * Read from the receipt rather than from the order: PO-203 makes the actual cost the
 * one that matters, and the ordered figure is what the store *thought* it would pay.
 */
function lastCostFor(supplierId, productId) {
  return db.get().prepare(`
    SELECT gi.unit_cost_centavos, g.received_at, g.gr_no
      FROM goods_receipt_items gi
      JOIN goods_receipts g ON g.id = gi.gr_id
     WHERE g.supplier_id = ? AND gi.product_id = ?
     ORDER BY g.received_at DESC, g.id DESC
     LIMIT 1
  `).get(supplierId, productId) || null;
}

module.exports = {
  findById, findByName, findByCode, countAll, search, countSearch,
  insert, updateFields, transactionCount, lastCostFor,
};
