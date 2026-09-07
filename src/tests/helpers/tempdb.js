'use strict';

// A throwaway database per test. The application resolves its path from
// paths.dataDir(); tests bypass that with an explicit path so several databases can
// exist inside one test file.

const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../../config/database');
const migrate = require('../../config/migrate');
const secrets = require('../../config/secrets');

const made = [];

function freshDir(label = 'agrivet') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  made.push(dir);
  return dir;
}

/**
 * Open an empty database at a new path. Nothing is migrated.
 *
 * The data directory moves with it, so session.key (SEC-7) is written into the
 * throwaway directory and not into the developer's real one.
 */
function openEmpty(label) {
  db.close();
  const dir = freshDir(label);
  process.env.AGRIVET_DATA_DIR = dir;
  secrets.reset();
  db.open({ path: path.join(dir, 'agrivet.db') });
  return dir;
}

/**
 * Close and reopen the same database, as an application restart would.
 *
 * SEC-3 requires a lockout to survive this, which is why it is a helper and not an
 * inline detail of one test.
 */
function reopen(dir) {
  db.close();
  secrets.reset();
  db.open({ path: path.join(dir, 'agrivet.db') });
}

/** Open a database and bring it to the current schema version. */
function openMigrated(label) {
  const dir = openEmpty(label);
  migrate.migrate();
  return dir;
}

function cleanup() {
  db.close();
  secrets.reset();
  delete process.env.AGRIVET_DATA_DIR;
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

/** The system actor a first-run setup uses before any user exists (TASK-004 owns it). */
const SETUP_ACTOR = Object.freeze({ id: null, username: 'setup' });

/** Create a user directly through the service, as an administrator would. */
function seedUser({ username, role = 'CASHIER', password = 'correct-horse-battery', pin = null, fullName = null }) {
  const userService = require('../../services/userService');
  return userService.create(
    { username, fullName: fullName || username, password, role, pin },
    SETUP_ACTOR
  );
}

module.exports = { freshDir, openEmpty, openMigrated, reopen, cleanup, seedUser, SETUP_ACTOR };
