'use strict';

// POS-109 — the orders a counter has taken and not yet been paid for (TASK-066).
//
// Like carts, this counter's own (config/syncTables.js): never synced, never exported.
// Unlike a cart nothing here is deleted — a paid order points at its sale, and a voided
// one keeps its reason, so "what happened to table 4's order" always has an answer.

const db = require('../config/database');

const COLUMNS = `
  id, order_no, business_date, status, order_type, table_label, customer_id, payload, sent,
  line_count, ticket_count, opened_by, opened_shift_id, opened_at, updated_at,
  sale_id, closed_at, closed_by, void_reason
`;

function findById(id) {
  return db.get().prepare(`SELECT ${COLUMNS} FROM open_orders WHERE id = ?`).get(id) || null;
}

function findBySale(saleId) {
  return db.get().prepare(`SELECT ${COLUMNS} FROM open_orders WHERE sale_id = ?`).get(saleId) || null;
}

/** Every order still open, oldest first: the table that has waited longest is first. */
function listOpen() {
  return db.get()
    .prepare(`SELECT ${COLUMNS} FROM open_orders WHERE status = 'OPEN' ORDER BY opened_at, order_no`)
    .all();
}

function countOpen() {
  return db.get().prepare("SELECT COUNT(*) AS n FROM open_orders WHERE status = 'OPEN'").get().n;
}

/** The day's next number, from 1. Read inside the caller's transaction. */
function nextNumber(businessDate) {
  const row = db.get()
    .prepare('SELECT MAX(order_no) AS highest FROM open_orders WHERE business_date = ?')
    .get(businessDate);
  return (row.highest || 0) + 1;
}

function insert(row) {
  const keys = Object.keys(row);
  db.get()
    .prepare(`INSERT INTO open_orders (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`)
    .run(row);
  return findById(row.id);
}

const UPDATABLE = [
  'status', 'order_type', 'table_label', 'customer_id', 'payload', 'sent', 'line_count',
  'ticket_count', 'updated_at', 'sale_id', 'closed_at', 'closed_by', 'void_reason',
];

function update(id, fields) {
  const keys = Object.keys(fields).filter((k) => UPDATABLE.includes(k));
  if (keys.length === 0) return findById(id);
  db.get()
    .prepare(`UPDATE open_orders SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`)
    .run({ ...fields, id });
  return findById(id);
}

module.exports = { findById, findBySale, listOpen, countOpen, nextNumber, insert, update };
