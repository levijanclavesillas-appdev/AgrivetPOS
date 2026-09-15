'use strict';

// TASK-058 — a person's own sign-in, through the real server: their password, their
// PIN, and the owner's recovery code. Each is proved with the current password, none is
// open to a PIN session (SEC-2), and each is audited without its secret (SEC-1).

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const authService = require('../../services/authService');
const auditService = require('../../services/auditService');
const shiftService = require('../../services/shiftService');
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';
let BASE = null;
let instance;

const call = (path, { token = null, method = 'GET', body = null } = {}) => fetch(`${BASE}${path}`, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const login = (username, password = PASSWORD) => call('/auth/login', { method: 'POST', body: { username, password } });
const tokenFor = async (username, password = PASSWORD) => (await (await login(username, password)).json()).token;

test.before(async () => {
  temp.openEmpty('own-account');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;
  temp.seedStore({ withOwner: false });
  temp.seedUser({ username: 'owner', role: 'OWNER', password: PASSWORD });
  temp.seedUser({ username: 'joy', role: 'CASHIER', password: PASSWORD, pin: '284917' });
  temp.seedUser({ username: 'leo', role: 'INVENTORY', password: PASSWORD });
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

test('TASK-058: anybody changes their own password, proved with the current one', async () => {
  const token = await tokenFor('leo');

  const wrong = await call('/auth/password', { token, method: 'POST', body: { currentPassword: 'not-it-at-all', newPassword: 'a-new-password-1' } });
  // 403, not 401: the renderer reads a 401 as a session that ended and locks the screen.
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).error.message, 'That is not your current password.');

  const short = await call('/auth/password', { token, method: 'POST', body: { currentPassword: PASSWORD, newPassword: 'short' } });
  assert.equal(short.status, 400);
  const same = await call('/auth/password', { token, method: 'POST', body: { currentPassword: PASSWORD, newPassword: PASSWORD } });
  assert.equal(same.status, 400);

  const res = await call('/auth/password', { token, method: 'POST', body: { currentPassword: PASSWORD, newPassword: 'leo-new-password-26' } });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  assert.ok(!text.includes('password_hash'));

  assert.equal((await login('leo')).status, 401, 'the old password no longer signs in');
  assert.equal((await login('leo', 'leo-new-password-26')).status, 200);

  const row = auditService.list({ action: 'PASSWORD_CHANGED' })[0];
  assert.equal(row.actor_username, 'leo');
  assert.ok(!/\$2[aby]\$/.test(`${row.after_value}`), 'no hash in the trail');
});

test('TASK-058: a PIN, set, changed and removed by its owner; a PIN session changes nothing', async () => {
  const token = await tokenFor('joy');

  const bad = await call('/auth/pin', { token, method: 'POST', body: { currentPassword: PASSWORD, pin: '123456' } });
  assert.equal(bad.status, 400, 'a sequential PIN is refused as at the Users screen');

  const set = await call('/auth/pin', { token, method: 'POST', body: { currentPassword: PASSWORD, pin: '739051' } });
  assert.equal(set.status, 200);
  assert.equal((await set.json()).user.has_pin, true);

  // The new PIN unlocks her open shift; the old one does not.
  const cashier = authService.verifyToken(token);
  const { shift } = shiftService.open({ actor: cashier, openingFloatCentavos: 50000, confirmed: true });
  const old = await call('/auth/pin-unlock', { method: 'POST', body: { username: 'joy', pin: '284917' } });
  assert.equal(old.status, 401);
  const unlocked = await (await call('/auth/pin-unlock', { method: 'POST', body: { username: 'joy', pin: '739051' } })).json();
  assert.equal(unlocked.scope, 'PIN');

  // SEC-2: the counter's session is not a way into the account behind it.
  for (const [path, body] of [
    ['/auth/password', { currentPassword: PASSWORD, newPassword: 'taken-over-password' }],
    ['/auth/pin', { currentPassword: PASSWORD, pin: '905173' }],
    ['/auth/recovery-code', { password: PASSWORD }],
  ]) {
    const res = await call(path, { token: unlocked.token, method: 'POST', body });
    assert.equal(res.status, 403, path);
    assert.equal((await res.json()).error.rule_id, 'SEC-2');
  }

  const cleared = await call('/auth/pin', { token, method: 'POST', body: { currentPassword: PASSWORD, pin: null } });
  assert.equal((await cleared.json()).user.has_pin, false);
  assert.deepEqual(
    auditService.list({ action: 'PIN_CHANGED' }).map((r) => JSON.parse(r.after_value)).reverse(),
    [{ pin_set: true }, { pin_cleared: true }]
  );
  shiftService.close({ shiftId: shift.id, actualCashCentavos: 50000, actor: cashier }, cashier);
});

test('TASK-058: the owner replaces the recovery code; the old one stops working', async () => {
  const cashier = await tokenFor('joy');
  const refused = await call('/auth/recovery-code', { token: cashier, method: 'POST', body: { password: PASSWORD } });
  assert.equal(refused.status, 403);

  const token = await tokenFor('owner');
  // The setup wizard's code, as the store wrote it down.
  const first = (await (await call('/auth/recovery-code', { token, method: 'POST', body: { password: PASSWORD } })).json()).recoveryCode;
  const second = (await (await call('/auth/recovery-code', { token, method: 'POST', body: { password: PASSWORD } })).json()).recoveryCode;
  assert.match(second, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  assert.notEqual(first, second);

  const stale = await call('/auth/recover', { method: 'POST', body: { username: 'owner', recoveryCode: first, newPassword: 'owner-recovered-26' } });
  assert.equal(stale.status, 401, 'the replaced code is worthless');

  const recovered = await call('/auth/recover', { method: 'POST', body: { username: 'owner', recoveryCode: second.toLowerCase(), newPassword: 'owner-recovered-26' } });
  const body = await recovered.json();
  assert.equal(recovered.status, 200);
  assert.ok(body.recoveryCode && body.recoveryCode !== second, 'and the recovery issues the next one');
  assert.equal((await login('owner', 'owner-recovered-26')).status, 200);

  assert.equal(auditService.list({ action: 'RECOVERY_CODE_REISSUED' }).length, 2);
});

test('TASK-058: guessing at the current password counts towards the sign-in lockout (SEC-3)', async () => {
  temp.seedUser({ username: 'ben', role: 'MANAGER', password: PASSWORD });
  const token = await tokenFor('ben');
  let last;
  for (let i = 0; i < 6; i += 1) {
    last = await call('/auth/password', { token, method: 'POST', body: { currentPassword: `guess-${i}-guess`, newPassword: 'whatever-new-26' } });
  }
  assert.equal(last.status, 423);
  assert.equal((await login('ben')).status, 423, 'and the account is locked at the sign-in screen too');
});
