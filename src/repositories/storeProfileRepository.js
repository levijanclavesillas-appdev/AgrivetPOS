'use strict';

// store_profile holds the store's identity and its tax mode (TAX-001). There is
// exactly one row: the table is a singleton, and requirement 6 makes "exactly one"
// a property of the completion transaction rather than a hope.

const db = require('../config/database');

const COLUMNS = 'id, store_name, address, contact_no, tin, tax_mode, currency, created_at, updated_at, updated_by';

function find() {
  return db.get().prepare(`SELECT ${COLUMNS} FROM store_profile LIMIT 1`).get() || null;
}

function count() {
  return db.get().prepare('SELECT COUNT(*) AS n FROM store_profile').get().n;
}

function insert(row) {
  db.get().prepare(`
    INSERT INTO store_profile (id, store_name, address, contact_no, tin, tax_mode, currency, created_at)
    VALUES (@id, @store_name, @address, @contact_no, @tin, @tax_mode, @currency, @created_at)
  `).run(row);
  return find();
}

/** Only the columns present are touched; the id and created_at are never among them. */
function updateFields(id, fields) {
  const allowed = ['store_name', 'address', 'contact_no', 'tin', 'tax_mode', 'currency', 'updated_at', 'updated_by'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (keys.length === 0) return find();

  db.get()
    .prepare(`UPDATE store_profile SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`)
    .run({ ...fields, id });
  return find();
}

module.exports = { find, count, insert, updateFields };
