'use strict';

// TC-E2E-17 — a return, through the endpoints SCR-305 calls.
//
// The walk TASK-020 describes: sell three lines to one farm, then take two of them
// back — one restocked, one written off — and a third off a separate credit sale, and
// find the ledger, the balance and the daily reconciliation all right afterwards.
//
// Every step goes over HTTP with a real session, because the rules were proved by the
// integration cases and what this asserts is that a person can reach them. That
// includes the two refusals, which is the part a screen is most likely to get wrong:
// a cashier restocking a medicine is stopped and a manager releases it, and the
// authorisation is a real second actor rather than a claim in a request body.
//
// The three lines are chosen so that each takes a different path:
//
//   • **Hog Grower** — an ordinary feed line, restocked, and the shelf goes up.
//   • **Antibiotic** — batch-tracked, so POS-304 defaults it to write-off; the cashier
//     tries to restock it, is refused, and the manager authorises. Two movements.
//   • **Vitamin drench** — on a credit sale, so POS-305 sends the refund back to the
//     account it was charged to and POS-306 pays out nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const customerService = require('../../services/customerService');
const inventoryService = require('../../services/inventoryService');
const shiftService = require('../../services/shiftService');
const clock = require('../../config/clock');
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';

const SACK_MILLI = 50000;               // a fifty-kilo sack, in thousandths (MON-002)

let instance;
let BASE = null;
const tokens = {};
const sessions = {};
let feed;
let medicine;
let drench;
let farm;
let cashSale;
let creditSale;
let posted = {};

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
  temp.openMigrated('returns-e2e');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;

  temp.seedStore({ withOwner: false, taxMode: 'NONE' });
  const ref = temp.seedCatalog();

  // Tess works the till; Rosa manages. The split is what makes POS-304's authorisation
  // a real one — AUD-603's distinct actors apply because Tess is not a manager.
  for (const [who, role] of [['rosa', 'MANAGER'], ['tess', 'CASHIER'], ['boss', 'OWNER']]) {
    temp.seedUser({ username: who, role, password: PASSWORD });
    tokens[who] = authService.login({ username: who, password: PASSWORD }).token;
    sessions[who] = authService.verifyToken(tokens[who]);
  }

  const owner = sessions.boss;

  // INV-202: a batch is part of a supplier's identity, so batch-tracked stock needs one.
  const supplier = temp.seedSupplier({}, owner);

  const stock = (input, qtyMilli, costCentavos) => {
    const made = productService.create({ baseUnitId: ref.kg.id, ...input }, owner);
    // INV-201, from TASK-029: a batch-tracked product's stock arrives in a batch, so
    // even the opening shelf has to be one. The antibiotic below is the only product
    // in this walk that is batch-tracked, and it is batch-tracked precisely because
    // POS-304 turns on it.
    if (input.isBatchTracked) {
      temp.seedBatch({
        product: made, supplier, qtyMilli, unitCostCentavos: costCentavos,
        batchNo: `${input.sku}-A`, actor: owner,
      });
    } else {
      inventoryService.postStandalone({
        productId: made.id, type: 'OPENING', qtyMilli, unitCostCentavos: costCentavos, actor: owner,
      });
    }
    return made;
  };

  feed = stock({
    sku: 'HG-50', name: 'Hog Grower Pellets', categoryId: ref.category.id,
    retailPriceCentavos: 5200,
  }, 10 * SACK_MILLI, 3900);

  // POS-304's first clause, as a column. This is the line the walk turns on.
  medicine = stock({
    sku: 'AB-100', name: 'Amoxicillin 100ml', categoryId: ref.otherCategory.id,
    retailPriceCentavos: 32000, isBatchTracked: true,
  }, 20000, 21000);

  drench = stock({
    sku: 'VD-1L', name: 'Vitamin Drench 1L', categoryId: ref.category.id,
    retailPriceCentavos: 45000,
  }, 30000, 30000);

  farm = customerService.create({
    name: 'Sitio Maligaya Farm', customerType: 'FARM', priceLevel: 'RETAIL',
    isCreditEligible: true, creditLimitCentavos: 5000000, termsDays: 30,
  }, owner);

  shiftService.open({ actor: sessions.tess, openingFloatCentavos: 300000, confirmed: true });
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

test('TC-E2E-17 · the farm buys feed and a bottle of antibiotic, for cash', async () => {
  const sale = await json(await call('/sales', {
    method: 'POST',
    body: {
      customerId: farm.id,
      lines: [
        { productId: feed.id, qtyMilli: 2 * SACK_MILLI },        // 2 sacks · ₱5,200
        { productId: medicine.id, qtyMilli: 2000 },              // 2 × 100 ml · ₱640
      ],
      tenders: [{ method: 'CASH', amountCentavos: 600000 }],
    },
  }));
  cashSale = sale.sale;

  assert.equal(sale.sale.total_centavos, 584000, '₱5,200 of feed and ₱640 of antibiotic');
  assert.equal(sale.sale.change_centavos, 16000);

  const shelf = await json(await call(`/inventory/${feed.id}`));
  assert.equal(shelf.on_hand.qty_on_hand_milli, 8 * SACK_MILLI, 'eight sacks left');
});

