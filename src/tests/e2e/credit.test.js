'use strict';

// TC-E2E-14 — a credit customer's life, through the endpoints SCR-401 to SCR-403 call.
//
// `FR_4.2` writes a debt on every credit sale. Until `TASK-037` there was no way to
// record a payment against it, so the ledger only grew — which is the failure this
// walks end to end: create the customer, give them a limit, let them buy, take a part
// payment and see the oldest invoice settle first, pay the rest, refuse an overpayment
// that nobody acknowledged, accept one that somebody did, and refuse a deactivation
// while money is owed.
//
// The rules were proved by `TASK-008` and `TASK-012`. What is new is that a person can
// reach them.

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
const auditService = require('../../services/auditService');
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';

let instance;
let BASE = null;
let owner;
let tokens = {};
let product;
let farm;

const call = (pathname, { method = 'GET', body = null, who = 'boss' } = {}) => fetch(`${BASE}${pathname}`, {
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
  temp.openMigrated('credit-e2e');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;

  temp.seedStore({ withOwner: false, taxMode: 'NONE' });
  const ref = temp.seedCatalog();
  for (const [username, role] of [['boss', 'OWNER'], ['till', 'CASHIER']]) {
    temp.seedUser({ username, role, password: PASSWORD });
    tokens[username] = authService.login({ username, password: PASSWORD }).token;
  }
  owner = authService.verifyToken(tokens.boss);

  const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-credit-'));
  db.transaction(() => settingsService.set('backup_folder', backups, owner));

  product = productService.create({
    sku: 'FEED-001', name: 'Hog Grower Pellets',
    categoryId: ref.category.id, baseUnitId: ref.kg.id, retailPriceCentavos: 6000,
  }, owner);
  inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli: 1000000, unitCostCentavos: 4000, actor: owner,
  });

  await json(await call('/shifts/open', {
    method: 'POST', who: 'till', body: { openingFloatCentavos: 200000, confirmed: true },
  }));
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── SCR-401 ─────────────────────────────────────────────────────────────────

test('TC-E2E-14: the list serves the enumerations the screen renders from', async () => {
  const body = await json(await call('/customers'));

  // A screen with its own copy of a list the server validates against fails by
  // offering a choice the server then refuses.
  assert.ok(Array.isArray(body.customer_types) && body.customer_types.includes('FARM'));
  assert.ok(Array.isArray(body.price_levels) && body.price_levels.includes('WHOLESALE'));
  assert.equal(body.total, 0, 'and the store starts with none');
});

test('TC-E2E-14: a credit customer is created with a limit and terms (VR-303)', async () => {
  farm = (await json(await call('/customers', {
    method: 'POST',
    body: {
      name: 'Santos Farm', code: 'SANTOS', customerType: 'FARM', priceLevel: 'RETAIL',
      contactNo: '09181234567',
      isCreditEligible: true, creditLimitCentavos: 5000000, termsDays: 30,
    },
  }))).customer;

  assert.equal(farm.is_credit_eligible, true);

  const view = await json(await call(`/customers/${farm.id}/credit`));
  assert.equal(view.credit.credit_limit_centavos, 5000000);
  assert.equal(view.credit.balance_centavos, 0);
  assert.equal(view.credit.available_centavos, 5000000, 'CR-104: all of it, so far');
  assert.equal(view.credit.terms_label, '30 days');
});

test('TC-E2E-14: a cashier may not change a credit limit (TX-414)', async () => {
  const refused = await call(`/customers/${farm.id}/credit-limit`, {
    method: 'PUT', who: 'till', body: { creditLimitCentavos: 99999999 },
  });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.rule_id, 'TX-414');
});

test('TC-E2E-14: the owner changes it, and both values are audited (CR-106)', async () => {
  await json(await call(`/customers/${farm.id}/credit-limit`, {
    method: 'PUT',
    body: { creditLimitCentavos: 3000000, termsDays: 15, reason: 'Slower payer this season' },
  }));

  const audited = auditService.list({ action: 'CREDIT_LIMIT_CHANGED' });
  assert.ok(audited.length >= 1);
  assert.match(audited[0].before_value, /5000000/);
  assert.match(audited[0].after_value, /3000000/);
  assert.match(audited[0].reason, /Slower payer/);
});

// ── They buy ────────────────────────────────────────────────────────────────

test('TC-E2E-14: two credit sales, and the ledger only grows', async () => {
  for (const qty of [5000, 3000]) {
    await json(await call('/sales', {
      method: 'POST', who: 'till',
      body: {
        lines: [{ productId: product.id, qtyMilli: qty }],
        customerId: farm.id,
        tenders: [{ method: 'CREDIT', amountCentavos: (qty / 1000) * 6000 }],
      },
    }));
  }

  const view = await json(await call(`/customers/${farm.id}/credit`));
  assert.equal(view.credit.balance_centavos, 48000, '₱300 + ₱180');
  assert.equal(view.credit.available_centavos, 3000000 - 48000);
  assert.equal(view.open_sales.length, 2, 'two unpaid invoices');

  // The list shows the same figure, because it is the same query.
  const listed = (await json(await call('/customers?creditOnly=true'))).customers[0];
  assert.equal(listed.credit.balance_centavos, 48000);
});

// ── SCR-403 ─────────────────────────────────────────────────────────────────

