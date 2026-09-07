'use strict';

// Categories, brands and units. Three tables with the same shape, so one repository
// rather than three near-identical files.
//
// VR-206's reasoning applies to all three: nothing here deletes. A category with
// products, a unit that is some product's base unit, and a brand on a sold item are
// all referenced by history, and history does not move because somebody tidied a
// dropdown. Deactivation is the only removal.

const db = require('../config/database');

const TABLES = Object.freeze({
  categories: { columns: 'id, name, max_discount_bp, is_active, created_at', label: 'name' },
  brands: { columns: 'id, name, is_active, created_at', label: 'name' },
  units: { columns: 'id, code, name, allows_fraction, is_active, created_at', label: 'code' },
});

function assertTable(table) {
  if (!Object.prototype.hasOwnProperty.call(TABLES, table)) {
    // A programming error: the table name is interpolated below, so it may only ever
    // come from this list and never from a request.
    throw new RangeError(`unknown reference table: ${table}`);
  }
  return table;
}

function findById(table, id) {
  assertTable(table);
  return db.get().prepare(`SELECT ${TABLES[table].columns} FROM ${table} WHERE id = ?`).get(id) || null;
}

/** Case-insensitive: the columns collate NOCASE, so this matches the unique index. */
function findByLabel(table, value) {
  assertTable(table);
  const { columns, label } = TABLES[table];
  return db.get().prepare(`SELECT ${columns} FROM ${table} WHERE ${label} = ? COLLATE NOCASE`).get(value) || null;
}

function list(table, { includeInactive = false } = {}) {
  assertTable(table);
  const { columns, label } = TABLES[table];
  return db.get().prepare(`
    SELECT ${columns} FROM ${table}
     WHERE (@includeInactive = 1 OR is_active = 1)
     ORDER BY ${label} COLLATE NOCASE
  `).all({ includeInactive: includeInactive ? 1 : 0 });
}

function insert(table, row) {
  assertTable(table);
  const keys = Object.keys(row);
  db.get().prepare(`
    INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})
  `).run(row);
  return findById(table, row.id);
}

function updateFields(table, id, fields) {
  assertTable(table);
  const keys = Object.keys(fields).filter((k) => TABLES[table].columns.includes(k) && k !== 'id');
  if (keys.length === 0) return findById(table, id);

  db.get()
    .prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`)
    .run({ ...fields, id });
  return findById(table, id);
}

/** How many products point at this row — VR-206's "referenced" for a reference table. */
function referenceCount(table, id) {
  assertTable(table);
  const column = { categories: 'category_id', brands: 'brand_id', units: 'base_unit_id' }[table];
  const products = db.get().prepare(`SELECT COUNT(*) AS n FROM products WHERE ${column} = ?`).get(id).n;
  if (table !== 'units') return products;

  // A unit is also referenced as a pack unit, not only as a base unit.
  const packs = db.get().prepare('SELECT COUNT(*) AS n FROM product_packs WHERE unit_id = ?').get(id).n;
  return products + packs;
}

module.exports = { TABLES, findById, findByLabel, list, insert, updateFields, referenceCount };
