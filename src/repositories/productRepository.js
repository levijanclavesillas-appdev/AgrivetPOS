'use strict';

// Products and their four child tables: barcodes (VR-205), packs (UOM-002), prices
// (PR-101) and, from TASK-007, the movements that freeze the base unit (UOM-003).

const db = require('../config/database');

const COLUMNS = `
  p.id, p.sku, p.name, p.category_id, p.brand_id, p.base_unit_id, p.description,
  p.tax_class, p.statutory_discount_eligible, p.avg_cost_centavos, p.avg_cost_as_of,
  p.min_stock_milli, p.is_batch_tracked, p.is_active,
  p.created_at, p.created_by, p.updated_at, p.updated_by
`;

// The names the list screen shows instead of ids (SCR-201). Joined rather than
// denormalised: a renamed brand should read as renamed everywhere at once.
const JOINED = `
  ${COLUMNS},
  c.name AS category_name,
  -- PR-202's ceiling, joined rather than looked up per line at pricing time. The
  -- category is already joined for its name, so this costs nothing and saves the
  -- pricing engine a query per cart line — which on a twenty-line basket is twenty
  -- round trips inside NFR_1.1's two-second budget.
  c.max_discount_bp AS category_max_discount_bp,
  b.name AS brand_name,
  u.code AS base_unit_code,
  u.name AS base_unit_name,
  u.allows_fraction AS base_unit_allows_fraction,
  -- SCR-201 shows on-hand in its list. Joined here rather than fetched per row,
  -- because fifty products on a page is fifty round trips otherwise, and the figure is
  -- one the list is read for. COALESCE because a product that has never moved has no
  -- inventory row at all — which is 0 on hand, not a missing product (INV-101).
  COALESCE(i.qty_on_hand_milli, 0) AS qty_on_hand_milli,
  (i.product_id IS NOT NULL) AS has_moved
`;

const FROM = `
  FROM products p
  JOIN categories c ON c.id = p.category_id
  LEFT JOIN brands b ON b.id = p.brand_id
  JOIN units u ON u.id = p.base_unit_id
  LEFT JOIN inventory i ON i.product_id = p.id
`;

function findById(id) {
  return db.get().prepare(`SELECT ${JOINED} ${FROM} WHERE p.id = ?`).get(id) || null;
}

function findBySku(sku) {
  return db.get().prepare(`SELECT ${JOINED} ${FROM} WHERE p.sku = ? COLLATE NOCASE`).get(sku) || null;
}

function countAll() {
  return db.get().prepare('SELECT COUNT(*) AS n FROM products').get().n;
}

/**
 * Search across name, SKU, barcode and brand (FR_2.1, NFR_1.3).
 *
 * One statement rather than four queries merged in the service: the counter types into
 * a single box and expects one ranked answer inside 500 ms, and four round trips plus
 * a merge in JavaScript is how that budget gets spent.
 *
 * Ordering puts an exact SKU or barcode first, then a name that starts with the term,
 * then anything else that contains it. A scan and a half-typed name are the two real
 * uses, and they want opposite orderings from the same box.
 *
 * Both barcode clauses are written to run **once**, not once per candidate row. The
 * obvious shape — a correlated `EXISTS (... WHERE bc.product_id = p.id AND ...)` — makes
 * SQLite walk product_barcodes for every product it considers, which at 5,000 products
 * measured about six seconds a search: twelve times the NFR_1.3 budget, and invisible
 * on the twenty rows a developer usually has. A scalar subquery on the indexed barcode
 * column and an `IN` over the same index both resolve first, and the rest is one pass.
 */
