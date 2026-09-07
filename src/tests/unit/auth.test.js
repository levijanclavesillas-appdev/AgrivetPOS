'use strict';

// TC-UT-01 — bcrypt verify, wrong password rejected, hash never returned (SEC-1) —
// plus the credential validation of VR-502 and the TX-* matrix transcription that
// TC-API-01 rests on.

const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../../services/authService');
const permissions = require('../../services/permissions');

test('TC-UT-01: bcrypt verifies the right password and rejects the wrong one', () => {
  const hash = auth.hashSecretValue('correct-horse-battery');

  assert.notEqual(hash, 'correct-horse-battery', 'the password is not stored');
  assert.equal(auth.verifySecretValue('correct-horse-battery', hash), true);
  assert.equal(auth.verifySecretValue('Correct-horse-battery', hash), false);
  assert.equal(auth.verifySecretValue('', hash), false);
});

test('TC-UT-01: the production bcrypt cost is at least 12 (SEC-1)', () => {
  assert.ok(auth.BCRYPT_COST >= 12);
  // The cost is encoded in the hash, so this asserts what was actually used rather than
  // what the constant says. Hashed at the production factor explicitly, because the
  // suite itself runs at a lower one.
  assert.match(
    auth.hashSecretValue('whatever-ten-chars', { cost: auth.BCRYPT_COST }),
    /^\$2[aby]\$(1[2-9]|[2-9]\d)\$/
  );
});

test('TC-UT-01: the work factor cannot be lowered outside a test run (SEC-1)', () => {
  // The override exists so the suite is runnable. It must be inert on a store PC, or
  // it is a way to weaken every password hash in the product with an environment
  // variable.
  const realEnv = process.env.NODE_ENV;
  const realCost = process.env.AGRIVET_BCRYPT_COST;
  try {
    process.env.AGRIVET_BCRYPT_COST = '4';
    for (const env of ['production', 'development', undefined]) {
      if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env;
      assert.equal(auth.workFactor(), auth.BCRYPT_COST, `NODE_ENV=${env} must not lower the cost`);
    }
    process.env.NODE_ENV = 'test';
    assert.equal(auth.workFactor(), 4, 'a test run may lower it');
    process.env.AGRIVET_BCRYPT_COST = '99';
    assert.equal(auth.workFactor(), auth.BCRYPT_COST, 'and may never raise it past production');
  } finally {
    process.env.NODE_ENV = realEnv;
    if (realCost === undefined) delete process.env.AGRIVET_BCRYPT_COST;
    else process.env.AGRIVET_BCRYPT_COST = realCost;
  }
});

test('TC-UT-01: a verification against a missing hash is false, not a crash', () => {
  // The unknown-username path: there is no hash to compare, and the comparison must
  // still cost the same and still fail.
  assert.equal(auth.verifySecretValue('anything', null), false);
  assert.equal(auth.verifySecretValue('anything', undefined), false);
});

test('TC-UT-01: no hash reaches the public shape of a user (SEC-1)', () => {
  const row = {
    id: 'u1', username: 'owner', full_name: 'The Owner', role: 'OWNER',
    password_hash: '$2b$12$aaaa', pin_hash: '$2b$12$bbbb', recovery_code_hash: '$2b$12$cccc',
    failed_attempts: 2, locked_until_at: null, is_active: 1, created_at: '2026-09-07T00:00:00.000Z',
  };
  const shown = auth.toPublic(row);

  for (const secret of ['password_hash', 'pin_hash', 'recovery_code_hash']) {
    assert.ok(!(secret in shown), `${secret} is present in the public shape`);
  }
  assert.ok(!JSON.stringify(shown).includes('$2b$12$'), 'no hash value survives serialisation');
  assert.equal(shown.has_pin, true, 'that a PIN exists is visible; the hash is not');
  assert.equal(shown.username, 'owner');
});

test('VR-502: a password is at least 10 characters', () => {
  assert.equal(auth.validatePassword('correct-horse-battery'), 'correct-horse-battery');
  assert.equal(auth.validatePassword('0123456789'), '0123456789');
  assert.throws(() => auth.validatePassword('short'), /at least 10 characters/);
  assert.throws(() => auth.validatePassword(null), /at least 10 characters/);
});

