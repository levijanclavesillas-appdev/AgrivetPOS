'use strict';

// AUD-605: audit rows are append-only and never deleted by any application path. This
// repository therefore exposes no update and no delete, and SEC-11 makes that absence
// the control rather than a convention — there is no code path to reach for.

const db = require('../config/database');

const COLUMNS = `
  id, occurred_at, actor_id, actor_username, approver_id, approver_username,
  action, entity_type, entity_id, before_value, after_value, reason, shift_id
`;

function insert(row) {
  db.get().prepare(`
    INSERT INTO audit_logs (${COLUMNS})
    VALUES (@id, @occurred_at, @actor_id, @actor_username, @approver_id, @approver_username,
            @action, @entity_type, @entity_id, @before_value, @after_value, @reason, @shift_id)
  `).run(row);
  return row;
}

function list({ actorId = null, entityType = null, entityId = null, action = null, limit = 100 } = {}) {
  return db.get().prepare(`
    SELECT ${COLUMNS} FROM audit_logs
     WHERE (@actorId    IS NULL OR actor_id    = @actorId)
       AND (@entityType IS NULL OR entity_type = @entityType)
       AND (@entityId   IS NULL OR entity_id   = @entityId)
       AND (@action     IS NULL OR action      = @action)
     ORDER BY occurred_at DESC, id DESC
     LIMIT @limit
  `).all({ actorId, entityType, entityId, action, limit });
}

function countAll() {
  return db.get().prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n;
}

module.exports = { insert, list, countAll };
