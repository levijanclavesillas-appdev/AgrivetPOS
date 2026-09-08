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

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../config/database');
const ids = require('../config/ids');
const zip = require('../config/zip');

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
 * Snapshot, then archive (OPS-001, 05_TECH_SPEC.md §7).
 *
 * VACUUM INTO writes a plain SQLite file to a temporary path; that file is then
 * deflated into the .zip the operator actually keeps. The intermediate is removed
 * whether or not the archive succeeds — a stray uncompressed database sitting beside
 * the backups is a copy of the whole store's data nobody is tracking.
 *
 * The entry inside the archive is named `agrivet.db`, so the recovery instruction is
 * "open the zip and take out agrivet.db" rather than a scavenger hunt.
 */
const ENTRY_NAME = 'agrivet.db';

function archive(archivePath) {
  const staging = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-backup-')),
    `${ids.uuidv7()}.db`
  );

  try {
    snapshot(staging);
    const raw = fs.readFileSync(staging);
    fs.writeFileSync(archivePath, zip.zipOne(ENTRY_NAME, raw), { mode: 0o600 });
    return { path: archivePath, raw_bytes: raw.length, size_bytes: fs.statSync(archivePath).size };
  } finally {
    try {
      fs.rmSync(path.dirname(staging), { recursive: true, force: true });
    } catch { /* a leftover temp file is not worth failing a good backup over */ }
  }
}

/**
 * Extract the archive's database to a path of the caller's choosing.
 *
 * Shared by verification and by restore, so the two cannot disagree about what "the
 * database inside this backup" means.
 */
function extract(archivePath, targetPath) {
  const entry = zip.unzipOne(fs.readFileSync(archivePath));
  fs.writeFileSync(targetPath, entry.content, { mode: 0o600 });
  return { entry_name: entry.name, bytes: entry.content.length };
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
  let staged = null;

  try {
    // OPS-002 asks for the backup to be opened. With an archive that means unpacking
    // it first, which makes the check stronger rather than weaker: it proves the
    // archive can be read back and its checksum holds, not merely that bytes reached
    // the disk.
    staged = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-verify-')), 'copy.db');
    extract(filePath, staged);

    copy = new Database(staged, { readonly: true, fileMustExist: true });

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
    if (staged) {
      try {
        fs.rmSync(path.dirname(staged), { recursive: true, force: true });
      } catch { /* as above */ }
    }
  }
}

// ── The log (OPS-002, OPS-003, OPS-006) ─────────────────────────────────────

const LOG_COLUMNS = `
  id, filename, path, size_bytes, taken_at, trigger, verified_at,
  verification_result, error, schema_version, row_counts, created_by, pruned_at
`;

/** Whether TASK-017's table is here yet, for the readers that predate it. */
function logExists() {
  return Boolean(db.get()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backups'")
    .get());
}

function insertLog(row) {
  const keys = Object.keys(row);
  db.get()
    .prepare(`INSERT INTO backups (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`)
    .run(row);
  return findLog(row.id);
}

function findLog(id) {
  return db.get().prepare(`SELECT ${LOG_COLUMNS} FROM backups WHERE id = ?`).get(id) || null;
}

function updateLog(id, changes) {
  const keys = Object.keys(changes);
  if (keys.length === 0) return findLog(id);
  db.get()
    .prepare(`UPDATE backups SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`)
    .run({ ...changes, id });
  return findLog(id);
}

function listLog({ limit = 30, includePruned = true } = {}) {
  return db.get().prepare(`
    SELECT ${LOG_COLUMNS} FROM backups
    ${includePruned ? '' : 'WHERE pruned_at IS NULL'}
    ORDER BY taken_at DESC LIMIT ?
  `).all(limit);
}

/**
 * The newest backup that actually verified (OPS-002, OPS-006).
 *
 * `verification_result = 'OK'` and nothing else. A written-but-unverified file is not
 * an answer to "when were we last backed up", and treating it as one is the failure
 * mode the whole rule exists to prevent.
 */
function lastVerified() {
  return db.get().prepare(`
    SELECT ${LOG_COLUMNS} FROM backups
    WHERE verification_result = 'OK'
    ORDER BY taken_at DESC LIMIT 1
  `).get() || null;
}

/** OPS-003: the verified backups still on disk, oldest first, for pruning. */
function verifiedOnDisk() {
  return db.get().prepare(`
    SELECT ${LOG_COLUMNS} FROM backups
    WHERE verification_result = 'OK' AND pruned_at IS NULL
    ORDER BY taken_at ASC
  `).all();
}

// ── system_events (OPS-006, OPS-009) ────────────────────────────────────────

function insertEvent(row) {
  const keys = Object.keys(row);
  db.get()
    .prepare(`INSERT INTO system_events (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`)
    .run(row);
  return row;
}

function lastEvent(kind) {
  return db.get().prepare(`
    SELECT id, kind, occurred_at, ok, detail, actor_id FROM system_events
    WHERE kind = ? ORDER BY occurred_at DESC LIMIT 1
  `).get(kind) || null;
}

/** VR-103 / OPS-009: the newest timestamp any ledger has recorded. */
function latestRecordedAt() {
  const row = db.get().prepare(`
    SELECT MAX(at) AS at FROM (
      SELECT MAX(occurred_at) AS at FROM sales
      UNION ALL SELECT MAX(occurred_at) FROM inventory_movements
      UNION ALL SELECT MAX(occurred_at) FROM audit_logs
      UNION ALL SELECT MAX(taken_at) FROM backups
    )
  `).get();
  return row ? row.at : null;
}

module.exports = {
  ENTRY_NAME,
  snapshot, archive, extract, verify,
  logExists, insertLog, findLog, updateLog, listLog, lastVerified, verifiedOnDisk,
  insertEvent, lastEvent, latestRecordedAt,
};
