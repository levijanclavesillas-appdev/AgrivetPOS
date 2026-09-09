'use strict';

// The generic table reads and writes the export and import need, and nothing else.
//
// Every other repository in this project is shaped around one entity and knows its
// columns. This one cannot be: `OPS-101` asks for one JSON file per entity across the
// whole store, and twenty-odd bespoke `allRows()` methods would be twenty places to
// forget a table the day somebody adds one.
//
// **So the table name is a parameter, and that is the risk.** A repository that
// interpolates a caller's string into SQL is an injection waiting for a route to pass
// one through. The mitigation is `EXPORTABLE` below: a frozen allow-list, checked on
// every call, of tables this module will read or write. A name not on it is a
// programming error and throws — there is no path from a request body to a table name
// here, and the assertion is what keeps that true rather than a comment saying so.

const db = require('../config/database');
const errors = require('../services/errors');

/**
 * The tables an export carries, **in dependency order**.
 *
 * The order is the whole of the import's correctness: rows are written in this
 * sequence, so a foreign key's parent is always already there. It is not alphabetical
 * and must not be sorted — `sale_items` after `sales`, `credit_allocations` after the
 * transactions they cite.
 *
 * `schema_migrations` is absent deliberately: the target database has its own, applied
 * by its own binary, and importing somebody else's migration log would make a database
 * claim a history it does not have. `carts` is absent because a parked cart is a
 * moment in a shift, not data anybody archives (`POS-105`).
 */
const EXPORTABLE = Object.freeze([
  // Reference and identity first: everything else points at these.
  'users',
  'store_profile',
  'system_settings',
  'categories',
  'brands',
  'units',
  // Catalogue.
  'products',
  'product_barcodes',
  'product_packs',
  'product_prices',
  'product_quantity_breaks',
  // Customers and their credit.
  'customers',
  'customer_credit_accounts',
  'customer_prices',
  // Stock.
  'inventory',
  'inventory_movements',
  // Shifts, then the sales that cite them.
  'cashier_shifts',
  'till_movements',
  'cashier_closings',
  'closing_method_lines',
  'sales',
  'sale_items',
  'sale_tenders',
  'sale_discounts',
  // Credit transactions cite sales; allocations cite transactions.
  'customer_credit_transactions',
  'credit_allocations',
  // Purchasing.
  'suppliers',
  'purchase_orders',
  'purchase_order_items',
  'goods_receipts',
  'goods_receipt_items',
  // The v1.1 documents.
  'sale_returns',
  'sale_return_items',
  'stock_count_sessions',
  'stock_count_lines',
  // Operational history.
  'backups',
  'system_events',
  'alert_dismissals',
  'audit_logs',
]);

const EXPORTABLE_SET = new Set(EXPORTABLE);

function assertExportable(table) {
  if (!EXPORTABLE_SET.has(table)) {
    // A programming error, not a user error: nothing reaches here from a request.
    throw new RangeError(`${table} is not an exportable table (dataRepository.EXPORTABLE)`);
  }
  return table;
}

/**
 * Every row of one table, ordered by primary key.
 *
 * Ordered so that requirement 8's determinism is a property of the read rather than a
 * sort somebody remembers to do afterwards. `rowid` is SQLite's own and is stable for
 * a table that has never had a row deleted; the tables here are append-only or
 * near-enough, and where they are not the id is a UUIDv7 and therefore already
 * time-ordered (`VR-101`).
 */
function rowsOf(table) {
  assertExportable(table);
  return db.get().prepare(`SELECT * FROM ${table} ORDER BY ${primaryKeyOf(table).join(', ')}`).all();
}

