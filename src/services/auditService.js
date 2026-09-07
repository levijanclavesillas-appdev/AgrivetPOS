'use strict';

// AUD-606: an audit row records UTC timestamp, actor id and username as text, action,
// entity type, entity id, before value, after value, reason, and the shift id where one
// is open. The username is denormalised so that deactivating a user does not blank the
// history.
//
// TASK-005 owns the audit service: the full AUD-601 action list, the SCR-703 screen,
// filtering and export. This is the write path TASK-003 needs, in the file that task
// extends.

const ids = require('../config/ids');
const clock = require('../config/clock');
const auditRepository = require('../repositories/auditRepository');

/**
 * Append one audit row. Never updates, never deletes (AUD-605).
 *
 * Called inside the caller's transaction where the audited change is transactional —
 * AUD-604 requires the recovery row to be written *before* the password reset takes
 * effect, and both must commit together or neither does.
 */
function record({
  actor, action, entityType, entityId = null,
  before = null, after = null, reason = null, approver = null, shiftId = null,
}) {
  if (!action) throw new TypeError('an audit row needs an action');
  if (!entityType) throw new TypeError('an audit row needs an entity type');
  if (!actor || !actor.username) {
    throw new TypeError('an audit row needs an actor username (AUD-606)');
  }

  return auditRepository.insert({
    id: ids.uuidv7(),
    occurred_at: clock.nowUtc(),
    actor_id: actor.id || null,
    actor_username: actor.username,
    approver_id: approver ? approver.id || null : null,
    approver_username: approver ? approver.username : null,
    action,
    entity_type: entityType,
    entity_id: entityId,
    before_value: before === null ? null : JSON.stringify(before),
    after_value: after === null ? null : JSON.stringify(after),
    reason,
    shift_id: shiftId,
  });
}

module.exports = { record, list: auditRepository.list };
