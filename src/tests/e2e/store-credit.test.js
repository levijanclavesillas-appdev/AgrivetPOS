'use strict';

// TC-E2E-22 — the money the store owes a customer, through the endpoints the counter
// calls. `FT-408`, `CR-108`.
//
// One farm, one afternoon: they overpay their account, they bring back a sack, and
// then they buy feed and pay for half of it with what the store is holding. Every
// figure below is asked of the API the screens ask, and the walk ends the way the
// gate ends — on `CR-103`'s reconciliation, with negative balances in the data.
//
// What this exists to catch is the thing a unit test cannot: **the balance moving for
// no visible reason.** Store credit is earned on one line of the statement and spent
// on another, and a customer standing at the counter has to be able to follow it. So
// the walk reads the statement after every step and checks it still tells the story.

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
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';

let instance;
let BASE = null;
let owner;
const tokens = {};
let product;
let farm;
let creditSale;

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

const creditView = async () => json(await call(`/customers/${farm.id}/credit`));

test.before(async () => {
  temp.openMigrated('store-credit-e2e');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;

  temp.seedStore({ withOwner: false, taxMode: 'NONE' });
  const ref = temp.seedCatalog();
  for (const [username, role] of [['boss', 'OWNER'], ['till', 'CASHIER']]) {
    temp.seedUser({ username, role, password: PASSWORD });
    tokens[username] = authService.login({ username, password: PASSWORD }).token;
  }
  owner = authService.verifyToken(tokens.boss);

  const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-store-credit-'));
  db.transaction(() => settingsService.set('backup_folder', backups, owner));

  product = productService.create({
    sku: 'FEED-050', name: 'Hog Grower Pellets',
    categoryId: ref.category.id, baseUnitId: ref.kg.id, retailPriceCentavos: 6000,
  }, owner);
  inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli: 1000000, unitCostCentavos: 4000, actor: owner,
  });

  await json(await call('/shifts/open', {
    method: 'POST', who: 'till', body: { openingFloatCentavos: 200000, confirmed: true },
  }));

  farm = (await json(await call('/customers', {
    method: 'POST',
    body: {
      name: 'Delos Reyes Farm', code: 'DRF', customerType: 'FARM', priceLevel: 'RETAIL',
      isCreditEligible: true, creditLimitCentavos: 5000000, termsDays: 15,
    },
  }))).customer;
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── They buy on account, then overpay ───────────────────────────────────────

test('TC-E2E-22 · the farm buys 10 KG on account, and owes ₱600', async () => {
  creditSale = await json(await call('/sales', {
    method: 'POST', who: 'till',
    body: {
      lines: [{ productId: product.id, qtyMilli: 10000 }],
      customerId: farm.id,
      tenders: [{ method: 'CREDIT', amountCentavos: 60000 }],
    },
  }));

  const view = await creditView();
  assert.equal(view.credit.balance_centavos, 60000);
  assert.equal(view.open_sales.length, 1, 'one unpaid invoice');
  assert.equal(view.credit.store_credit_centavos, 0);
});

test('TC-E2E-22 · they hand over ₱1,000, and the excess becomes store credit (CR-204)', async () => {
  // Unacknowledged first, because that is what happens at a counter: the cashier keys
  // the notes they were given and the system asks whether the extra is meant.
  const asked = await call(`/customers/${farm.id}/collections`, {
    method: 'POST', who: 'till', body: { amountCentavos: 100000, method: 'CASH' },
  });
  assert.equal(asked.status, 409);
  assert.equal((await asked.json()).error.rule_id, 'CR-204');

  const taken = await json(await call(`/customers/${farm.id}/collections`, {
    method: 'POST', who: 'till',
    body: { amountCentavos: 100000, method: 'CASH', acceptOverpayment: true, notes: 'Paying ahead for the season' },
  }));

  assert.equal(taken.balance_centavos, -40000, 'CR-108: past zero, into credit');
  assert.equal(taken.store_credit_centavos, 40000);

  const view = await creditView();
  assert.equal(view.credit.store_credit_centavos, 40000);
  assert.equal(view.open_sales.length, 0, 'CR-203: the invoice is settled, not merely outnumbered');
  assert.equal(view.credit.ageing_status, 'PAID');
});

// ── They bring a sack back ──────────────────────────────────────────────────

test('TC-E2E-22 · a return with nothing owing adds to the credit rather than opening the till', async () => {
  // SCR-305 opens with what is still returnable, per line — the same endpoint the
  // screen calls, so the walk returns against the id a cashier would be clicking.
  const returnable = await json(await call(`/sales/${creditSale.sale.id}/returnable`, { who: 'till' }));
  const line = returnable.lines[0];
  assert.ok(line.sale_item_id, 'the returnable view names its lines');

  const returned = await json(await call(`/sales/${creditSale.sale.id}/returns`, {
    method: 'POST', who: 'till',
    body: {
      lines: [{ saleItemId: line.sale_item_id, qtyMilli: 5000, disposition: 'RESTOCK' }],
      reason: 'Wrong item sold',
    },
  }));

  // POS-305: the sale was on credit, so the refund goes to the ledger — and with
  // nothing owing it goes past zero. No notes leave a drawer for a customer who is
  // already in credit.
  assert.equal(returned.sale_return.refund.cash_centavos, 0);
  assert.equal(returned.sale_return.refund.store_credit_centavos, 30000);
  assert.equal(returned.drawer, null, 'the till stayed shut');

  const view = await creditView();
  assert.equal(view.credit.store_credit_centavos, 70000, '₱400 held plus ₱300 back');
  assert.equal(view.credit.balance_centavos, -70000);
});

