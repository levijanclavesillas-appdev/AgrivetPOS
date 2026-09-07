'use strict';

// Boot order: open the database, migrate, then listen. The server never comes up
// against an unmigrated database — a half-ready API is worse than a slow start.

const http = require('http');
const db = require('./config/database');
const migrate = require('./config/migrate');
const { createApp } = require('./app');

// SEC-8: 127.0.0.1 only in v1.0, and not configurable. A POS API on an open LAN
// with no client authentication is a store-wide compromise; the bind address opens
// up in v1.3, when device authentication arrives with it.
const HOST = '127.0.0.1';
const DEFAULT_PORT = 47800;

function port() {
  return Number(process.env.AGRIVET_PORT) || DEFAULT_PORT;
}

async function start({ listenPort = port(), log = () => {} } = {}) {
  db.open();
  const result = migrate.migrate({ log });
  log(`schema version ${result.to}`);

  const app = createApp();
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(listenPort, HOST, () => resolve(s));
    s.on('error', reject);
  });
  log(`listening on http://${HOST}:${server.address().port}/api/v1`);
  return server;
}

/** Ask whether something is already answering as our API on this port. */
function probe({ listenPort = port(), timeoutMs = 1000 } = {}) {
  return new Promise((resolve) => {
    const req = http.get(
      `http://${HOST}:${listenPort}/api/v1/health`,
      { timeout: timeoutMs },
      (res) => { res.resume(); resolve(res.statusCode === 200); }
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/**
 * Start the API unless one is already answering on the port, in which case return
 * null and leave it alone.
 *
 * A store PC gets a double-clicked shortcut. A second launch must attach to the
 * running server rather than race it for the port and fail to open a window — and
 * two processes writing one SQLite file is not a state worth reaching.
 */
async function ensureStarted(opts = {}) {
  const listenPort = opts.listenPort || port();
  if (await probe({ listenPort })) {
    (opts.log || (() => {}))(`reusing the server already answering on http://${HOST}:${listenPort}`);
    return null;
  }
  return start({ ...opts, listenPort });
}

/** Poll until the API answers, so a window never loads against a dead port. */
async function waitForHealth({ listenPort = port(), attempts = 50, intervalMs = 100 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    if (await probe({ listenPort })) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function stop(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => {
      db.close();
      resolve();
    });
  });
}

module.exports = { start, stop, probe, ensureStarted, waitForHealth, HOST, DEFAULT_PORT, port };

if (require.main === module) {
  start({ log: (line) => process.stdout.write(`${line}\n`) }).catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
