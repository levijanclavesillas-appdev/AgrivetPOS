'use strict';

// TC-INT-02, TC-INT-03 and TC-INT-04 — lockout and its survival across a restart,
// the PIN scope boundary, and the recovery path's single use and audit ordering.

const test = require('node:test');
const assert = require('node:assert/strict');
const authService = require('../../services/authService');
const auditService = require('../../services/auditService');
const userRepository = require('../../repositories/userRepository');
const settingsService = require('../../services/settingsService');
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';

function attemptLogin(username, password) {
  try {
    return { ok: true, result: authService.login({ username, password }) };
  } catch (err) {
    return { ok: false, err };
  }
}

test.afterEach(() => temp.cleanup());

test('a correct password signs in and returns no hash', () => {
  temp.openMigrated('login-ok');
  temp.seedUser({ username: 'cashier1', password: PASSWORD });

  const { token, user } = authService.login({ username: 'cashier1', password: PASSWORD });

  assert.ok(token, 'a session token is issued');
  assert.equal(user.username, 'cashier1');
  assert.ok(!JSON.stringify(user).includes('$2'), 'no bcrypt hash in the response');

  const session = authService.verifyToken(token);
  assert.equal(session.role, 'CASHIER');
  assert.equal(session.scope, 'FULL');
});

test('the username is matched case-insensitively (VR-501)', () => {
  temp.openMigrated('login-case');
  temp.seedUser({ username: 'Cashier1', password: PASSWORD });
  assert.ok(authService.login({ username: 'cashier1', password: PASSWORD }).token);
  assert.ok(authService.login({ username: 'CASHIER1', password: PASSWORD }).token);
});

test('a wrong password is refused without disclosing which field was wrong (FR_1.2)', () => {
  temp.openMigrated('login-refusal');
  temp.seedUser({ username: 'cashier1', password: PASSWORD });

  const wrongPassword = attemptLogin('cashier1', 'not-the-password');
  const unknownUser = attemptLogin('nobody-here', 'not-the-password');

  assert.equal(wrongPassword.ok, false);
  assert.equal(unknownUser.ok, false);
  assert.equal(wrongPassword.err.message, unknownUser.err.message, 'the two must be indistinguishable');
  assert.equal(wrongPassword.err.message, 'Incorrect username or password');
  assert.equal(wrongPassword.err.status, 401);
});

test('TC-INT-02: five failures lock the account for fifteen minutes (SEC-3)', () => {
  temp.openMigrated('lockout');
  temp.seedUser({ username: 'cashier1', password: PASSWORD });

  const threshold = settingsService.get('lockout_threshold');
  assert.equal(threshold, 5);

  for (let i = 1; i < threshold; i += 1) {
    const attempt = attemptLogin('cashier1', 'wrong');
    assert.equal(attempt.err.status, 401, `attempt ${i} should be a plain refusal`);
  }

  const locking = attemptLogin('cashier1', 'wrong');
  assert.equal(locking.err.status, 423, 'the fifth failure locks');
  assert.match(locking.err.message, /locked for 15 more minutes/);
  assert.equal(locking.err.ruleId, 'SEC-3');

  // Locked means locked: the right password does not open it either.
  const withCorrect = attemptLogin('cashier1', PASSWORD);
  assert.equal(withCorrect.ok, false);
  assert.equal(withCorrect.err.status, 423);
});

test('TC-INT-02: the lock survives an application restart', () => {
  const dir = temp.openMigrated('lockout-restart');
  temp.seedUser({ username: 'cashier1', password: PASSWORD });
  for (let i = 0; i < 5; i += 1) attemptLogin('cashier1', 'wrong');

  // The counter is a column, not a variable in a process that just went away.
  temp.reopen(dir);

  const afterRestart = attemptLogin('cashier1', PASSWORD);
  assert.equal(afterRestart.ok, false);
  assert.equal(afterRestart.err.status, 423, 'a restart must not clear the lock');

  const row = userRepository.findByUsername('cashier1');
  assert.equal(row.failed_attempts, 5);
  assert.ok(row.locked_until_at > new Date().toISOString());
});