function search({ q = null, categoryId = null, includeInactive = false, limit = 50, offset = 0 } = {}) {
  const like = q ? `%${q}%` : null;
  return db.get().prepare(`
    SELECT ${JOINED},
           (p.id = (SELECT bc.product_id FROM product_barcodes bc WHERE bc.barcode = @q)) AS barcode_exact
      ${FROM}
     WHERE (@includeInactive = 1 OR p.is_active = 1)
       AND (@categoryId IS NULL OR p.category_id = @categoryId)
       AND (@q IS NULL
            OR p.sku LIKE @like COLLATE NOCASE
            OR p.name LIKE @like COLLATE NOCASE
            OR b.name LIKE @like COLLATE NOCASE
            OR p.id IN (SELECT bc.product_id FROM product_barcodes bc WHERE bc.barcode LIKE @like))
     ORDER BY
       CASE WHEN @q IS NULL THEN 0
            WHEN p.sku = @q COLLATE NOCASE THEN 0
            WHEN barcode_exact THEN 0
            WHEN p.name LIKE @prefix COLLATE NOCASE THEN 1
            ELSE 2 END,
       p.name COLLATE NOCASE
     LIMIT @limit OFFSET @offset
  `).all({
    q, like, prefix: q ? `${q}%` : null, categoryId,
    includeInactive: includeInactive ? 1 : 0, limit, offset,
  });
}

function countSearch({ q = null, categoryId = null, includeInactive = false } = {}) {
  const like = q ? `%${q}%` : null;
  return db.get().prepare(`
    SELECT COUNT(*) AS n
      ${FROM}
     WHERE (@includeInactive = 1 OR p.is_active = 1)
       AND (@categoryId IS NULL OR p.category_id = @categoryId)
       AND (@q IS NULL
            OR p.sku LIKE @like COLLATE NOCASE
            OR p.name LIKE @like COLLATE NOCASE
            OR b.name LIKE @like COLLATE NOCASE
            OR p.id IN (SELECT bc.product_id FROM product_barcodes bc WHERE bc.barcode LIKE @like))
  `).get({ q, like, categoryId, includeInactive: includeInactive ? 1 : 0 }).n;
}

function insert(row) {
  const keys = Object.keys(row);
  db.get().prepare(`
    INSERT INTO products (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})
  `).run(row);
  return findById(row.id);
}

const UPDATABLE = [
  'sku', 'name', 'category_id', 'brand_id', 'base_unit_id', 'description', 'tax_class',
  'statutory_discount_eligible', 'avg_cost_centavos', 'avg_cost_as_of', 'min_stock_milli',
  'is_batch_tracked', 'is_active', 'updated_at', 'updated_by',
];

function updateFields(id, fields) {
  const keys = Object.keys(fields).filter((k) => UPDATABLE.includes(k));
  if (keys.length === 0) return findById(id);

  db.get()
    .prepare(`UPDATE products SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`)
    .run({ ...fields, id });
  return findById(id);
}

// ── Barcodes (VR-205) ───────────────────────────────────────────────────────

function barcodesFor(productId) {
  return db.get()
    .prepare('SELECT id, barcode, created_at FROM product_barcodes WHERE product_id = ? ORDER BY created_at')
    .all(productId);
}

function findByBarcode(barcode) {
  const row = db.get().prepare('SELECT product_id FROM product_barcodes WHERE barcode = ?').get(barcode);
  return row ? findById(row.product_id) : null;
}

function findBarcode(barcode) {
  return db.get()
    .prepare('SELECT id, product_id, barcode FROM product_barcodes WHERE barcode = ?')
    .get(barcode) || null;
}

function insertBarcode(row) {
  db.get().prepare(`
    INSERT INTO product_barcodes (id, product_id, barcode, created_at)
    VALUES (@id, @product_id, @barcode, @created_at)
  `).run(row);
  return row;
}

function deleteBarcode(id) {
  // Not a VR-206 deletion: a barcode is a label on a box, not history. Detaching a
  // mis-scanned code has to be possible or the code is unusable forever, and no
  // movement, sale or ledger row references product_barcodes.
  db.get().prepare('DELETE FROM product_barcodes WHERE id = ?').run(id);
}

// ── Packs (UOM-002) ─────────────────────────────────────────────────────────

/**
 * How many products are batch-tracked, in the whole catalogue or in one category.
 *
 * Read by the stock count, which leaves them off its sheet (INV-201) and has to be
 * able to say how many it left off.
 */
