'use strict';

// Forward-only migration runner (05_TECH_SPEC.md §3.5, §8.9).
//
// Each file runs in its own transaction and is recorded in schema_migrations.
// A migration file is never edited once it has been applied anywhere — correcting
// one means writing the next one.

const fs = require('fs');
const path = require('path');
const db = require('./database');
const paths = require('./paths');
const clock = require('./clock');

const FILENAME = /^(\d{3})_([a-z0-9_]+)\.sql$/;

class SchemaAheadOfBinaryError extends Error {
  constructor(dbVersion, binaryVersion) {
    super(
      `This database is at schema version ${dbVersion}, but this version of Chachi ` +
      `Agrivet POS only knows up to ${binaryVersion}. It was written by a newer ` +
      `installation. Install the current version before opening it — running an older ` +
      `build against a newer database loses data.`
    );
    this.name = 'SchemaAheadOfBinaryError';
    this.dbVersion = dbVersion;
    this.binaryVersion = binaryVersion;
  }
}

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
 * Apply every pending migration, in order, each in its own transaction.
 *
 * Refuses to run — before touching anything — when the database is ahead of this
 * binary. A newer database opened by an older .exe is a data-loss event, not a
 * warning (05_TECH_SPEC.md §3.5).
 */
function migrate({ dir = paths.migrationsDir(), handle = db.get(), log = () => {} } = {}) {
  const list = available(dir);
  const known = list.length ? list[list.length - 1].version : 0;
  const current = schemaVersion(handle);

  if (current > known) throw new SchemaAheadOfBinaryError(current, known);

  const appliedVersions = new Set(applied(handle).map((r) => r.version));
  const pending = list.filter((m) => !appliedVersions.has(m.version));

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
  FILENAME, SchemaAheadOfBinaryError,
  available, binaryVersion, applied, schemaVersion, migrate,
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