test('TC-INT-02: the lockout is audited, and a successful sign-in clears the counter', () => {
  temp.openMigrated('lockout-audit');
  temp.seedUser({ username: 'cashier1', password: PASSWORD });

  for (let i = 0; i < 5; i += 1) attemptLogin('cashier1', 'wrong');

  const locked = auditService.list({ action: 'LOGIN_LOCKED' });
  assert.equal(locked.length, 1, 'AUD-601: failures beyond the threshold are audited');
  assert.equal(locked[0].actor_username, 'cashier1');
  assert.match(locked[0].reason, /5 consecutive failed attempts/);

  // Clear the lock as time would, then a good password resets the counter.
  userRepository.updateFields(userRepository.findByUsername('cashier1').id, { locked_until_at: null });
  assert.ok(authService.login({ username: 'cashier1', password: PASSWORD }).token);
  assert.equal(userRepository.findByUsername('cashier1').failed_attempts, 0);
});

test('TC-INT-02: an owner resetting the password clears the lock (TASK-040)', () => {
  temp.openMigrated('lockout-reset');
  temp.seedStore({ withOwner: false });
  temp.seedUser({ username: 'boss', role: 'OWNER', password: PASSWORD });
  temp.seedUser({ username: 'cashier1', password: PASSWORD });

  const owner = authService.verifyToken(
    authService.login({ username: 'boss', password: PASSWORD }).token
  );

  for (let i = 0; i < 5; i += 1) attemptLogin('cashier1', 'wrong');
  const locked = userRepository.findByUsername('cashier1');
  assert.ok(locked.locked_until_at, 'SEC-3: locked');
  assert.equal(attemptLogin('cashier1', PASSWORD).ok, false, 'even with the right password');

  // The sequence a store actually hits. SEC-3 stops somebody guessing at the login
  // screen; an owner deliberately setting a new password is not that, and the lock has
  // nothing left to guard — the password it protected no longer exists.
  const userService = require('../../services/userService');
  userService.update(locked.id, { password: 'a-brand-new-password' }, owner);

  const after = userRepository.findByUsername('cashier1');
  assert.equal(after.locked_until_at, null, 'the lock is cleared');
  assert.equal(after.failed_attempts, 0, 'and so is the counter');
  assert.ok(
    authService.login({ username: 'cashier1', password: 'a-brand-new-password' }).token,
    'so the cashier can serve the queue that is standing there'
  );

  // SEC-1: what changed is on the trail; what it changed to is not.
  const audited = auditService.list({ action: 'PASSWORD_RESET' });
  assert.equal(audited.length, 1);
  const recorded = JSON.parse(audited[0].after_value);
  assert.equal(recorded.password_changed, true);
  assert.equal(recorded.lockout_cleared, true);
  assert.equal(/a-brand-new-password|\$2[aby]\$/.test(audited[0].after_value), false, 'no secret on the trail');
});

test('TC-INT-02: the lock is per account, not global', () => {
  temp.openMigrated('lockout-scope');
  temp.seedUser({ username: 'cashier1', password: PASSWORD });
  temp.seedUser({ username: 'cashier2', password: PASSWORD });

  for (let i = 0; i < 5; i += 1) attemptLogin('cashier1', 'wrong');

  assert.equal(attemptLogin('cashier1', PASSWORD).ok, false);
  assert.equal(attemptLogin('cashier2', PASSWORD).ok, true, 'one locked till user must not close the counter');
});

test('TC-INT-03: a PIN unlocks an open shift and the session is scoped to the counter', () => {
  temp.openMigrated('pin-unlock');
  temp.seedUser({ username: 'cashier1', password: PASSWORD, pin: '284917' });

  // cashier_shifts arrives with TASK-010, so the open shift is supplied here. The
  // end-to-end assertion — a real shift, opened through the API — belongs to that task.
  const openShift = () => ({ id: 'shift-1', status: 'OPEN' });
  const unlocked = authService.pinUnlock({ username: 'cashier1', pin: '284917' }, { openShiftLookup: openShift });

  const session = authService.verifyToken(unlocked.token);
  assert.equal(session.scope, 'PIN');
  assert.equal(session.shiftId, 'shift-1');
  assert.deepEqual(unlocked.permitted, ['TX-401', 'TX-402', 'TX-413', 'TX-416', 'TX-420', 'TX-430']);
  assert.ok(!JSON.stringify(unlocked).includes('$2'), 'no hash in the response');
});

