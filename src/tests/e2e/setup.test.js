'use strict';

// TC-E2E-00 — fresh install → setup wizard → owner created → first login
// (07_TEST_PLAN.md §5).
//
// Everything here goes over HTTP, in the order a person does it, against a database
// that starts empty. Nothing reaches into a service: this is the one level that proves
// the wizard is reachable and the gate is real, rather than that the functions behind
// them work.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const server = require('../../server');
const temp = require('../helpers/tempdb');
const schemaRepository = require('../../repositories/schemaRepository');

/** Row counts read straight from the database — /health no longer reports them. */
const counts = () => schemaRepository.rowCounts();

// Port 0: the OS picks a free one and the real port is read back off the server.
// A fixed port collides whenever two runs overlap or a socket lingers, which is a
// flake that looks like a defect in whatever test happens to be running.
let ORIGIN = null;
// Read at call time, not at module load: ORIGIN is not known until the server has
// bound its port.
const API = () => `${ORIGIN}/api/v1`;

const STORE = 'Chachi Agrivet Supply';
const OWNER = { fullName: 'Aling Nena', username: 'nena', password: 'correct-horse-battery', pin: '284917' };

let instance;
let backupFolder;
let recoveryCode;

const call = (path_, { token = null, method = 'GET', body = null } = {}) => fetch(`${API()}${path_}`, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

test.before(async () => {
  temp.openEmpty('e2e-setup');                 // migrate() inside start(); no rows at all
  instance = await server.start({ listenPort: 0 });
  ORIGIN = `http://127.0.0.1:${instance.address().port}`;
  backupFolder = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-e2e-')), 'backups');
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── 1. A fresh install serves the wizard and refuses everything else ────────

test('TC-E2E-00: a fresh install answers the wizard at the root', async () => {
  const page = await fetch(`${ORIGIN}/`);
  assert.equal(page.status, 200);

  const html = await page.text();
  assert.match(html, /Set up Chachi Agrivet POS/, 'SCR-001, not the application shell');
  for (const step of ['Your store', 'Tax', 'Owner account', 'Recovery code', 'Backup folder']) {
    assert.ok(html.includes(step), `the wizard shows the "${step}" step`);
  }
});

test('TC-E2E-00: every route but the wizard and health is refused (FR_1.1)', async () => {
  for (const [method, route] of [['GET', '/users'], ['GET', '/settings'], ['GET', '/store-profile'], ['POST', '/auth/login']]) {
    const res = await call(route, { method, body: method === 'POST' ? { username: 'x', password: 'y' } : null });
    assert.equal(res.status, 409, `${method} ${route} is not reachable before setup`);

    const body = await res.json();
    assert.equal(body.error.code, 'SETUP_REQUIRED');
    assert.equal(body.error.rule_id, 'FR_1.1');
  }

  // main.js polls health before the window opens, so it answers on an empty database.
  // TASK-017 made that answer deliberately thin — a status and a version, nothing
  // about the store — because SEC-8 opens the bind address to the LAN in v1.3 and an
  // unauthenticated endpoint reporting row counts would go with it. The counts come
  // from the database directly here, which is what this case actually wants.
  const health = await call('/health');
  assert.equal(health.status, 200);
  const liveness = await health.json();
  assert.equal(liveness.status, 'ok');
  assert.equal('database' in liveness, false, 'and it says nothing about the store');
  assert.equal(counts().users, 0);
});

test('TC-E2E-00: the wizard reports what it needs, in five steps', async () => {
  const res = await call('/setup');
  assert.equal(res.status, 200);

  const status = await res.json();
  assert.equal(status.required, true);
  assert.deepEqual(status.steps, ['store', 'tax', 'owner', 'recovery', 'backup']);
  assert.equal(status.store_name, null, 'there is no store yet');
  assert.equal(status.tax_modes.length, 3, 'TAX-001');
});

// ── 2. A refusal mid-wizard leaves the installation untouched ──────────────

test('TC-E2E-00: a refused completion writes nothing and the wizard starts again', async () => {
  const res = await call('/setup', {
    method: 'POST',
    body: {
      store: { storeName: STORE },
      taxMode: 'VAT',
      owner: OWNER,
      backupFolder,
      acknowledgedRecoveryCode: false,          // SEC-5: the box was not ticked
    },
  });

  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.rule_id, 'SEC-5');

  const written = counts();
  assert.equal(written.users, 0, 'no owner');
  assert.equal(written.store_profile, 0, 'no profile');
  assert.equal(written.system_settings, 0, 'no settings');
  assert.equal((await (await call('/setup')).json()).required, true, 'back at step 1');
});

// ── 3. Completion ──────────────────────────────────────────────────────────

test('TC-E2E-00: completing the wizard installs the store, the owner and the settings', async () => {
  const res = await call('/setup', {
    method: 'POST',
    body: {
      store: { storeName: STORE, address: 'Poblacion, Sultan Kudarat', contactNo: '0917 000 0000' },
      taxMode: 'VAT',
      owner: OWNER,
      backupFolder,
      acknowledgedRecoveryCode: true,
    },
  });

  assert.equal(res.status, 201);
  const body = await res.json();

  assert.equal(body.profile.store_name, STORE);
  assert.equal(body.profile.tax_mode, 'VAT');
  assert.equal(body.owner.username, OWNER.username);
  assert.equal(body.owner.role, 'OWNER');
  assert.equal(body.backupFolder, path.resolve(backupFolder));
  assert.ok(body.settingsSeeded >= 12, 'the OPS-005 list is seeded, not left empty');

  // SEC-5: shown once, here and nowhere else.
  assert.match(body.recoveryCode, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  recoveryCode = body.recoveryCode;

  // SEC-1 / TC-API-02: no hash leaves the server, not even on the one response that
  // carries a credential the operator has to read.
  const serialised = JSON.stringify(body);
  for (const secret of ['password_hash', 'pin_hash', 'recovery_code_hash', OWNER.password]) {
    assert.equal(serialised.includes(secret), false, `${secret} is not in the response`);
  }

  assert.ok(fs.existsSync(path.resolve(backupFolder)), 'OPS-001: the folder exists and was proved writable');
});

test('TC-E2E-00: the wizard cannot be run twice', async () => {
  const res = await call('/setup', {
    method: 'POST',
    body: {
      store: { storeName: 'Someone Else Supply' },
      taxMode: 'NONE',
      owner: { ...OWNER, username: 'intruder' },
      backupFolder,
      acknowledgedRecoveryCode: true,
    },
  });

  assert.equal(res.status, 409);
  assert.equal((await call('/health')).status, 200);
  assert.equal(counts().users, 1, 'still one user');
});

// ── 4. First login ─────────────────────────────────────────────────────────

test('TC-E2E-00: the owner signs in and reaches the application', async () => {
  const res = await call('/auth/login', {
    method: 'POST',
    body: { username: OWNER.username, password: OWNER.password },
  });

  assert.equal(res.status, 200, 'the login route is reachable now the gate has opened');
  const body = await res.json();
  assert.equal(body.user.role, 'OWNER');
  assert.equal(body.user.has_pin, true);
  assert.ok(body.token);

  // The screens the owner lands on are reachable with that session.
  const settings = await call('/settings', { token: body.token });
  assert.equal(settings.status, 200);
  assert.ok((await settings.json()).settings.some((s) => s.key === 'backup_folder'));

  const users = await call('/users', { token: body.token });
  assert.equal(users.status, 200);
  assert.deepEqual((await users.json()).users.map((u) => u.username), [OWNER.username]);
});

test('TC-E2E-00: the root now serves the application, and the login screen knows the store', async () => {
  const page = await fetch(`${ORIGIN}/`);
  const html = await page.text();
  assert.doesNotMatch(html, /Set up Chachi Agrivet POS/, 'the wizard is behind us');

  // SCR-101 shows the store name before anyone has signed in, so it is readable
  // without a session — and nothing else about the installation is.
  const status = await (await call('/setup')).json();
  assert.deepEqual(
    { required: status.required, store_name: status.store_name, tax_mode: status.tax_mode },
    { required: false, store_name: STORE, tax_mode: 'VAT' }
  );
  assert.equal(status.suggested_backup_folder, null);
});

test('TC-E2E-00: the recovery code issued by the wizard is the real one', async () => {
  // The end of the offline story: the code the operator wrote down at step 4 is what
  // gets them back in, and using it issues a replacement (SEC-5, AUD-604).
  const res = await call('/auth/recover', {
    method: 'POST',
    body: { username: OWNER.username, recoveryCode, newPassword: 'a-brand-new-password' },
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.notEqual(body.recoveryCode, recoveryCode, 'a replacement, not the same code');

  const signIn = await call('/auth/login', {
    method: 'POST',
    body: { username: OWNER.username, password: 'a-brand-new-password' },
  });
  assert.equal(signIn.status, 200);
});
