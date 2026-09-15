'use strict';

// TASK-063 — the rows a store's web copy and its devices exchange.
//
// Change capture is by trigger, generated here from the live schema whenever this
// installation is a hub or a device: an insert, an update (with the columns that
// changed) or a delete on any synced table lands a row in sync_changes. Nothing in a
// service has to remember to record anything, which is the only way a rule this wide
// stays true as the product grows.
//
// Two flags in sync_state steer the triggers while rows from elsewhere are written:
// `applying` silences them on a device (the hub's rows are not the device's changes),
// and `origin` stamps the hub's log with the device a row came from.

const db = require('../config/database');
const { LOCAL_TABLES, LOCAL_SETTINGS } = require('../config/syncTables');

const q = (name) => `"${String(name).replace(/"/g, '""')}"`;
const lit = (text) => `'${String(text).replace(/'/g, "''")}'`;

// ── The schema, as it is ────────────────────────────────────────────────────

function syncedTables() {
  return db.get()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name)
    .filter((name) => !LOCAL_TABLES.includes(name));
}

const columnCache = new Map();

function columnsOf(table) {
  if (!columnCache.has(table)) {
    columnCache.set(table, db.get().prepare(`PRAGMA table_info(${q(table)})`).all());
  }
  return columnCache.get(table);
}

function keyOf(table) {
  const key = columnsOf(table).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  if (key.length === 0) throw new RangeError(`${table} has no primary key and cannot be synced`);
  return key;
}

function isSynced(table) {
  return syncedTables().includes(table);
}

// ── Triggers ────────────────────────────────────────────────────────────────

function dropTriggers() {
  const names = db.get()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync\\_%' ESCAPE '\\'")
    .all();
  for (const { name } of names) db.get().exec(`DROP TRIGGER IF EXISTS ${q(name)}`);
  return names.length;
}

/**
 * The three triggers of one table. The update trigger names the columns whose value
 * moved, so two devices changing different fields of one row both keep their change.
 */
function triggerSql(table) {
  const cols = columnsOf(table).map((c) => c.name);
  const key = keyOf(table);
  const guard = '(SELECT applying FROM sync_state WHERE id = 1) = 0';
  const origin = '(SELECT origin FROM sync_state WHERE id = 1)';
  // A machine's own settings (its printer, its backup folder) are not the store's.
  const localKeys = LOCAL_SETTINGS.map(lit).join(', ');
  const settings = (row) => (table === 'system_settings' ? ` AND ${row}.key NOT IN (${localKeys})` : '');
  const pk = (row) => `json_array(${key.map((c) => `${row}.${q(c)}`).join(', ')})`;
  const changed = cols.map((c) => `CASE WHEN OLD.${q(c)} IS NOT NEW.${q(c)} THEN ${lit(`${c},`)} ELSE '' END`).join(' || ');
  const name = (suffix) => q(`sync_${table}_${suffix}`);

  return [
    `CREATE TRIGGER ${name('i')} AFTER INSERT ON ${q(table)} WHEN ${guard}${settings('NEW')}
     BEGIN INSERT INTO sync_changes (tbl, pk, op, origin) VALUES (${lit(table)}, ${pk('NEW')}, 'I', ${origin}); END`,
    `CREATE TRIGGER ${name('u')} AFTER UPDATE ON ${q(table)} WHEN ${guard}${settings('NEW')}
     BEGIN INSERT INTO sync_changes (tbl, pk, op, cols, origin)
       SELECT ${lit(table)}, ${pk('NEW')}, 'U', c, ${origin} FROM (SELECT ${changed} AS c) WHERE c <> ''; END`,
    `CREATE TRIGGER ${name('d')} AFTER DELETE ON ${q(table)} WHEN ${guard}${settings('OLD')}
     BEGIN INSERT INTO sync_changes (tbl, pk, op, origin) VALUES (${lit(table)}, ${pk('OLD')}, 'D', ${origin}); END`,
  ];
}