// ── And they spend it ───────────────────────────────────────────────────────

test('TC-E2E-22 · a sack paid half from credit and half in cash', async () => {
  const before = (await creditView()).credit.store_credit_centavos;
  const shiftBefore = (await json(await call('/shifts/current', { who: 'till' })));

  // ₱600 of feed: ₱300 off the balance, ₱300 in notes.
  const sale = await json(await call('/sales', {
    method: 'POST', who: 'till',
    body: {
      lines: [{ productId: product.id, qtyMilli: 10000 }],
      customerId: farm.id,
      tenders: [
        { method: 'STORE_CREDIT', amountCentavos: 30000 },
        { method: 'CASH', amountCentavos: 30000 },
      ],
    },
  }));

  assert.equal(sale.sale.total_centavos, 60000);
  assert.equal(sale.sale.change_centavos, 0);
  assert.deepEqual(sale.tenders.map((t) => t.method).sort(), ['CASH', 'STORE_CREDIT']);

  const view = await creditView();
  assert.equal(view.credit.store_credit_centavos, before - 30000, 'exactly what was spent');
  assert.equal(view.open_sales.length, 0, 'and it opened no invoice — it was paid for');
  assert.equal(view.credit.ageing_status, 'PAID');

  // POS-509: only the cash half reached the drawer. The other ₱300 arrived weeks ago,
  // when they overpaid, and counting it again tonight would find ₱300 too much.
  const expectedBefore = shiftBefore.expected ? shiftBefore.expected.expected_cash_centavos : null;
  const shiftAfter = await json(await call('/shifts/current', { who: 'till' }));
  if (expectedBefore !== null) {
    assert.equal(shiftAfter.expected.expected_cash_centavos, expectedBefore + 30000);
  }
});

test('TC-E2E-22 · beyond the balance is refused with the figure, and nothing moves', async () => {
  const held = (await creditView()).credit.store_credit_centavos;

  const refused = await call('/sales', {
    method: 'POST', who: 'till',
    body: {
      lines: [{ productId: product.id, qtyMilli: 10000 }],
      customerId: farm.id,
      tenders: [{ method: 'STORE_CREDIT', amountCentavos: held + 10000 }],
    },
  });

  assert.equal(refused.status, 400);
  const { error } = await refused.json();
  assert.equal(error.rule_id, 'CR-108');
  assert.match(error.message, /Delos Reyes Farm/, 'the refusal names the customer');
  assert.match(error.message, new RegExp(`₱${(held / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`),
    'and the figure the cashier has to work with');

  assert.equal((await creditView()).credit.store_credit_centavos, held, 'nothing moved');
});

// ── The statement, and the invariant ────────────────────────────────────────

test('TC-E2E-22 · the statement reads down the page: earned, then spent', async () => {
  const view = await creditView();
  const rows = [...view.transactions.rows].reverse();     // oldest first, as a page reads

  assert.deepEqual(rows.map((r) => r.type), [
    'CREDIT_SALE',      // the 10 KG on account
    'COLLECTION',       // ₱1,000 handed over, ₱400 of it ahead
    'RETURN_CREDIT',    // the sack brought back
    'CREDIT_SALE',      // paid from the credit held
  ]);

  // The fourth row is the one this task exists for, and it says so: it names the sale,
  // it says the money came from store credit, and it carries no due date because
  // nothing is owed for it.
  const spent = rows[3];
  assert.equal(spent.method, 'STORE_CREDIT');
  assert.ok(spent.sale_id, 'it names the sale it paid for');
  assert.equal(spent.due_at, null);

  // Every row carries the balance it left behind, so a customer can follow it with a
  // finger rather than taking the last figure on trust.
  let running = 0;
  for (const row of rows) {
    running += row.amount_centavos;
    assert.equal(row.balance_after_centavos, running, `${row.type} on ${row.occurred_at_manila}`);
  }
  assert.equal(running, view.credit.balance_centavos);
  assert.ok(running < 0, 'and they are still in credit');
});

test('TC-E2E-22 · CR-103 reconciles, and the worklist keeps the debt and the liability apart', async () => {
  const reconciliation = await json(await call('/customers/credit-reconciliation'));
  assert.equal(reconciliation.ok, true);
  assert.deepEqual(reconciliation.breaks, []);

  const worklist = await json(await call('/customers/outstanding'));
  const row = worklist.accounts.find((a) => a.customer_id === farm.id);

  assert.ok(row, 'an account in credit is still on the worklist — it is a balance, not nothing');
  assert.ok(row.store_credit_centavos > 0);
  assert.notEqual(row.ageing_status, 'OVERDUE', 'CR-107: there is no debt here to age');

  // Requirement 7: the two totals are reported apart. Netting them answers neither
  // "what are we owed" nor "what do we owe".
  assert.equal(worklist.total_store_credit_centavos, row.store_credit_centavos);
  assert.equal(
    worklist.total_balance_centavos,
    worklist.total_receivable_centavos - worklist.total_store_credit_centavos
  );
});