test('VR-502: a PIN is exactly 6 digits and is neither a repeated nor a sequential run', () => {
  assert.equal(auth.validatePin('284917'), '284917');

  assert.throws(() => auth.validatePin('12345'), /exactly 6 digits/);
  assert.throws(() => auth.validatePin('1234567'), /exactly 6 digits/);
  assert.throws(() => auth.validatePin('12a456'), /exactly 6 digits/);

  for (const repeated of ['111111', '000000', '999999']) {
    assert.throws(() => auth.validatePin(repeated), /repeated run/, repeated);
  }
  for (const sequential of ['123456', '654321', '012345', '987654']) {
    assert.throws(() => auth.validatePin(sequential), /sequential run/, sequential);
  }
  // Not a run: only the first digits ascend.
  assert.equal(auth.validatePin('123457'), '123457');
});

test('VR-501: a username is 3 to 32 characters, trimmed', () => {
  assert.equal(auth.validateUsername('  cashier1  '), 'cashier1');
  assert.throws(() => auth.validateUsername('ab'), /3 to 32/);
  assert.throws(() => auth.validateUsername('x'.repeat(33)), /3 to 32/);
  assert.throws(() => auth.validateUsername(null), /Username is required/);
});

test('SEC-5: a recovery code is readable off paper and has no ambiguous characters', () => {
  const code = auth.generateRecoveryCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
  // 0/O and 1/I are excluded: this is transcribed by hand, a year later, under stress.
  assert.ok(!/[01IO]/.test(code));
  assert.notEqual(auth.generateRecoveryCode(), auth.generateRecoveryCode());
});

test('the TX-* matrix is transcribed completely from 03_BUSINESS_RULES.md §10', () => {
  const txIds = Object.keys(permissions.MATRIX);
  assert.equal(txIds.length, 30, 'TX-401 through TX-430');
  assert.deepEqual(txIds, txIds.slice().sort(), 'listed in id order');
  assert.equal(txIds[0], 'TX-401');
  assert.equal(txIds[29], 'TX-430');

  for (const [txId, row] of Object.entries(permissions.MATRIX)) {
    assert.ok(row.what, `${txId} has no description`);
    for (const role of permissions.ROLES) {
      const level = row[role];
      assert.ok(level === null || permissions.LEVELS.includes(level), `${txId}/${role} = ${level}`);
    }
    assert.notEqual(row.OWNER, null, `${txId}: the owner does everything (02 §2 Users)`);
  }
});

test('the three qualified cells of §10 are levels, not ticks', () => {
  assert.equal(permissions.grant('CASHIER', 'TX-421'), permissions.OWN_SHIFT);
  assert.equal(permissions.grant('CASHIER', 'TX-422'), permissions.VIEW);
  assert.equal(permissions.grant('INVENTORY', 'TX-413'), permissions.VIEW);
  assert.equal(permissions.grant('MANAGER', 'TX-424'), permissions.LIMITED);

  // A write route demands FULL, so a VIEW-level role is refused by the same check.
  const inventory = { role: 'INVENTORY', scope: 'FULL' };
  assert.equal(permissions.can(inventory, 'TX-413'), true, 'may look a customer up');
  assert.equal(permissions.can(inventory, 'TX-413', permissions.FULL), false, 'may not edit one');
});

test('SEC-2: a PIN session is narrowed to the counter whatever the role allows', () => {
  const ownerOnPin = { role: 'OWNER', scope: 'PIN' };
  const ownerSignedIn = { role: 'OWNER', scope: 'FULL' };

  for (const txId of ['TX-401', 'TX-416', 'TX-420', 'TX-430']) {
    assert.equal(permissions.can(ownerOnPin, txId), true, `${txId} is counter work`);
  }
  // FR_1.3: a PIN cannot reach Settings, Users, Products edit, or Reports — and an
  // owner on a PIN is still only at the counter.
  for (const txId of ['TX-423', 'TX-424', 'TX-425', 'TX-410', 'TX-411', 'TX-412', 'TX-421', 'TX-429', 'TX-427']) {
    assert.equal(permissions.can(ownerOnPin, txId), false, `${txId} is out of PIN scope`);
    assert.equal(permissions.can(ownerSignedIn, txId), true, `${txId} is open to a signed-in owner`);
  }
});

test('an unknown permission or role is a programming error, not a silent false', () => {
  assert.throws(() => permissions.grant('OWNER', 'TX-999'), /unknown permission/);
  assert.throws(() => permissions.grant('ADMIN', 'TX-401'), /unknown role/);
  assert.throws(() => permissions.assertKnown('TX-400'), /unknown permission/);
});
