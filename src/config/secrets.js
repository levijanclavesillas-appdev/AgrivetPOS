'use strict';

// SEC-7: the JWT signing secret is generated at install and stored in the application
// data directory with OS file permissions. It is never in the source, never in the
// database (a stolen database must not also yield the ability to mint sessions), and
// never logged.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const KEY_FILE = 'session.key';   // 05_TECH_SPEC.md §7 runtime layout
const KEY_BYTES = 64;

let cached = null;

function keyPath() {
  return path.join(paths.dataDir(), KEY_FILE);
}

/**
 * The signing secret, generated on first call and reused after.
 *
 * Written 0600 so that another account on the machine cannot read it. Windows ignores
 * the mode, which is why SEC-9's warning about who can read the data directory is
 * given to the operator in plain words rather than assumed away here.
 */
function sessionSecret() {
  if (cached) return cached;
  const file = keyPath();

  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) {
      cached = existing;
      return cached;
    }
    // A truncated or emptied key file invalidates every issued session anyway; a fresh
    // one at least leaves the app usable, and the old sessions were already dead.
  }

  paths.ensureDataDir();
  const secret = crypto.randomBytes(KEY_BYTES).toString('base64');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);   // in case the file pre-existed with a wider mode
  } catch {
    /* Windows: no POSIX mode to set */
  }
  cached = secret;
  return cached;
}

/** Test seam. Also used where a fresh data directory has replaced the old one. */
function reset() {
  cached = null;
}

module.exports = { KEY_FILE, keyPath, sessionSecret, reset };
