'use strict';

// TC-INST-01 and TC-INST-02 — the upgrade path (05_TECH_SPEC.md §7).
//
// This is where small-product installers lose data. The claim being tested is narrow
// and specific: an upgrade over a real prior install preserves the database, takes a
// **verified** backup before the first migration statement runs, migrates on first
// launch, and — if any of that fails — leaves the previous database exactly as it was
// and says so in words an owner can act on.
//
// Migrations are forward-only and are never edited once applied (§8.9). There is no
// down-migration in this product and there never will be: one that drops a column
// drops the data in it, and a store that upgraded on Tuesday and rolled back on
// Wednesday would lose Tuesday. **The pre-migration backup is the only way back**, so
// a failure to take one stops the upgrade rather than proceeding without it.
//
// These cases run against the working tree rather than the installed .exe, which is
// what a machine without Windows can do. The installed-build half is TASK-018's UAT.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../../config/database');
const migrate = require('../../config/migrate');
const server = require('../../server');
const upgradeService = require('../../services/upgradeService');
const backupService = require('../../services/backupService');
const backupRepository = require('../../repositories/backupRepository');
const settingsService = require('../../services/settingsService');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';

/**
 * A database as a **previous version** left it: migrated only as far as `toVersion`,
 * with a store, an owner and a product in it.
 *
 * Built by running the real migrations up to a point rather than by hand-writing an
 * old schema, so the fixture cannot drift away from what the previous release actually
 * produced.
 */
function priorInstall(toVersion) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-prior-'));
  const dbPath = path.join(dir, 'agrivet.db');

  // A directory holding only the migrations the previous release shipped. The real
  // runner is then pointed at it, so the fixture is the previous release's schema by
  // construction and cannot drift away from it the way a hand-written one would.
  const oldMigrations = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-migrations-'));
  for (const file of migrate.available().filter((m) => m.version <= toVersion)) {
    fs.copyFileSync(file.fullPath, path.join(oldMigrations, file.file));
  }

  process.env.AGRIVET_DATA_DIR = dir;
  require('../../config/secrets').reset();
  db.close();
  db.open({ path: dbPath });
  migrate.migrate({ dir: oldMigrations });
  assert.equal(migrate.schemaVersion(), toVersion, 'the fixture is at the previous version');

  return { dir, dbPath, oldMigrations };
}

test.after(() => temp.cleanup());

// ── TC-INST-01 ──────────────────────────────────────────────────────────────

test('TC-INST-01: an upgrade preserves the data, backs up first, and migrates on launch', async () => {
  // A store on the previous release: schema 8, with a day of its own data in it.
  const version = migrate.binaryVersion();
  assert.ok(version >= 9, 'there is at least one migration to apply');

  const prior = priorInstall(version - 1);

  temp.seedStore({ withOwner: false, taxMode: 'NONE' });
  const ref = temp.seedCatalog();
  temp.seedUser({ username: 'owner', role: 'OWNER', password: PASSWORD });
  const owner = authService.verifyToken(authService.login({ username: 'owner', password: PASSWORD }).token);
  productService.create({
    sku: 'FEED-001', name: 'Hog Grower Pellets',
    categoryId: ref.category.id, baseUnitId: ref.kg.id, retailPriceCentavos: 6000,
  }, owner);

  const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-upgrade-backups-'));
  db.transaction(() => settingsService.set('backup_folder', backups, owner));

  const before = {
    version: migrate.schemaVersion(),
    products: db.get().prepare('SELECT COUNT(*) AS n FROM products').get().n,
    users: db.get().prepare('SELECT COUNT(*) AS n FROM users').get().n,
  };
  assert.equal(before.version, version - 1, 'the fixture really is a version behind');
  assert.equal(before.products, 1);

  db.close();

  // The upgrade: what happens on the first launch after the new .exe is installed.
  const instance = await server.start({ listenPort: 0 });
  try {
    assert.equal(migrate.schemaVersion(), version, 'pending migrations ran on launch');

    // The data is still there. That is the whole claim.
    assert.equal(db.get().prepare('SELECT COUNT(*) AS n FROM products').get().n, before.products);
    assert.equal(db.get().prepare('SELECT COUNT(*) AS n FROM users').get().n, before.users);
    assert.equal(
      db.get().prepare('SELECT sku FROM products').get().sku, 'FEED-001',
      'and it is the same data, not a fresh database of the same shape'
    );

    // §7: a verified backup, before the first migration statement.
    const written = fs.readdirSync(backups).filter((f) => f.endsWith('.zip'));
    assert.equal(written.length, 1, 'one upgrade, one pre-migration backup');

    // The backup is taken before the migrations run, so on this particular upgrade
    // there was nowhere to record it — the `backups` table arrives in 009. The row is
    // written afterwards, because otherwise the most important backup a store ever
    // takes would be the one missing from its log.
    const logged = backupRepository.listLog({ limit: 10 })
      .find((row) => row.trigger === 'PRE_MIGRATION');
    assert.ok(logged, 'and it is in the log');
    assert.equal(logged.filename, written[0]);
    assert.equal(logged.verification_result, 'OK', 'OPS-002: opened and checked');

    // The way back really is a way back: the copy is the database as it was, at the
    // old schema, with the store's data in it.
    const staged = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-up-')), 'copy.db');
    backupRepository.extract(path.join(backups, written[0]), staged);
    const copy = new Database(staged, { readonly: true, fileMustExist: true });
    try {
      assert.equal(copy.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, before.version);
      assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM products').get().n, before.products);
      assert.equal(copy.pragma('integrity_check')[0].integrity_check, 'ok');
    } finally {
      copy.close();
    }
  } finally {
    await server.stop(instance);
  }
});