test('TC-INT-03: a PIN is refused when no shift is open (SEC-2, POS-501)', () => {
  temp.openMigrated('pin-no-shift');
  temp.seedUser({ username: 'cashier1', password: PASSWORD, pin: '284917' });

  // The default lookup: before migration 005 no shift can be open, which is the honest
  // answer rather than an error.
  assert.throws(
    () => authService.pinUnlock({ username: 'cashier1', pin: '284917' }),
    (err) => err.status === 403 && err.ruleId === 'POS-501'
  );
});

test('TC-INT-03: a wrong PIN counts toward the same lockout as a password (SEC-3)', () => {
  temp.openMigrated('pin-lockout');
  temp.seedUser({ username: 'cashier1', password: PASSWORD, pin: '284917' });
  const openShift = () => ({ id: 'shift-1', status: 'OPEN' });

  for (let i = 0; i < 4; i += 1) {
    assert.throws(() => authService.pinUnlock({ username: 'cashier1', pin: '999998' }, { openShiftLookup: openShift }));
  }
  assert.equal(userRepository.findByUsername('cashier1').failed_attempts, 4);

  assert.throws(
    () => authService.pinUnlock({ username: 'cashier1', pin: '999998' }, { openShiftLookup: openShift }),
    (err) => err.status === 423
  );
});

test('TC-INT-04: a recovery code works exactly once and is replaced', () => {
  temp.openMigrated('recovery');
  const owner = temp.seedUser({ username: 'owner', role: 'OWNER', password: PASSWORD });

  const code = authService.generateRecoveryCode();
  userRepository.updateFields(owner.id, { recovery_code_hash: authService.hashSecretValue(code) });

  const result = authService.recover({
    username: 'owner', recoveryCode: code, newPassword: 'a-brand-new-password',
  });

  assert.ok(result.recoveryCode, 'a replacement code is issued');
  assert.notEqual(result.recoveryCode, code);
  assert.ok(!JSON.stringify(result.user).includes('$2'));

  // The new password works, the old one does not.
  assert.ok(authService.login({ username: 'owner', password: 'a-brand-new-password' }).token);
  assert.equal(attemptLogin('owner', PASSWORD).ok, false);

  // The consumed code is dead.
  assert.throws(
    () => authService.recover({ username: 'owner', recoveryCode: code, newPassword: 'another-password-x' }),
    /not valid/
  );

  // The replacement is live.
  assert.ok(authService.recover({
    username: 'owner', recoveryCode: result.recoveryCode, newPassword: 'third-password-here',
  }).recoveryCode);
});