function countBatchTracked({ categoryId = null } = {}) {
  return db.get().prepare(`
    SELECT COUNT(*) AS n FROM products
     WHERE is_batch_tracked = 1
       AND (@categoryId IS NULL OR category_id = @categoryId)
  `).get({ categoryId }).n;
}

function packsFor(productId) {
  return db.get().prepare(`
    SELECT pk.id, pk.unit_id, pk.factor_milli, pk.is_default_sell, pk.created_at,
           u.code AS unit_code, u.name AS unit_name
      FROM product_packs pk
      JOIN units u ON u.id = pk.unit_id
     WHERE pk.product_id = ?
     ORDER BY pk.factor_milli
  `).all(productId);
}

function insertPack(row) {
  db.get().prepare(`
    INSERT INTO product_packs (id, product_id, unit_id, factor_milli, is_default_sell, created_at)
    VALUES (@id, @product_id, @unit_id, @factor_milli, @is_default_sell, @created_at)
  `).run(row);
  return row;
}

function clearDefaultPack(productId) {
  db.get().prepare('UPDATE product_packs SET is_default_sell = 0 WHERE product_id = ?').run(productId);
}

function deletePack(id) {
  db.get().prepare('DELETE FROM product_packs WHERE id = ?').run(id);
}

// ── Prices (PR-101, PR-102) ─────────────────────────────────────────────────

function insertPrice(row) {
  db.get().prepare(`
    INSERT INTO product_prices (id, product_id, price_level, price_centavos, effective_from, created_at, created_by)
    VALUES (@id, @product_id, @price_level, @price_centavos, @effective_from, @created_at, @created_by)
  `).run(row);
  return row;
}

/**
 * The price in force for one level at one instant: the newest row dated at or before
 * it. A future-dated price is invisible until its day arrives, which is how a price
 * list can be loaded in advance without changing what the counter charges today.
 */
function priceAt(productId, level, at) {
  return db.get().prepare(`
    SELECT id, price_level, price_centavos, effective_from, created_at, created_by
      FROM product_prices
     WHERE product_id = ? AND price_level = ? AND effective_from <= ?
     ORDER BY effective_from DESC, created_at DESC
     LIMIT 1
  `).get(productId, level, at) || null;
}

/** Every level's current price in one statement, for the editor and the list. */
// ── PR-101 levels 1 and 2 (TASK-024) ────────────────────────────────────────

/**
 * PR-103 — the price this customer has negotiated for this product, as at a moment.
 *
 * The same shape `priceAt` takes for a level price, for the same reason: a customer
 * price is superseded by a later row, never updated, so "the price now" is the newest
 * row not in the future.
 */
function customerPriceAt(customerId, productId, at) {
  return db.get().prepare(`
    SELECT id, customer_id, product_id, price_centavos, effective_from, note, created_at, created_by
      FROM customer_prices
     WHERE customer_id = ? AND product_id = ? AND effective_from <= ?
     ORDER BY effective_from DESC, created_at DESC
     LIMIT 1
  `).get(customerId, productId, at) || null;
}

/** Every customer price standing against one customer, newest per product. */
function customerPricesFor(customerId, at) {
  return db.get().prepare(`
    SELECT cp.product_id, p.sku, p.name AS product_name, cp.price_centavos,
           cp.effective_from, cp.note, u.code AS base_unit_code
      FROM customer_prices cp
      JOIN products p ON p.id = cp.product_id
      JOIN units u ON u.id = p.base_unit_id
     WHERE cp.customer_id = @customerId
       AND cp.effective_from <= @at
       AND cp.effective_from = (
         SELECT MAX(x.effective_from) FROM customer_prices x
          WHERE x.customer_id = cp.customer_id AND x.product_id = cp.product_id
            AND x.effective_from <= @at)
     ORDER BY p.name COLLATE NOCASE
  `).all({ customerId, at });
}

function insertCustomerPrice(row) {
  const keys = Object.keys(row);
  db.get().prepare(`
    INSERT INTO customer_prices (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})
  `).run(row);
  return row;
}

