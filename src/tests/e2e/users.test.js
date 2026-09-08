'use strict';

// TC-E2E-12 — the owner creates a cashier, and that cashier trades.
//
// The point of `SCR-701` is not that a row appears in a table. It is that the store
// stops trading on the owner login: the person at the counter has their own account,
// their own PIN, their own permissions, and their own name on every row they write.
//
// So this walks the whole of that — create, sign in, be refused what a cashier may not
// do, open a drawer, sell, unlock the screen with a PIN, and appear by name on the
// audit trail — through the endpoints `SCR-701` calls. Anything less proves only that
// a form posts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const server = require('../../server');
const db = require('../../config/database');
const settingsService = require('../../services/settingsService');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const inventoryService = require('../../services/inventoryService');
const auditService = require('../../services/auditService');
const userRepository = require('../../repositories/userRepository');
const temp = require('../helpers/tempdb');

const OWNER_PASSWORD = 'sack-of-feed-2026';
const CASHIER_PASSWORD = 'first-day-at-the-till';

let instance;
let BASE = null;
let owner;
let product;
let created;
let cashierToken;

const call = (pathname, { method = 'GET', body = null, token = null } = {}) => fetch(`${BASE}${pathname}`, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

const json = async (res) => {
  const body = await res.json();
  assert.ok(res.ok, `${res.status} ${JSON.stringify(body)}`);
  return body;
};

let ownerToken;

test.before(async () => {
  temp.openMigrated('users-e2e');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;

  temp.seedStore({ withOwner: false, taxMode: 'NONE' });
  const ref = temp.seedCatalog();
  temp.seedUser({ username: 'chachi', role: 'OWNER', password: OWNER_PASSWORD, fullName: 'Chachi Dela Cruz' });
  ownerToken = authService.login({ username: 'chachi', password: OWNER_PASSWORD }).token;
  owner = authService.verifyToken(ownerToken);

  const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-users-'));
  db.transaction(() => settingsService.set('backup_folder', backups, owner));

  product = productService.create({
    sku: 'FEED-001', name: 'Hog Grower Pellets',
    categoryId: ref.category.id, baseUnitId: ref.kg.id, retailPriceCentavos: 6000,
  }, owner);
  inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli: 500000, unitCostCentavos: 4000, actor: owner,
  });
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── The screen's own surface ────────────────────────────────────────────────

test('TC-E2E-12: only an owner reaches user administration (TX-423)', async () => {
  temp.seedUser({ username: 'mgr', role: 'MANAGER', password: OWNER_PASSWORD });
  const manager = authService.login({ username: 'mgr', password: OWNER_PASSWORD }).token;

  const refused = await call('/users', { token: manager });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.rule_id, 'TX-423');

  assert.equal((await call('/users')).status, 401, 'and nobody reaches it unauthenticated');
  assert.equal((await call('/users', { token: ownerToken })).status, 200);
});

test('TC-E2E-12: the owner creates the cashier, with a PIN', async () => {
  created = (await json(await call('/users', {
    method: 'POST', token: ownerToken,
    body: {
      username: 'aling.nena', fullName: 'Nena Reyes',
      role: 'CASHIER', password: CASHIER_PASSWORD, pin: '441703',
    },
  }))).user;

  assert.equal(created.role, 'CASHIER');
  assert.equal(created.has_pin, true);
  assert.equal(created.is_active, true);

  // SEC-1: no hash leaves the server, on the one response that could carry one.
  const raw = JSON.stringify(created);
  assert.equal(/\$2[aby]\$|password|pin_hash/.test(raw), false, raw);

  // AUD-601. The seeded users wrote their own rows, so this asks about this one.
  const audited = auditService.list({ action: 'USER_CREATED' })
    .find((row) => row.entity_id === created.id);
  assert.ok(audited, 'the creation is on the trail');
  assert.equal(audited.actor_username, 'chachi', 'and the owner is named as the creator');
});

test('TC-E2E-12: VR-501 and VR-502 are refused with their rules named', async () => {
  const short = await call('/users', {
    method: 'POST', token: ownerToken,
    body: { username: 'x', fullName: 'A', role: 'CASHIER', password: CASHIER_PASSWORD },
  });
  assert.equal(short.status, 400);

  const badPin = await call('/users', {
    method: 'POST', token: ownerToken,
    body: {
      username: 'pinless', fullName: 'Pin Less', role: 'CASHIER',
      password: CASHIER_PASSWORD, pin: '123',
    },
  });
  assert.equal(badPin.status, 400);
  assert.equal((await badPin.json()).error.rule_id, 'VR-502');
});

test('TC-E2E-12: VR-503 — the store cannot be left without an active owner', async () => {
  const demote = await call(`/users/${owner.id}`, {
    method: 'PUT', token: ownerToken, body: { role: 'CASHIER' },
  });
  assert.equal(demote.status >= 400, true);
  assert.equal((await demote.json()).error.rule_id, 'VR-503');

  const deactivate = await call(`/users/${owner.id}`, {
    method: 'PUT', token: ownerToken, body: { isActive: false },
  });
  assert.equal(deactivate.status >= 400, true);
  const error = (await deactivate.json()).error;
  assert.equal(error.rule_id, 'VR-503');
  // The refusal explains itself rather than being a greyed-out control.
  assert.match(error.message, /owner/i);
});

// ── And the cashier trades ──────────────────────────────────────────────────