function installTriggers() {
  columnCache.clear();
  dropTriggers();
  const tables = syncedTables();
  for (const table of tables) for (const sql of triggerSql(table)) db.get().exec(sql);
  return tables.length;
}

function triggersInstalled() {
  return db.get()
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync\\_%' ESCAPE '\\'")
    .get().n > 0;
}

// ── Flags ───────────────────────────────────────────────────────────────────

function setApplying(on) {
  db.get().prepare('UPDATE sync_state SET applying = ? WHERE id = 1').run(on ? 1 : 0);
}

function setOrigin(origin) {
  db.get().prepare('UPDATE sync_state SET origin = ? WHERE id = 1').run(origin || null);
}

// ── The log ─────────────────────────────────────────────────────────────────

function changesAfter(afterId, { limit = 500 } = {}) {
  return db.get().prepare(`
    SELECT id, tbl, pk, op, cols, origin, at FROM sync_changes WHERE id > ? ORDER BY id LIMIT ?
  `).all(afterId, limit);
}

function maxChangeId() {
  return db.get().prepare('SELECT COALESCE(MAX(id), 0) AS id FROM sync_changes').get().id;
}

function countChangesAfter(afterId) {
  return db.get().prepare('SELECT COUNT(*) AS n FROM sync_changes WHERE id > ?').get(afterId).n;
}

function clearChanges() {
  db.get().exec('DELETE FROM sync_changes');
}

/** HUB: forget log entries every device has already pulled. */
function pruneChangesThrough(version) {
  return db.get().prepare('DELETE FROM sync_changes WHERE id <= ?').run(version).changes;
}

// ── Rows ────────────────────────────────────────────────────────────────────

const where = (key) => key.map((c) => `${q(c)} = ?`).join(' AND ');

function readRow(table, pkValues) {
  const key = keyOf(table);
  return db.get().prepare(`SELECT * FROM ${q(table)} WHERE ${where(key)}`).get(...pkValues) || null;
}

function assertColumns(table, names) {
  const known = new Set(columnsOf(table).map((c) => c.name));
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length > 0) {
    // A newer or older build's column: the two sides are on different schemas, which
    // the schema check before every exchange exists to stop reaching here.
    throw new RangeError(`${table} has no column ${unknown.join(', ')}`);
  }
}

/** Insert the row, or bring an existing one to these values. */
function upsertRow(table, data) {
  const names = Object.keys(data);
  assertColumns(table, names);
  const key = keyOf(table);
  const rest = names.filter((n) => !key.includes(n));
  const sql = `INSERT INTO ${q(table)} (${names.map(q).join(', ')}) VALUES (${names.map(() => '?').join(', ')})
    ON CONFLICT (${key.map(q).join(', ')}) DO ${rest.length
    ? `UPDATE SET ${rest.map((n) => `${q(n)} = excluded.${q(n)}`).join(', ')}`
    : 'NOTHING'}`;
  return db.get().prepare(sql).run(...names.map((n) => data[n])).changes;
}

/** Only the named columns; 0 when the row is not here. */
function updateRow(table, pkValues, data) {
  const names = Object.keys(data);
  if (names.length === 0) return 0;
  assertColumns(table, names);
  const key = keyOf(table);
  return db.get()
    .prepare(`UPDATE ${q(table)} SET ${names.map((n) => `${q(n)} = ?`).join(', ')} WHERE ${where(key)}`)
    .run(...names.map((n) => data[n]), ...pkValues).changes;
}

function deleteRow(table, pkValues) {
  return db.get().prepare(`DELETE FROM ${q(table)} WHERE ${where(keyOf(table))}`).run(...pkValues).changes;
}

function deleteAll(table) {
  db.get().exec(`DELETE FROM ${q(table)}`);
}

// ── A batch from elsewhere ──────────────────────────────────────────────────

/** Foreign keys are checked when the batch commits, so its rows can arrive in any order. */
function deferForeignKeys() {
  db.get().pragma('defer_foreign_keys = ON');
}

/** Rows whose parent is missing, found before the batch commits (and fails on them). */
function foreignKeyOrphans() {
  return db.get().pragma('foreign_key_check');
}

