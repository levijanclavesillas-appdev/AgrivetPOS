'use strict';

// TC-E2E-24 — one batch of a vaccine, sold six times, then recalled.
//
// The walk TASK-030 describes, over HTTP: two sales on credit to named farms, three to
// walk-ins, one later voided — and then the question a manufacturer's notice makes the
// store ask. Who has it, how much, and who can I not reach.
//
// **The assertion that matters is the arithmetic at the end**, because a recall is only
// as good as its reconciliation: what this batch gave out, less what came back, plus
// what is still on the shelf, has to add up to what was received. A recall that lost a
// sack somewhere is a recall that leaves somebody holding it.
//
// The second one that matters is the walk-in count. Four of the six buyers here cannot
// be telephoned — the three walk-ins and the voided sale, which was also cash over the
// counter — and the store has to be told that as a number rather than left to notice it
// row by row.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const customerService = require('../../services/customerService');
const batchService = require('../../services/batchService');
const goodsReceiptService = require('../../services/goodsReceiptService');
const shiftService = require('../../services/shiftService');
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';
const VIAL = 1000;

let instance;
let BASE = null;
const tokens = {};
const sessions = {};
let product;
let batch;
let voidedSaleNo;

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
  temp.openMigrated('recall-e2e');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;

  temp.seedStore({ withOwner: false, taxMode: 'NONE' });
  const ref = temp.seedCatalog();

  for (const [who, role] of [['boss', 'OWNER'], ['till', 'CASHIER'], ['boss2', 'MANAGER']]) {
    temp.seedUser({ username: who, role, password: PASSWORD });
    const signedIn = authService.login({ username: who, password: PASSWORD });
    tokens[who] = signedIn.token;
    sessions[who] = authService.verifyToken(signedIn.token);
  }
  const owner = sessions.boss;
  const supplier = temp.seedSupplier({ name: 'Mindanao Vet Supply', code: 'MVS' }, owner);

  product = productService.create({
    sku: 'VET-FMD-20',
    name: 'Foot and Mouth Vaccine 20ml',
    categoryId: ref.otherCategory.id,
    baseUnitId: ref.piece.id,
    retailPriceCentavos: 45000,
    isBatchTracked: true,
  }, owner);

  // One batch, thirty vials. Everything sold below comes out of it.
  goodsReceiptService.post({
    supplierId: supplier.id,
    supplierDrNo: 'DR-FMD-8891',
    lines: [{
      productId: product.id,
      receivedQtyMilli: 30 * VIAL,
      unitCostCentavos: 28000,
      batchNo: 'FMD-8891',
      expiryDate: batchService.addDays(batchService.today(), 240),
    }],
  }, owner);
  [batch] = batchService.listForProduct(product.id, {});

  shiftService.open({ actor: sessions.till, openingFloatCentavos: 500000, confirmed: true });
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

test('TC-E2E-24 · the batch is sold six times — two farms, three walk-ins, one to be voided', async () => {
  const farms = [];
  for (const [name, contact] of [['Santos Farm', '09171112222'], ['Dela Cruz Piggery', '09173334444']]) {
    farms.push(customerService.create({
      name, customerType: 'FARM', priceLevel: 'RETAIL', contactNo: contact,
      isCreditEligible: true, creditLimitCentavos: 5000000, termsDays: 30,
    }, sessions.boss));
  }

  // Two on credit, to people the store can telephone.
  for (const [index, farm] of farms.entries()) {
    await json(await call('/sales', {
      method: 'POST',
      who: 'till',
      body: {
        lines: [{ productId: product.id, qtyMilli: (index + 2) * VIAL }],   // 2 and 3
        customerId: farm.id,
        tenders: [{ method: 'CREDIT', amountCentavos: (index + 2) * 45000 }],
      },
    }));
  }

  // Three walk-ins, who cannot be telephoned at all.
  for (const vials of [1, 4, 2]) {
    await json(await call('/sales', {
      method: 'POST',
      who: 'till',
      body: {
        lines: [{ productId: product.id, qtyMilli: vials * VIAL }],
        tenders: [{ method: 'CASH', amountCentavos: 500000 }],
      },
    }));
  }

  // And one more that the counter undoes a minute later.
  const mistake = await json(await call('/sales', {
    method: 'POST',
    who: 'till',
    body: {
      lines: [{ productId: product.id, qtyMilli: 3 * VIAL }],
      tenders: [{ method: 'CASH', amountCentavos: 500000 }],
    },
  }));
  voidedSaleNo = mistake.sale.sale_no;
  await json(await call(`/sales/${mistake.sale.id}/void`, {
    method: 'POST',
    who: 'boss',
    body: { reason: 'Rang up the wrong customer’s vials' },
  }));

  // 2 + 3 + 1 + 4 + 2 = 12 gone, and the voided three came back.
  const { on_hand: onHand } = await json(await call(`/inventory/${product.id}`));
  assert.equal(onHand.qty_on_hand_milli, 18 * VIAL);
});