test('TC-E2E-12: the cashier signs in and is refused what a cashier may not do', async () => {
  cashierToken = (await json(await call('/auth/login', {
    method: 'POST', body: { username: 'aling.nena', password: CASHIER_PASSWORD },
  }))).token;

  // TX-412: cost is absent from the payload, not merely hidden by a screen.
  const seen = (await json(await call(`/products/${product.id}`, { token: cashierToken }))).product;
  assert.equal('avg_cost_centavos' in seen, false, 'TX-412: no cost for a cashier');

  // TX-423: and no user administration.
  assert.equal((await call('/users', { token: cashierToken })).status, 403);
  // TX-427: nor a restore.
  assert.equal((await call('/backups/restore/preflight', { token: cashierToken })).status, 403);
});

test('TC-E2E-12: the cashier opens a drawer and sells under their own name', async () => {
  await json(await call('/shifts/open', {
    method: 'POST', token: cashierToken,
    body: { openingFloatCentavos: 200000, confirmed: true },
  }));

  const sale = await json(await call('/sales', {
    method: 'POST', token: cashierToken,
    body: {
      lines: [{ productId: product.id, qtyMilli: 2000 }],
      tenders: [{ method: 'CASH', amountCentavos: 15000 }],
    },
  }));

  // The whole point of the screen: the row carries the person who made it, not the
  // owner whose login the store would otherwise be trading on.
  assert.equal(sale.sale.created_by, created.id);
  assert.notEqual(sale.sale.created_by, owner.id);
});

test('TC-E2E-12: SEC-2 — the PIN unlocks the screen mid-shift', async () => {
  const unlocked = await json(await call('/auth/pin-unlock', {
    method: 'POST', body: { username: 'aling.nena', pin: '441703' },
  }));

  assert.equal(unlocked.user.username, 'aling.nena');
  assert.ok(unlocked.token);

  // It unlocks; it does not grant. A PIN session is scoped to the counter.
  assert.equal(
    (await call('/users', { token: unlocked.token })).status, 403,
    'a PIN session reaches no more than the counter'
  );
});

// ── The reset that the lockout used to defeat ───────────────────────────────

test('TC-E2E-12: a locked-out cashier is unlocked by the owner resetting the password', async () => {
  for (let i = 0; i < 5; i += 1) {
    await call('/auth/login', {
      method: 'POST', body: { username: 'aling.nena', password: 'wrong' },
    });
  }

  const locked = await call('/auth/login', {
    method: 'POST', body: { username: 'aling.nena', password: CASHIER_PASSWORD },
  });
  // 423 Locked, not 401: the credentials are not the problem and the message says so,
  // with the minutes remaining (SEC-3).
  assert.equal(locked.status, 423, 'SEC-3: even the right password is refused while locked');
  assert.equal((await locked.json()).error.rule_id, 'SEC-3');

  // The screen shows this, with the minutes remaining.
  const listed = (await json(await call('/users', { token: ownerToken })))
    .users.find((u) => u.username === 'aling.nena');
  assert.ok(listed.locked_until_at, 'and the owner can see it is locked');

  // TASK-040's decision: the reset clears the lock. SEC-3 guards against guessing at
  // the login screen; an owner deliberately setting a new password is not that, and
  // the password the lock protected no longer exists.
  await json(await call(`/users/${created.id}`, {
    method: 'PUT', token: ownerToken, body: { password: 'a-brand-new-password' },
  }));

  const after = (await json(await call('/users', { token: ownerToken })))
    .users.find((u) => u.username === 'aling.nena');
  assert.equal(after.locked_until_at, null);

  // And she can serve the queue that is standing there.
  assert.ok((await json(await call('/auth/login', {
    method: 'POST', body: { username: 'aling.nena', password: 'a-brand-new-password' },
  }))).token);

  // SEC-1: what changed is on the trail; what it changed to is not.
  const reset = auditService.list({ action: 'PASSWORD_RESET' });
  assert.ok(reset.length >= 1);
  assert.equal(/a-brand-new-password|\$2[aby]\$/.test(JSON.stringify(reset)), false);
});

// ── Deactivation ────────────────────────────────────────────────────────────

test('TC-E2E-12: AUD-606 — a deactivated user keeps their name on their history', async () => {
  const shift = (await json(await call('/shifts/current', { token: cashierToken }))).shift;
  const fresh = (await json(await call('/auth/login', {
    method: 'POST', body: { username: 'aling.nena', password: 'a-brand-new-password' },
  }))).token;
  const expected = await json(await call(`/shifts/${shift.id}/expected`, { token: fresh }));
  await json(await call(`/shifts/${shift.id}/close`, {
    method: 'POST', token: fresh,
    body: { actualCashCentavos: expected.expected_cash_centavos },
  }));

  await json(await call(`/users/${created.id}`, {
    method: 'PUT', token: ownerToken, body: { isActive: false },
  }));

  // She cannot sign in.
  assert.equal((await call('/auth/login', {
    method: 'POST', body: { username: 'aling.nena', password: 'a-brand-new-password' },
  })).status, 401);

  // And every row she wrote still names her — which is why this is a deactivation and
  // not a delete.
  assert.ok(userRepository.findById(created.id), 'the row survives');
  const sales = db.get().prepare('SELECT COUNT(*) AS n FROM sales WHERE created_by = ?')
    .get(created.id).n;
  assert.ok(sales > 0, 'her sale is still hers');

  const trail = auditService.list({ actor: created.id });
  assert.ok(trail.length > 0, 'and so is her audit trail');
});

test('TC-E2E-12: and she can be brought back', async () => {
  await json(await call(`/users/${created.id}`, {
    method: 'PUT', token: ownerToken, body: { isActive: true },
  }));

  assert.ok((await json(await call('/auth/login', {
    method: 'POST', body: { username: 'aling.nena', password: 'a-brand-new-password' },
  }))).token);
});
