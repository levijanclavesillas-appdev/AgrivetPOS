'use strict';

// POS-105, POS-106 — cart rows.
//
// The one table in this schema a delete is right for: a cart is a draft, not history.
// An abandoned one is cleared rather than kept, because a row saying "this cashier had
// an empty cart" restores an empty screen and looks like a defect. A *parked* cart is
// expired rather than deleted, so "where did my parked cart go" has an answer.

const db = require('../config/database');

const COLUMNS = `
  id, user_id, shift_id, customer_id, status, label, payload, line_count,
  parked_at, resumed_at, expired_at, created_at, updated_at
`;

function findById(id) {
  return db.get().prepare(`SELECT ${COLUMNS} FROM carts WHERE id = ?`).get(id) || null;
}

/** POS-105's question: this user, this shift, still in progress. */
function findActive(userId, shiftId) {
  return db.get()
    .prepare(`SELECT ${COLUMNS} FROM carts WHERE user_id = ? AND shift_id = ? AND status = 'ACTIVE'`)
    .get(userId, shiftId) || null;
}

function parkedForShift(shiftId) {
  return db.get()
    .prepare(`SELECT ${COLUMNS} FROM carts WHERE shift_id = ? AND status = 'PARKED' ORDER BY parked_at`)
    .all(shiftId);
}

function insert(row) {
  const keys = Object.keys(row);
  db.get()
    .prepare(`INSERT INTO carts (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`)
    .run(row);
  return findById(row.id);
}

const UPDATABLE = [
  'customer_id', 'status', 'label', 'payload', 'line_count',
  'parked_at', 'resumed_at', 'expired_at', 'updated_at',
];

function update(id, fields) {
  const keys = Object.keys(fields).filter((k) => UPDATABLE.includes(k));
  if (keys.length === 0) return findById(id);

  db.get()
    .prepare(`UPDATE carts SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`)
    .run({ ...fields, id });
  return findById(id);
}

function remove(id) {
  db.get().prepare('DELETE FROM carts WHERE id = ?').run(id);
}

/** POS-106: everything still parked when the drawer is counted. */
function expireForShift(shiftId, at) {
  const result = db.get()
    .prepare("UPDATE carts SET status = 'EXPIRED', expired_at = ?, updated_at = ? WHERE shift_id = ? AND status IN ('ACTIVE','PARKED')")
    .run(at, at, shiftId);
  return result.changes;
}

function countForShift(shiftId) {
  return db.get().prepare('SELECT COUNT(*) AS n FROM carts WHERE shift_id = ?').get(shiftId).n;
}

module.exports = {
  findById, findActive, parkedForShift, insert, update, remove, expireForShift, countForShift,
};