test('TC-E2E-24 · the recall names everyone who took it, and counts who cannot be reached', async () => {
  const recall = await json(await call(`/batches/${batch.id}/recall`, { who: 'boss' }));

  assert.equal(recall.sales.length, 6, 'every sale that took from the batch, the voided one included');

  const named = recall.sales.filter((sale) => !sale.is_walk_in);
  assert.deepEqual(
    named.map((sale) => [sale.customer_name, sale.qty_display]).sort(),
    [['Dela Cruz Piggery', '3 PC'], ['Santos Farm', '2 PC']],
    'the two farms, with what each took'
  );
  // The number somebody actually rings, on the row.
  assert.ok(named.every((sale) => /^09\d{9}$/.test(sale.customer_contact_no)));

  // Four of the six buyers cannot be telephoned — the three walk-ins, and the voided
  // sale, which was also cash over the counter. That last one is the case the count
  // exists for: its goods may have left with somebody the store cannot ring, and a
  // figure of three would have quietly written them off.
  assert.equal(recall.summary.walk_in_count, 4);
  assert.equal(recall.summary.customers_count, 2, 'customers, not sales');

  // POS-401: the voided sale is on the list and marked. Its goods may have left with
  // the customer before anybody noticed, and that is the store's call to make.
  const voided = recall.sales.find((sale) => sale.sale_no === voidedSaleNo);
  assert.ok(voided, 'the voided sale is not hidden');
  assert.equal(voided.is_voided, true);
  assert.equal(voided.outstanding_qty_milli, 3 * VIAL);
});

test('TC-E2E-24 · the recall reconciles against the batch it is about', async () => {
  const recall = await json(await call(`/batches/${batch.id}/recall`, { who: 'boss' }));
  const { summary } = recall;

  // Everything this batch ever gave a sale line: 2 + 3 + 1 + 4 + 2 + 3.
  assert.equal(summary.sold_milli, 15 * VIAL);
  // The voided three are counted as still out — the report does not decide that they
  // came back just because the ledger says the stock did.
  assert.equal(summary.outstanding_milli, 15 * VIAL);
  assert.equal(summary.on_hand_display, '18 PC');

  // The reconciliation: what left on sale lines, less the void's compensating return,
  // plus what is on the shelf, is what was received. A recall that lost a vial
  // somewhere is a recall that leaves somebody holding it.
  assert.equal(summary.sold_milli - 3 * VIAL + summary.on_hand_milli, 30 * VIAL);

  // And a return moves the figure the store is chasing, without moving the sale off
  // the list — what did not come back is still in somebody's shed.
  const santos = recall.sales.find((sale) => sale.customer_name === 'Santos Farm');
  const saleRepository = require('../../repositories/saleRepository');
  const item = saleRepository.itemsFor(santos.sale_id)[0];
  shiftService.open({ actor: sessions.boss2, openingFloatCentavos: 100000, confirmed: true });
  await json(await call(`/sales/${santos.sale_id}/returns`, {
    method: 'POST',
    who: 'boss2',
    body: {
      reason: 'Expired stock',
      lines: [{ saleItemId: item.id, qtyMilli: 1 * VIAL, disposition: 'WRITE_OFF' }],
    },
  }));

  const after = await json(await call(`/batches/${batch.id}/recall`, { who: 'boss' }));
  const santosAfter = after.sales.find((sale) => sale.customer_name === 'Santos Farm');
  assert.equal(santosAfter.qty_milli, 2 * VIAL, 'what they took has not changed');
  assert.equal(santosAfter.returned_qty_milli, 1 * VIAL);
  assert.equal(santosAfter.outstanding_qty_milli, 1 * VIAL, 'one vial is still with them');
  assert.equal(after.summary.outstanding_milli, 14 * VIAL);
  assert.equal(after.sales.length, 6, 'and the sale is still on the list');
});

test('TC-E2E-24 · the list exports, with the same figures the screen shows', async () => {
  const res = await call(`/batches/${batch.id}/recall/export.csv`, { who: 'boss' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);

  const rows = (await res.text()).trim().split('\r\n');
  assert.equal(rows.length, 7, 'a header and the six sales');
  assert.match(rows[0], /^"sale_no","date","customer","contact_no"/);

  const text = rows.join('\n');
  assert.match(text, /"Santos Farm","09171112222"/);
  // The word, not an empty cell: a blank in a column of names reads as data that failed
  // to load rather than as the answer.
  assert.match(text, /"Walk-in",""/);
  assert.match(text, /"VOIDED"/);
});
