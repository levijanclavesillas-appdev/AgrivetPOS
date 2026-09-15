'use strict';

// Local authentication for a standalone installation.
//
// 01_PRODUCT_BRIEF.md §8 is required reading before changing anything here: this
// product stores a local bcrypt password per user, and that is **not** an
// product_auth_integration.md AC-1 violation, because the credential authenticates a
// user to this installation only. It confers no access to any Chachi platform, the
// installation holds no tenancy, and it calls nothing. A reviewer who has not read §8
// will flag this file.

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const db = require('../config/database');
const clock = require('../config/clock');
const secrets = require('../config/secrets');
const errors = require('./errors');
const auditService = require('./auditService');
const settingsService = require('./settingsService');
const permissions = require('./permissions');
const userRepository = require('../repositories/userRepository');
const shiftRepository = require('../repositories/shiftRepository');

// SEC-1: bcrypt, cost >= 12. This is the production cost and the only one a shipped
// build ever uses.
const BCRYPT_COST = 12;
const PIN_LENGTH = 6;              // SEC-2, VR-502
const PASSWORD_MIN = 10;           // VR-502
const RECOVERY_CODE_GROUPS = 4;

/**
 * The work factor actually used.
 *
 * Cost 12 is deliberately expensive — roughly 300 ms a hash — which is right at a login
 * prompt and ruinous in a test suite that seeds users in every case. Tests may lower it,
 * and **only** tests: the override is ignored unless NODE_ENV is exactly 'test', so
 * setting the variable on a store PC changes nothing. TC-UT-01 asserts both halves —
 * that the production cost is >= 12, and that this function refuses to lower it outside
 * a test run.
 */
function workFactor() {
  if (process.env.NODE_ENV !== 'test') return BCRYPT_COST;
  const override = Number.parseInt(process.env.AGRIVET_BCRYPT_COST || '', 10);
  return Number.isInteger(override) && override >= 4 && override < BCRYPT_COST ? override : BCRYPT_COST;
}

// SEC-3 wording, reused everywhere a credential fails. The same sentence for an unknown
// username and a wrong password: saying which was wrong tells an attacker which half
// they have already guessed (FR_1.2).
const CREDENTIAL_REFUSAL = 'Incorrect username or password';

// A bcrypt hash of a value nobody holds. Verifying against it for an unknown username
// costs the same as a real check, so response time does not disclose whether an account
// exists.
const DUMMY_HASH = bcrypt.hashSync('no such account, this hash never matches', workFactor());

// ── Credential validation (VR-501, VR-502) ──────────────────────────────────

function validateUsername(username) {
  if (typeof username !== 'string') throw errors.badRequest('Username is required', { ruleId: 'VR-501' });
  const trimmed = username.trim();
  if (trimmed.length < 3 || trimmed.length > 32) {
    throw errors.badRequest('Username must be 3 to 32 characters', { ruleId: 'VR-501' });
  }
  return trimmed;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    throw errors.badRequest(`Password must be at least ${PASSWORD_MIN} characters`, { ruleId: 'VR-502' });
  }
  return password;
}

/** A run is sequential when every step between digits is the same ±1. */
function isSequentialRun(digits) {
  const steps = [];
  for (let i = 1; i < digits.length; i += 1) steps.push(digits[i] - digits[i - 1]);
  return steps.every((s) => s === 1) || steps.every((s) => s === -1);
}

function validatePin(pin) {
  if (typeof pin !== 'string' || !new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) {
    throw errors.badRequest(`The PIN is exactly ${PIN_LENGTH} digits`, { ruleId: 'VR-502' });
  }
  const digits = [...pin].map(Number);
  if (digits.every((d) => d === digits[0])) {
    throw errors.badRequest('The PIN may not be a repeated run such as 111111', { ruleId: 'VR-502' });
  }
  if (isSequentialRun(digits)) {
    throw errors.badRequest('The PIN may not be a sequential run such as 123456', { ruleId: 'VR-502' });
  }
  return pin;
}