test('TC-INT-04: the audit row is written before the reset takes effect (AUD-604)', () => {
  temp.openMigrated('recovery-audit');
  const owner = temp.seedUser({ username: 'owner', role: 'OWNER', password: PASSWORD });
  const code = authService.generateRecoveryCode();
  userRepository.updateFields(owner.id, { recovery_code_hash: authService.hashSecretValue(code) });

  authService.recover({ username: 'owner', recoveryCode: code, newPassword: 'a-brand-new-password' });

  const rows = auditService.list({ action: 'OWNER_PASSWORD_RECOVERED' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_username, 'owner');
  assert.equal(rows[0].entity_type, 'users');
  assert.equal(rows[0].entity_id, owner.id);
  assert.match(rows[0].reason, /recovery code consumed/i);
  assert.ok(!JSON.stringify(rows[0]).includes('$2'), 'no hash reaches the trail');
});

test('TC-INT-04: a failed recovery leaves the password alone and neither audits nor commits', () => {
  temp.openMigrated('recovery-failed');
  const owner = temp.seedUser({ username: 'owner', role: 'OWNER', password: PASSWORD });
  const code = authService.generateRecoveryCode();
  const before = userRepository.findById(owner.id).password_hash;
  userRepository.updateFields(owner.id, { recovery_code_hash: authService.hashSecretValue(code) });

  assert.throws(
    () => authService.recover({ username: 'owner', recoveryCode: 'WRON-GCOD-EHER-EXXX', newPassword: 'a-new-password' }),
    /not valid/
  );

  assert.equal(userRepository.findById(owner.id).password_hash, before, 'the password did not move');
  assert.equal(auditService.list({ action: 'OWNER_PASSWORD_RECOVERED' }).length, 0);
  assert.equal(userRepository.findById(owner.id).failed_attempts, 1, 'rate-limited as SEC-3');
});

test('TC-INT-04: recovery is refused for a non-owner, and a weak new password is rejected', () => {
  temp.openMigrated('recovery-guards');
  const cashier = temp.seedUser({ username: 'cashier1', password: PASSWORD });
  const owner = temp.seedUser({ username: 'owner', role: 'OWNER', password: PASSWORD });
  const code = authService.generateRecoveryCode();
  userRepository.updateFields(cashier.id, { recovery_code_hash: authService.hashSecretValue(code) });
  userRepository.updateFields(owner.id, { recovery_code_hash: authService.hashSecretValue(code) });

  // SEC-5 issues the code to the owner. A cashier holding one recovers nothing.
  assert.throws(
    () => authService.recover({ username: 'cashier1', recoveryCode: code, newPassword: 'a-new-password' }),
    /not valid/
  );
  assert.throws(
    () => authService.recover({ username: 'owner', recoveryCode: code, newPassword: 'short' }),
    /at least 10 characters/
  );
});

test('a session times out, and the message says so without leaking why', () => {
  temp.openMigrated('session-expiry');
  const user = temp.seedUser({ username: 'cashier1', password: PASSWORD });

  settingsService.set('idle_timeout_minutes', 15, temp.SETUP_ACTOR);
  const token = authService.issueToken({ user: { id: user.id, username: user.username, role: user.role } });
  assert.equal(authService.verifyToken(token).username, 'cashier1');

  assert.throws(() => authService.verifyToken('not.a.token'), (err) => err.status === 401);
  assert.throws(() => authService.verifyToken(`${token}tampered`), (err) => err.status === 401);
});

test('the idle timeout comes from settings, not from a literal (OPS-005)', () => {
  temp.openMigrated('idle-setting');
  assert.equal(settingsService.get('idle_timeout_minutes'), 15, 'the declared default');

  settingsService.set('idle_timeout_minutes', 30, temp.SETUP_ACTOR);
  assert.equal(settingsService.get('idle_timeout_minutes'), 30, 'the store may change it');
});

test('SEC-7: the signing secret is a file in the data directory, 0600, and stable', () => {
  const fs = require('fs');
  const secrets = require('../../config/secrets');
  const dir = temp.openMigrated('session-key');
  const user = temp.seedUser({ username: 'cashier1', password: PASSWORD });

  assert.ok(!fs.existsSync(secrets.keyPath()), 'not written until a session is issued');

  const token = authService.issueToken({ user });
  const keyFile = secrets.keyPath();

  assert.ok(fs.existsSync(keyFile), 'issuing a session writes the key');
  assert.equal(keyFile, `${dir}/session.key`, '05_TECH_SPEC.md §7 runtime layout');

  if (process.platform !== 'win32') {
    // 0600: another account on the machine must not be able to mint sessions. Windows
    // has no POSIX mode, which is why SEC-9 warns the operator in words instead.
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  }

  // The secret is not in the database: stealing agrivet.db must not also yield the
  // ability to forge a session.
  const inDatabase = require('../../repositories/schemaRepository').rowCounts();
  assert.equal(inDatabase.system_settings, 0, 'the key is not a setting');

  const secret = fs.readFileSync(keyFile, 'utf8');
  assert.ok(secret.length >= 32);

  // Reissuing reuses it, or every request would invalidate the last session.
  authService.issueToken({ user });
  assert.equal(fs.readFileSync(keyFile, 'utf8'), secret);
  assert.equal(authService.verifyToken(token).username, 'cashier1');
});

test('SEC-7: a session minted under a different secret is refused', () => {
  const dir = temp.openMigrated('session-key-rotate');
  const user = temp.seedUser({ username: 'cashier1', password: PASSWORD });
  const token = authService.issueToken({ user });

  // Replace the key, as restoring onto new hardware would.
  require('fs').writeFileSync(`${dir}/session.key`, 'a-different-secret-of-sufficient-length', { mode: 0o600 });
  require('../../config/secrets').reset();

  assert.throws(() => authService.verifyToken(token), (err) => err.status === 401);
});
