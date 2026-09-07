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

/** The system actor a first-run setup uses before any user exists (TASK-004). */
const SETUP_ACTOR = require('../../services/setupService').SETUP_ACTOR;

/**
 * Bring a migrated database to "installed": a store profile and the seeded settings.
 *
 * Most cases need an installation rather than a wizard — the setup gate refuses every
 * route until one exists (FR_1.1), so a test that skips this is testing the gate
 * whether it meant to or not. Cases that *are* about the wizard use a bare
 * openMigrated() and drive setupService themselves.
 */
function seedStore({ storeName = 'Test Agrivet Supply', taxMode = 'NONE', withOwner = true } = {}) {
  const storeProfileService = require('../../services/storeProfileService');
  const settingsService = require('../../services/settingsService');
  const userRepository = require('../../repositories/userRepository');

  const profile = storeProfileService.create({ storeName, taxMode });
  settingsService.seedDefaults();

  // setupService.isComplete() is profile AND active owner, so an installation without
  // one is still behind the gate. Cases that seed their own owner pass withOwner:false
  // rather than end up with two, which would quietly disarm VR-503.
  if (withOwner && userRepository.countActiveOwners() === 0) {
    seedUser({ username: 'installowner', role: 'OWNER', fullName: 'Install Owner' });
  }
  return profile;
}

/** Create a user directly through the service, as an administrator would. */
function seedUser({ username, role = 'CASHIER', password = 'correct-horse-battery', pin = null, fullName = null }) {
  const userService = require('../../services/userService');
  return userService.create(
    { username, fullName: fullName || username, password, role, pin },
    SETUP_ACTOR
  );
}

module.exports = { freshDir, openEmpty, openMigrated, reopen, cleanup, seedStore, seedUser, SETUP_ACTOR };
