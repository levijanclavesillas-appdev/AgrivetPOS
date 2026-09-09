'use strict';

// TC-E2E-18 — a wrong sale rung, voided, and a drawer that balances.
//
// The walk TASK-021 describes, and the last of it is the point: **the shift closes with
// no variance.** A void that reversed the stock and the ledger but left the drawer
// expecting the voided sale's cash would pass every other assertion in this file and
// then hand the cashier a shortage at the end of the day, which is the moment nobody
// can reconstruct what happened.
//
// The order matters too. The close comes last, because POS-402 makes it a one-way
// door: once the shift is shut the void is gone and the correction is a return. So the
// walk proves that in the same run — void inside the shift, then close, then try again
// and read the refusal that names the return.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const customerService = require('../../services/customerService');
const inventoryService = require('../../services/inventoryService');
const clock = require('../../config/clock');
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';

const SACK_MILLI = 50000;
const FLOAT_CENTAVOS = 200000;          // ₱2,000.00 counted into the drawer

let instance;
let BASE = null;
const tokens = {};
const sessions = {};
let feed;
let farm;
let shift;
let goodSale;
let doomed;
let creditSale;

const call = (pathname, { method = 'GET', body = null, who = 'tess' } = {}) => fetch(`${BASE}${pathname}`, {
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

const refusal = async (res, { status, ruleId }) => {
  const body = await res.json();
  assert.equal(res.status, status, JSON.stringify(body));
  assert.equal(body.error.rule_id, ruleId);
  return body.error;
};

test.before(async () => {
  temp.openMigrated('voids-e2e');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;

  temp.seedStore({ withOwner: false, taxMode: 'NONE' });
  const ref = temp.seedCatalog();

  // Tess works the till; Rosa manages. POS-403 needs them to be two people, or the
  // authorisation in the middle of this walk is one person asserted twice.
  // Chachi owns the store: FR_1.1's gate wants an active owner before anything else
  // works. Rosa is the manager who actually authorises the void, because POS-403's two
  // actors have to be two people and the cashier is the one who noticed.
  for (const [who, role] of [['chachi', 'OWNER'], ['rosa', 'MANAGER'], ['tess', 'CASHIER']]) {
    temp.seedUser({ username: who, role, password: PASSWORD });
    tokens[who] = authService.login({ username: who, password: PASSWORD }).token;
    sessions[who] = authService.verifyToken(tokens[who]);
  }

  feed = productService.create({
    sku: 'HG-50', name: 'Hog Grower Pellets', categoryId: ref.category.id,
    baseUnitId: ref.kg.id, retailPriceCentavos: 5200,
  }, sessions.rosa);
  inventoryService.postStandalone({
    productId: feed.id, type: 'OPENING', qtyMilli: 10 * SACK_MILLI,
    unitCostCentavos: 3900, actor: sessions.rosa,
  });

  farm = customerService.create({
    name: 'Sitio Maligaya Farm', customerType: 'FARM', priceLevel: 'RETAIL',
    isCreditEligible: true, creditLimitCentavos: 5000000, termsDays: 30,
  }, sessions.rosa);
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

test('TC-E2E-18 · Tess opens her drawer and rings a good sale', async () => {
  const opened = await json(await call('/shifts/open', {
    method: 'POST', body: { openingFloatCentavos: FLOAT_CENTAVOS, confirmed: true },
  }));
  shift = opened.shift;

  const sale = await json(await call('/sales', {
    method: 'POST',
    body: {
      lines: [{ productId: feed.id, qtyMilli: SACK_MILLI }],        // 1 sack · ₱2,600
      tenders: [{ method: 'CASH', amountCentavos: 300000 }],        // ₱3,000, ₱400 change
    },
  }));
  goodSale = sale.sale;
  assert.equal(goodSale.total_centavos, 260000);
  assert.equal(goodSale.change_centavos, 40000);
});

test('TC-E2E-18 · then rings the wrong thing entirely', async () => {
  const before = await json(await call(`/inventory/${feed.id}`));

  const sale = await json(await call('/sales', {
    method: 'POST',
    body: {
      // Four sacks, when the farmer asked for one. The mis-scan POS-401 exists for.
      lines: [{ productId: feed.id, qtyMilli: 4 * SACK_MILLI }],    // ₱10,400
      tenders: [{ method: 'CASH', amountCentavos: 1100000 }],       // ₱11,000, ₱600 change
    },
  }));
  doomed = sale.sale;
  assert.equal(doomed.total_centavos, 1040000);
  assert.equal(doomed.change_centavos, 60000);

  const after = await json(await call(`/inventory/${feed.id}`));
  assert.equal(
    after.on_hand.qty_on_hand_milli,
    before.on_hand.qty_on_hand_milli - 4 * SACK_MILLI,
    'four sacks left the shelf'
  );
});

test('TC-E2E-18 · SCR-304 asks whether it can be undone, before offering the button', async () => {
  const eligible = await json(await call(`/sales/${doomed.id}/voidable`));

  assert.equal(eligible.can_void, true);
  assert.equal(eligible.refusal, null);
  assert.equal(eligible.shift.open, true, 'POS-402: the originating shift is still open');
  // POS-403 has no ordinary case, and the screen is told so before it draws anything.
  assert.equal(eligible.requires_authorisation, true);
  assert.equal(eligible.self_authorised, false, 'Tess is a cashier');
  assert.equal(eligible.requires_role, 'MANAGER or OWNER');
});

test('TC-E2E-18 · Tess cannot undo it alone, and the refusal says so in the rule’s words', async () => {
  const error = await refusal(
    await call(`/sales/${doomed.id}/void`, { method: 'POST', body: { reason: 'Scanned four, wanted one' } }),
    { status: 403, ruleId: 'POS-403' }
  );
  assert.equal(error.requires_role, 'MANAGER or OWNER');
  assert.match(error.message, /never void a sale unaided/);

  // POS-401: and a void with no reason is refused whoever asks.
  await refusal(
    await call(`/sales/${doomed.id}/void`, { method: 'POST', body: { reason: '', approver: { username: 'rosa' } } }),
    { status: 400, ruleId: 'POS-401' }
  );

  // Nothing happened on either attempt.
  const still = await json(await call(`/sales/${doomed.id}`));
  assert.equal(still.sale.status, 'COMPLETED');
});

test('TC-E2E-18 · Rosa authorises, and the sale reverses whole', async () => {
  const stockBefore = (await json(await call(`/inventory/${feed.id}`))).on_hand.qty_on_hand_milli;

  const result = await json(await call(`/sales/${doomed.id}/void`, {
    method: 'POST',
    body: { reason: 'Scanned four sacks, the farmer wanted one', approver: { username: 'rosa' } },
  }));

  assert.equal(result.sale.status, 'VOIDED');
  assert.equal(result.authorisation.authorised_by, 'rosa');
  assert.equal(result.authorisation.self_authorised, false);
  assert.equal(result.sale.void_reason, 'Scanned four sacks, the farmer wanted one');
  assert.ok(result.sale.voided_at && result.sale.voided_by, 'POS-401: actor and timestamp');

  // POS-401: the stock is back, by a compensating movement rather than a deletion.
  const stockAfter = (await json(await call(`/inventory/${feed.id}`))).on_hand.qty_on_hand_milli;
  assert.equal(stockAfter, stockBefore + 4 * SACK_MILLI);

  const ledger = await json(await call(`/inventory/${feed.id}/movements?limit=20`));
  const forSale = ledger.movements.filter((m) => m.reference && m.reference.no === doomed.sale_no);
  assert.equal(forSale.length, 2, 'INV-102: the sale and its reversal both stand');
  assert.deepEqual(forSale.map((m) => m.type).sort(), ['SALE', 'SALE_VOID']);

  // Requirement 6: what Tess hands back is what came in less the change she already
  // gave — ₱11,000 in, ₱600 out, so ₱10,400 back across the counter.
  assert.equal(result.reversal.drawer.cash_out_centavos, 1040000);
  assert.equal(result.reversal.drawer.till_movement_written, false);
});

test('TC-E2E-18 · POS-404 — it stays in the ledger, keeps its number, and is out of net', async () => {
  const today = clock.manilaDate(clock.nowUtc());

  const sale = await json(await call(`/sales/${doomed.id}`));
  assert.equal(sale.sale.sale_no, doomed.sale_no, 'the number is not reissued');

  const audit = await json(await call('/sales/sequence-audit', { who: 'rosa' }));
  assert.deepEqual(audit.gaps, [], 'POS-108: and the run has no hole where it sits');

  const daily = await json(await call(`/reports/daily?from=${today}`, { who: 'rosa' }));
  assert.equal(daily.totals.net_centavos, goodSale.total_centavos, 'only the good sale is in net');
  assert.equal(daily.header.voided_excluded_count, 1);
  assert.equal(daily.header.voided_excluded_centavos, doomed.total_centavos);
  assert.equal(daily.reconciliation.reconciles, true, 'and the day still reconciles');

  // Excluded from net, not from sight — which is the distinction POS-404 draws in one
  // sentence and the reason the void report exists.
  const listed = daily.sales.find((s) => s.id === doomed.id);
  assert.ok(listed, 'the void is still on the daily report');
  assert.equal(listed.excluded_from_net, true);

  const voids = await json(await call(`/reports/voids?from=${today}`, { who: 'rosa' }));
  assert.equal(voids.totals.void_count, 1);
  assert.equal(voids.voids[0].sale_no, doomed.sale_no);
  assert.equal(voids.voids[0].cashier_username, 'tess');
  assert.equal(voids.voids[0].voided_by, 'tess');
  assert.equal(voids.voids[0].approved_by, 'rosa', 'AUD-603: both actors, on the row');
  assert.match(voids.voids[0].reason, /the farmer wanted one/);
  assert.equal(voids.voids[0].cash_returned_centavos, 1040000);
  assert.match(voids.sequence_note, /no gap/);
});

test('TC-E2E-18 · a credit sale voids off the account too', async () => {
  const sale = await json(await call('/sales', {
    method: 'POST',
    body: {
      customerId: farm.id,
      lines: [{ productId: feed.id, qtyMilli: SACK_MILLI }],
      tenders: [{ method: 'CREDIT', amountCentavos: 260000 }],
    },
  }));
  creditSale = sale.sale;

  const owing = await json(await call(`/customers/${farm.id}/credit`, { who: 'rosa' }));
  assert.equal(owing.credit.balance_centavos, 260000);

  await json(await call(`/sales/${creditSale.id}/void`, {
    method: 'POST',
    body: { reason: 'Charged the wrong farm', approver: { username: 'rosa' } },
  }));

  // CR-103: the balance derives from the ledger, so it comes back by a compensating
  // row rather than by being written back to what it was.
  const after = await json(await call(`/customers/${farm.id}/credit`, { who: 'rosa' }));
  assert.equal(after.credit.balance_centavos, 0);
});

test('TC-E2E-18 · and it cannot be voided twice, or returned against', async () => {
  await refusal(
    await call(`/sales/${doomed.id}/void`, {
      method: 'POST', body: { reason: 'Again', approver: { username: 'rosa' } },
    }),
    { status: 409, ruleId: 'POS-404' }
  );

  const items = (await json(await call(`/sales/${doomed.id}`))).items;
  await refusal(
    await call(`/sales/${doomed.id}/returns`, {
      method: 'POST',
      body: { reason: 'Wrong item sold', lines: [{ saleItemId: items[0].id, qtyMilli: 1000 }] },
    }),
    { status: 409, ruleId: 'POS-301' }
  );
});

test('TC-E2E-18 · the drawer balances at the close — the assertion the whole task is for', async () => {
  const expected = await json(await call(`/shifts/${shift.id}/expected`));

  // ₱2,000 float + ₱3,000 taken on the good sale − ₱400 change. The voided sale's
  // ₱11,000 and its ₱600 change are both out, by the status alone: no till movement
  // was written for either, and a compensating one would have made this ₱10,400 wrong.
  assert.equal(
    expected.expected_cash_centavos,
    FLOAT_CENTAVOS + 300000 - 40000,
    'float + the good sale’s cash − its change'
  );
  assert.equal(expected.cash_sales_centavos, 300000, 'the void is out of cash sales');
  assert.equal(expected.change_given_centavos, 40000, 'and its change is out of change given');

  const closed = await json(await call(`/shifts/${shift.id}/close`, {
    method: 'POST',
    body: { actualCashCentavos: expected.expected_cash_centavos, confirmed: true },
  }));

  // POS-510: no variance, so no reason was needed and none was asked for. A void that
  // left the drawer expecting the voided sale's cash would have shown a ₱10,400
  // shortage here, at the moment of the day when nobody can reconstruct what happened.
  assert.equal(closed.variance_centavos, 0);
  assert.equal(closed.beyond_tolerance, false);
  assert.equal(closed.variance_reason, null, 'and none was asked for');
});

test('TC-E2E-18 · POS-402 — after the close, the correction is a return', async () => {
  const error = await refusal(
    await call(`/sales/${goodSale.id}/void`, {
      method: 'POST',
      body: { reason: 'Thought better of it', approver: { username: 'rosa' } },
    }),
    { status: 409, ruleId: 'POS-402' }
  );

  // The refusal has to leave the counter somewhere to go. "No" on its own is the
  // answer that gets worked around.
  assert.match(error.message, /as a return/);
  assert.match(error.message, /counted against it/);

  const eligible = await json(await call(`/sales/${goodSale.id}/voidable`));
  assert.equal(eligible.can_void, false);
  assert.equal(eligible.refusal.rule_id, 'POS-402');
  assert.equal(eligible.shift.open, false);
});