test('TC-E2E-17 · and takes a drum of drench on account', async () => {
  const sale = await json(await call('/sales', {
    method: 'POST',
    body: {
      customerId: farm.id,
      lines: [{ productId: drench.id, qtyMilli: 2000 }],         // 2 L · ₱900
      tenders: [{ method: 'CREDIT', amountCentavos: 90000 }],
    },
  }));
  creditSale = sale.sale;

  const credit = await json(await call(`/customers/${farm.id}/credit`));
  assert.equal(credit.credit.balance_centavos, 90000, 'CR-103: ₱900 on account');
});

// ── Two days later, at the counter ──────────────────────────────────────────

test('TC-E2E-17 · the lookup offers the sale, and says what is left on it', async () => {
  // SCR-305's opening question. POS-301's two statuses are the server's, so a screen
  // never offers a sale it will then be refused a return against.
  const found = await json(await call(`/sales?returnable=true&q=${cashSale.sale_no}`));
  assert.equal(found.sales.length, 1);
  assert.equal(found.sales[0].id, cashSale.id);
  assert.equal(found.sales[0].is_returnable, true);

  const view = await json(await call(`/sales/${cashSale.id}/returnable`));
  assert.equal(view.sale.is_returnable, true);
  assert.equal(view.window.beyond, false, 'POS-307: well inside the seven days');
  assert.deepEqual(
    view.lines.map((line) => [line.sku, line.remaining_qty_milli, line.default_disposition]),
    [['HG-50', 2 * SACK_MILLI, 'RESTOCK'], ['AB-100', 2000, 'WRITE_OFF']]
  );

  // POS-304 says the screen defaults that way **and says why**. The sentence is the
  // server's, so the screen cannot soften it.
  const line = view.lines.find((l) => l.sku === 'AB-100');
  assert.match(line.default_reason, /batch-tracked/);
  assert.match(line.default_reason, /POS-304/);
  assert.equal(view.lines.find((l) => l.sku === 'HG-50').default_reason, null);

  // POS-302: the reason list is served, not hard-coded in the renderer.
  assert.ok(view.reasons.includes('Wrong item sold'));
});

test('TC-E2E-17 · Tess cannot put the antibiotic back on the shelf, and is told why', async () => {
  const view = await json(await call(`/sales/${cashSale.id}/returnable`));
  const bottle = view.lines.find((l) => l.sku === 'AB-100');

  const error = await refusal(
    await call(`/sales/${cashSale.id}/returns`, {
      method: 'POST',
      body: {
        reason: 'Customer changed their mind',
        lines: [{ saleItemId: bottle.sale_item_id, qtyMilli: 1000, disposition: 'RESTOCK' }],
      },
    }),
    { status: 403, ruleId: 'POS-304' }
  );
  assert.equal(error.requires_role, 'MANAGER or OWNER');
  assert.match(error.message, /batch-tracked/);

  // POS-302 is refused the same way, and before anybody argues about the disposition.
  await refusal(
    await call(`/sales/${cashSale.id}/returns`, {
      method: 'POST',
      body: { reason: 'the farmer changed his mind', lines: [{ saleItemId: bottle.sale_item_id, qtyMilli: 1000 }] },
    }),
    { status: 400, ruleId: 'POS-302' }
  );

  // POS-301, at the far end: three bottles cannot come back off a sale of two.
  await refusal(
    await call(`/sales/${cashSale.id}/returns`, {
      method: 'POST',
      body: { reason: 'Wrong item sold', lines: [{ saleItemId: bottle.sale_item_id, qtyMilli: 3000 }] },
    }),
    { status: 409, ruleId: 'POS-301' }
  );
});

