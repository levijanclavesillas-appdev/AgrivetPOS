'use strict';

// The one-row licence_state table (901_licence.sql).

const db = require('../config/database');

const get = () => db.get().prepare('SELECT * FROM licence_state WHERE id = 1').get() || null;

function ensure(installationId, at) {
  db.get().prepare(`INSERT INTO licence_state (id, installation_id, updated_at) VALUES (1, ?, ?)
                    ON CONFLICT(id) DO NOTHING`).run(installationId, at);
  return get();
}

const FIELDS = new Set(['licence', 'installation_secret', 'pending_device_code', 'pending_user_code',
  'pending_uri', 'pending_expires_at', 'last_attempt_at', 'last_error', 'max_seen_at']);

function update(changes, at) {
  const keys = Object.keys(changes).filter((k) => FIELDS.has(k));
  if (keys.length === 0) return get();
  db.get().prepare(`UPDATE licence_state SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @updated_at WHERE id = 1`)
    .run({ ...changes, updated_at: at });
  return get();
}

module.exports = { get, ensure, update };