/**
 * PR-104 — the band set in force for one product and level, ascending.
 *
 * The **set**, not a band: PR-104's rules are properties of the set — ascending,
 * non-overlapping, each cheaper than the one below — and a caller handed one band at a
 * time cannot check any of them.
 *
 * The table holds the current set only. `setQuantityBreaks` clears the level and
 * writes the new one in a transaction, because an append-only band table cannot
 * express "no bands at all" — writing an empty generation writes no rows, and the old
 * set would stay in force. 013's own header explains the asymmetry with
 * `customer_prices`, which does not have that problem because a price always exists.
 */
function quantityBreaksAt(productId, priceLevel) {
  return db.get().prepare(`
    SELECT id, product_id, price_level, min_qty_milli, price_centavos, defined_at
      FROM product_quantity_breaks
     WHERE product_id = ? AND price_level = ?
     ORDER BY min_qty_milli
  `).all(productId, priceLevel);
}

/** Every level's current band set, for the product editor. */
function allQuantityBreaks(productId) {
  return db.get().prepare(`
    SELECT id, product_id, price_level, min_qty_milli, price_centavos, defined_at
      FROM product_quantity_breaks
     WHERE product_id = ?
     ORDER BY price_level, min_qty_milli
  `).all(productId);
}

/** Clear one level's set, so the replacement is the whole of it. */
function deleteQuantityBreaks(productId, priceLevel) {
  return db.get()
    .prepare('DELETE FROM product_quantity_breaks WHERE product_id = ? AND price_level = ?')
    .run(productId, priceLevel).changes;
}

function insertQuantityBreak(row) {
  const keys = Object.keys(row);
  db.get().prepare(`
    INSERT INTO product_quantity_breaks (${keys.join(', ')})
    VALUES (${keys.map((k) => `@${k}`).join(', ')})
  `).run(row);
  return row;
}

function currentPrices(productId, at) {
  const prices = {};
  for (const level of ['RETAIL', 'WHOLESALE', 'DEALER']) {
    prices[level] = priceAt(productId, level, at);
  }
  return prices;
}

function priceHistory(productId, { limit = 100 } = {}) {
  return db.get().prepare(`
    SELECT id, price_level, price_centavos, effective_from, created_at, created_by
      FROM product_prices WHERE product_id = ?
     ORDER BY effective_from DESC, created_at DESC LIMIT ?
  `).all(productId, limit);
}

// ── References that make a product undeletable (VR-206) ─────────────────────

function tableExists(name) {
  return Boolean(
    db.get().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  );
}

/**
 * How many inventory movements exist for a product — the UOM-003 gate.
 *
 * inventory_movements arrives with TASK-007's migration 003. Until it does, "no
 * movements exist" is not a convenient assumption, it is the truth: at schema version
 * 2 the ledger has no rows because it has no table. The check is written this way so
 * that the base unit becomes immutable the moment the ledger exists, with no edit to
 * this file.
 */
function countMovements(productId) {
  if (!tableExists('inventory_movements')) return 0;
  return db.get()
    .prepare('SELECT COUNT(*) AS n FROM inventory_movements WHERE product_id = ?')
    .get(productId).n;
}

/** Everything that makes a product history rather than a draft (VR-206). */
function countReferences(productId) {
  let total = countMovements(productId);
  for (const [table, column] of [['sale_items', 'product_id'], ['purchase_order_items', 'product_id']]) {
    if (!tableExists(table)) continue;
    total += db.get().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(productId).n;
  }
  return total;
}

module.exports = {
  countBatchTracked,
  findById, findBySku, countAll, search, countSearch, insert, updateFields,
  barcodesFor, findByBarcode, findBarcode, insertBarcode, deleteBarcode,
  packsFor, insertPack, clearDefaultPack, deletePack,
  insertPrice, priceAt, currentPrices, priceHistory,
  customerPriceAt, customerPricesFor, insertCustomerPrice,
  quantityBreaksAt, allQuantityBreaks, insertQuantityBreak, deleteQuantityBreaks,
  countMovements, countReferences, tableExists,
};
