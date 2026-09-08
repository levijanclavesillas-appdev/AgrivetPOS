'use strict';

// The only module that opens the database, and — with repositories/ — one of the two
// places permitted to import better-sqlite3 (05_TECH_SPEC.md §8.1). That restriction
// is the whole of the SQLite -> PostgreSQL portability requirement, and TC-UT-99
// enforces it mechanically.

const Database = require('better-sqlite3');
const fs = require('fs');
const paths = require('./paths');

// 05_TECH_SPEC.md §3.2. OPS-008 rests on the first two: WAL plus synchronous=NORMAL
// is what makes an abrupt power loss lose no committed transaction and commit no
// partial one.
const PRAGMAS = [
  ['journal_mode', 'WAL'],
  ['synchronous', 'NORMAL'],
  ['foreign_keys', 'ON'],
  ['busy_timeout', '5000'],
];

let db = null;
let dbPath = null;
let depth = 0;

function applyPragmas(handle) {
  for (const [name, value] of PRAGMAS) handle.pragma(`${name} = ${value}`);
}

/** Open the database, creating the data directory if this is a first run. */
function open({ path: overridePath, readonly = false } = {}) {
  if (db) return db;
  dbPath = overridePath || paths.databasePath();
  if (!overridePath) paths.ensureDataDir();
  db = new Database(dbPath, { readonly });
  applyPragmas(db);
  return db;
}

function get() {
  return db || open();
}

function isOpen() {
  return db !== null;
}

function close() {
  if (!db) return;
  db.close();
  db = null;
  dbPath = null;
  depth = 0;
}

/**
 * Run fn inside one transaction and return its result. A service owns the
 * transaction; a repository never opens one (05_TECH_SPEC.md §8.3).
 *
 * Nesting throws rather than silently opening a savepoint: a service calling
 * another service's transaction is the design error the standard names, and it is
 * cheaper to fail here than to debug a half-committed sale.
 */
function transaction(fn, { immediate = false } = {}) {
  if (typeof fn !== 'function') throw new TypeError('transaction(fn) needs a function');
  if (depth > 0) {
    throw new Error(
      'nested transaction: a service owns the transaction, and nesting them is a ' +
      'design error (05_TECH_SPEC.md §8.3)'
    );
  }
  const handle = get();
  const wrapped = handle.transaction((...args) => fn(...args));
  depth += 1;
  try {
    // 05_TECH_SPEC.md §4.1 requires BEGIN IMMEDIATE for the sale. SQLite's default
    // BEGIN is deferred: it takes a read lock first and upgrades on the first write,
    // which can fail with SQLITE_BUSY partway through a transaction that has already
    // done work. IMMEDIATE takes the write lock up front, so a sale either starts or
    // does not — it never gets halfway and loses the race. v1.0 has one writer, so
    // this costs nothing today and is correct when v1.3's terminals arrive.
    return immediate ? wrapped.immediate() : wrapped();
  } finally {
    depth -= 1;
  }
}

/** Effective pragma values on the live connection — read back, not assumed. */
function pragmaState() {
  const handle = get();
  const state = {};
  for (const [name] of PRAGMAS) {
    const value = handle.pragma(name, { simple: true });
    state[name] = value;
  }
  return state;
}

/** Database size on disk, WAL and shm included — the figure OPS-006 reports. */
function sizeBytes() {
  if (!dbPath) return 0;
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += fs.statSync(dbPath + suffix).size;
    } catch {
      /* -wal and -shm are absent until the first write; that is not an error */
    }
  }
  return total;
}

function currentPath() {
  return dbPath;
}

module.exports = {
  PRAGMAS, open, get, isOpen, close, transaction, pragmaState, sizeBytes, currentPath,
};
