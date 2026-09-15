'use strict';

// A product's picture (902_product_images.sql, TASK-052). The pictures are read one at
// a time and only by the route that serves them; everything else asks for the metadata.

const db = require('../config/database');

const META = 'product_id, sha256, mime, image_bytes, thumb_bytes, updated_at, updated_by';

const meta = (productId) => db.get()
  .prepare(`SELECT ${META} FROM product_images WHERE product_id = ?`).get(productId) || null;

/** One size, with what the response needs to describe it. `size` is 'thumb' or 'image'. */
function picture(productId, size) {
  const column = size === 'thumb' ? 'thumb' : 'image';
  return db.get()
    .prepare(`SELECT sha256, mime, ${column} AS bytes FROM product_images WHERE product_id = ?`)
    .get(productId) || null;
}

function upsert(row) {
  db.get().prepare(`
    INSERT INTO product_images (product_id, sha256, mime, image_bytes, thumb_bytes, updated_at, updated_by, thumb, image)
    VALUES (@product_id, @sha256, @mime, @image_bytes, @thumb_bytes, @updated_at, @updated_by, @thumb, @image)
    ON CONFLICT(product_id) DO UPDATE SET
      sha256 = excluded.sha256, mime = excluded.mime, image_bytes = excluded.image_bytes,
      thumb_bytes = excluded.thumb_bytes, updated_at = excluded.updated_at,
      updated_by = excluded.updated_by, thumb = excluded.thumb, image = excluded.image
  `).run(row);
  return meta(row.product_id);
}

const remove = (productId) => db.get().prepare('DELETE FROM product_images WHERE product_id = ?').run(productId).changes;

module.exports = { meta, picture, upsert, remove };
