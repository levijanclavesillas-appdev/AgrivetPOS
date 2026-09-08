'use strict';

// OPS-001 / OPS-002 — writing a backup and proving it is one.
//
// The copy is taken with `VACUUM INTO`, which is SQLite's own snapshot: it is
// synchronous, takes a consistent view even in WAL mode with a write in flight, and
// produces a compacted file rather than a byte copy that would also carry the WAL.
// A filesystem copy of agrivet.db while the application is running is exactly the
// backup that restores into a half-written page (TC-INT-75).
//
// Verification opens the *copy* and runs an integrity check on it. Checking the
// original would prove nothing about the file that was written — OPS-002's whole point
// is that a backup nobody has opened is a hope.

const Database = require('better-sqlite3');
const db = require('../config/database');

/**
 * Snapshot the live database to `filePath`.
 *
 * The path is interpolated because VACUUM INTO takes no parameter binding. It comes
 * from the backup_folder setting and a generated timestamp, never from a request, and
 * a single quote in it would break the statement rather than escape it — so it is
 * rejected here rather than escaped.
 */
function snapshot(filePath) {
  if (/['\r\n]/.test(filePath)) {
    throw new RangeError(`a backup path may not contain a quote or newline: ${filePath}`);
  }
  db.get().exec(`VACUUM INTO '${filePath}'`);
  return filePath;
}

/**
 * Open the written file and check it (OPS-002).
 *
 * Read-only, so verification cannot itself modify what it is checking, and closed
 * again immediately — a held handle on a backup file is a file Windows will not let
 * anyone move.
 */
function verify(filePath) {
  let copy = null;
  try {
    copy = new Database(filePath, { readonly: true, fileMustExist: true });

    const integrity = copy.pragma('integrity_check').map((row) => row.integrity_check);
    if (integrity.length !== 1 || integrity[0] !== 'ok') {
      return { ok: false, error: `integrity_check: ${integrity.join('; ')}` };
    }

    const foreignKeys = copy.pragma('foreign_key_check');
    if (foreignKeys.length > 0) {
      return { ok: false, error: `${foreignKeys.length} foreign key violation(s) in the copy` };
    }

    // A file that passes an integrity check but has no schema is a valid empty
    // database, not a backup of this one.
    const version = copy
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get().version;
    if (!version) return { ok: false, error: 'the copy carries no schema version' };

    const counts = {};
    for (const table of ['sales', 'inventory_movements', 'customer_credit_transactions', 'audit_logs']) {
      counts[table] = copy.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
    }

    return { ok: true, schemaVersion: version, rowCounts: counts };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (copy) copy.close();
  }
}

module.exports = { snapshot, verify };
