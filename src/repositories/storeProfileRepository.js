'use strict';

// store_profile holds the store's identity and its tax mode (TAX-001). There is
// exactly one row: the table is a singleton, and requirement 6 makes "exactly one"
// a property of the completion transaction rather than a hope.

const db = require('../config/database');

const COLUMNS = 'id, store_name, address, contact_no, tin, tax_mode, currency, created_at, updated_at, updated_by';

function find() {
  const row = db.get().prepare(`SELECT ${COLUMNS} FROM store_profile LIMIT 1`).get() || null;
  // TASK-053's column, read on its own so a database from before 904 still reads.
  return row ? { ...row, industry: industry() } : null;
}

function count() {
  return db.get().prepare('SELECT COUNT(*) AS n FROM store_profile').get().n;
}

function insert(row) {
  db.get().prepare(`
    INSERT INTO store_profile (id, store_name, address, contact_no, tin, tax_mode, currency, industry, created_at)
    VALUES (@id, @store_name, @address, @contact_no, @tin, @tax_mode, @currency, @industry, @created_at)
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

/**
 * The industry alone (TASK-053), for settingsService, which the store profile service
 * itself reads. Null before setup, and on a database from before 904_store_industry.sql.
 */
function industry() {
  try {
    const row = db.get().prepare('SELECT industry FROM store_profile LIMIT 1').get();
    return row ? row.industry : null;
  } catch {
    return null;
  }
}

module.exports = {
  industry, find, count, insert, updateFields };
