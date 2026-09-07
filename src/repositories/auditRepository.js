'use strict';

// AUD-605: audit rows are append-only and never deleted by any application path. This
// repository therefore exposes no update and no delete, and SEC-11 makes that absence
// the control rather than a convention — there is no code path to reach for.
//
// TC-UT-07 greps this file for an UPDATE or DELETE against audit_logs and fails the
// build if one ever appears, because "we agreed not to" is not an integrity control.

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

/**
 * The filter clause SCR-703 needs, written once and shared by list and count so a
 * paged result and its total can never disagree about what was being filtered.
 *
 * Every parameter is null-tolerant: a null means "do not filter on this", which keeps
 * the query one prepared statement rather than a string built per request.
 */
const WHERE = `
  WHERE (@actorId       IS NULL OR actor_id       = @actorId)
    AND (@actorUsername IS NULL OR actor_username = @actorUsername COLLATE NOCASE)
    AND (@action        IS NULL OR action         = @action)
    AND (@entityType    IS NULL OR entity_type    = @entityType)
    AND (@entityId      IS NULL OR entity_id      = @entityId)
    AND (@fromAt        IS NULL OR occurred_at   >= @fromAt)
    AND (@toAt          IS NULL OR occurred_at   <= @toAt)
`;

const filterParams = ({
  actorId = null, actorUsername = null, action = null,
  entityType = null, entityId = null, fromAt = null, toAt = null,
} = {}) => ({ actorId, actorUsername, action, entityType, entityId, fromAt, toAt });

/**
 * Newest first, then by id.
 *
 * The id tiebreak is not decoration: ids are UUIDv7 (VR-101), so they order by
 * creation time within the same millisecond. Two rows written by one transaction —
 * an override and the sale that carried it — share a timestamp to the millisecond and
 * would otherwise come back in an order SQLite is free to change between runs.
 */
function list({ limit = 100, offset = 0, ...filters } = {}) {
  return db.get().prepare(`
    SELECT ${COLUMNS} FROM audit_logs
    ${WHERE}
     ORDER BY occurred_at DESC, id DESC
     LIMIT @limit OFFSET @offset
  `).all({ ...filterParams(filters), limit, offset });
}

function count(filters = {}) {
  return db.get().prepare(`SELECT COUNT(*) AS n FROM audit_logs ${WHERE}`).get(filterParams(filters)).n;
}

function countAll() {
  return db.get().prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n;
}

/** The distinct actors present in the trail, for SCR-703's filter dropdown. */
function actors() {
  return db.get().prepare(`
    SELECT actor_username AS username, COUNT(*) AS rows_written
      FROM audit_logs
     GROUP BY actor_username
     ORDER BY actor_username
  `).all();
}

module.exports = { insert, list, count, countAll, actors };