test('TC-E2E-17 · one sack goes back on the shelf and one bottle is written off', async () => {
  const view = await json(await call(`/sales/${cashSale.id}/returnable`));
  const sack = view.lines.find((l) => l.sku === 'HG-50');
  const bottle = view.lines.find((l) => l.sku === 'AB-100');

  const result = await json(await call(`/sales/${cashSale.id}/returns`, {
    method: 'POST',
    body: {
      reason: 'Wrong item sold',
      notes: 'Wanted the starter, not the grower.',
      // Rosa authenticated in §4's panel. She is a different user from Tess, so
      // AUD-603's two actors are real ones.
      approver: { username: 'rosa' },
      approvalReason: 'Bottle unopened and never left the counter.',
      lines: [
        { saleItemId: sack.sale_item_id, qtyMilli: SACK_MILLI, disposition: 'RESTOCK' },
        { saleItemId: bottle.sale_item_id, qtyMilli: 1000, disposition: 'RESTOCK' },
      ],
    },
  }));
  posted.cash = result;

  assert.match(result.sale_return.return_no, /^RET-\d{8}-\d{6}$/);
  assert.equal(result.sale_status, 'PARTIALLY_RETURNED', 'POS-107: the one status a return moves');
  assert.equal(result.authorisation.authorised_by, 'rosa');

  // ₱2,600 of feed and ₱320 of antibiotic, refunded in cash — this sale was paid in
  // cash, and POS-305 refunds by the means it was tendered by. The farm owes ₱900 on
  // a *different* sale, and POS-306 does not reach it: that rule is scoped to a return
  // against a credit sale, and reading it wider would mean confiscating a refund to
  // settle an unrelated debt.
  assert.equal(result.sale_return.total_centavos, 292000);
  assert.equal(result.sale_return.refund.cash_centavos, 292000);
  assert.equal(result.sale_return.refund.credit_centavos, 0);
  assert.equal(result.sale_return.refund.store_credit_centavos, 0);
  assert.equal(result.withheld_reason, null);
  assert.equal(result.drawer.reason, 'CASH_REFUND', 'POS-507: the drawer opened for it');

  // POS-303: the restocked sack is one movement; the antibiotic — restocked against
  // the default — is also one, because the disposition is what decides, not the rule.
  const sackLine = result.lines.find((l) => l.sku === 'HG-50');
  const bottleLine = result.lines.find((l) => l.sku === 'AB-100');
  assert.equal(sackLine.write_off_movement_id, null);
  assert.equal(bottleLine.write_off_movement_id, null);
  assert.equal(bottleLine.restocked_against_default, true, 'POS-304: the exception is on the row');

  const shelf = await json(await call(`/inventory/${feed.id}`));
  assert.equal(shelf.on_hand.qty_on_hand_milli, 9 * SACK_MILLI, 'the sack is back');
});

test('TC-E2E-17 · the second bottle comes back opened, and is written off', async () => {
  const view = await json(await call(`/sales/${cashSale.id}/returnable`));
  const bottle = view.lines.find((l) => l.sku === 'AB-100');
  assert.equal(bottle.remaining_qty_milli, 1000, 'POS-301: one of the two is left');

  const before = await json(await call(`/inventory/${medicine.id}`));

  // No approver this time: the default *is* write-off, so nothing needs authorising.
  const result = await json(await call(`/sales/${cashSale.id}/returns`, {
    method: 'POST',
    body: {
      reason: 'Damaged on arrival',
      lines: [{ saleItemId: bottle.sale_item_id, qtyMilli: 1000, disposition: 'WRITE_OFF' }],
    },
  }));
  posted.writeOff = result;
  assert.equal(result.authorisation.required, false);

  // POS-303: two movements, netting to zero. Posting nothing would leave the same
  // figure on the shelf and no row saying the customer brought anything back.
  const line = result.lines[0];
  assert.ok(line.return_movement_id && line.write_off_movement_id);
  assert.equal(line.net_stock_milli, 0);

  const after = await json(await call(`/inventory/${medicine.id}`));
  assert.equal(after.on_hand.qty_on_hand_milli, before.on_hand.qty_on_hand_milli);

  const ledger = await json(await call(`/inventory/${medicine.id}/movements?limit=20`));
  const forReturn = ledger.movements.filter((m) => m.reference && m.reference.no === result.sale_return.return_no);
  assert.deepEqual(forReturn.map((m) => m.type).sort(), ['CUSTOMER_RETURN', 'DAMAGE']);
});

test('TC-E2E-17 · the drench goes back off the credit sale, and comes off the balance', async () => {
  const view = await json(await call(`/sales/${creditSale.id}/returnable`));
  assert.equal(view.credit.sold_on_credit, true, 'POS-305 knows how it was paid for');
  const line = view.lines[0];

  const result = await json(await call(`/sales/${creditSale.id}/returns`, {
    method: 'POST',
    body: {
      reason: 'Duplicate purchase',
      lines: [{ saleItemId: line.sale_item_id, qtyMilli: 1000, disposition: 'RESTOCK' }],
    },
  }));
  posted.credit = result;

  // POS-305's precedence, in order: credit first, and it covers the whole ₱450.
  assert.equal(result.sale_return.total_centavos, 45000);
  assert.equal(result.sale_return.refund.credit_centavos, 45000);
  assert.equal(result.sale_return.refund.cash_centavos, 0, 'POS-306: no cash while a balance stands');
  assert.ok(result.sale_return.credit_txn_id);

  const credit = await json(await call(`/customers/${farm.id}/credit`));
  // ₱900 owed, less the ₱450 this return put back: the account moved, and only this
  // return moved it. The two cash refunds above left it exactly where it was.
  assert.equal(credit.credit.balance_centavos, 90000 - 45000);

  assert.equal(result.sale_status, 'PARTIALLY_RETURNED');
});