const hashSecretValue = (value, { cost = workFactor() } = {}) => bcrypt.hashSync(value, cost);
const verifySecretValue = (value, hash) => bcrypt.compareSync(value, hash || DUMMY_HASH);

/** SEC-5: a code a person can read off paper and type back in a year's time. */
function generateRecoveryCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1
  const groups = [];
  for (let g = 0; g < RECOVERY_CODE_GROUPS; g += 1) {
    let group = '';
    for (let i = 0; i < 4; i += 1) group += alphabet[crypto.randomInt(alphabet.length)];
    groups.push(group);
  }
  return groups.join('-');
}

// ── Public shape (SEC-1, TC-API-02) ─────────────────────────────────────────

/**
 * The only shape a user ever leaves the server in.
 *
 * password_hash, pin_hash and recovery_code_hash are not omitted by convention here —
 * they are absent because this function never reads them, so a new endpoint cannot leak
 * one by forgetting to strip it.
 */
function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    full_name: row.full_name,
    role: row.role,
    has_pin: Boolean(row.pin_hash),
    is_active: Boolean(row.is_active),
    locked_until_at: row.locked_until_at || null,
    created_at: row.created_at,
  };
}

// ── Lockout (SEC-3) ─────────────────────────────────────────────────────────

function lockoutState(user, now = clock.nowUtc()) {
  const until = user.locked_until_at;
  return {
    locked: Boolean(until && until > now),
    until,
    minutesLeft: until && until > now
      ? Math.max(1, Math.ceil((Date.parse(until) - Date.parse(now)) / 60000))
      : 0,
  };
}

/**
 * Count a failure and lock the account on the threshold.
 *
 * The counter is a column, not a variable, so the lock survives an application restart —
 * the failure mode SEC-3 names explicitly.
 */
function registerFailure(user) {
  const threshold = settingsService.get('lockout_threshold');
  const minutes = settingsService.get('lockout_minutes');
  const attempts = user.failed_attempts + 1;

  let lockedUntilAt = null;
  if (attempts >= threshold) {
    lockedUntilAt = new Date(Date.now() + minutes * 60000).toISOString();
    // AUD-601: failures beyond the threshold are audited.
    auditService.write({
      actor: { id: user.id, username: user.username },
      action: 'LOGIN_LOCKED',
      entityType: 'users',
      entityId: user.id,
      after: { failed_attempts: attempts, locked_until_at: lockedUntilAt },
      reason: `${attempts} consecutive failed attempts`,
    });
  }
  userRepository.recordFailedAttempt(user.id, { lockedUntilAt });
  return { attempts, lockedUntilAt, threshold };
}

function lockedError(state) {
  return errors.locked(
    `This account is locked for ${state.minutesLeft} more minute${state.minutesLeft === 1 ? '' : 's'} ` +
    'after too many failed attempts.',
    { ruleId: 'SEC-3' }
  );
}

// ── Sessions (SEC-7) ────────────────────────────────────────────────────────

/**
 * A JWT held in renderer memory only — never localStorage (SEC-7).
 *
 * The token's lifetime is the idle timeout, and the middleware re-issues it on each
 * authenticated request. That is what makes it an *idle* timeout rather than a hard
 * session cap: a cashier working steadily is never logged out mid-sale, and one who
 * walks away is locked out on schedule (FR_1.2).
 */
function issueToken({ user, scope = 'FULL', shiftId = null }) {
  const minutes = settingsService.get('idle_timeout_minutes');
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role, scope, shift_id: shiftId },
    secrets.sessionSecret(),
    { expiresIn: `${minutes}m` }
  );
}

function verifyToken(token) {
  try {
    const claims = jwt.verify(token, secrets.sessionSecret());
    // An approval (below) is signed with the same secret. It proves one person agreed to
    // one thing; it is not a way in, so it is refused as a session.
    if (claims.scope === APPROVAL_SCOPE) throw new Error('an approval is not a session');
    return {
      id: claims.sub,
      username: claims.username,
      role: claims.role,
      scope: claims.scope,
      shiftId: claims.shift_id || null,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
    };
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    throw errors.unauthorized(
      expired ? 'Your session timed out. Sign in again to continue.' : 'Your session is not valid.',
      { ruleId: 'SEC-7' }
    );
  }
}

