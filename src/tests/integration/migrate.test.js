'use strict';

// TC-INT-01 — migrations apply once, are idempotent, and a database ahead of the
// binary refuses to start (05_TECH_SPEC.md §3.5, §8.9).
//
// This file writes raw SQL to build a database no production path can produce: one
// stamped with a schema version from the future. That is why src/tests is outside
// the TC-UT-99 scan.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const db = require('../../config/database');
const migrate = require('../../config/migrate');
const paths = require('../../config/paths');
const temp = require('../helpers/tempdb');

test.afterEach(() => temp.cleanup());

test('TC-INT-01: a fresh database applies every migration and records each one', () => {
  temp.openEmpty('migrate-fresh');
  assert.equal(migrate.schemaVersion(), 0, 'an empty database is at version 0');

  const result = migrate.migrate();

  // Asserted against the binary rather than a literal: a task that adds a migration
  // should not have to come back and edit this number, but it must still be true that
  // a fresh database ends up at exactly what this build ships.
  assert.equal(result.from, 0);
  assert.equal(result.to, migrate.binaryVersion());
  assert.deepEqual(result.applied, migrate.available().map((m) => m.file));
  assert.deepEqual(result.applied.slice(0, 3), ['001_foundation.sql', '002_catalog.sql', '003_inventory.sql']);

  const rows = migrate.applied();
  assert.equal(rows.length, migrate.binaryVersion());
  assert.deepEqual(rows.map((r) => r.version), rows.map((_, i) => i + 1), 'contiguous, ascending');
  assert.equal(rows[0].name, 'foundation');
  assert.equal(rows[1].name, 'catalog');
  assert.equal(rows[2].name, 'inventory');
  for (const row of rows) assert.match(row.applied_at, /Z$/, 'applied_at is stored UTC (VR-102)');
});

test('TC-INT-01: re-running migrations is a no-op', () => {
  temp.openMigrated('migrate-idempotent');
  const before = migrate.applied();

  const again = migrate.migrate();

  assert.deepEqual(again.applied, [], 'nothing should be re-applied');
  assert.equal(again.from, again.to);
  assert.deepEqual(migrate.applied(), before, 'the migration log is unchanged');
});

test('TC-INT-01: a database ahead of the binary refuses to start, with a clear message', () => {
  temp.openMigrated('migrate-ahead');

  // A database written by a newer installation. Stamped directly because no
  // application path can produce one.
  db.get()
    .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
    .run(99, 'from_the_future', new Date().toISOString());

  assert.equal(migrate.schemaVersion(), 99);
  assert.ok(migrate.binaryVersion() < 99, 'the binary is behind this database');

  let err;
  try {
    migrate.migrate();
  } catch (caught) {
    err = caught;
  }
  const binary = migrate.binaryVersion();
  assert.ok(err instanceof migrate.SchemaAheadOfBinaryError, 'it must refuse, not proceed');
  assert.equal(err.dbVersion, 99);
  assert.equal(err.binaryVersion, binary);
  // The message is read by a store owner, not a developer.
  assert.match(err.message, /schema version 99/);
  assert.match(err.message, new RegExp(`only knows up to ${binary}`));
  assert.match(err.message, /newer installation/);
  assert.ok(!/stack|undefined|\[object/i.test(err.message), 'no developer debris in the message');
});

test('TC-INT-01: a failing migration leaves the database at its previous version', () => {
  const dir = temp.openEmpty('migrate-rollback');
  const migDir = path.join(dir, 'migrations');
  fs.mkdirSync(migDir);
  fs.copyFileSync(
    path.join(paths.migrationsDir(), '001_foundation.sql'),
    path.join(migDir, '001_foundation.sql')
  );
  // 002 creates a table, then fails. Neither half may survive.
  fs.writeFileSync(
    path.join(migDir, '002_broken.sql'),
    'CREATE TABLE should_not_exist (id TEXT PRIMARY KEY);\nTHIS IS NOT SQL;\n'
  );

  assert.throws(() => migrate.migrate({ dir: migDir }));

  assert.equal(migrate.schemaVersion(), 1, 'still at 001');
  const tables = require('../../repositories/schemaRepository').listTables();
  assert.ok(!tables.includes('should_not_exist'), 'the half-applied table was rolled back');
});

test('the migrations create exactly the tables of 05_TECH_SPEC.md §3.4', () => {
  temp.openMigrated('migrate-shape');
  const repo = require('../../repositories/schemaRepository');

  assert.deepEqual(repo.listTables().sort(), [
    // 001_foundation
    'audit_logs', 'schema_migrations', 'store_profile', 'system_settings', 'users',
    // 002_catalog
    'brands', 'categories', 'product_barcodes', 'product_packs', 'product_prices',
    'products', 'units',
    // 003_inventory
    'inventory', 'inventory_movements',
  ].sort());

  for (const index of ['idx_audit_time', 'idx_audit_entity', 'idx_barcode', 'idx_prices_lookup',
    'idx_products_name', 'idx_products_category', 'idx_products_active',
    'idx_move_product', 'idx_move_ref', 'idx_move_corrects']) {
    assert.ok(repo.listIndexes().includes(index), `missing index ${index}`);
  }
  assert.ok(repo.integrityCheck().ok, 'a freshly migrated database passes integrity_check');
  assert.deepEqual(repo.foreignKeyCheck(), [], 'no foreign key violations');
});

test('TC-INT-05: an audit row is writable before cashier_shifts exists', () => {
  // The guard on 05_TECH_SPEC.md §3.4: audit_logs.shift_id carries no foreign key.
  // Declaring one makes SQLite resolve cashier_shifts at INSERT time, and that table
  // does not exist until migration 005 — so every audit write, NULL shift_id included,
  // would fail from first-run setup (AUD-604) onwards.
  temp.openMigrated('audit-writable');
  const repo = require('../../repositories/schemaRepository');
  assert.ok(!repo.listTables().includes('cashier_shifts'), 'shifts arrive in 005');

  const insert = db.get().prepare(
    'INSERT INTO audit_logs (id, occurred_at, actor_username, action, entity_type, shift_id) ' +
    'VALUES (?, ?, ?, ?, ?, ?)'
  );

  // Both shapes must work: setup writes before any shift exists, and a later write
  // carries a shift id whose table this schema version cannot see.
  assert.doesNotThrow(() => insert.run('a1', '2026-09-07T00:00:00.000Z', 'owner', 'SETUP_COMPLETED', 'store_profile', null));
  assert.doesNotThrow(() => insert.run('a2', '2026-09-07T00:00:01.000Z', 'owner', 'SETTING_CHANGED', 'system_settings', 'shift-not-yet-a-table'));

  assert.equal(repo.rowCounts().audit_logs, 2);
  assert.deepEqual(repo.foreignKeyCheck(), [], 'no foreign key violations were introduced');
});
