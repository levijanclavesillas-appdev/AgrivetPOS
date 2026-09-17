'use strict';

// POS-113 — the counter's quick keys (TASK-070). The store's, so synced like the catalogue.

const db = require('../config/database');

/** Every key in position order, with what the button needs to show and to add. */
function list() {
  return db.get().prepare(`
    SELECT k.id, k.position, k.product_id, k.pack_unit_id, k.label,
           p.name AS product_name, p.sku, p.is_active, p.base_unit_id,
           bu.code AS base_unit_code, pu.code AS pack_unit_code,
           pk.factor_milli AS pack_factor_milli,
           img.sha256 AS image_sha256
      FROM quick_keys k
      JOIN products p ON p.id = k.product_id
      JOIN units bu ON bu.id = p.base_unit_id
      LEFT JOIN units pu ON pu.id = k.pack_unit_id
      LEFT JOIN product_packs pk ON pk.product_id = k.product_id AND pk.unit_id = k.pack_unit_id
      LEFT JOIN product_images img ON img.product_id = k.product_id
     ORDER BY k.position
  `).all();
}

function replaceAll(rows) {
  const database = db.get();
  database.prepare('DELETE FROM quick_keys').run();
  const insert = database.prepare(`
    INSERT INTO quick_keys (id, position, product_id, pack_unit_id, label, created_at, created_by)
    VALUES (@id, @position, @product_id, @pack_unit_id, @label, @created_at, @created_by)
  `);
  for (const row of rows) insert.run(row);
}

module.exports = { list, replaceAll };
