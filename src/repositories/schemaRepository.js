'use strict';

// Repository layer: the only layer that knows better-sqlite3 exists, and the only
// layer that holds SQL (05_TECH_SPEC.md §8.1). A repository never opens a
// transaction — the service owns it (§8.3).

const db = require('../config/database');

/** Business tables present in the database, excluding SQLite's own bookkeeping. */
function listTables() {
  return db.get()
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' " +
      "AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((row) => row.name);
}

function listIndexes() {
  return db.get()
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' " +
      "AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((row) => row.name);
}

/** Row count per table — the figures OPS-006 puts on the health panel. */
function rowCounts() {
  const counts = {};
  for (const table of listTables()) {
    // Table names come from sqlite_master, never from a request, so interpolating
    // one here cannot carry user input. Quoted regardless.
    const row = db.get().prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get();
    counts[table] = row.n;
  }
  return counts;
}

/** PRAGMA integrity_check — 'ok' when the file is sound (OPS-002, OPS-006). */
function integrityCheck() {
  const rows = db.get().pragma('integrity_check');
  const results = rows.map((r) => r.integrity_check);
  return { ok: results.length === 1 && results[0] === 'ok', results };
}

function foreignKeyCheck() {
  return db.get().pragma('foreign_key_check');
}

module.exports = { listTables, listIndexes, rowCounts, integrityCheck, foreignKeyCheck };