// ── Login (FR_1.2) ──────────────────────────────────────────────────────────

function login({ username, password }) {
  const fresh = checkPassword({ username, password });
  return { token: issueToken({ user: fresh }), user: toPublic(fresh) };
}

/**
 * The password check behind login() and approve(): the same refusals, the same lockout
 * (SEC-3), so a manager's password is no easier to guess at the approval panel than at
 * the sign-in screen. Returns the user's current row.
 */
function checkPassword({ username, password }) {
  const name = typeof username === 'string' ? username.trim() : '';
  const user = name ? userRepository.findByUsername(name) : null;

  // An unknown username still pays for a bcrypt comparison, so the refusal below does
  // not become a account-enumeration oracle by being faster.
  const passwordOk = verifySecretValue(typeof password === 'string' ? password : '', user && user.password_hash);

  if (!user) throw errors.unauthorized(CREDENTIAL_REFUSAL, { ruleId: 'SEC-3' });

  const state = lockoutState(user);
  if (state.locked) throw lockedError(state);

  if (!user.is_active) {
    // Deliberately the same sentence: a deactivated account is not disclosed either.
    throw errors.unauthorized(CREDENTIAL_REFUSAL, { ruleId: 'SEC-3' });
  }

  if (!passwordOk) {
    const failure = registerFailure(user);
    if (failure.lockedUntilAt) throw lockedError(lockoutState(userRepository.findById(user.id)));
    throw errors.unauthorized(CREDENTIAL_REFUSAL, { ruleId: 'SEC-3' });
  }

  userRepository.clearFailedAttempts(user.id);
  return userRepository.findById(user.id);
}

// ── PIN unlock (FR_1.3, SEC-2) ──────────────────────────────────────────────

/**
 * Unlock an open shift with a 6-digit PIN.
 *
 * SEC-2: this is not an alternative login. It unlocks an already-authenticated user's
 * open shift, and the session it returns is narrowed to the counter (permissions.
 * PIN_SCOPE) whatever the user's role would otherwise allow.
 *
 * `openShiftLookup` is injectable because cashier_shifts arrives with TASK-010. Until
 * then the default correctly reports no open shift, and the end-to-end assertion —
 * a real shift, a real unlock — lands with that task.
 */
function pinUnlock({ username, pin }, { openShiftLookup = shiftRepository.findOpenForUser } = {}) {
  const name = typeof username === 'string' ? username.trim() : '';
  const user = name ? userRepository.findByUsername(name) : null;
  const pinOk = verifySecretValue(typeof pin === 'string' ? pin : '', user && user.pin_hash);

  if (!user || !user.is_active) throw errors.unauthorized(CREDENTIAL_REFUSAL, { ruleId: 'SEC-2' });

  const state = lockoutState(user);
  if (state.locked) throw lockedError(state);

  if (!user.pin_hash || !pinOk) {
    const failure = registerFailure(user);
    if (failure.lockedUntilAt) throw lockedError(lockoutState(userRepository.findById(user.id)));
    throw errors.unauthorized('Incorrect PIN', { ruleId: 'SEC-2' });
  }

  const shift = openShiftLookup(user.id);
  if (!shift) {
    throw errors.forbidden(
      'A PIN unlocks an open shift. Sign in with your password to open one.',
      { ruleId: 'POS-501' }
    );
  }

  userRepository.clearFailedAttempts(user.id);
  const fresh = userRepository.findById(user.id);
  return {
    token: issueToken({ user: fresh, scope: 'PIN', shiftId: shift.id }),
    user: toPublic(fresh),
    scope: 'PIN',
    permitted: permissions.PIN_SCOPE,
  };
}

// ── Offline recovery (FR_1.4, SEC-5) ────────────────────────────────────────

