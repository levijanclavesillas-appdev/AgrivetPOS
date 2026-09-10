'use strict';

// TC-E2E-23 — three batches of a vaccine, sold across two of them, the third expired.
//
// The walk TASK-029 describes, over HTTP with real sessions: receive three deliveries
// of one vaccine at three costs and three dates, sell more than the oldest batch holds,
// try to sell the batch that has expired, write it off, and then find the ledger, the
// costs and the recall trail all right afterwards.
//
// What this adds over the integration cases is the **order** — a store does these in
// sequence over a morning, and every one of them reads what the last one wrote. The
// three that matter:
//
//   The sale spans two batches and its cost snapshot is the weighted blend of what it
//   actually took (`MON-004`). Read from the sale afterwards, not computed here.
//
//   The expired batch refuses at the counter (`INV-205`), with the date in the message
//   — and the refusal arrives *before* a sale number is drawn (`POS-108`), so a store
//   that hits it every morning does not gap its own receipt numbering.
//
//   `INV-201` reconciles at the end, after four kinds of movement have touched the
//   product. That is the whole design in one assertion.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const batchService = require('../../services/batchService');
const shiftService = require('../../services/shiftService');
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';

// A vial is one piece; the ledger works in thousandths (MON-002), so ten vials is
// 10,000. Three deliveries, three costs, three dates.
const VIAL = 1000;
const DELIVERIES = [
  { batchNo: 'A-2291', vials: 6, costCentavos: 21000, expiresInDays: 40 },
  { batchNo: 'A-2318', vials: 10, costCentavos: 22500, expiresInDays: 400 },
  { batchNo: 'A-2004', vials: 4, costCentavos: 19000, expiresInDays: -3 },
];

let instance;
let BASE = null;
const tokens = {};
let product;
let supplier;
let sale;

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

const refusal = async (res, { status, ruleId }) => {
  const body = await res.json();
  assert.equal(res.status, status, JSON.stringify(body));
  assert.equal(body.error.rule_id, ruleId);
  return body.error;
};

const day = (n) => batchService.addDays(batchService.today(), n);

