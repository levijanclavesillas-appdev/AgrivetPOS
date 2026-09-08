'use strict';

// Customers. VR-304 applies the same reasoning as VR-206 did to products: a customer
// who has transacted is history, and there is no delete path here to reach for.

const db = require('../config/database');

const COLUMNS = `
  id, code, name, contact_no, address, customer_type, price_level,
  is_credit_eligible, is_active, notes, created_at, created_by, updated_at, updated_by
`;

function findById(id) {
  return db.get().prepare(`SELECT ${COLUMNS} FROM customers WHERE id = ?`).get(id) || null;
}

function findByCode(code) {
  return db.get().prepare(`SELECT ${COLUMNS} FROM customers WHERE code = ? COLLATE NOCASE`).get(code) || null;
}

function countAll() {
  return db.get().prepare('SELECT COUNT(*) AS n FROM customers').get().n;
}

/**
 * Search by name, code or contact number (SCR-401).
 *
 * A counter looks a farm up by whatever they remember — the name on the sack, the
 * number they were called from, or the code on the last receipt — so all three go
 * through one box, as the product search does.
 */
function search({ q = null, includeInactive = false, creditOnly = false, limit = 50, offset = 0 } = {}) {
  const like = q ? `%${q}%` : null;
  return db.get().prepare(`
    SELECT ${COLUMNS} FROM customers
     WHERE (@includeInactive = 1 OR is_active = 1)
       AND (@creditOnly = 0 OR is_credit_eligible = 1)
       AND (@q IS NULL
            OR name LIKE @like COLLATE NOCASE
            OR code LIKE @like COLLATE NOCASE
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
    includeInactive: includeInactive ? 1 : 0, creditOnly: creditOnly ? 1 : 0, limit, offset,
  });
}

function countSearch({ q = null, includeInactive = false, creditOnly = false } = {}) {
  const like = q ? `%${q}%` : null;
  return db.get().prepare(`
    SELECT COUNT(*) AS n FROM customers
     WHERE (@includeInactive = 1 OR is_active = 1)
       AND (@creditOnly = 0 OR is_credit_eligible = 1)
       AND (@q IS NULL
            OR name LIKE @like COLLATE NOCASE
            OR code LIKE @like COLLATE NOCASE
            OR contact_no LIKE @like)
  `).get({ q, like, includeInactive: includeInactive ? 1 : 0, creditOnly: creditOnly ? 1 : 0 }).n;
}

function insert(row) {
  const keys = Object.keys(row);
  db.get().prepare(`
    INSERT INTO customers (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})
  `).run(row);
  return findById(row.id);
}

const UPDATABLE = [
  'code', 'name', 'contact_no', 'address', 'customer_type', 'price_level',
  'is_credit_eligible', 'is_active', 'notes', 'updated_at', 'updated_by',
];

function updateFields(id, fields) {
  const keys = Object.keys(fields).filter((k) => UPDATABLE.includes(k));
  if (keys.length === 0) return findById(id);

  db.get()
    .prepare(`UPDATE customers SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`)
    .run({ ...fields, id });
  return findById(id);
}

/**
 * Whether a customer has transacted — VR-304's "once transacted".
 *
 * `sales` arrives with TASK-011, so it is counted only where it exists: at schema
 * version 4 a customer genuinely cannot have a sale, because there is no table for one.
 * A credit transaction is a transaction in its own right and counts today.
 */
function tableExists(name) {
  return Boolean(
    db.get().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  );
}

function transactionCount(customerId) {
  let total = db.get().prepare(`
    SELECT COUNT(*) AS n
      FROM customer_credit_transactions t
      JOIN customer_credit_accounts a ON a.id = t.account_id
     WHERE a.customer_id = ?
  `).get(customerId).n;

  if (tableExists('sales')) {
    total += db.get().prepare('SELECT COUNT(*) AS n FROM sales WHERE customer_id = ?').get(customerId).n;
  }
  return total;
}

module.exports = {
  findById, findByCode, countAll, search, countSearch, insert, updateFields,
  transactionCount, tableExists,
};
