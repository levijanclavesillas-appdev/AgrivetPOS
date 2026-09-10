'use strict';

// TC-E2E-25 — the fridge, counted box by box (TASK-042).
//
// Three batches of one vaccine, one box short of the middle one, over HTTP with real
// sessions: open the count, read the sheet, key what is on the shelf, get a second pair
// of eyes on it, post, and then ask the batch list what the store now holds.
//
// **The assertion that matters is the last one.** The product's total is short by one
// box either way — that is what a product-level count would have found, and it would
// have had nowhere to put it. What this proves is that the shortage landed on the batch
// it was found missing from, so `INV-206`'s recall reads the truth about which boxes
// are still out there. Posting it FEFO would have produced the same product figure and
// the wrong answer to the only question a recall asks.
//
// The count is deliberately left partly done: `INV-111`'s uncounted line writes nothing
// and must stay distinguishable from a line counted and found correct.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const batchService = require('../../services/batchService');
const goodsReceiptService = require('../../services/goodsReceiptService');
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';
const VIAL = 1000;

let instance;
let BASE = null;
const tokens = {};
let product;
let feed;
let supplier;
let sessionId;

const call = (pathname, { method = 'GET', body = null, who = 'clerk' } = {}) => fetch(`${BASE}${pathname}`, {
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
  temp.openMigrated('count-by-batch-e2e');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;

  temp.seedStore({ withOwner: false, taxMode: 'NONE' });
  const ref = temp.seedCatalog();

  // The clerk counts and the manager approves: INV-112 is two people, and a walk that
  // did both as one user would never reach the rule.
  for (const [who, role] of [['boss', 'OWNER'], ['clerk', 'INVENTORY'], ['boss2', 'MANAGER']]) {
    temp.seedUser({ username: who, role, password: PASSWORD });
    tokens[who] = authService.login({ username: who, password: PASSWORD }).token;
  }
  const owner = authService.verifyToken(tokens.boss);
  supplier = temp.seedSupplier({ name: 'Mindanao Vet Supply', code: 'MVS' }, owner);

  product = productService.create({
    sku: 'VET-NCD-10',
    name: 'Newcastle Disease Vaccine',
    categoryId: ref.otherCategory.id,
    baseUnitId: ref.piece.id,
    retailPriceCentavos: 28000,
    isBatchTracked: true,
  }, owner);

  // A sack of feed in the same count, so the sheet carries both shapes of line and the
  // ordinary one is proved not to have changed.
  feed = productService.create({
    sku: 'FEED-LAY-25',
    name: 'Layer Mash',
    categoryId: ref.category.id,
    baseUnitId: ref.kg.id,
    retailPriceCentavos: 5200,
  }, owner);
  require('../../services/inventoryService').postStandalone({
    productId: feed.id, type: 'OPENING', qtyMilli: 250000, unitCostCentavos: 3900, actor: owner,
  });

  // Three deliveries, three dates, three costs.
  for (const batch of [
    { batchNo: 'NCD-01', vials: 10, cost: 19000, days: 30 },
    { batchNo: 'NCD-02', vials: 8, cost: 21000, days: 200 },
    { batchNo: 'NCD-03', vials: 6, cost: 22000, days: 400 },
  ]) {
    goodsReceiptService.post({
      supplierId: supplier.id,
      supplierDrNo: `DR-${batch.batchNo}`,
      lines: [{
        productId: product.id,
        receivedQtyMilli: batch.vials * VIAL,
        unitCostCentavos: batch.cost,
        batchNo: batch.batchNo,
        expiryDate: batchService.addDays(batchService.today(), batch.days),
      }],
    }, owner);
  }
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

test('TC-E2E-25 · the sheet has a line per box, and the feed still has one line', async () => {
  const opened = await json(await call('/stock-counts', {
    method: 'POST', body: { scope: 'ALL', notes: 'The vaccine fridge' },
  }));
  sessionId = opened.session.id;

  const sheet = await json(await call(`/stock-counts/${sessionId}?limit=100`));
  const vaccine = sheet.lines.filter((l) => l.product_id === product.id);

  assert.deepEqual(
    vaccine.map((l) => [l.batch_no, l.expected_milli]),
    [['NCD-01', 10 * VIAL], ['NCD-02', 8 * VIAL], ['NCD-03', 6 * VIAL]],
    'one line per batch, earliest expiry first — the order a counter walks a shelf in'
  );
  assert.ok(vaccine.every((l) => l.expiry_date), 'each carries the date printed on its box');

  const mash = sheet.lines.filter((l) => l.product_id === feed.id);
  assert.equal(mash.length, 1, 'a product that is not batch-tracked is counted as one line');
  assert.equal(mash[0].batch_id, null);

  // The heading a counter checks before posting: four rows that each look right can
  // still be wrong together, and this is the figure that says so.
  const group = sheet.groups.find((g) => g.product_id === product.id);
  assert.equal(group.batch_count, 3);
  assert.equal(group.expected_display, '24 PC');
  assert.equal(group.counted_display, null, 'nothing counted yet is not a counted zero');
});

test('TC-E2E-25 · one box is missing from the middle batch, and the feed is left uncounted', async () => {
  const sheet = await json(await call(`/stock-counts/${sessionId}?limit=100`));
  const byBatch = Object.fromEntries(sheet.lines.filter((l) => l.batch_no).map((l) => [l.batch_no, l]));

  await json(await call(`/stock-counts/${sessionId}/lines`, {
    method: 'PUT',
    body: {
      lines: [
        { lineId: byBatch['NCD-01'].id, countedMilli: 10 * VIAL },   // right
        { lineId: byBatch['NCD-02'].id, countedMilli: 7 * VIAL },    // one short
        { lineId: byBatch['NCD-03'].id, countedMilli: 6 * VIAL },    // right
      ],
    },
  }));

  const after = await json(await call(`/stock-counts/${sessionId}?limit=100`));
  const group = after.groups.find((g) => g.product_id === product.id);
  assert.equal(group.counted_display, '23 PC', 'twenty-three where the system expected twenty-four');
  assert.equal(group.uncounted_count, 0);

  // INV-111: the sack of feed was never reached, and a line nobody counted writes
  // nothing. It stays distinguishable from a line counted and found correct.
  const mash = after.lines.find((l) => l.product_id === feed.id);
  assert.equal(mash.is_counted, false);
  assert.equal(after.session.uncounted_count, 1);
});

test('TC-E2E-25 · the variance posts against the batch it was found missing from', async () => {
  await json(await call(`/stock-counts/${sessionId}/approve`, { method: 'POST', who: 'boss2', body: {} }));
  const posted = await json(await call(`/stock-counts/${sessionId}/post`, { method: 'POST', body: {} }));

  assert.equal(posted.session.status, 'POSTED');
  assert.equal(posted.posting.movements.length, 1, 'INV-111: one movement, for the one line that varied');
  assert.equal(posted.posting.movements[0].batch_no, 'NCD-02');
  assert.equal(posted.posting.movements[0].variance_milli, -1 * VIAL);
  // MON-004: valued at that batch's own cost — ₱210, not the product's blended average.
  assert.equal(posted.posting.movements[0].value_centavos, -21000);

  const { batches } = await json(await call(`/products/${product.id}/batches`));
  assert.deepEqual(
    batches.map((b) => [b.batch_no, b.qty_milli]),
    [['NCD-01', 10 * VIAL], ['NCD-02', 7 * VIAL], ['NCD-03', 6 * VIAL]],
    'the shortage came out of the box it was missing from, not out of the oldest'
  );

  // The product's own figure is short by one either way — which is exactly why the
  // batch balances are the assertion that matters. A count that posted FEFO would pass
  // the next line and fail the one above it.
  const { on_hand: onHand } = await json(await call(`/inventory/${product.id}`));
  assert.equal(onHand.qty_on_hand_milli, 23 * VIAL);

  const reconciliation = await json(await call('/inventory/reconciliation', { who: 'boss' }));
  assert.equal(reconciliation.ok, true);
  assert.deepEqual(reconciliation.batch_breaks, [], 'INV-201, with nothing having been repaired');

  // And the ledger says which box, in words, a year later.
  const { movements } = await json(await call(`/inventory/${product.id}/movements?limit=10`));
  const variance = movements.find((m) => m.type === 'COUNT_VARIANCE');
  assert.match(variance.reason, /batch NCD-02/);
  assert.match(variance.reason, /counted 7 PC against 8 PC expected/);
});
