'use strict';

// User administration under TX-423. Every mutation here is audited (AUD-601): user
// create, modify, deactivate and role change are all on that rule's list.

const db = require('../config/database');
const ids = require('../config/ids');
const clock = require('../config/clock');
const errors = require('./errors');
const auth = require('./authService');
const auditService = require('./auditService');
const permissions = require('./permissions');
const userRepository = require('../repositories/userRepository');

function list({ includeInactive = false } = {}) {
  return userRepository.list({ includeInactive }).map(auth.toPublic);
}

function get(id) {
  const user = userRepository.findById(id);
  if (!user) throw errors.notFound('No such user');
  return auth.toPublic(user);
}

function assertRole(role) {
  if (!permissions.ROLES.includes(role)) {
    throw errors.badRequest(`Role must be one of ${permissions.ROLES.join(', ')}`, { ruleId: 'TX-423' });
  }
  return role;
}

/** VR-501: unique, case-insensitive. The column collates NOCASE; this is the message. */
function assertUsernameFree(username, { exceptId = null } = {}) {
  const existing = userRepository.findByUsername(username);
  if (existing && existing.id !== exceptId) {
    throw errors.conflict(`The username "${username}" is already taken`, { ruleId: 'VR-501' });
  }
}

/**
 * VR-503: the last active OWNER may not be deactivated or demoted.
 *
 * Without this an owner can lock themselves out of their own installation, and on an
 * offline product with no support channel that is unrecoverable short of a restore.
 */
function assertNotLastOwner(user, { becomingRole = null, becomingActive = null }) {
  if (user.role !== 'OWNER' || !user.is_active) return;
  const demoted = becomingRole !== null && becomingRole !== 'OWNER';
  const deactivated = becomingActive === false;
  if (!demoted && !deactivated) return;

  if (userRepository.countActiveOwners() <= 1) {
    throw errors.conflict(
      'This is the last active owner. Create another owner before ' +
      `${deactivated ? 'deactivating' : 'demoting'} this one.`,
      { ruleId: 'VR-503' }
    );
  }
}

function create({ username, fullName, password, role, pin = null }, actor) {
  const name = auth.validateUsername(username);
  auth.validatePassword(password);
  assertRole(role);
  if (typeof fullName !== 'string' || fullName.trim().length < 2) {
    throw errors.badRequest('Full name is required', { ruleId: 'VR-501' });
  }
  if (pin !== null) auth.validatePin(pin);
  assertUsernameFree(name);

  const row = {
    id: ids.uuidv7(),
    username: name,
    full_name: fullName.trim(),
    password_hash: auth.hashSecretValue(password),
    pin_hash: pin === null ? null : auth.hashSecretValue(pin),
    role,
    recovery_code_hash: null,
    is_active: 1,
    created_at: clock.nowUtc(),
    created_by: actor.id || null,
  };

  return db.transaction(() => {
    const created = userRepository.insert(row);
    auditService.write({
      actor,
      action: 'USER_CREATED',
      entityType: 'users',
      entityId: created.id,
      after: { username: created.username, role: created.role, is_active: true },
    });
    return auth.toPublic(created);
  });
}

/**
 * Change a user. Only the fields present are touched, and each one that AUD-601 lists
 * carries its before and after into the trail.
 */
function update(id, changes, actor) {
  const user = userRepository.findById(id);
  if (!user) throw errors.notFound('No such user');

  const fields = {};
  const before = {};
  const after = {};

  if (changes.username !== undefined) {
    const name = auth.validateUsername(changes.username);
    assertUsernameFree(name, { exceptId: id });
    fields.username = name;
    before.username = user.username;
    after.username = name;
  }
  if (changes.fullName !== undefined) {
    if (typeof changes.fullName !== 'string' || changes.fullName.trim().length < 2) {
      throw errors.badRequest('Full name is required', { ruleId: 'VR-501' });
    }
    fields.full_name = changes.fullName.trim();
    before.full_name = user.full_name;
    after.full_name = fields.full_name;
  }
  if (changes.role !== undefined) {
    assertRole(changes.role);
    assertNotLastOwner(user, { becomingRole: changes.role });
    fields.role = changes.role;
    before.role = user.role;
    after.role = changes.role;
  }
  if (changes.isActive !== undefined) {
    assertNotLastOwner(user, { becomingActive: Boolean(changes.isActive) });
    fields.is_active = changes.isActive ? 1 : 0;
    before.is_active = Boolean(user.is_active);
    after.is_active = Boolean(changes.isActive);
  }
  if (changes.password !== undefined) {
    auth.validatePassword(changes.password);
    fields.password_hash = auth.hashSecretValue(changes.password);
    // The hash itself never enters the trail (SEC-1); that it changed does.
    after.password_changed = true;
  }
  if (changes.pin !== undefined) {
    if (changes.pin === null) {
      fields.pin_hash = null;
      after.pin_cleared = true;
    } else {
      auth.validatePin(changes.pin);
      fields.pin_hash = auth.hashSecretValue(changes.pin);
      after.pin_set = true;
    }
  }

  if (Object.keys(fields).length === 0) return auth.toPublic(user);

  return db.transaction(() => {
    const updated = userRepository.updateFields(id, fields);
    auditService.write({
      actor,
      action: actionFor(changes, before, after),
      entityType: 'users',
      entityId: id,
      before: Object.keys(before).length ? before : null,
      after,
    });
    return auth.toPublic(updated);
  });
}

/**
 * One save is one row, and this chooses which action it is written under.
 *
 * AUD-601 lists "user create/modify/deactivate" together and "role change" separately,
 * so a demotion has to be findable on its own rather than buried in a generic modify.
 * SCR-701 edits a user in one form, though, and splitting one save into three rows
 * makes the trail harder to read than the thing it is recording — so the row takes the
 * most significant action of the save, and its before/after carries every field that
 * moved regardless.
 *
 * The one case this flattens is a save that both demotes and deactivates: it reads as
 * a deactivation, and the role move is visible in the values rather than the action.
 */
function actionFor(changes, before, after) {
  if (changes.isActive === false) return 'USER_DEACTIVATED';
  // Submitted-and-unchanged is not a change: SCR-701 posts the whole form, so a role
  // that came back identical must not be recorded as a demotion nobody performed.
  if (after.role !== undefined && after.role !== before.role) return 'ROLE_CHANGED';
  if (changes.password !== undefined) return 'PASSWORD_RESET';
  return 'USER_MODIFIED';
}

module.exports = { list, get, create, update, assertNotLastOwner };