/**
 * Reset a forgotten owner password with the code issued at setup.
 *
 * An offline product has no reset email; without a code issued in advance there is no
 * recovery path at all, which is why TASK-004's wizard shows one once and this consumes
 * it.
 *
 * AUD-604 requires the audit row to be written **before** the reset takes effect. Both
 * happen in one transaction, audit first, so there is no ordering in which the password
 * changes without the row — including a crash between them.
 */
function recover({ username, recoveryCode, newPassword }) {
  const name = typeof username === 'string' ? username.trim() : '';
  const user = name ? userRepository.findByUsername(name) : null;
  const codeOk = verifySecretValue(
    typeof recoveryCode === 'string' ? recoveryCode.trim().toUpperCase() : '',
    user && user.recovery_code_hash
  );

  if (!user || user.role !== 'OWNER' || !user.is_active) {
    throw errors.unauthorized('That recovery code is not valid.', { ruleId: 'SEC-5' });
  }

  const state = lockoutState(user);
  if (state.locked) throw lockedError(state);

  if (!user.recovery_code_hash || !codeOk) {
    // SEC-5: rate-limited identically to SEC-3, on the same counter, so a code cannot
    // be ground down where a password could not.
    const failure = registerFailure(user);
    if (failure.lockedUntilAt) throw lockedError(lockoutState(userRepository.findById(user.id)));
    throw errors.unauthorized('That recovery code is not valid.', { ruleId: 'SEC-5' });
  }

  validatePassword(newPassword);
  const replacement = generateRecoveryCode();

  db.transaction(() => {
    auditService.write({
      actor: { id: user.id, username: user.username },
      action: 'OWNER_PASSWORD_RECOVERED',
      entityType: 'users',
      entityId: user.id,
      reason: 'Offline recovery code consumed',
      after: { recovery_code_replaced: true },
    });
    userRepository.updateFields(user.id, {
      password_hash: hashSecretValue(newPassword),
      recovery_code_hash: hashSecretValue(replacement),
      failed_attempts: 0,
      locked_until_at: null,
    });
  });

  // Shown once, exactly like the one at setup (SEC-5). It is not stored in plaintext
  // and cannot be produced again.
  return { user: toPublic(userRepository.findById(user.id)), recoveryCode: replacement };
}

// ── A person's own sign-in (TASK-058) ──────────────────────────────────────
//
// SCR-701 lets the owner reset anybody's password; nothing let a cashier change their
// own, though the Users screen told the owner "They can change it later". These are
// that: each proves the person with their current password first — through the same
// check as the sign-in screen, so it counts towards the same lockout (SEC-3) — and none
// is open to a PIN session, which is scoped to the counter (SEC-2). A screen left
// unlocked with a PIN is not a way to take over the account behind it.

function assertOwnSession(session) {
  if (!session || session.scope === 'PIN') {
    throw errors.forbidden(
      'A PIN session cannot change sign-in details. Sign in with your password.',
      { ruleId: 'SEC-2' }
    );
  }
}

/** The signed-in person, proved again with their password; the row, fresh. */
function provePassword(session, password) {
  assertOwnSession(session);
  const user = userRepository.findById(session.id);
  if (!user || !user.is_active) throw errors.unauthorized('Your session is not valid.', { ruleId: 'SEC-7' });
  try {
    return checkPassword({ username: user.username, password });
  } catch (err) {
    // The sign-in screen's sentence names a username; here it can only be the password.
    // And 403, not 401: the renderer reads a 401 as a session that has ended and locks
    // the screen, which is not what a mistyped password in a form should do.
    if (err.status === 401 && err.message === CREDENTIAL_REFUSAL) {
      throw errors.forbidden('That is not your current password.', { ruleId: 'SEC-3' });
    }
    throw err;
  }
}

