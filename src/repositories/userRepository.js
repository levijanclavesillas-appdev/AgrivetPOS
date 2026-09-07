'use strict';

// All user SQL. No business rule here — the service decides; this layer only reads and
// writes (05_TECH_SPEC.md §8.1, §8.2).

const db = require('../config/database');

const COLUMNS = `
  id, username, full_name, password_hash, pin_hash, role, recovery_code_hash,
  failed_attempts, locked_until_at, is_active, created_at, created_by
`;

function findById(id) {
  return db.get().prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`).get(id);
}

/** VR-501: username is unique and case-insensitive (the column is COLLATE NOCASE). */
function findByUsername(username) {
  return db.get().prepare(`SELECT ${COLUMNS} FROM users WHERE username = ?`).get(username);
}

function list({ includeInactive = false } = {}) {
  const where = includeInactive ? '' : 'WHERE is_active = 1';
  return db.get().prepare(`SELECT ${COLUMNS} FROM users ${where} ORDER BY username`).all();
}

function insert(user) {
  db.get().prepare(`
    INSERT INTO users (id, username, full_name, password_hash, pin_hash, role,
                       recovery_code_hash, failed_attempts, is_active, created_at, created_by)
    VALUES (@id, @username, @full_name, @password_hash, @pin_hash, @role,
            @recovery_code_hash, 0, @is_active, @created_at, @created_by)
  `).run(user);
  return findById(user.id);
}

function updateFields(id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return findById(id);
  const assignments = keys.map((k) => `${k} = @${k}`).join(', ');
  db.get().prepare(`UPDATE users SET ${assignments} WHERE id = @id`).run({ ...fields, id });
  return findById(id);
}

/** SEC-3: the counter lives in the database so the lock survives a restart. */
function recordFailedAttempt(id, { lockedUntilAt = null } = {}) {
  db.get().prepare(`
    UPDATE users
       SET failed_attempts = failed_attempts + 1,
           locked_until_at = COALESCE(?, locked_until_at)
     WHERE id = ?
  `).run(lockedUntilAt, id);
  return findById(id);
}

function clearFailedAttempts(id) {
  db.get().prepare('UPDATE users SET failed_attempts = 0, locked_until_at = NULL WHERE id = ?').run(id);
  return findById(id);
}

/** VR-503: the count that decides whether this owner is the last one. */
function countActiveOwners() {
  const row = db.get()
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'OWNER' AND is_active = 1")
    .get();
  return row.n;
}

function countAll() {
  return db.get().prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

module.exports = {
  findById, findByUsername, list, insert, updateFields,
  recordFailedAttempt, clearFailedAttempts, countActiveOwners, countAll,
};
