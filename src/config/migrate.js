'use strict';

// Forward-only migration runner (05_TECH_SPEC.md §3.5, §8.9).
//
// Each file runs in its own transaction and is recorded in schema_migrations.
// A migration file is never edited once it has been applied anywhere — correcting
// one means writing the next one.
//
// ## Two number ranges, because there are two branches (PHARMACY_EDITION.md §3)
//
// `main` is the base product and is merged into `pharmacy`, never the reverse. The base
// product's migrations are 001–899 and are written on `main`; this edition's own are
// 900–999 and exist only here. So a base migration merged in from `main` can arrive
// *after* an edition one has already run, with a lower number.
//
// That is why "pending" means **every file the database has not recorded**, and never
// "every file above the highest number it has". Comparing highest numbers — which is
// what this product did until the edition had a migration of its own — would count a
// store at 900 as up to date and skip `main`'s 019 without a word. `status()` is the one
// place that question is answered; upgradeService, restore, health and import ask it.

const fs = require('fs');
const path = require('path');
const db = require('./database');
const paths = require('./paths');
const clock = require('./clock');

const FILENAME = /^(\d{3})_([a-z0-9_]+)\.sql$/;

class SchemaAheadOfBinaryError extends Error {
  constructor(dbVersion, binaryVersion, unknown = []) {
    super(
      `This database is at schema version ${dbVersion}, but this version of Chachi ` +
      `Pharmacy POS only knows up to ${binaryVersion}` +
      (unknown.some((version) => version !== dbVersion)
        ? ` and has never heard of migration ${unknown.join(', ')}` : '') +
      '. It was written by a newer ' +
      `installation. Install the current version before opening it — running an older ` +
      `build against a newer database loses data.`
    );
    this.name = 'SchemaAheadOfBinaryError';
    this.dbVersion = dbVersion;
    this.binaryVersion = binaryVersion;
    this.unknown = unknown;
  }
}

/** The first number of this edition's own range; everything below it is `main`'s. */
const EDITION_FLOOR = 900;

/** Migration files this binary ships, ascending. */
function available(dir = paths.migrationsDir()) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((file) => {
      const m = FILENAME.exec(file);
      return m ? { version: Number(m[1]), name: m[2], file, fullPath: path.join(dir, file) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.version - b.version);
}

/** The highest migration this binary can apply. 0 on a binary shipping none. */
function binaryVersion(dir) {
  const list = available(dir);
  return list.length ? list[list.length - 1].version : 0;
}

function migrationsTableExists(handle) {
  const row = handle
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  return Boolean(row);
}

/** Versions already applied to this database, ascending. */
function applied(handle = db.get()) {
  if (!migrationsTableExists(handle)) return [];
  return handle.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all();
}

/** The database's current schema version. 0 means "nothing applied yet". */
function schemaVersion(handle = db.get()) {
  const rows = applied(handle);
  return rows.length ? rows[rows.length - 1].version : 0;
}

/**
 * The database against this binary, by the set of migrations rather than the highest one.
 *
 *   pending   files this binary ships that the database has not recorded — to be run
 *   unknown   migrations the database has recorded that this binary does not ship — a
 *             newer build wrote it, and this one must not touch it
 */
function status({ dir = paths.migrationsDir(), handle = db.get() } = {}) {
  const files = available(dir);
  const done = applied(handle).map((row) => row.version);
  const recorded = new Set(done);
  const shipped = new Set(files.map((file) => file.version));
  return {
    current: done.length ? done[done.length - 1] : 0,
    binary: files.length ? files[files.length - 1].version : 0,
    applied: done,
    pending: files.filter((file) => !recorded.has(file.version)).map((file) => file.version),
    unknown: done.filter((version) => !shipped.has(version)),
  };
}

/**
 * Apply every pending migration, in order, each in its own transaction.
 *
 * Refuses to run — before touching anything — when the database is ahead of this
 * binary. A newer database opened by an older .exe is a data-loss event, not a
 * warning (05_TECH_SPEC.md §3.5).
 */
function migrate({ dir = paths.migrationsDir(), handle = db.get(), log = () => {} } = {}) {
  const list = available(dir);
  const before = status({ dir, handle });

  // Any recorded migration this binary does not ship means a newer build wrote the
  // database, whether or not its number is the highest.
  if (before.unknown.length) throw new SchemaAheadOfBinaryError(before.current, before.binary, before.unknown);

  const current = before.current;
  const pending = list.filter((m) => before.pending.includes(m.version));

  for (const migration of pending) {
    const sql = fs.readFileSync(migration.fullPath, 'utf8');
    // One transaction per migration: a failure leaves the database at the previous
    // version rather than half-migrated.
    handle.transaction(() => {
      handle.exec(sql);
      handle
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, clock.nowUtc());
    })();
    log(`applied ${migration.file}`);
  }

  return { from: current, to: schemaVersion(handle), applied: pending.map((m) => m.file) };
}

module.exports = {
  FILENAME, SchemaAheadOfBinaryError, EDITION_FLOOR,
  available, binaryVersion, applied, schemaVersion, status, migrate,
};

if (require.main === module) {
  db.open();
  try {
    const result = migrate({ log: (line) => process.stdout.write(`${line}\n`) });
    process.stdout.write(
      result.applied.length
        ? `schema ${result.from} -> ${result.to}\n`
        : `schema ${result.to}, nothing to apply\n`
    );
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