function changePassword({ currentPassword, newPassword }, session) {
  const user = provePassword(session, currentPassword);
  validatePassword(newPassword);
  if (newPassword === currentPassword) {
    throw errors.badRequest('The new password is the same as the current one.', { ruleId: 'VR-502' });
  }

  db.transaction(() => {
    auditService.write({
      actor: { id: user.id, username: user.username },
      action: 'PASSWORD_CHANGED',
      entityType: 'users',
      entityId: user.id,
      after: { password_changed: true },          // never the hash (SEC-1)
    });
    userRepository.updateFields(user.id, { password_hash: hashSecretValue(newPassword) });
  });
  return { user: toPublic(userRepository.findById(user.id)) };
}

/** A new PIN, or none: `newPin` null or empty clears it. */
function changePin({ currentPassword, newPin }, session) {
  const user = provePassword(session, currentPassword);
  const clearing = newPin === null || newPin === undefined || newPin === '';
  if (!clearing) validatePin(newPin);

  db.transaction(() => {
    auditService.write({
      actor: { id: user.id, username: user.username },
      action: 'PIN_CHANGED',
      entityType: 'users',
      entityId: user.id,
      after: clearing ? { pin_cleared: true } : { pin_set: true },
    });
    userRepository.updateFields(user.id, { pin_hash: clearing ? null : hashSecretValue(newPin) });
  });
  return { user: toPublic(userRepository.findById(user.id)) };
}

/**
 * SEC-5's code, replaced while the owner still knows the password.
 *
 * The code is shown once at setup, and a paper that is lost is a store with no way back
 * into its owner account the day the password goes too. Issuing a new one makes the
 * old one worthless, which is also the answer to "somebody may have seen it".
 */
function renewRecoveryCode({ password }, session) {
  const user = provePassword(session, password);
  if (user.role !== 'OWNER') {
    throw errors.forbidden('Only the owner has a recovery code.', { ruleId: 'SEC-5', requiresRole: 'OWNER' });
  }
  const replacement = generateRecoveryCode();

  db.transaction(() => {
    auditService.write({
      actor: { id: user.id, username: user.username },
      action: 'RECOVERY_CODE_REISSUED',
      entityType: 'users',
      entityId: user.id,
      after: { recovery_code_replaced: true },
    });
    userRepository.updateFields(user.id, { recovery_code_hash: hashSecretValue(replacement) });
  });
  return { recoveryCode: replacement };
}

// ── AUD-603's second actor ──────────────────────────────────────────────────
//
// A manager approving at the cashier's screen types their own password into the
// authorisation panel. That proves who they are to the server once, at
// POST /auth/approve, which answers with an approval: a token naming the approver and
// the session that asked for it, good for APPROVAL_MINUTES and for one action. The
// action then carries the approval, and middleware/auth.js replaces whatever the body
// said about the approver with who the approval proves. Before this, the body's
// `{ username }` — or its `role` — was believed, so any signed-in user could name a
// manager and be approved.

const APPROVAL_SCOPE = 'APPROVAL';
const APPROVAL_MINUTES = 5;
const APPROVAL_REFUSAL = 'The approval has expired or was not given. Ask the approver to approve it again.';

// The approvals already used, until they would have expired anyway. Held in memory: a
// restart forgets them, and by then APPROVAL_MINUTES has all but passed.
const spentApprovals = new Map();

/** POST /auth/approve: the approver's own password, for the session that asks. */
/**
 * TASK-060: which rules an approval is for, as the approver saw them on the panel. An
 * approval used to prove only *who* agreed; a manager approving a discount therefore also
 * approved, unseen, a credit sale over the customer's limit on the same request. A rule
 * that needs to know it was the thing approved (CR-104) checks this list.
 */
const APPROVAL_RULE = /^[A-Z]{2,4}-\d{3}$/;
const approvalRules = (rules) => (Array.isArray(rules) ? rules : [])
  .map((rule) => String(rule).trim().toUpperCase())
  .filter((rule) => APPROVAL_RULE.test(rule))
  .slice(0, 12);

