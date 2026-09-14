'use strict';

// `src/config/sqlite.js` — the one change the Android app needed from the server (TASK-049).
//
// On the tablet, better-sqlite3's addon is compiled into the APK and the app passes its path
// in AGRIVET_SQLITE_ADDON. What can be checked on a build machine is the mechanism: the same
// addon npm built, loaded by path instead of by better-sqlite3's own lookup, opens a working
// database — and without the variable, nothing changes. Each case runs in its own process,
// because the addon is loaded once per process and the variable is read at first open.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const ADDON = path.join(ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');

const probe = `
  const { openDatabase } = require(${JSON.stringify(path.join(ROOT, 'src', 'config', 'sqlite'))});
  const db = openDatabase(':memory:');
  db.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (41), (1)');
  process.stdout.write(JSON.stringify({
    sum: db.prepare('SELECT SUM(x) AS s FROM t').get().s,
    foreignKeys: db.pragma('foreign_keys', { simple: true }),
  }));
`;

const run = (env) => {
  const result = spawnSync(process.execPath, ['-e', probe], { env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

test('TASK-049: a database opens through an addon loaded by path, as the tablet loads it', () => {
  const opened = run({ AGRIVET_SQLITE_ADDON: ADDON });
  assert.equal(opened.sum, 42);
  // SQLITE_DEFAULT_FOREIGN_KEYS=1 is one of better-sqlite3's own build options, and
  // android/app/src/main/cpp/CMakeLists.txt repeats it. The ledger's integrity leans on it.
  assert.equal(opened.foreignKeys, 1);
});

test('TASK-049: without the variable, better-sqlite3 finds its own addon as it always has', () => {
  const env = { ...process.env };
  delete env.AGRIVET_SQLITE_ADDON;
  const result = spawnSync(process.execPath, ['-e', probe], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sum, 42);
});

test('TASK-049: a wrong addon path is an error at open, not a silent fallback', () => {
  const result = spawnSync(process.execPath, ['-e', probe], {
    env: { ...process.env, AGRIVET_SQLITE_ADDON: path.join(ROOT, 'no-such-addon.so') }, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no-such-addon\.so/);
});
