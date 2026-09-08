'use strict';

// TC-E2E-15 — a day's work is legible afterwards.
//
// `AUD-601` writes a row for every price change, cost change, credit limit, adjustment,
// void, reprint, user change, settings change, export and restore. The trail has been
// complete since `TASK-005` and append-only by construction since — and until
// `TASK-041` the owner it exists for could not read a line of it.
//
// That is what makes the rest mean anything. `TX-412` hides cost, `AUD-603` records two
// actors on an override and `POS-511` freezes a closed shift, all on the understanding
// that somebody can look afterwards. **A trail nobody can read deters nobody.**
//
// So this does a day's work — a price change, an adjustment somebody had to authorise,
// a settings change, a reprint — and then asks the questions an owner actually asks:
// who changed this price, what was it before, and who allowed that.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const server = require('../../server');
const db = require('../../config/database');
const clock = require('../../config/clock');
const settingsService = require('../../services/settingsService');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const inventoryService = require('../../services/inventoryService');
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';

let instance;
let BASE = null;
let owner;
let manager;
let tokens = {};
let product;
let today;

const call = (pathname, { method = 'GET', body = null, who = 'boss', raw = false } = {}) => fetch(`${BASE}${pathname}`, {
  method,
  headers: {
    ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

const json = async (res) => {
  const body = await res.json();
  assert.ok(res.ok, `${res.status} ${JSON.stringify(body)}`);
  return body;
};

test.before(async () => {
  temp.openMigrated('audit-e2e');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;

  temp.seedStore({ withOwner: false, taxMode: 'NONE' });
  const ref = temp.seedCatalog();
  for (const [username, role] of [['boss', 'OWNER'], ['mgr', 'MANAGER'], ['till', 'CASHIER']]) {
    temp.seedUser({ username, role, password: PASSWORD });
    tokens[username] = authService.login({ username, password: PASSWORD }).token;
  }
  owner = authService.verifyToken(tokens.boss);
  manager = authService.verifyToken(tokens.mgr);

  const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-audit-'));
  db.transaction(() => settingsService.set('backup_folder', backups, owner));

  product = productService.create({
    sku: 'FEED-001', name: 'Hog Grower Pellets',
    categoryId: ref.category.id, baseUnitId: ref.kg.id, retailPriceCentavos: 6000,
  }, owner);
  inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli: 500000, unitCostCentavos: 4000, actor: owner,
  });

  today = clock.manilaDate(clock.nowUtc());
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── Who may read it ─────────────────────────────────────────────────────────

test('TC-E2E-15: the trail is TX-429, and a cashier cannot read it', async () => {
  assert.equal((await call('/audit', { who: 'till' })).status, 403);
  assert.equal((await call('/audit/export', { who: 'till' })).status, 403);
  assert.equal((await call('/audit')).status, 200);
});

test('TC-E2E-15: the screen is served the lists its filters are built from', async () => {
  const auditService = require('../../services/auditService');
  const body = await json(await call('/audit'));

  // A screen holding its own action list would drift from ACTIONS the first time one
  // was added — and would offer a filter the server then refuses.
  assert.equal(body.actions.length, auditService.ACTION_NAMES.length);
  assert.ok(body.actions.every((a) => a.value && a.label));
  assert.ok(body.actors.length >= 1);
  assert.ok(body.actors.every((a) => a.username && typeof a.rows_written === 'number'));
});

// ── A day's work ────────────────────────────────────────────────────────────

test('TC-E2E-15: a price change is on the trail, with what it was before', async () => {
  await json(await call(`/products/${product.id}/prices`, {
    method: 'PUT', body: { RETAIL: 6500, reason: 'Supplier put feed up' },
  }));

  const page = await json(await call(`/audit?action=PRICE_CHANGED`));
  assert.equal(page.total, 1);

  const row = page.rows[0];
  assert.equal(row.actor.username, 'boss');
  assert.equal(row.action_label, 'Selling price changed');
  assert.equal(row.entity_type, 'products');
  assert.equal(row.entity_id, product.id);
  assert.match(row.reason, /Supplier put feed up/);

  // AUD-606: the change is legible afterwards. "Price changed" answers nothing.
  assert.ok(row.before, 'the row carries what it was');
  assert.ok(row.after, 'and what it became');
  assert.match(JSON.stringify(row.before), /6000/);
  assert.match(JSON.stringify(row.after), /6500/);
});

test('TC-E2E-15: an authorised adjustment names both actors (AUD-603)', async () => {
  // Above the threshold, so an owner must authorise it — and the manager who filed it
  // and the owner who allowed it are two different people on the row.
  const threshold = settingsService.get('adjustment_authorisation_centavos');
  const qty = Math.ceil((threshold / 4000) * 1000) + 10000;

  const posted = await json(await call('/inventory/adjustments', {
    method: 'POST', who: 'mgr',
    body: {
      productId: product.id, qtyMilli: -qty,
      reason: 'Damaged in storage', notes: 'Sacks split in the rain',
      approver: { id: owner.id, username: owner.username, role: 'OWNER' },
    },
  }));
  assert.ok(posted.movement);

  const page = await json(await call('/audit?action=INVENTORY_ADJUSTED'));
  const row = page.rows[0];

  assert.equal(row.actor.username, 'mgr', 'who filed it');
  assert.ok(row.approver, 'and who allowed it');
  assert.equal(row.approver.username, 'boss');
  assert.notEqual(row.actor.username, row.approver.username, 'two distinct actors');
  assert.match(row.reason, /Damaged in storage/);
});

test('TC-E2E-15: a settings change and a reprint are both there', async () => {
  await json(await call('/settings', {
    method: 'PUT', body: { shift_max_open_hours: 10, reason: 'The shop shuts at seven' },
  }));

  const settingsRow = (await json(await call('/audit?action=SETTING_CHANGED'))).rows[0];
  assert.equal(settingsRow.entity_id, 'shift_max_open_hours');
  assert.match(JSON.stringify(settingsRow.after), /10/);

  // A reprint (POS-208) — an unmarked one is a shrinkage tool, which is why it is here.
  await json(await call('/shifts/open', {
    method: 'POST', who: 'till', body: { openingFloatCentavos: 200000, confirmed: true },
  }));
  const sale = await json(await call('/sales', {
    method: 'POST', who: 'till',
    body: {
      lines: [{ productId: product.id, qtyMilli: 1000 }],
      tenders: [{ method: 'CASH', amountCentavos: 10000 }],
    },
  }));
  await json(await call(`/sales/${sale.sale.id}/reprint`, { method: 'POST', body: {} }));

  const reprint = (await json(await call('/audit?action=RECEIPT_REPRINTED'))).rows[0];
  assert.equal(reprint.entity_id, sale.sale.id);
});

// ── The questions an owner actually asks ────────────────────────────────────

test('TC-E2E-15: "who changed this price" is answerable by entity', async () => {
  const page = await json(await call(`/audit?entity=products&entityId=${product.id}`));

  assert.ok(page.total >= 1);
  assert.ok(page.rows.every((row) => row.entity_type === 'products'));
  assert.ok(page.rows.some((row) => row.action === 'PRICE_CHANGED'));
});

test('TC-E2E-15: "what did the manager do today" is answerable by actor and date', async () => {
  const byActor = await json(await call(`/audit?actorUsername=mgr`));
  assert.ok(byActor.total >= 1);
  assert.ok(byActor.rows.every((row) => row.actor.username === 'mgr'));

  const todayOnly = await json(await call(`/audit?from=${today}&to=${today}`));
  assert.ok(todayOnly.total >= 4, 'the day is all there');

  const longAgo = await json(await call('/audit?from=2020-01-01&to=2020-01-02'));
  assert.equal(longAgo.total, 0, 'and a quiet range is quiet');
});

test('TC-E2E-15: the trail is newest first, and pages', async () => {
  const page = await json(await call('/audit?limit=3'));

  assert.equal(page.rows.length, 3);
  assert.ok(page.total > 3);
  for (let i = 1; i < page.rows.length; i += 1) {
    assert.ok(
      Date.parse(page.rows[i - 1].occurred_at) >= Date.parse(page.rows[i].occurred_at),
      'newest first'
    );
  }

  const second = await json(await call('/audit?limit=3&offset=3'));
  assert.equal(second.offset, 3);
  assert.notEqual(second.rows[0].id, page.rows[0].id);
});

// ── SEC-1 and AUD-605 ───────────────────────────────────────────────────────

test('TC-E2E-15: no secret is anywhere on the trail', async () => {
  // A password reset writes a row saying a password changed, never what it changed to.
  const target = (await json(await call('/users'))).users.find((u) => u.username === 'till');
  await json(await call(`/users/${target.id}`, {
    method: 'PUT', body: { password: 'a-brand-new-password' },
  }));

  const everything = await json(await call('/audit?limit=200'));
  const raw = JSON.stringify(everything);

  assert.equal(/a-brand-new-password/.test(raw), false, 'no password');
  assert.equal(/\$2[aby]\$/.test(raw), false, 'no hash');
  assert.equal(/correct-horse-battery/.test(raw), false);

  const reset = everything.rows.find((row) => row.action === 'PASSWORD_RESET');
  assert.ok(reset, 'the reset is recorded');
  assert.equal(reset.after.password_changed, true, 'that it happened, not what it was');
});

test('TC-E2E-15: AUD-605 — the trail has no write path at all', async () => {
  const row = (await json(await call('/audit?limit=1'))).rows[0];

  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await call(`/audit/${row.id}`, { method, body: {} });
    assert.ok(res.status === 404 || res.status === 405, `${method} must not be a route`);
  }
  assert.equal((await call('/audit', { method: 'DELETE' })).status >= 400, true);

  // And no repository method offers one.
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'repositories', 'auditRepository.js'), 'utf8'
  );
  assert.equal(/UPDATE audit_logs|DELETE FROM audit_logs/i.test(source), false);
});

