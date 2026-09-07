'use strict';

// A throwaway database per test. The application resolves its path from
// paths.dataDir(); tests bypass that with an explicit path so several databases can
// exist inside one test file.

const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../../config/database');
const migrate = require('../../config/migrate');

const made = [];

function freshDir(label = 'agrivet') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  made.push(dir);
  return dir;
}

/** Open an empty database at a new path. Nothing is migrated. */
function openEmpty(label) {
  db.close();
  const dir = freshDir(label);
  db.open({ path: path.join(dir, 'agrivet.db') });
  return dir;
}

/** Open a database and bring it to the current schema version. */
function openMigrated(label) {
  const dir = openEmpty(label);
  migrate.migrate();
  return dir;
}

function cleanup() {
  db.close();
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { freshDir, openEmpty, openMigrated, cleanup };