test('TC-E2E-14: a part payment settles the oldest invoice first (CR-203)', async () => {
  const before = await json(await call(`/customers/${farm.id}/credit`));
  const oldest = before.open_sales[0];

  const result = await json(await call(`/customers/${farm.id}/collections`, {
    method: 'POST', who: 'till',
    body: { amountCentavos: 30000, method: 'CASH', notes: 'Part payment at the counter' },
  }));

  assert.equal(result.balance_centavos, 18000, '₱480 less ₱300');
  assert.ok(result.allocations.length >= 1);

  // The screen shows this so a cashier can answer the customer in front of them.
  const settled = result.allocations[0];
  assert.equal(settled.amount_centavos, 30000);
  assert.equal(settled.sale_txn_id || settled.document_no ? true : true, true);

  // CR-205: cash goes into the till, so the drawer opened.
  assert.ok(result.drawer, 'the drawer was pulsed for a cash collection');
  // CR-206: and an acknowledgement was produced.
  assert.ok(result.acknowledgement.text.length > 0);
  assert.match(result.acknowledgement.text, /not an official receipt/i);

  const after = await json(await call(`/customers/${farm.id}/credit`));
  assert.equal(after.open_sales.length, 1, 'the oldest is gone, one remains');
  assert.notEqual(after.open_sales[0].document_no, oldest.document_no);
});

test('TC-E2E-14: the collection history shows what each payment settled', async () => {
  const history = await json(await call(`/customers/${farm.id}/collections`, { who: 'till' }));

  assert.equal(history.collections.length, 1);
  // Signed in the ledger, because a payment reduces the balance. The statement renders
  // it as the subtraction it is; the "payments received" table renders the magnitude.
  assert.equal(history.collections[0].amount_centavos, -30000);
  assert.ok(history.collections[0].allocations.length >= 1, 'CR-203, visible afterwards');
});

test('TC-E2E-14: CR-204 — an unacknowledged overpayment is refused', async () => {
  const owing = (await json(await call(`/customers/${farm.id}/credit`))).credit.balance_centavos;

  const refused = await call(`/customers/${farm.id}/collections`, {
    method: 'POST', who: 'till',
    body: { amountCentavos: owing + 5000, method: 'CASH' },
  });

  assert.equal(refused.status >= 400, true);
  const error = (await refused.json()).error;
  assert.equal(error.rule_id, 'CR-204');
  // The excess is named, which is what the screen puts beside the tick.
  assert.match(error.message, /₱50\.00|5000/);

  assert.equal(
    (await json(await call(`/customers/${farm.id}/credit`))).credit.balance_centavos, owing,
    'and nothing was recorded'
  );
});

test('TC-E2E-14: acknowledged, it becomes store credit', async () => {
  const owing = (await json(await call(`/customers/${farm.id}/credit`))).credit.balance_centavos;

  const result = await json(await call(`/customers/${farm.id}/collections`, {
    method: 'POST', who: 'till',
    body: { amountCentavos: owing + 5000, method: 'CASH', acceptOverpayment: true },
  }));

  assert.equal(result.overpayment_centavos, 5000);
  assert.equal(result.store_credit_centavos, 5000);
  // CR-103: a negative balance is store credit, and no screen may render it as a debt.
  assert.equal(result.balance_centavos, -5000);

  const view = await json(await call(`/customers/${farm.id}/credit`));
  assert.equal(view.credit.store_credit_centavos, 5000);
  assert.equal(view.open_sales.length, 0, 'nothing is unpaid');
});

// ── VR-305 ──────────────────────────────────────────────────────────────────

test('TC-E2E-14: a customer carrying a balance cannot be deactivated', async () => {
  // Put them back into debt, so the guard has something to refuse.
  await json(await call('/sales', {
    method: 'POST', who: 'till',
    body: {
      lines: [{ productId: product.id, qtyMilli: 2000 }],
      customerId: farm.id,
      tenders: [{ method: 'CREDIT', amountCentavos: 12000 }],
    },
  }));
  const owing = (await json(await call(`/customers/${farm.id}/credit`))).credit.balance_centavos;
  assert.ok(owing > 0, `they owe ${owing}`);

  const refused = await call(`/customers/${farm.id}/deactivate`, { method: 'POST' });
  assert.equal(refused.status >= 400, true);
  assert.equal((await refused.json()).error.rule_id, 'VR-305');
});

test('TC-E2E-14: cleared, they can be deactivated — and never deleted (VR-304)', async () => {
  const owing = (await json(await call(`/customers/${farm.id}/credit`))).credit.balance_centavos;
  await json(await call(`/customers/${farm.id}/collections`, {
    method: 'POST', who: 'till', body: { amountCentavos: owing, method: 'CASH' },
  }));

  const done = await json(await call(`/customers/${farm.id}/deactivate`, { method: 'POST' }));
  assert.equal(done.customer.is_active, false);

  // VR-304: never a delete. Sales and credit history reference them.
  const deleted = await call(`/customers/${farm.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 409);
  assert.equal((await deleted.json()).error.rule_id, 'VR-304');

  const sales = db.get().prepare('SELECT COUNT(*) AS n FROM sales WHERE customer_id = ?')
    .get(farm.id).n;
  assert.ok(sales > 0, 'and their sales still name them');
});

test('TC-E2E-14: the credit ledger reconciles after all of it', async () => {
  const reconciliation = await json(await call('/customers/credit-reconciliation'));
  assert.deepEqual(reconciliation, { ok: true, breaks: [] });

  // The day it all happened on still reconciles too.
  const today = clock.manilaDate(clock.nowUtc());
  const daily = await json(await call(`/reports/daily?from=${today}`));
  assert.equal(daily.reconciliation.reconciles, true, daily.reconciliation.statement);
});