// ── The export ──────────────────────────────────────────────────────────────

test('TC-E2E-15: the export matches the filter, and is itself audited', async () => {
  const before = (await json(await call('/audit?action=AUDIT_EXPORTED'))).total;

  const res = await call('/audit/export?action=PRICE_CHANGED');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /audit-\d{4}-\d{2}-\d{2}\.csv/);

  const csv = await res.text();
  const lines = csv.trim().split('\r\n');
  assert.match(lines[0], /occurred_at_utc/, 'a header row');
  assert.equal(lines.length, 2, 'one filtered row');
  assert.match(lines[1], /PRICE_CHANGED/);
  assert.match(lines[1], /6500/, 'and it carries the figures, not just the action');

  // AUD-601: a copy of who-did-what leaving the machine is exactly the event somebody
  // would later want to find.
  const after = await json(await call('/audit?action=AUDIT_EXPORTED'));
  assert.equal(after.total, before + 1);
  assert.match(after.rows[0].reason, /exported from SCR-703/i);
  assert.equal(after.rows[0].actor.username, 'boss');
});

test('TC-E2E-15: no secret reaches the exported file either', async () => {
  const csv = await (await call('/audit/export')).text();

  assert.equal(/a-brand-new-password|correct-horse-battery/.test(csv), false);
  assert.equal(/\$2[aby]\$/.test(csv), false);
});