function countOf(table) {
  assertExportable(table);
  return db.get().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

/**
 * The table's declared primary key columns, asked of SQLite rather than assumed.
 *
 * Nearly every table here is keyed on `id`, and assuming that is exactly the mistake:
 * `system_settings` is keyed on `key` and `inventory` on `product_id`. An `OPS-104`
 * collision check that only looked at `id` would report no collision for either, and
 * then a SKIP import would try to insert a settings row that is already there and fail
 * on the constraint — a rule not working, wearing the clothes of a database error.
 */
function primaryKeyOf(table) {
  assertExportable(table);
  const columns = db.get().prepare(`PRAGMA table_info(${table})`).all()
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  // A table with no declared primary key orders by SQLite's own rowid, which is stable
  // for the append-only tables here.
  return columns.length > 0 ? columns : ['rowid'];
}

function columnsOf(table) {
  assertExportable(table);
  return db.get().prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

/**
 * Every set of columns on which two rows would collide: the primary key, and each
 * UNIQUE index.
 *
 * **The natural keys are the ones that matter**, and looking only at the primary key
 * was the first version's mistake. Two stores set up independently have different
 * UUIDs for everything, so an archive's rows never collide on `id` — but they collide
 * constantly on `users.username`, `categories.name`, `units.code`, `products.sku` and
 * `customers.code`, because those are what a person types and two shops type the same
 * words. An `OPS-104` check blind to them reports "no collisions", and the import then
 * fails on a constraint halfway through: the rule not working, wearing the clothes of
 * a database error.
 */
function uniqueKeysOf(table) {
  assertExportable(table);
  const keys = [];

  const pk = primaryKeyOf(table);
  if (pk[0] !== 'rowid') keys.push(pk);

  for (const index of db.get().prepare(`PRAGMA index_list(${table})`).all()) {
    if (!index.unique) continue;
    const columns = db.get().prepare(`PRAGMA index_info(${index.name})`).all()
      .sort((a, b) => a.seqno - b.seqno)
      .map((c) => c.name);
    // A partial index does not constrain every row, so a value matching it is not
    // necessarily a collision. `PRAGMA index_list` reports those with `partial: 1`.
    if (index.partial) continue;
    if (columns.length > 0) keys.push(columns);
  }

  return keys;
}

/**
 * Whether a row would collide with one already here — `OPS-104`'s question.
 *
 * True if it clashes on **any** unique key, not only on identity. A `NULL` in a key
 * is not a collision: SQLite's UNIQUE permits any number of them, so a customer with
 * no code does not collide with another customer with no code.
 */
function existsByKey(table, row) {
  assertExportable(table);

  for (const key of uniqueKeysOf(table)) {
    const params = Object.fromEntries(key.map((column) => [column, row[column]]));
    if (key.some((column) => params[column] === undefined || params[column] === null)) continue;

    const where = key.map((column) => `${column} = @${column}`).join(' AND ');
    if (db.get().prepare(`SELECT 1 FROM ${table} WHERE ${where}`).get(params)) return true;
  }
  return false;
}

function insertRow(table, row) {
  assertExportable(table);
  const keys = Object.keys(row);
  db.get().prepare(`
    INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})
  `).run(row);
  return row;
}

/** `OPS-104`'s REPLACE: the colliding row goes, the incoming one takes its place. */
function replaceRow(table, row) {
  assertExportable(table);
  const keys = Object.keys(row);
  db.get().prepare(`
    INSERT OR REPLACE INTO ${table} (${keys.join(', ')})
    VALUES (${keys.map((k) => `@${k}`).join(', ')})
  `).run(row);
  return row;
}

/**
 * `PRAGMA foreign_key_check`, run inside the import's transaction before it commits.
 *
 * `OPS-102` asks for referential integrity to be validated before anything is written,
 * and `importService` does that against the archive's own contents. This is the second
 * pair of eyes: SQLite checking the database it actually has, so a reference into rows
 * the archive did not carry is caught by the engine rather than by our arithmetic.
 */
function foreignKeyViolations() {
  return db.get().prepare('PRAGMA foreign_key_check').all();
}

module.exports = {
  EXPORTABLE, assertExportable,
  rowsOf, countOf, columnsOf, primaryKeyOf, uniqueKeysOf,
  existsByKey, insertRow, replaceRow, foreignKeyViolations,
};
