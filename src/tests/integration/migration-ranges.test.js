'use strict';

// The two migration ranges — PHARMACY_EDITION.md §3, config/migrate.js.
//
// `main` is the base product and is merged into `pharmacy`, never the reverse. So the
// base product's migrations (001–899) are written on `main`, this edition's (900–999)
// only here, and a base migration merged in later can land *below* an edition one that
// a store has already run. Four things have to hold for that to be safe, and each is a
// case here rather than a sentence in a document:
//
//   1. every migration below 900 is one of the base product's, byte for byte, as listed
//      in `src/tests/fixtures/base-migrations.sha256` — an edition change written into
//      the base range is the collision the ranges exist to prevent. The list lives on
//      this branch, so the check reads nothing outside it: no `main`, no git;
//   2. this edition's own migrations are 900 and up;
//   3. a base migration merged in below an edition one still runs;
//   4. a recorded migration this build does not ship is refused, even when it is not
//      the highest number.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const db = require('../../config/database');
const migrate = require('../../config/migrate');
const temp = require('../helpers/tempdb');

const ROOT = path.join(__dirname, '..', '..', '..');

test.after(() => temp.cleanup());

const LOCK = path.join(ROOT, 'src', 'tests', 'fixtures', 'base-migrations.sha256');

/** The base product's migrations this branch carries, as { file: sha256 }. */
const baseLock = () => Object.fromEntries(fs.readFileSync(LOCK, 'utf8').split('\n')
  .filter((line) => line.trim() && !line.startsWith('#'))
  .map((line) => line.trim().split(/\s+/)));

test('every migration below 900 is a base migration this branch has recorded, byte for byte', () => {
  const lock = baseLock();
  const base = migrate.available().filter((m) => m.version < migrate.EDITION_FLOOR);
  assert.ok(base.length > 0);
  for (const m of base) {
    assert.ok(lock[m.file], `${m.file} is below ${migrate.EDITION_FLOOR} and not in `
      + 'src/tests/fixtures/base-migrations.sha256. If it came from main, add its line there; '
      + `if it is a pharmacy change, renumber it to ${migrate.EDITION_FLOOR} or above.`);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(m.fullPath)).digest('hex');
    assert.equal(hash, lock[m.file], `${m.file} has changed. A migration is never edited once written (§8.9)`);
  }
  // And nothing listed has gone missing: a base migration deleted here would leave a
  // store that ran it looking "ahead" of this build.
  for (const file of Object.keys(lock)) {
    assert.ok(base.some((m) => m.file === file), `${file} is listed but not in src/migrations`);
  }
});

test('this edition\'s own migrations are numbered from 900', () => {
  const edition = migrate.available().filter((m) => m.version >= migrate.EDITION_FLOOR);
  assert.deepEqual(edition.map((m) => m.file), ['900_generic_name.sql', '901_licence.sql', '902_product_images.sql', '903_batch_recall.sql']);
});

/** A database built from a chosen set of this build's migration files. */
function databaseFrom(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmacy-migrations-'));
  for (const m of files) fs.copyFileSync(m.fullPath, path.join(dir, m.file));
  temp.openEmpty('migration-ranges');
  migrate.migrate({ dir });
  return dir;
}

test('a base migration merged in below an edition one still runs', () => {
  // A pharmacy store today: every base migration, and the edition's 900.
  const dir = databaseFrom(migrate.available());
  const top = migrate.available().filter((m) => m.version < migrate.EDITION_FLOOR).slice(-1)[0].version;
  const next = String(top + 1).padStart(3, '0');

  // Then main ships its next migration, and it is merged in.
  fs.writeFileSync(path.join(dir, `${next}_from_main.sql`), 'CREATE TABLE merged_from_main (x INTEGER);\n');

  const behind = migrate.status({ dir });
  assert.equal(behind.current, migrate.available().slice(-1)[0].version, 'the highest applied number already covers it');
  assert.deepEqual(behind.pending, [top + 1], '…and it is pending all the same');

  const result = migrate.migrate({ dir });
  assert.deepEqual(result.applied, [`${next}_from_main.sql`]);
  assert.ok(db.get().prepare("SELECT 1 FROM sqlite_master WHERE name = 'merged_from_main'").get());
  assert.deepEqual(migrate.status({ dir }).pending, []);
});

test('a recorded migration this build does not ship is refused, even below the highest', () => {
  const dir = databaseFrom(migrate.available());
  // What a newer build would leave: main's next migration recorded, and this build
  // without the file for it. Its number is below 900, so "highest applied > highest
  // shipped" would never notice.
  const top = migrate.available().filter((m) => m.version < migrate.EDITION_FLOOR).slice(-1)[0].version;
  db.get().prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
    .run(top + 1, 'from_a_newer_build', new Date().toISOString());

  assert.deepEqual(migrate.status({ dir }).unknown, [top + 1]);
  assert.throws(() => migrate.migrate({ dir }), (err) => err instanceof migrate.SchemaAheadOfBinaryError
    && new RegExp(`never heard of migration ${top + 1}`).test(err.message));
});
