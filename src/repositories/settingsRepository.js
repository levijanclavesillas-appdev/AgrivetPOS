'use strict';

// OPS-005 storage. TASK-004 owns the settings registry — the full list of operator-
// owned figures, their validation and the SCR-702 screen. This is the read and write
// TASK-003 needs for the idle timeout, written in the file that task will extend.

const db = require('../config/database');

function get(key) {
  return db.get().prepare('SELECT key, value, value_type FROM system_settings WHERE key = ?').get(key);
}

function all() {
  return db.get().prepare('SELECT key, value, value_type FROM system_settings ORDER BY key').all();
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

module.exports = { get, all, put };
