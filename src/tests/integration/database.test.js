'use strict';

// The pragmas of 05_TECH_SPEC.md §3.2 and the transaction discipline of §8.3.
//
// OPS-008 — no committed transaction lost, no partial one committed — rests entirely
// on the first two pragmas, so they are read back off a live connection rather than
// assumed to have been set.

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../../config/database');
const temp = require('../helpers/tempdb');

test.afterEach(() => temp.cleanup());

test('all four pragmas are set on an open connection (OPS-008)', () => {
  temp.openMigrated('pragmas');
  const state = db.pragmaState();

  assert.equal(String(state.journal_mode).toLowerCase(), 'wal');
  assert.equal(Number(state.synchronous), 1, 'synchronous = NORMAL');
  assert.equal(Number(state.foreign_keys), 1, 'foreign_keys = ON');
  assert.equal(Number(state.busy_timeout), 5000);
});

test('transaction() commits on success', () => {
  temp.openMigrated('tx-commit');
  const repo = require('../../repositories/schemaRepository');
  const before = repo.rowCounts().system_settings;

  db.transaction(() => {
    db.get()
      .prepare('INSERT INTO system_settings (key, value, value_type) VALUES (?, ?, ?)')
      .run('idle_timeout_minutes', '15', 'INT');
  });

  assert.equal(repo.rowCounts().system_settings, before + 1);
});

test('transaction() rolls back entirely when the body throws', () => {
  temp.openMigrated('tx-rollback');
  const repo = require('../../repositories/schemaRepository');

  assert.throws(() => {
    db.transaction(() => {
      const stmt = db.get()
        .prepare('INSERT INTO system_settings (key, value, value_type) VALUES (?, ?, ?)');
      stmt.run('backup_retention', '30', 'INT');
      stmt.run('backup_hour', '21', 'INT');
      throw new Error('failure injected after the writes');
    });
  }, /failure injected/);

  assert.equal(repo.rowCounts().system_settings, 0, 'neither write survived');
});

test('a nested transaction is refused rather than opening a savepoint (§8.3)', () => {
  temp.openMigrated('tx-nested');

  assert.throws(
    () => db.transaction(() => db.transaction(() => 1)),
    /nested transaction/,
    'nesting must fail loudly; a silent savepoint hides a design error'
  );

  // The guard must not leave the depth counter poisoned for the next caller.
  assert.equal(db.transaction(() => 'fine'), 'fine');
});

test('transaction() returns the body\'s value', () => {
  temp.openMigrated('tx-return');
  assert.equal(db.transaction(() => 42), 42);
});