test.before(async () => {
  temp.openMigrated('batches-e2e');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;

  temp.seedStore({ withOwner: false, taxMode: 'NONE' });
  const ref = temp.seedCatalog();

  for (const [who, role] of [['boss', 'OWNER'], ['till', 'CASHIER']]) {
    temp.seedUser({ username: who, role, password: PASSWORD });
    tokens[who] = authService.login({ username: who, password: PASSWORD }).token;
  }
  const owner = authService.verifyToken(tokens.boss);

  product = productService.create({
    sku: 'VET-HS-10',
    name: 'Haemorrhagic Septicaemia Vaccine 10ml',
    categoryId: ref.otherCategory.id,
    baseUnitId: ref.piece.id,
    retailPriceCentavos: 32000,
    // Q-2's answer for this category: a vaccine is sold by its expiry date, so the
    // store tracks it by batch. A sack of feed in the same load is not.
    isBatchTracked: true,
  }, owner);

  supplier = temp.seedSupplier({ name: 'Mindanao Vet Supply', code: 'MVS' }, owner);
  shiftService.open({
    actor: authService.verifyToken(tokens.till), openingFloatCentavos: 500000, confirmed: true,
  });
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

test('TC-E2E-23 · a delivery of a vaccine without its batch number is refused', async () => {
  const error = await refusal(
    await call('/goods-receipts', {
      method: 'POST',
      body: {
        supplierId: supplier.id,
        supplierDrNo: 'DR-NO-BATCH',
        lines: [{ productId: product.id, receivedQtyMilli: 6 * VIAL, unitCostCentavos: 21000 }],
      },
    }),
    { status: 400, ruleId: 'INV-202' }
  );
  // Named, because a twelve-line delivery is keyed by somebody who needs to know which
  // line to go back to.
  assert.match(error.message, /Haemorrhagic Septicaemia Vaccine 10ml needs a batch number/);

  const { batches } = await json(await call(`/products/${product.id}/batches?includeEmpty=true`));
  assert.deepEqual(batches, [], 'and nothing was created');
});

test('TC-E2E-23 · three deliveries arrive, at three costs and three dates', async () => {
  for (const delivery of DELIVERIES) {
    await json(await call('/goods-receipts', {
      method: 'POST',
      body: {
        supplierId: supplier.id,
        supplierDrNo: `DR-${delivery.batchNo}`,
        lines: [{
          productId: product.id,
          receivedQtyMilli: delivery.vials * VIAL,
          unitCostCentavos: delivery.costCentavos,
          batchNo: delivery.batchNo,
          expiryDate: day(delivery.expiresInDays),
        }],
      },
    }));
  }

  const { batches } = await json(await call(`/products/${product.id}/batches`));
  // Earliest expiry first, which is both the shelf order and FEFO's order (INV-204).
  assert.deepEqual(
    batches.map((b) => [b.batch_no, b.qty_milli, b.expiry_status]),
    [
      ['A-2004', 4 * VIAL, 'EXPIRED'],
      ['A-2291', 6 * VIAL, 'NEAR_EXPIRY'],
      ['A-2318', 10 * VIAL, 'NORMAL'],
    ]
  );
  // INV-203 is derived, so the store's own threshold decides which word each one gets.
  assert.equal(batches[1].days_to_expiry, 40);
  assert.equal(batches[0].supplier_name, 'Mindanao Vet Supply', 'INV-202 — whose batch it is');
  assert.equal(batches[2].qty_display, '10 PC', 'UOM-005 — never a quantity without its unit');

  const { on_hand: onHand } = await json(await call(`/inventory/${product.id}`));
  assert.equal(onHand.qty_on_hand_milli, 20 * VIAL, 'twenty vials, of which four cannot be sold');
});

test('TC-E2E-23 · a sale of eight spans two batches and costs at what it took', async () => {
  sale = await json(await call('/sales', {
    method: 'POST',
    who: 'till',
    body: {
      lines: [{ productId: product.id, qtyMilli: 8 * VIAL }],
      tenders: [{ method: 'CASH', amountCentavos: 300000 }],
    },
  }));

  assert.equal(sale.items.length, 1, 'one line — the cashier sold eight, the receipt says eight');
  assert.equal(sale.items[0].qty_milli, 8 * VIAL);

  // FEFO skipped the expired A-2004 entirely and took six from A-2291, two from A-2318.
  const { batches } = await json(await call(`/products/${product.id}/batches?includeEmpty=true`));
  assert.deepEqual(
    batches.map((b) => [b.batch_no, b.qty_milli]),
    [['A-2004', 4 * VIAL], ['A-2291', 0], ['A-2318', 8 * VIAL]]
  );

  // MON-004: six at ₱210 and two at ₱225 is ₱213.75 — 21,375 centavos, weighted by
  // quantity and rounded once. The unweighted average would be ₱217.50.
  const receipt = await json(await call(`/sales/${sale.sale.id}`));
  assert.equal(receipt.items[0].unit_cost_centavos, 21375);
});

test('TC-E2E-23 · the expired batch cannot be sold, and the refusal names its date', async () => {
  // Twelve vials sit on the shelf and only eight of them may be sold: A-2004's four
  // expired three days ago. Asking for ten is refused as an expiry problem rather than
  // as a shortage — a clerk sent looking for stock that is in front of them is the
  // failure this message exists to prevent.
  const error = await refusal(
    await call('/sales', {
      method: 'POST',
      who: 'till',
      body: {
        lines: [{ productId: product.id, qtyMilli: 10 * VIAL }],
        tenders: [{ method: 'CASH', amountCentavos: 400000 }],
      },
    }),
    { status: 409, ruleId: 'INV-205' }
  );
  assert.match(error.message, /2 PC short/, 'the shortfall is stated in the store’s own unit');
  assert.match(error.message, /expired/);
  assert.match(error.message, new RegExp(`A-2004 on ${day(-3)}`));

  // POS-108: the refused sale drew no number, so the sequence has no gap in it.
  const after = await json(await call('/sales?limit=5', { who: 'till' }));
  assert.equal(after.sales.length, 1, 'still one sale today');
  assert.equal(after.sales[0].sale_no, sale.sale.sale_no);
});

test('TC-E2E-23 · the expired batch is written off, and the ledger says why', async () => {
  const { batches } = await json(await call(`/products/${product.id}/batches`));
  const expired = batches.find((b) => b.batch_no === 'A-2004');
  assert.equal(expired.expiry_status, 'EXPIRED');

  const written = await json(await call(`/batches/${expired.id}/expire`, {
    method: 'POST',
    body: { reason: 'Swept the vaccine fridge' },
  }));
  assert.equal(written.batch.qty_milli, 0);
  assert.equal(written.movement.movement.movement_type, 'EXPIRY');

  // INV-103's declared type, so the store can total what expiry cost it — an ADJUSTMENT
  // would have moved the same stock and said nothing about why.
  const { movements } = await json(await call(`/inventory/${product.id}/movements?limit=20`));
  const expiryRows = movements.filter((m) => m.type === 'EXPIRY');
  assert.equal(expiryRows.length, 1);
  assert.equal(expiryRows[0].qty_milli, -4 * VIAL);
  assert.match(expiryRows[0].reason, /Swept the vaccine fridge/);

  // A cashier could not have done it: writing stock off is TX-407.
  const another = batches.find((b) => b.batch_no === 'A-2318');
  await refusal(
    await call(`/batches/${another.id}/expire`, { method: 'POST', who: 'till', body: {} }),
    { status: 403, ruleId: 'TX-407' }
  );
});

test('TC-E2E-23 · the recall trail, and INV-201 after four kinds of movement', async () => {
  // INV-206's question, asked of the batch rather than of the product: which sale took
  // how much of A-2291, and at what cost. This is what a manufacturer's notice is
  // answered with, and it survives the batch having been emptied.
  const { batches } = await json(await call(`/products/${product.id}/batches?includeEmpty=true`));
  assert.deepEqual(
    batches.map((b) => [b.batch_no, b.qty_milli]),
    [['A-2004', 0], ['A-2291', 0], ['A-2318', 8 * VIAL]],
    'the shelf, after a sale and a write-off'
  );

  const batchRepository = require('../../repositories/batchRepository');
  const saleRepository = require('../../repositories/saleRepository');
  const item = saleRepository.itemsFor(sale.sale.id)[0];
  const took = batchRepository.saleItemBatchesFor(item.id);
  assert.deepEqual(
    took.map((r) => [r.batch_no, r.qty_milli, r.unit_cost_centavos]),
    [['A-2291', 6 * VIAL, 21000], ['A-2318', 2 * VIAL, 22500]],
    'per batch, per line, at the cost that batch actually carried'
  );

  // And the invariant the whole design exists to keep, after a receipt, a sale, a
  // write-off and a refusal: on-hand and the batch quantities are the same sum.
  const reconciliation = await json(await call('/inventory/reconciliation'));
  assert.equal(reconciliation.ok, true);
  assert.deepEqual(reconciliation.batch_breaks, []);

  const { on_hand: onHand } = await json(await call(`/inventory/${product.id}`));
  assert.equal(
    onHand.qty_on_hand_milli,
    batches.reduce((sum, b) => sum + b.qty_milli, 0),
    'INV-201 — one ledger, read two ways'
  );
});