function deleteByRowid(table, rowid) {
  return db.get().prepare(`DELETE FROM ${q(table)} WHERE rowid = ?`).run(rowid).changes;
}

// ── What the hub works out for itself (INV-101, CR-103, PO-102) ─────────────

function recomputeOnHand(productId, at) {
  return db.get().prepare(`
    INSERT INTO inventory (product_id, qty_on_hand_milli, updated_at)
    VALUES (@productId, (SELECT COALESCE(SUM(qty_milli), 0) FROM inventory_movements WHERE product_id = @productId), @at)
    ON CONFLICT (product_id) DO UPDATE SET qty_on_hand_milli = excluded.qty_on_hand_milli, updated_at = excluded.updated_at
     WHERE inventory.qty_on_hand_milli <> excluded.qty_on_hand_milli
  `).run({ productId, at }).changes;
}

function recomputeCreditBalance(accountId, at) {
  return db.get().prepare(`
    UPDATE customer_credit_accounts
       SET balance_centavos = (SELECT COALESCE(SUM(amount_centavos), 0) FROM customer_credit_transactions WHERE account_id = @accountId),
           updated_at = @at
     WHERE id = @accountId
       AND balance_centavos <> (SELECT COALESCE(SUM(amount_centavos), 0) FROM customer_credit_transactions WHERE account_id = @accountId)
  `).run({ accountId, at }).changes;
}

// ── Identity and devices ────────────────────────────────────────────────────

const IDENTITY_COLUMNS = ['role', 'device_id', 'device_name', 'series', 'hub_url', 'device_secret',
  'pulled_version', 'pushed_change', 'linked_at', 'last_sync_at', 'last_error', 'updated_at'];

function identity() {
  const exists = db.get().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_identity'").get();
  if (!exists) return null;
  return db.get().prepare('SELECT * FROM sync_identity WHERE id = 1').get() || null;
}

function updateIdentity(fields) {
  const keys = Object.keys(fields).filter((k) => IDENTITY_COLUMNS.includes(k));
  if (keys.length === 0) return identity();
  db.get().prepare(`UPDATE sync_identity SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = 1`).run(fields);
  return identity();
}

function insertDevice(row) {
  const keys = Object.keys(row);
  db.get().prepare(`INSERT INTO sync_devices (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`).run(row);
  return findDevice(row.id);
}

function findDevice(id) {
  return db.get().prepare('SELECT * FROM sync_devices WHERE id = ?').get(id) || null;
}

function listDevices() {
  return db.get().prepare('SELECT * FROM sync_devices ORDER BY series').all();
}

function usedSeries() {
  return db.get().prepare('SELECT series FROM sync_devices').all().map((r) => r.series);
}

const DEVICE_COLUMNS = ['name', 'platform', 'app_version', 'last_seen_at', 'pushed_through', 'pulled_version', 'revoked_at', 'revoked_by'];

function updateDevice(id, fields) {
  const keys = Object.keys(fields).filter((k) => DEVICE_COLUMNS.includes(k));
  if (keys.length) {
    db.get().prepare(`UPDATE sync_devices SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
  }
  return findDevice(id);
}

/** The oldest version any live device still needs, for pruning the log. */
function lowestPulledVersion() {
  const row = db.get().prepare('SELECT MIN(pulled_version) AS v FROM sync_devices WHERE revoked_at IS NULL').get();
  return row.v;
}

module.exports = {
  syncedTables, columnsOf, keyOf, isSynced,
  triggerSql, installTriggers, dropTriggers, triggersInstalled,
  setApplying, setOrigin,
  changesAfter, maxChangeId, countChangesAfter, clearChanges, pruneChangesThrough,
  readRow, upsertRow, updateRow, deleteRow, deleteAll, deferForeignKeys, foreignKeyOrphans, deleteByRowid,
  recomputeOnHand, recomputeCreditBalance,
  identity, updateIdentity, insertDevice, findDevice, listDevices, usedSeries, updateDevice, lowestPulledVersion,
};
