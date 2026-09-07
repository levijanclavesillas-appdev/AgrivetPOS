'use strict';

// TC-API-01 and TC-API-02 — every route refuses an actor lacking its TX-*, with 403 and
// an audit row (SEC-6); and no endpoint returns a hash (SEC-1).

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const authService = require('../../services/authService');
const auditService = require('../../services/auditService');
const permissions = require('../../services/permissions');
const { SESSION_HEADER } = require('../../middleware/auth');
const temp = require('../helpers/tempdb');

const PORT = 47897;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'correct-horse-battery';

let instance;
const tokens = {};

const call = (path, { token = null, method = 'GET', body = null } = {}) => fetch(`${BASE}${path}`, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

test.before(async () => {
  temp.openEmpty('authz');
  instance = await server.start({ listenPort: PORT });

  for (const role of permissions.ROLES) {
    const username = role.toLowerCase();
    temp.seedUser({ username, role, password: PASSWORD, pin: '284917' });
    tokens[role] = authService.login({ username, password: PASSWORD }).token;
  }
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

test('TC-API-01: an unauthenticated request to a protected route is refused 401', async () => {
  const res = await call('/users');
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, 'UNAUTHORIZED');
  assert.equal(body.error.rule_id, 'SEC-7');
});

test('TC-API-01: TX-423 admits the owner and refuses everyone else, with 403', async () => {
  const owner = await call('/users', { token: tokens.OWNER });
  assert.equal(owner.status, 200, 'the owner manages users');

  for (const role of ['MANAGER', 'CASHIER', 'INVENTORY']) {
    const res = await call('/users', { token: tokens[role] });
    assert.equal(res.status, 403, `${role} must be refused TX-423`);

    const body = await res.json();
    assert.equal(body.error.code, 'FORBIDDEN');
    assert.equal(body.error.rule_id, 'TX-423', 'the UI needs the rule to explain the refusal');
    assert.equal(body.error.requires_role, 'OWNER', 'and who may do it instead');
    assert.ok(!/stack|at Object|\.js:/.test(body.error.message), 'no developer debris');
  }
});

test('TC-API-01: a refusal is audited, naming the transaction and the route (SEC-6)', async () => {
  const before = auditService.list({ action: 'PERMISSION_REFUSED' }).length;

  await call('/users', { token: tokens.CASHIER, method: 'POST', body: { username: 'x' } });

  const rows = auditService.list({ action: 'PERMISSION_REFUSED' });
  assert.equal(rows.length, before + 1, 'a blocked attempt must be visible afterwards, not only blocked');

  const row = rows[0];
  assert.equal(row.actor_username, 'cashier');
  assert.equal(row.entity_type, 'permission');
  assert.equal(row.entity_id, 'TX-423');
  assert.match(JSON.parse(row.after_value).route, /POST \/api\/v1\/users/);
});

test('TC-API-01: every write route rejects a forbidden actor before it does any work', async () => {
  const owner = await call('/users', { token: tokens.OWNER, method: 'POST', body: {
    username: 'victim', fullName: 'Victim', password: PASSWORD, role: 'CASHIER',
  } });
  assert.equal(owner.status, 201);
  const { user } = await owner.json();

  // A refused PUT must not have changed anything on the way to being refused.
  const refused = await call(`/users/${user.id}`, {
    token: tokens.MANAGER, method: 'PUT', body: { role: 'OWNER' },
  });
  assert.equal(refused.status, 403);

  const after = await (await call(`/users/${user.id}`, { token: tokens.OWNER })).json();
  assert.equal(after.user.role, 'CASHIER', 'the refused change did not land');
});

test('TC-INT-03: a PIN session is refused on user administration whatever the role', async () => {
  // An owner on a PIN is still only at the counter (SEC-2, FR_1.3).
  const ownerRow = require('../../repositories/userRepository').findByUsername('owner');
  const pinToken = authService.issueToken({ user: ownerRow, scope: 'PIN', shiftId: 'shift-1' });

  const res = await call('/users', { token: pinToken });
  assert.equal(res.status, 403);

  const body = await res.json();
  assert.equal(body.error.rule_id, 'SEC-2');
  assert.match(body.error.message, /PIN session/);

  const row = auditService.list({ action: 'PERMISSION_REFUSED' })[0];
  assert.match(row.reason, /scoped to the counter/);
});

test('the session is re-issued on each authenticated request, making the timeout an idle one', async () => {
  const res = await call('/auth/session', { token: tokens.OWNER });
  assert.equal(res.status, 200);

  const refreshed = res.headers.get(SESSION_HEADER);
  assert.ok(refreshed, 'a fresh token comes back on every authenticated call (FR_1.2)');
  assert.equal(authService.verifyToken(refreshed).username, 'owner');

  const body = await res.json();
  assert.equal(body.session.role, 'OWNER');
  assert.equal(body.session.scope, 'FULL');
});

test('TC-API-02: no endpoint returns password_hash, pin_hash or recovery_code_hash', async () => {
  const owner = require('../../repositories/userRepository').findByUsername('owner');
  const code = authService.generateRecoveryCode();
  require('../../repositories/userRepository')
    .updateFields(owner.id, { recovery_code_hash: authService.hashSecretValue(code) });

  const responses = [
    await call('/health'),
    await call('/auth/session', { token: tokens.OWNER }),
    await call('/users', { token: tokens.OWNER }),
    await call(`/users/${owner.id}`, { token: tokens.OWNER }),
    await call('/users', { token: tokens.OWNER, method: 'POST', body: {
      username: 'newcashier', fullName: 'New Cashier', password: PASSWORD, role: 'CASHIER', pin: '284917',
    } }),
    await call(`/users/${owner.id}`, { token: tokens.OWNER, method: 'PUT', body: { fullName: 'Renamed Owner' } }),
    await call('/auth/login', { method: 'POST', body: { username: 'cashier', password: PASSWORD } }),
    await call('/auth/login', { method: 'POST', body: { username: 'cashier', password: 'wrong' } }),
    await call('/auth/pin-unlock', { method: 'POST', body: { username: 'cashier', pin: '284917' } }),
    await call('/auth/recover', { method: 'POST', body: {
      username: 'owner', recoveryCode: code, newPassword: 'a-brand-new-password',
    } }),
    await call('/users', { token: tokens.CASHIER }),
  ];

  for (const res of responses) {
    const text = await res.text();
    for (const secret of ['password_hash', 'pin_hash', 'recovery_code_hash']) {
      assert.ok(!text.includes(secret), `${secret} appeared in a response body`);
    }
    // A bcrypt hash is recognisable whatever key it hides under.
    assert.ok(!/\$2[aby]\$\d\d\$/.test(text), `a bcrypt hash appeared in a response: ${text.slice(0, 200)}`);
  }
});

test('VR-503: the last active owner cannot be deactivated or demoted, over HTTP', async () => {
  const owner = require('../../repositories/userRepository').findByUsername('owner');

  const demote = await call(`/users/${owner.id}`, {
    token: tokens.OWNER, method: 'PUT', body: { role: 'CASHIER' },
  });
  assert.equal(demote.status, 409);
  const body = await demote.json();
  assert.equal(body.error.rule_id, 'VR-503');
  assert.match(body.error.message, /last active owner/);

  const deactivate = await call(`/users/${owner.id}`, {
    token: tokens.OWNER, method: 'PUT', body: { isActive: false },
  });
  assert.equal(deactivate.status, 409);

  // With a second owner in place, the first may step down.
  const second = await (await call('/users', { token: tokens.OWNER, method: 'POST', body: {
    username: 'owner2', fullName: 'Second Owner', password: PASSWORD, role: 'OWNER',
  } })).json();
  assert.equal(second.user.role, 'OWNER');

  const now = await call(`/users/${owner.id}`, {
    token: tokens.OWNER, method: 'PUT', body: { role: 'MANAGER' },
  });
  assert.equal(now.status, 200);
  assert.equal((await now.json()).user.role, 'MANAGER');
});
