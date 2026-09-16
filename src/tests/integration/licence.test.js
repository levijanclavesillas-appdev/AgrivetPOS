'use strict';

// The subscription on the POS — TASK-048, LIC-001 – LIC-004.
//
// Against a real licence server (licence-server/), started here with its own database,
// key and clock. Google is not involved: the owner's approval is made on the server's
// service directly, which is what its /link page does after Google has said who they are.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const server = require('../../server');
const authService = require('../../services/authService');
const settingsService = require('../../services/settingsService');
const licenceService = require('../../services/licenceService');
const licenceRepository = require('../../repositories/licenceRepository');
const db = require('../../config/database');
const temp = require('../helpers/tempdb');

const licenceDb = require('../../../licence-server/src/db');
const licenceSigning = require('../../../licence-server/src/licence');
const { createService } = require('../../../licence-server/src/service');
const { createApp } = require('../../../licence-server/src/app');

const PASSWORD = 'correct-horse-battery';
const DAY = 86400e3;

let pos;
let BASE;
let licenceHttp;
let licensing;           // the licence server's service
let signingKey;          // …and its private key, to write a licence as an older server did
const tokens = {};

const call = (p, { token, method = 'GET', body = null } = {}) => fetch(`${BASE}${p}`, {
  method,
  headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const json = async (response) => ({ status: response.status, body: await response.json() });
const openShift = (token) => call('/shifts/open', { token, method: 'POST', body: { openingFloatCentavos: 100000, confirmed: true } });
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString();

test.before(async () => {
  // The licence server, as it will run at pos.chachisoftware.store.
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  signingKey = privateKey;
  licensing = createService({
    db: licenceDb.open(':memory:'),
    config: { baseUrl: 'http://licence.test', validityDays: 30, graceDays: 7, warningDays: 7, trialDays: 14 },
    privateKey,
  });
  const app = createApp({
    service: licensing, config: { baseUrl: 'http://licence.test', admin: {}, behindProxy: false },
    google: { configured: false }, play: { configured: false },
  });
  licenceHttp = app.listen(0);
  await new Promise((r) => licenceHttp.once('listening', r));
  process.env.AGRIVET_LICENCE_SERVER = `http://127.0.0.1:${licenceHttp.address().port}`;
  process.env.AGRIVET_LICENCE_PUBLIC_KEY = licenceSigning.publicPem(privateKey);

  temp.openEmpty('licence');
  pos = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${pos.address().port}/api/v1`;
  temp.seedStore({ storeName: 'Botika ni Aling Rosa', taxMode: 'NONE', withOwner: false });
  for (const role of ['OWNER', 'CASHIER']) {
    const username = role.toLowerCase();
    temp.seedUser({ username, role, password: PASSWORD });
    tokens[role] = authService.login({ username, password: PASSWORD }).token;
  }
  const session = authService.verifyToken(tokens.OWNER);
  settingsService.set('backup_folder', fs.mkdtempSync(path.join(os.tmpdir(), 'licence-backups-')), session);
});

test.after(async () => {
  await server.stop(pos);
  await new Promise((r) => licenceHttp.close(r));
  temp.cleanup();
  delete process.env.AGRIVET_LICENCE_SERVER;
  delete process.env.AGRIVET_LICENCE_PUBLIC_KEY;
});

test('LIC-001: a POS not linked to a store opens no shift, and says where to link it', async () => {
  const status = await json(await call('/licence', { token: tokens.CASHIER }));
  assert.equal(status.body.state, 'UNLINKED');

  const refused = await json(await openShift(tokens.OWNER));
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.rule_id, 'LIC-001');
  assert.match(refused.body.error.message, /not linked to a store yet.*Admin → Subscription/);
});

test('LIC-004: a cashier can read the state but cannot link the POS', async () => {
  assert.equal((await call('/licence/link', { token: tokens.CASHIER, method: 'POST' })).status, 403);
});

test('LIC-004: the owner links it — a code, approved on the licence server, collected by the poll', async () => {
  const started = await json(await call('/licence/link', { token: tokens.OWNER, method: 'POST' }));
  assert.equal(started.status, 200);
  const code = started.body.pending.user_code;
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.match(started.body.pending.uri, new RegExp(`/link\\?code=${code}$`));

  assert.equal((await json(await call('/licence/link/poll', { token: tokens.OWNER, method: 'POST' }))).body.poll, 'pending');

  // What /link does once Google has said who the owner is.
  licensing.approveLink({ code, owner: { sub: 'google-rosa', email: 'rosa@example.com' }, newStoreName: 'Botika ni Aling Rosa' });

  const linked = await json(await call('/licence/link/poll', { token: tokens.OWNER, method: 'POST' }));
  assert.equal(linked.body.poll, 'approved');
  assert.equal(linked.body.state, 'ACTIVE');
  assert.equal(linked.body.store_name, 'Botika ni Aling Rosa');
  assert.equal(linked.body.ends_because, 'UNPAID', 'the 14-day trial ends before the 30-day check does');
  assert.equal(linked.body.pending, null);

  const audit = db.get().prepare("SELECT * FROM audit_logs WHERE action = 'LICENCE_LINKED'").all();
  assert.equal(audit.length, 1);
  assert.match(audit[0].after_value, /Botika ni Aling Rosa/);

  // The secret is stored for renewals and never returned to a screen.
  assert.ok(licenceRepository.get().installation_secret);
  assert.equal(JSON.stringify(linked.body).includes(licenceRepository.get().installation_secret), false);

  assert.equal((await openShift(tokens.OWNER)).status, 201, 'linked, a shift opens');
});

test('LIC-002: active, then the warning week, then the grace week, then lapsed', () => {
  // Trial: paid until +14 days. Warning from +7, grace to +21.
  assert.equal(licenceService.state({ at: inDays(3) }).state, 'ACTIVE');
  assert.equal(licenceService.state({ at: inDays(8) }).state, 'WARNING');
  const grace = licenceService.state({ at: inDays(15) });
  assert.equal(grace.state, 'GRACE');
  assert.match(grace.message, /Everything works until/);
  assert.doesNotThrow(() => licenceService.assertMayOpenShift({ at: inDays(20) }), 'grace still opens a shift');

  assert.throws(() => licenceService.assertMayOpenShift({ at: inDays(22) }), (err) => err.ruleId === 'LIC-001'
    && /grace period on .* no new shift can be opened until it is renewed/.test(err.message));
});

test('LIC-003: setting the clock back does not undo a lapse', () => {
  // The previous case saw +22 days. The clock now says today, and the POS remembers.
  assert.equal(licenceService.state().state, 'LAPSED');
});

test('LIC-001: a shift already open when the licence lapses runs to its close', async () => {
  const resumed = await json(await openShift(tokens.OWNER));
  assert.equal(resumed.status, 200, 'resuming creates nothing, so it is 200 and not 201');
  assert.equal(resumed.body.resumed, true, 'the open shift is resumed, not refused');

  const cashierRefused = await json(await openShift(tokens.CASHIER));
  assert.equal(cashierRefused.status, 403, 'a new one is not');
  assert.equal(cashierRefused.body.error.rule_id, 'LIC-001');
});

test('LIC-002: a payment recorded on the licence server arrives with the next check', async () => {
  const storeId = licenceService.state().store_id;
  licensing.recordPayment({ storeId, months: 2, amountCentavos: 99800, reference: 'GC-1', recordedBy: 'admin' });

  const renewed = await json(await call('/licence/renew', { token: tokens.OWNER, method: 'POST' }));
  assert.equal(renewed.status, 200);
  assert.equal(renewed.body.state, 'ACTIVE', 'paid two months past the day the POS last saw');
  assert.equal(db.get().prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'LICENCE_RENEWED'").get().n, 1);

  // A second check that changes nothing adds nothing to the trail.
  await call('/licence/renew', { token: tokens.OWNER, method: 'POST' });
  assert.equal(db.get().prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'LICENCE_RENEWED'").get().n, 1);
  assert.equal((await openShift(tokens.CASHIER)).status, 201);
});

test('LIC-003: a licence signed by any other key is not a licence', () => {
  const good = licenceRepository.get().licence;
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const payload = JSON.parse(Buffer.from(good.split('.')[1], 'base64url').toString('utf8'));
  const forged = licenceSigning.sign({ ...payload, paid_until: '2099-01-01T00:00:00.000Z' }, privateKey);
  licenceRepository.update({ licence: forged }, new Date().toISOString());
  try {
    const state = licenceService.state();
    assert.equal(state.state, 'UNLINKED');
    assert.match(state.message, /not valid for it/);
  } finally {
    licenceRepository.update({ licence: good }, new Date().toISOString());
  }
  assert.equal(licenceService.state().state, 'ACTIVE');
});

test('NFR_3.1: with the licence server unreachable, the check fails politely and the licence stands', async () => {
  const saved = process.env.AGRIVET_LICENCE_SERVER;
  process.env.AGRIVET_LICENCE_SERVER = 'http://127.0.0.1:9';
  try {
    const failed = await json(await call('/licence/renew', { token: tokens.OWNER, method: 'POST' }));
    assert.equal(failed.status, 409);
    assert.equal(failed.body.error.rule_id, 'LIC-002');
    assert.match(failed.body.error.message, /could not be reached/);
  } finally {
    process.env.AGRIVET_LICENCE_SERVER = saved;
  }
  const status = licenceService.state();
  assert.equal(status.state, 'ACTIVE');
  assert.match(status.last_error, /could not be reached/);
});

// ── TASK-067: a one-time licence ────────────────────────────────────────────

test('LIC-005: a one-time licence set on the licence server arrives with the next check, and is audited', async () => {
  const storeId = licenceService.state().store_id;
  licensing.setOneTime({ storeId, amountCentavos: 1500000, reference: 'BDO-1', recordedBy: 'admin' });

  const renewed = await json(await call('/licence/renew', { token: tokens.OWNER, method: 'POST' }));
  assert.equal(renewed.status, 200);
  assert.equal(renewed.body.state, 'ACTIVE');
  assert.equal(renewed.body.plan, 'ONE_TIME');
  assert.equal(renewed.body.paid_until, null, 'nothing to show as a paid-until');
  assert.equal(renewed.body.ends_because, 'OFFLINE', 'only the monthly check can end it');
  assert.match(renewed.body.message, /^One-time licence: no subscription to renew\. This POS checks in online by \d{4}-\d{2}-\d{2}\.$/);
  assert.doesNotThrow(() => licenceService.assertMayOpenShift());

  const audit = db.get().prepare("SELECT * FROM audit_logs WHERE action = 'LICENCE_RENEWED' ORDER BY rowid DESC").get();
  assert.deepEqual(JSON.parse(audit.before_value).plan, 'MONTHLY');
  assert.deepEqual(JSON.parse(audit.after_value), { plan: 'ONE_TIME', paid_until: '9999-12-31T00:00:00.000Z' });

  // Only a change of plan or date is recorded.
  const count = () => db.get().prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'LICENCE_RENEWED'").get().n;
  const before = count();
  await call('/licence/renew', { token: tokens.OWNER, method: 'POST' });
  assert.equal(count(), before);
});

test('LIC-005: a licence from before TASK-067, plan "monthly", is read as the monthly plan', () => {
  const good = licenceRepository.get().licence;
  const payload = JSON.parse(Buffer.from(good.split('.')[1], 'base64url').toString('utf8'));
  const older = licenceSigning.sign({ ...payload, plan: 'monthly', paid_until: inDays(60) }, signingKey);
  licenceRepository.update({ licence: older }, new Date().toISOString());
  try {
    const state = licenceService.state();
    assert.equal(state.plan, 'MONTHLY');
    assert.match(state.message, /^Subscribed until /);
    assert.ok(state.paid_until);
  } finally {
    licenceRepository.update({ licence: good }, new Date().toISOString());
  }
  assert.equal(licenceService.state().plan, 'ONE_TIME');
});

test('LIC-007: a one-time POS that stays offline past its check and grace opens no new shift', () => {
  // Checked today: valid 30 days, then 7 of grace. This moves the POS's clock on for good (LIC-003).
  assert.equal(licenceService.state({ at: inDays(25) }).state, 'WARNING');
  assert.match(licenceService.state({ at: inDays(25) }).message, /^The licence ends on .*has not reached the licence server/);
  assert.equal(licenceService.state({ at: inDays(33) }).state, 'GRACE');
  assert.throws(() => licenceService.assertMayOpenShift({ at: inDays(38) }), (err) => err.ruleId === 'LIC-001'
    && /^The licence ended on .* no new shift can be opened until it is renewed/.test(err.message));
});