function approve({ username, password, rules = [] }, requester) {
  let approver;
  try {
    approver = checkPassword({ username, password });
  } catch (err) {
    // The person asking is signed in; it is the approver's password that is wrong. A
    // 401 says the session is gone, and the renderer signs out on one — so a manager's
    // typo at the panel would sign the cashier out mid-sale. It is a refusal instead.
    if (err.status === 401) throw errors.forbidden(err.message, { ruleId: err.ruleId });
    throw err;
  }
  const token = jwt.sign(
    { sub: approver.id, scope: APPROVAL_SCOPE, for: requester.id, jti: crypto.randomUUID(), rules: approvalRules(rules) },
    secrets.sessionSecret(),
    { expiresIn: `${APPROVAL_MINUTES}m` }
  );
  return { approver: toPublic(approver), approval_token: token };
}

/**
 * The approver an approval proves, for the session presenting it. Refused if it is not
 * an approval, has expired, was asked for by somebody else, was already used, or names
 * a user who is no longer active. The role is the stored one, read now.
 */
function verifyApproval(token, requester) {
  let claims;
  try {
    claims = jwt.verify(String(token || ''), secrets.sessionSecret());
  } catch {
    throw errors.forbidden(APPROVAL_REFUSAL, { ruleId: 'AUD-603' });
  }
  if (claims.scope !== APPROVAL_SCOPE || claims.for !== requester.id || spentApprovals.has(claims.jti)) {
    throw errors.forbidden(APPROVAL_REFUSAL, { ruleId: 'AUD-603' });
  }
  const row = userRepository.findById(claims.sub);
  if (!row || !row.is_active) throw errors.forbidden(APPROVAL_REFUSAL, { ruleId: 'AUD-603' });
  return {
    id: row.id, username: row.username, role: row.role, jti: claims.jti, expiresAtMs: claims.exp * 1000,
    rules: approvalRules(claims.rules),
  };
}

/** One action per approval. `undo` puts it back, for an action that was refused. */
function spendApproval(approval) {
  const now = Date.now();
  for (const [jti, until] of spentApprovals) if (until < now) spentApprovals.delete(jti);
  spentApprovals.set(approval.jti, approval.expiresAtMs);
  return () => spentApprovals.delete(approval.jti);
}

/**
 * Resolve an approver against the users table rather than believing the request.
 *
 * SEC-6 says authorisation is server-side without exception. A body carrying
 * `{ role: 'OWNER' }` is a claim, not an authorisation, and on a route that can move
 * stock, rewrite average cost or pay out cash it is not one worth taking on trust — so
 * the username is looked up, the **stored** role is the one that counts, and a
 * deactivated user authorises nothing.
 *
 * Returns null where no approver was offered, so a caller can decide whether one was
 * needed; throws where one was offered and is not usable, because "that user does not
 * exist" and "no approver was given" are different sentences to show somebody.
 */
function resolveApprover(approver, { roles = ['MANAGER', 'OWNER'], ruleId = 'AUD-603' } = {}) {
  if (!approver || !approver.username) return null;

  const row = userRepository.findByUsername(String(approver.username).trim());
  if (!row) throw errors.forbidden('That user does not exist.', { ruleId });
  if (!row.is_active) {
    throw errors.forbidden(`${row.username} is deactivated and cannot authorise this.`, { ruleId });
  }
  // `roles: null` skips the role check, for a caller that wants to name its own rule
  // in the refusal rather than AUD-603 in general (goodsReceiptService does).
  if (roles && !roles.includes(row.role)) {
    throw errors.forbidden(
      `${row.username} is a ${row.role.toLowerCase()} and cannot authorise this.`,
      { ruleId, requiresRole: roles.join(' or ') }
    );
  }
  return { id: row.id, username: row.username, role: row.role };
}

module.exports = {
  BCRYPT_COST, PIN_LENGTH, PASSWORD_MIN, CREDENTIAL_REFUSAL, workFactor,
  resolveApprover, approve, verifyApproval, spendApproval, APPROVAL_MINUTES,
  validateUsername, validatePassword, validatePin,
  hashSecretValue, verifySecretValue, generateRecoveryCode,
  toPublic, lockoutState, issueToken, verifyToken,
  login, pinUnlock, recover, changePassword, changePin, renewRecoveryCode,
};