// ── And the figures afterwards ──────────────────────────────────────────────

test('TC-E2E-17 · every return is on the trail, with its rule and its two actors', async () => {
  const trail = await json(await call('/audit?action=SALE_RETURNED&limit=50', { who: 'boss' }));
  assert.equal(trail.rows.length, 3, 'three returns, three rows');

  const overrides = await json(await call(
    '/audit?action=OVERRIDE_RESTOCK_AGAINST_DEFAULT&limit=50', { who: 'boss' }
  ));
  assert.equal(overrides.rows.length, 1, 'AUD-603: one override, and only one');
  assert.equal(overrides.rows[0].actor.username, 'tess');
  assert.equal(overrides.rows[0].approver.username, 'rosa');
  assert.match(overrides.rows[0].reason, /unopened/);
});

test('TC-E2E-17 · POS-509 — the drawer is short by exactly what was handed back', async () => {
  const shift = await json(await call('/shifts/current'));
  const expected = await json(await call(`/shifts/${shift.shift.id}/expected`));

  // The two returns off the cash sale were paid out; the one off the credit sale was
  // not. POS-509's sixth term is the first two, subtracted once — the return records
  // the refund and writes no till movement of its own, or it would come off twice.
  const cashRefunded = posted.cash.sale_return.total_centavos
    + posted.writeOff.sale_return.total_centavos;
  assert.equal(expected.cash_refunds_centavos, cashRefunded);
  assert.equal(
    expected.expected_cash_centavos,
    300000 + 600000 - 16000 - cashRefunded,
    'float + cash tendered − change given − cash refunded'
  );
});

test('TC-E2E-17 · RPT-101 — the day reconciles with the returns in it', async () => {
  const daily = await json(await call(
    `/reports/daily?from=${clock.manilaDate(clock.nowUtc())}`, { who: 'boss' }
  ));

  assert.equal(daily.totals.return_count, 3);
  assert.equal(
    daily.totals.returns_centavos,
    posted.cash.sale_return.total_centavos
      + posted.writeOff.sale_return.total_centavos
      + posted.credit.sale_return.total_centavos
  );
  // The fourth term is no longer zero — which is the whole of requirement 10 — and
  // the term that was reserved for it is the one now carrying a figure.
  assert.ok(daily.totals.returns_centavos > 0);
  assert.equal(
    daily.totals.refund_cash_centavos,
    posted.cash.sale_return.total_centavos + posted.writeOff.sale_return.total_centavos
  );
  assert.equal(daily.totals.refund_credit_centavos, posted.credit.sale_return.total_centavos);

  // Both halves of RPT-101's identity, with the returns in them. A report that does
  // not reconcile is a defect, not a rounding artefact.
  assert.equal(daily.reconciliation.balances, true, daily.reconciliation.statement);
  assert.equal(daily.reconciliation.tenders_balance, true, daily.reconciliation.tender_statement);
  assert.equal(daily.reconciliation.reconciles, true);
  assert.equal(
    daily.totals.net_centavos,
    daily.totals.gross_sales_net_centavos - daily.totals.returns_centavos
  );

  // And the CSV a reader takes to the accountant carries the same four terms.
  const csv = await (await call(
    `/reports/daily/export.csv?from=${clock.manilaDate(clock.nowUtc())}`, { who: 'boss' }
  )).text();
  assert.match(csv, /"Returns"/);
  assert.match(csv, /"  refunded in cash"/);
  assert.match(csv, /"  refunded off a balance"/);
});

test('TC-E2E-17 · a posted return is immutable, and the refusal names the correction', async () => {
  const one = posted.credit.sale_return.id;

  const read = await json(await call(`/returns/${one}`));
  assert.equal(read.sale_return.is_immutable, true);
  assert.equal(read.lines.length, 1);

  for (const method of ['PUT', 'DELETE']) {
    const error = await refusal(
      await call(`/returns/${one}`, { method }),
      { status: 409, ruleId: 'INV-102' }
    );
    assert.match(error.message, /adjustment/);
  }

  // And the whole day's returns read back as a list, which is what a manager asking
  // "what went back today" is actually holding.
  const listed = await json(await call('/returns?limit=50', { who: 'rosa' }));
  assert.equal(listed.total, 3);
  assert.ok(listed.returns.every((r) => r.is_immutable));
});
