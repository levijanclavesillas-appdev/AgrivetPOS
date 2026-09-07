'use strict';

// Filesystem locations. 05_TECH_SPEC.md §7 fixes the runtime layout on the store PC:
//   %LOCALAPPDATA%\ChachiAgrivetPOS\{agrivet.db, session.key, logs\}
// A non-Windows path exists only so the suite runs on a developer machine; the
// product targets one Windows PC (01_PRODUCT_BRIEF.md D-2).

const os = require('os');
const path = require('path');
const fs = require('fs');

const APP_DIR_NAME = 'ChachiAgrivetPOS';

function dataDir() {
  // AGRIVET_DATA_DIR is how the test suite gets a throwaway database. It is never
  // set in a packaged build.
  if (process.env.AGRIVET_DATA_DIR) return process.env.AGRIVET_DATA_DIR;

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, APP_DIR_NAME);
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, APP_DIR_NAME);
}

function ensureDataDir() {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const databasePath = () => path.join(dataDir(), 'agrivet.db');
const logsDir = () => path.join(dataDir(), 'logs');
const migrationsDir = () => path.join(__dirname, '..', 'migrations');

module.exports = { APP_DIR_NAME, dataDir, ensureDataDir, databasePath, logsDir, migrationsDir };