test('TC-INST-01: a second launch is a no-op — no backup, no migration', async () => {
  // The upgrade backup is taken because there is something to lose. An application
  // that took one on every launch would fill a USB stick and bury the one that matters.
  db.open();
  const folder = backupService.folder();
  const before = fs.readdirSync(folder).length;
  assert.ok(before > 0, 'the previous case left the upgrade backup');
  db.close();

  const instance = await server.start({ listenPort: 0 });
  try {
    assert.equal(upgradeService.inspect().state, 'CURRENT');
    assert.equal(fs.readdirSync(folder).length, before, 'nothing pending, nothing backed up');
  } finally {
    await server.stop(instance);
  }
});

test('TC-INST-01: a failed pre-migration backup stops the upgrade and changes nothing', async () => {
  const version = migrate.binaryVersion();
  const prior = priorInstall(version - 1);
  temp.seedStore({ withOwner: true, taxMode: 'NONE' });

  // No backup folder: the shape of an unplugged drive or a full disk.
  db.transaction(() => settingsService.set('backup_folder', '', require('../../services/setupService').SETUP_ACTOR));
  const at = migrate.schemaVersion();
  db.close();

  await assert.rejects(
    () => server.start({ listenPort: 0 }),
    (err) => {
      // Plain words, not a stack trace: this is what an owner reads at 7am.
      assert.match(err.message, /could not be taken first/);
      assert.match(err.message, /your data is untouched/i);
      assert.match(err.message, /start the application again/);
      return true;
    }
  );

  // And it really is untouched.
  db.open({ path: prior.dbPath });
  assert.equal(migrate.schemaVersion(), at, 'still at the previous version');
  db.close();
});

// ── TC-INST-02 ──────────────────────────────────────────────────────────────

test('TC-INST-02: a database ahead of the binary refuses to start, plainly', async () => {
  const prior = priorInstall(migrate.binaryVersion());

  // A newer release wrote a migration this build has never heard of.
  db.get().prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
    .run(migrate.binaryVersion() + 1, 'from_the_future', new Date().toISOString());

  const state = upgradeService.inspect();
  assert.equal(state.state, 'AHEAD');
  db.close();

  await assert.rejects(
    () => server.start({ listenPort: 0 }),
    (err) => {
      assert.match(err.message, /newer version of Chachi Agrivet POS/);
      assert.match(err.message, /Install the newer version again/);
      assert.match(err.message, /Nothing has been changed/);
      // Running an older binary against a newer schema is how a column that exists
      // gets written as if it did not.
      assert.doesNotMatch(err.message, /SQLITE|Error:|undefined/);
      return true;
    }
  );

  // Refused *before* anything was touched — including before a backup was taken, since
  // nothing is going to be changed.
  db.open({ path: prior.dbPath });
  assert.equal(migrate.schemaVersion(), migrate.binaryVersion() + 1);
  db.close();
});

test('TC-INST-02: the refusal names both versions, so a support call is one sentence', () => {
  const message = upgradeService.aheadMessage({ current: 12, binary: 9 });
  assert.match(message, /it is at version 12/);
  assert.match(message, /understands up to 9/);
});

// ── A fresh install ─────────────────────────────────────────────────────────

test('a fresh install migrates without taking a backup of nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-fresh-'));
  process.env.AGRIVET_DATA_DIR = dir;
  require('../../config/secrets').reset();

  const instance = await server.start({ listenPort: 0 });
  try {
    assert.equal(migrate.schemaVersion(), migrate.binaryVersion());
    assert.equal(upgradeService.inspect().state, 'CURRENT');
    // There was nothing to preserve, so nothing was preserved. A PRE_MIGRATION backup
    // of an empty database is a file that teaches the operator to ignore the folder.
    assert.equal(backupRepository.listLog({ limit: 10 }).length, 0);
  } finally {
    await server.stop(instance);
  }
});
