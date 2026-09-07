'use strict';

// OPS-005 storage. Rows only — the registry, the typing and the rules live in
// settingsService, because a repository that knows what a threshold means is a
// repository the next threshold has to be added to twice (05_TECH_SPEC.md §8.3).

const db = require('../config/database');

const COLUMNS = 'key, value, value_type, updated_at, updated_by';

function get(key) {
  return db.get().prepare(`SELECT ${COLUMNS} FROM system_settings WHERE key = ?`).get(key);
}

function all() {
  return db.get().prepare(`SELECT ${COLUMNS} FROM system_settings ORDER BY key`).all();
}

function count() {
  return db.get().prepare('SELECT COUNT(*) AS n FROM system_settings').get().n;
}

function put({ key, value, valueType, updatedAt = null, updatedBy = null }) {
  db.get().prepare(`
    INSERT INTO system_settings (key, value, value_type, updated_at, updated_by)
    VALUES (@key, @value, @valueType, @updatedAt, @updatedBy)
    ON CONFLICT(key) DO UPDATE SET
      value = @value, value_type = @valueType, updated_at = @updatedAt, updated_by = @updatedBy
  `).run({ key, value, valueType, updatedAt, updatedBy });
  return get(key);
}

module.exports = { get, all, count, put };
