'use strict';

// TASK-029 — batches, expiry and FEFO, through the services that use them.
// `TC-INT-107` to `TC-INT-111`, and the two routes `05_TECH_SPEC.md` §4 adds.
//
// The case worth reading first is `TC-INT-107`, because it is the one that says the
// design held. `INV-101` derives on-hand from the movement ledger; `INV-201` says the
// batch quantities sum to it. Those are two derivations of one number, and the whole
// of `014_batches.sql` is the decision to make them **the same sum grouped differently**
// rather than a stored counter maintained beside the ledger. So the test does not check
// that a receipt adds and a sale subtracts — it runs a receipt, a split sale, a return
// and an expiry write-off through, and then asks whether the two figures still agree.
// A stored counter passes every step of that and fails the last question.
//
// `TC-INT-110` is in the table as "the override, if built". It is not built: this
// store's policy does not permit selling expired stock, so the case here asserts the
// **absence** — no route, no parameter, no path. A test that skipped it would leave the
// only record of that decision in a comment.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const batchService = require('../../services/batchService');
const saleService = require('../../services/saleService');
const returnService = require('../../services/returnService');
const voidService = require('../../services/voidService');
const customerService = require('../../services/customerService');
const shiftService = require('../../services/shiftService');
const alertService = require('../../services/alertService');
const settingsService = require('../../services/settingsService');
const auditService = require('../../services/auditService');
const inventoryService = require('../../services/inventoryService');
const goodsReceiptService = require('../../services/goodsReceiptService');
const inventoryRepository = require('../../repositories/inventoryRepository');
const batchRepository = require('../../repositories/batchRepository');
const saleRepository = require('../../repositories/saleRepository');
const temp = require('../helpers/tempdb');

let BASE = null;
const PASSWORD = 'correct-horse-battery';

let instance;
let ref;
let supplier;
const tokens = {};
const sessions = {};

const call = (path, { token = null, method = 'GET', body = null } = {}) => fetch(`${BASE}${path}`, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

let seq = 0;

/** A batch-tracked product with no stock — every test here gives it its own. */
function vaccine({ retail = 32000, batchTracked = true } = {}) {
  seq += 1;
  return productService.create({
    sku: `BAT-${String(seq).padStart(3, '0')}`,
    name: `Batch Line ${seq}`,
    categoryId: ref.category.id,
    baseUnitId: ref.piece.id,
    taxClass: 'VATABLE',
    retailPriceCentavos: retail,
    isBatchTracked: batchTracked,
  }, sessions.OWNER);
}

/** A delivery with no purchase order behind it (PO-207), which is how a batch is born. */
function receive({ product, qtyMilli, unitCostCentavos, batchNo, expiryDate }) {
  return goodsReceiptService.post({
    supplierId: supplier.id,
    supplierDrNo: `DR-${seq}-${batchNo}`,
    lines: [{
      productId: product.id,
      receivedQtyMilli: qtyMilli,
      unitCostCentavos,
      batchNo,
      expiryDate,
    }],
  }, sessions.OWNER);
}

const cashSale = ({ product, qtyMilli }) => saleService.complete({
  lines: [{ productId: product.id, qtyMilli }],
  tenders: [{ method: 'CASH', amountCentavos: 100000000 }],
}, sessions.CASHIER);

const batchesOf = (productId) => batchService.listForProduct(productId, { includeEmpty: true });
const batched = (productId) => batchesOf(productId).reduce((sum, b) => sum + b.qty_milli, 0);
const days = (n) => batchService.addDays(batchService.today(), n);

test.before(async () => {
  temp.openEmpty('batches');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;
  temp.seedStore({ taxMode: 'NON_VAT', withOwner: false });
  ref = temp.seedCatalog();

  for (const role of ['OWNER', 'MANAGER', 'CASHIER', 'INVENTORY']) {
    const username = role.toLowerCase();
    temp.seedUser({ username, role, password: PASSWORD });
    const signedIn = authService.login({ username, password: PASSWORD });
    tokens[role] = signedIn.token;
    sessions[role] = authService.verifyToken(signedIn.token);
  }

  supplier = temp.seedSupplier({}, sessions.OWNER);
  // POS-502 gives one open shift per user. The cashier sells and the manager takes the
  // returns, so both need one — a return refused for a closed drawer would pass this
  // file's batch assertions without ever reaching them.
  shiftService.open({ actor: sessions.CASHIER, openingFloatCentavos: 500000, confirmed: true });
  shiftService.open({ actor: sessions.MANAGER, openingFloatCentavos: 500000, confirmed: true });
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── TC-INT-107 — INV-201 ────────────────────────────────────────────────────

test('TC-INT-107: batches reconcile to on-hand across receipt, sale, return and expiry', () => {
  const product = vaccine();
  receive({ product, qtyMilli: 6000, unitCostCentavos: 21000, batchNo: 'A-1', expiryDate: days(120) });
  receive({ product, qtyMilli: 10000, unitCostCentavos: 22000, batchNo: 'A-2', expiryDate: days(400) });

  const agrees = (what) => {
    assert.equal(
      batched(product.id), inventoryRepository.qtyOnHand(product.id),
      `INV-201 — the batches no longer sum to on-hand after ${what}`
    );
    assert.deepEqual(
      inventoryService.reconcile().batch_breaks, [],
      `and the reconciliation says so after ${what}`
    );
  };
  agrees('two receipts');

  // Ten where the oldest holds six: the line spans both batches.
  const sale = cashSale({ product, qtyMilli: 10000 });
  agrees('a sale spanning two batches');

  returnService.post({
    saleId: sale.sale.id,
    reason: 'Customer changed their mind',
    lines: [{ saleItemId: saleRepository.itemsFor(sale.sale.id)[0].id, qtyMilli: 2000, disposition: 'RESTOCK' }],
  }, sessions.MANAGER);
  agrees('a partial return');

  // And the write-off that INV-205 expects expired stock to leave by.
  const oldest = batchesOf(product.id).find((b) => b.batch_no === 'A-1');
  if (oldest.qty_milli > 0) {
    batchService.expire(oldest.id, { actor: sessions.OWNER, reason: 'Past its date' });
    agrees('an expiry write-off');
  }

  // The stronger form of the same claim: every movement of a batch-tracked product
  // names a batch, so there is nothing outside the grouped sum to hide a difference in.
  const unbatched = inventoryRepository.movementsFor(product.id, { limit: 100 })
    .filter((m) => !m.batch_id);
  assert.deepEqual(unbatched, [], 'INV-201 — a batch-tracked product has no unbatched movement');
});

test('TC-INT-107: a sale that spanned two batches records what each one gave', () => {
  const product = vaccine();
  receive({ product, qtyMilli: 6000, unitCostCentavos: 30000, batchNo: 'B-1', expiryDate: days(120) });
  receive({ product, qtyMilli: 20000, unitCostCentavos: 32000, batchNo: 'B-2', expiryDate: days(400) });

  const sale = cashSale({ product, qtyMilli: 10000 });
  const item = saleRepository.itemsFor(sale.sale.id)[0];

  // One sale line — the cashier sold ten, the receipt says ten, POS-301's ceiling is
  // ten — and two rows underneath it saying where they came from (INV-206).
  assert.equal(item.qty_milli, 10000, 'still one line of ten');
  assert.equal(item.batch_id, null, 'sale_items.batch_id is withdrawn in place, never populated');

  const took = batchRepository.saleItemBatchesFor(item.id);
  assert.deepEqual(took.map((r) => [r.batch_no, r.qty_milli]), [['B-1', 6000], ['B-2', 4000]]);
  assert.equal(took.reduce((sum, r) => sum + r.qty_milli, 0), item.qty_milli);

  // MON-004: the line costs at what it actually took — 6 at ₱300 and 4 at ₱320 is ₱308
  // — and not at the product's moving average, which is what it cost before batches.
  assert.equal(item.unit_cost_centavos, 30800);
});

test('TC-INT-107: a non-batch product is untouched by any of this', () => {
  const plain = vaccine({ batchTracked: false });
  inventoryService.postStandalone({
    productId: plain.id, type: 'RECEIPT', qtyMilli: 5000, unitCostCentavos: 1000, actor: sessions.OWNER,
  });
  const sale = cashSale({ product: plain, qtyMilli: 1000 });
  const item = saleRepository.itemsFor(sale.sale.id)[0];

  assert.equal(item.unit_cost_centavos, 1000, 'INV-106’s moving average, permanently');
  assert.deepEqual(batchRepository.saleItemBatchesFor(item.id), []);
  assert.equal(inventoryRepository.qtyOnHand(plain.id), 4000);
  // And it has no batches to ask about — the question itself is refused.
  assert.throws(() => batchService.listForProduct(plain.id, {}), (err) => err.ruleId === 'INV-201');
});

// ── TC-INT-108 — INV-202 ────────────────────────────────────────────────────

test('TC-INT-108: a batch-tracked delivery without a batch number is refused, naming the product', () => {
  const product = vaccine();

  assert.throws(
    () => receive({ product, qtyMilli: 5000, unitCostCentavos: 21000, batchNo: null, expiryDate: days(200) }),
    (err) => {
      assert.equal(err.ruleId, 'INV-202');
      assert.match(err.message, new RegExp(`${product.name} needs a batch number`));
      return true;
    }
  );
  assert.throws(
    () => receive({ product, qtyMilli: 5000, unitCostCentavos: 21000, batchNo: 'C-1', expiryDate: null }),
    (err) => err.ruleId === 'INV-202' && /needs an expiry date/.test(err.message)
  );
  // The shape, not only the presence: "31/03/2027" would otherwise reach INV-202 in
  // the middle of the transaction and roll back a delivery already keyed.
  assert.throws(
    () => receive({ product, qtyMilli: 5000, unitCostCentavos: 21000, batchNo: 'C-1', expiryDate: '31/03/2027' }),
    (err) => err.ruleId === 'INV-202' && /YYYY-MM-DD/.test(err.message)
  );

  assert.equal(inventoryRepository.qtyOnHand(product.id), 0, 'and nothing was posted');
  assert.deepEqual(batchesOf(product.id), [], 'nor any batch created');
});

test('TC-INT-108: a batch number is unique per product, and the same number redelivered is the same batch', () => {
  const first = vaccine();
  const second = vaccine();

  receive({ product: first, qtyMilli: 3000, unitCostCentavos: 21000, batchNo: 'A-2291', expiryDate: days(300) });
  // Two manufacturers use "A-2291" in the same year and neither is wrong (INV-202).
  receive({ product: second, qtyMilli: 3000, unitCostCentavos: 21000, batchNo: 'A-2291', expiryDate: days(300) });
  assert.equal(batchesOf(first.id).length, 1);
  assert.equal(batchesOf(second.id).length, 1);

  // The rest of the same batch, delivered a fortnight later, is the same batch — a
  // second row for it would split one recall in two.
  receive({ product: first, qtyMilli: 4000, unitCostCentavos: 21000, batchNo: 'A-2291', expiryDate: days(300) });
  const batches = batchesOf(first.id);
  assert.equal(batches.length, 1, 'still one batch');
  assert.equal(batches[0].qty_milli, 7000, 'holding both deliveries');

  // Creating one outright, twice, is the refusal underneath that.
  assert.throws(
    () => batchService.create({
      productId: first.id, batchNo: 'A-2291', supplierId: supplier.id,
      expiryDate: days(300), unitCostCentavos: 21000, actor: sessions.OWNER,
    }),
    (err) => err.ruleId === 'INV-202' && /already has a batch/.test(err.message)
  );
});

test('TC-INT-108: a batch on a product that is not batch-tracked is refused both ways', () => {
  const plain = vaccine({ batchTracked: false });

  assert.throws(
    () => batchService.create({
      productId: plain.id, batchNo: 'X-1', supplierId: supplier.id,
      expiryDate: days(300), unitCostCentavos: 100, actor: sessions.OWNER,
    }),
    (err) => err.ruleId === 'INV-201'
  );

  // And the ledger itself refuses a batch on one, which is the check a CHECK constraint
  // could not make — it cannot read products.is_batch_tracked from another table.
  const other = vaccine();
  receive({ product: other, qtyMilli: 1000, unitCostCentavos: 100, batchNo: 'Y-1', expiryDate: days(300) });
  const foreign = batchesOf(other.id)[0];
  assert.throws(
    () => inventoryService.postStandalone({
      productId: plain.id, type: 'RECEIPT', qtyMilli: 100, unitCostCentavos: 100,
      batchId: foreign.id, actor: sessions.OWNER,
    }),
    (err) => err.ruleId === 'INV-201' && /not batch-tracked/.test(err.message)
  );
});

// ── TC-INT-109 — INV-205 ────────────────────────────────────────────────────

test('TC-INT-109: an expired batch is not allocated, and selling it is refused', () => {
  const product = vaccine();
  receive({ product, qtyMilli: 5000, unitCostCentavos: 21000, batchNo: 'OLD', expiryDate: days(-1) });
  receive({ product, qtyMilli: 3000, unitCostCentavos: 22000, batchNo: 'GOOD', expiryDate: days(200) });

  // FEFO skips the expired one even though it is the earliest — INV-204 orders by
  // expiry and INV-205 removes the expired from the ordering altogether.
  const draw = batchService.allocate(product.id, 1000);
  assert.equal(draw.length, 1);
  assert.equal(draw[0].batchNo, 'GOOD');

  // Eight on hand, three of them sellable. Asking for five is refused, and the refusal
  // names the expiry rather than reporting a shortage the clerk can see is wrong.
  assert.equal(inventoryRepository.qtyOnHand(product.id), 8000);
  assert.throws(
    () => cashSale({ product, qtyMilli: 5000 }),
    (err) => {
      assert.equal(err.ruleId, 'INV-205');
      assert.match(err.message, /expired/);
      assert.match(err.message, /OLD on /);
      return true;
    }
  );

  // POS-108: the refused sale consumed no sale number and wrote nothing.
  assert.equal(inventoryRepository.qtyOnHand(product.id), 8000, 'and no stock moved');
});

test('TC-INT-109: expired stock leaves by an EXPIRY write-off, and the ledger says why', () => {
  const product = vaccine();
  receive({ product, qtyMilli: 5000, unitCostCentavos: 21000, batchNo: 'DEAD', expiryDate: days(-30) });

  const batch = batchesOf(product.id)[0];
  assert.equal(batch.expiry_status, 'EXPIRED');

  const { movement } = batchService.expire(batch.id, {
    actor: sessions.OWNER, reason: 'Swept the shelf',
  });

  assert.equal(movement.movement.movement_type, 'EXPIRY', 'INV-103’s declared type, first used here');
  assert.equal(movement.movement.batch_id, batch.id);
  assert.equal(inventoryRepository.qtyOnHand(product.id), 0);
  assert.equal(batched(product.id), 0, 'INV-201 still holds afterwards');

  // AUD-603: what left, and why, against the batch it left from.
  const [row] = auditService.browse({ action: 'BATCH_EXPIRE', entityId: batch.id }).rows;
  assert.ok(row, 'the write-off is on the trail');
  assert.equal(row.before.qty_milli, 5000);
  assert.equal(row.reason, 'Swept the shelf');

  // A second write-off has nothing to write off, and says so rather than posting zero.
  assert.throws(
    () => batchService.expire(batch.id, { actor: sessions.OWNER }),
    (err) => err.ruleId === 'INV-205' && /holds no stock/.test(err.message)
  );
});

// ── TC-INT-110 — the override that is deliberately not built ────────────────

test('TC-INT-110: there is no way to sell expired stock, by any path', async () => {
  const product = vaccine();
  receive({ product, qtyMilli: 5000, unitCostCentavos: 21000, batchNo: 'NOPE', expiryDate: days(-5) });
  const batch = batchesOf(product.id)[0];

  // INV-205 permits an owner override "only where the store's own policy allows it".
  // This store's does not, so the override is absent rather than guarded: there is no
  // approver parameter to send, and an owner is refused exactly as a cashier is.
  // POS-502 gives one open shift per user, so the owner gets their own — otherwise the
  // owner's attempt would be refused for having no shift and this case would pass
  // without ever reaching INV-205.
  shiftService.open({ actor: sessions.OWNER, openingFloatCentavos: 100000, confirmed: true });

  for (const [role, actor] of [['CASHIER', sessions.CASHIER], ['OWNER', sessions.OWNER]]) {
    assert.throws(
      () => saleService.complete({
        lines: [{ productId: product.id, qtyMilli: 1000 }],
        tenders: [{ method: 'CASH', amountCentavos: 100000 }],
        // The shapes an override would arrive in, if one existed.
        approver: { username: 'owner', password: PASSWORD },
        allowExpired: true,
        batchId: batch.id,
      }, actor),
      (err) => err.ruleId === 'INV-205',
      `a ${role} got past INV-205`
    );
  }

  // Not through the batch route either: it expires stock, it does not release it.
  const routes = await Promise.all([
    call(`/batches/${batch.id}/sell`, { token: tokens.OWNER, method: 'POST', body: {} }),
    call(`/batches/${batch.id}/allow-expired`, { token: tokens.OWNER, method: 'POST', body: {} }),
  ]);
  for (const res of routes) assert.equal(res.status, 404, 'no route grants an exception');

  // And the trail has no action name for one, so it could not be recorded if it happened.
  assert.equal(auditService.ACTIONS.BATCH_EXPIRED_SALE, undefined);
});

// ── TC-INT-111 — OPS-007 ────────────────────────────────────────────────────

test('TC-INT-111: the near-expiry alert fires on the configured threshold, apart from the expired', () => {
  settingsService.set('near_expiry_days', 30, sessions.OWNER);
  const product = vaccine();
  receive({ product, qtyMilli: 1000, unitCostCentavos: 21000, batchNo: 'N-SOON', expiryDate: days(10) });
  receive({ product, qtyMilli: 1000, unitCostCentavos: 21000, batchNo: 'N-LATER', expiryDate: days(200) });

  const kinds = (rows) => rows.map((a) => a.kind);
  let alerts = alertService.expiryAlerts();
  assert.ok(kinds(alerts).includes('NEAR_EXPIRY'), 'ten days out, against a 30-day threshold');
  const near = alerts.find((a) => a.kind === 'NEAR_EXPIRY');
  assert.match(near.message, /within 30 days/);
  assert.match(near.message, /N-SOON/);
  assert.equal(near.severity, 'WARNING');

  // Narrow the threshold and the same batch stops being near, with nothing having run.
  settingsService.set('near_expiry_days', 5, sessions.OWNER);
  assert.equal(kinds(alertService.expiryAlerts()).includes('NEAR_EXPIRY'), false);

  // Expired is its own line and its own severity: near-expiry is a selling problem,
  // expired is a disposal problem, and one count for both hides the second inside the
  // first.
  receive({ product, qtyMilli: 1000, unitCostCentavos: 21000, batchNo: 'N-GONE', expiryDate: days(-2) });
  alerts = alertService.expiryAlerts();
  const gone = alerts.find((a) => a.kind === 'EXPIRED_STOCK');
  assert.ok(gone, 'expired stock is its own alert');
  assert.equal(gone.severity, 'CRITICAL');
  assert.equal(gone.rule_id, 'INV-205');
  // Store-wide and named by the worst of them, so this asserts the sweep found this
  // one rather than that it is the one named.
  assert.ok(
    batchService.expired().some((b) => b.batch_no === 'N-GONE'),
    'the sweep found the batch that expired two days ago'
  );
  assert.match(gone.message, /may not be sold/);

  settingsService.set('near_expiry_days', 90, sessions.OWNER);
});

// ── The routes 05_TECH_SPEC.md §4 adds ──────────────────────────────────────

test('GET /products/:id/batches lists the shelf, and includeEmpty asks for the recall’s view', async () => {
  const product = vaccine();
  receive({ product, qtyMilli: 2000, unitCostCentavos: 21000, batchNo: 'R-1', expiryDate: days(60) });
  receive({ product, qtyMilli: 2000, unitCostCentavos: 21000, batchNo: 'R-2', expiryDate: days(400) });
  cashSale({ product, qtyMilli: 2000 });          // empties R-1 exactly

  const shelf = await (await call(`/products/${product.id}/batches`, { token: tokens.INVENTORY })).json();
  assert.deepEqual(shelf.batches.map((b) => b.batch_no), ['R-2'], 'an exhausted batch is off the shelf');
  assert.equal(shelf.batches[0].expiry_status, 'NORMAL');
  assert.equal(shelf.batches[0].qty_display, '2 PC', 'UOM-005 — never a quantity without its unit');

  const all = await (await call(`/products/${product.id}/batches?includeEmpty=true`, { token: tokens.INVENTORY })).json();
  assert.deepEqual(all.batches.map((b) => b.batch_no), ['R-1', 'R-2'], 'and still findable by a recall');

  // TX-422 guards the read; a cashier holds it, and an unauthenticated caller does not.
  assert.equal((await call(`/products/${product.id}/batches`)).status, 401);
});

test('POST /batches/:id/expire writes the batch off, behind TX-407', async () => {
  const product = vaccine();
  receive({ product, qtyMilli: 4000, unitCostCentavos: 21000, batchNo: 'E-1', expiryDate: days(-3) });
  const batch = batchesOf(product.id)[0];

  const refused = await call(`/batches/${batch.id}/expire`, {
    token: tokens.CASHIER, method: 'POST', body: { reason: 'Expired' },
  });
  assert.equal(refused.status, 403, 'a cashier may not write stock off');
  assert.equal((await refused.json()).error.rule_id, 'TX-407');

  const res = await call(`/batches/${batch.id}/expire`, {
    token: tokens.INVENTORY, method: 'POST', body: { reason: 'Expired on the shelf' },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.batch.qty_milli, 0);
  assert.equal(body.movement.movement.movement_type, 'EXPIRY');
  assert.equal(inventoryRepository.qtyOnHand(product.id), 0);
});

// ── The other two paths that move batch-tracked stock ───────────────────────

test('POS-401: voiding a sale returns each batch exactly what it gave', () => {
  const product = vaccine();
  receive({ product, qtyMilli: 6000, unitCostCentavos: 30000, batchNo: 'V-1', expiryDate: days(120) });
  receive({ product, qtyMilli: 6000, unitCostCentavos: 32000, batchNo: 'V-2', expiryDate: days(400) });

  const sale = cashSale({ product, qtyMilli: 10000 });
  const before = batchesOf(product.id).map((b) => [b.batch_no, b.qty_milli]);
  assert.deepEqual(before, [['V-1', 0], ['V-2', 2000]], 'six and four, oldest first');

  voidService.post({
    saleId: sale.sale.id,
    reason: 'Rang up the wrong farm’s account',
    approver: { username: 'manager' },
  }, sessions.CASHIER);

  // A void says the sale never happened. Returning the stock FEFO instead of to the
  // batches it came from would leave the shelf holding boxes whose dates the ledger
  // disagrees with — six would go back to V-1 and four to V-1 as well.
  assert.deepEqual(
    batchesOf(product.id).map((b) => [b.batch_no, b.qty_milli]),
    [['V-1', 6000], ['V-2', 6000]],
    'each batch got back what it gave'
  );
  assert.equal(batched(product.id), inventoryRepository.qtyOnHand(product.id));
});

test('POS-303: a return goes back to the batch it came from, not to the oldest', () => {
  const product = vaccine();
  receive({ product, qtyMilli: 6000, unitCostCentavos: 30000, batchNo: 'T-1', expiryDate: days(120) });
  receive({ product, qtyMilli: 6000, unitCostCentavos: 32000, batchNo: 'T-2', expiryDate: days(400) });

  const sale = cashSale({ product, qtyMilli: 10000 });
  const item = saleRepository.itemsFor(sale.sale.id)[0];
  assert.deepEqual(
    batchesOf(product.id).map((b) => [b.batch_no, b.qty_milli]),
    [['T-1', 0], ['T-2', 2000]],
    'six and four, oldest first'
  );

  // A delivery arrives after the sale, expiring sooner than either — so the product's
  // earliest-expiring batch is now one the sale never touched. This is what makes the
  // next assertion mean something: a return restocked by FEFO would land here.
  receive({ product, qtyMilli: 5000, unitCostCentavos: 31000, batchNo: 'T-0', expiryDate: days(30) });

  const back = (qtyMilli, disposition = 'RESTOCK', reason = 'Customer changed their mind') => returnService.post({
    saleId: sale.sale.id,
    reason,
    lines: [{ saleItemId: item.id, qtyMilli, disposition }],
  }, sessions.MANAGER);

  back(2000);
  assert.deepEqual(
    batchesOf(product.id).map((b) => [b.batch_no, b.qty_milli]),
    [['T-0', 5000], ['T-1', 2000], ['T-2', 2000]],
    'POS-303 — back to the batch the line took, not to the one expiring soonest'
  );

  // Six more, which is the cumulative case: the draw skips what has already gone back,
  // so it fills the rest of T-1's six and then spills into T-2. Replaying the draw from
  // the original consumption instead would return eight to a batch that gave six.
  back(6000);
  assert.deepEqual(
    batchesOf(product.id).map((b) => [b.batch_no, b.qty_milli]),
    [['T-0', 5000], ['T-1', 6000], ['T-2', 4000]],
    'each batch has had back exactly what it gave, and no more'
  );
  assert.equal(batched(product.id), inventoryRepository.qtyOnHand(product.id));

  // The last two, written off: POS-303's pair of movements posts both against the same
  // batch, so they net to zero per batch and not merely per product.
  back(2000, 'WRITE_OFF', 'Damaged on arrival');
  assert.deepEqual(
    batchesOf(product.id).map((b) => [b.batch_no, b.qty_milli]),
    [['T-0', 5000], ['T-1', 6000], ['T-2', 4000]],
    'in and straight back out, of the same batch'
  );
  assert.equal(batched(product.id), inventoryRepository.qtyOnHand(product.id));
  assert.deepEqual(inventoryService.reconcile().batch_breaks, []);
});

// ── TC-INT-112 / TC-INT-113 — INV-206, the recall ───────────────────────────
//
// The two cases that decide whether a recall can be trusted: it reports **this batch's
// share** of a line that spanned two, and it represents a voided sale, a returned line
// and a walk-in as themselves rather than dropping them. A recall that quietly omitted
// any of the three would leave somebody holding stock nobody rang about.

test('TC-INT-112: every consuming sale is found, with this batch’s share of each line', () => {
  const product = vaccine();
  receive({ product, qtyMilli: 6000, unitCostCentavos: 30000, batchNo: 'RC-1', expiryDate: days(120) });
  receive({ product, qtyMilli: 20000, unitCostCentavos: 32000, batchNo: 'RC-2', expiryDate: days(400) });

  const farm = customerService.create({
    name: 'Recall Farm', customerType: 'FARM', priceLevel: 'RETAIL',
    contactNo: '09171234567', isCreditEligible: true, creditLimitCentavos: 5000000, termsDays: 30,
  }, sessions.OWNER);

  // Ten, taken six from RC-1 and four from RC-2 — the ordinary split.
  const spanning = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 10000 }],
    customerId: farm.id,
    tenders: [{ method: 'CREDIT', amountCentavos: 320000 }],
  }, sessions.CASHIER);
  // And two more, entirely out of RC-2.
  cashSale({ product, qtyMilli: 2000 });

  const first = batchesOf(product.id).find((b) => b.batch_no === 'RC-1');
  const recall = batchService.recallFor(first.id, { actor: sessions.OWNER });

  assert.equal(recall.sales.length, 1, 'only the sale that took from this batch');
  assert.equal(recall.sales[0].sale_no, spanning.sale.sale_no);
  // Six, not ten: the line took four of its ten from the other batch, and a recall that
  // reported the line quantity would tell the store to chase stock it never sold here.
  assert.equal(recall.sales[0].qty_milli, 6000);
  assert.equal(recall.sales[0].qty_display, '6 PC');
  assert.equal(recall.sales[0].outstanding_qty_milli, 6000);

  // The customer, and the number somebody actually rings.
  assert.equal(recall.sales[0].customer_name, 'Recall Farm');
  assert.equal(recall.sales[0].customer_contact_no, '09171234567');
  assert.equal(recall.sales[0].is_walk_in, false);

  // And the other half of acting on a recall: what is still in the shop.
  assert.equal(recall.summary.on_hand_milli, 0, 'RC-1 was emptied by that line');
  assert.equal(recall.summary.outstanding_milli, 6000);
  assert.equal(recall.summary.customers_count, 1);
  assert.equal(recall.summary.walk_in_count, 0);

  // The second batch sees both sales, with its own shares.
  const second = batchesOf(product.id).find((b) => b.batch_no === 'RC-2');
  const rest = batchService.recallFor(second.id, { actor: sessions.OWNER });
  assert.deepEqual(rest.sales.map((s) => s.qty_milli).sort((a, b) => a - b), [2000, 4000]);
  assert.equal(rest.summary.walk_in_count, 1, 'the cash sale has nobody to ring');
});

test('TC-INT-113: voided, returned and walk-in sales are all represented as themselves', () => {
  const product = vaccine();
  receive({ product, qtyMilli: 30000, unitCostCentavos: 30000, batchNo: 'RC-3', expiryDate: days(300) });
  const batch = batchesOf(product.id)[0];

  const walkIn = cashSale({ product, qtyMilli: 3000 });
  const returned = cashSale({ product, qtyMilli: 5000 });
  const voided = cashSale({ product, qtyMilli: 4000 });

  // Two of the five come back; three are still in somebody's shed.
  returnService.post({
    saleId: returned.sale.id,
    reason: 'Customer changed their mind',
    lines: [{ saleItemId: saleRepository.itemsFor(returned.sale.id)[0].id, qtyMilli: 2000, disposition: 'RESTOCK' }],
  }, sessions.MANAGER);

  voidService.post({
    saleId: voided.sale.id,
    reason: 'Rang up the wrong farm’s account',
    approver: { username: 'manager' },
  }, sessions.CASHIER);

  const recall = batchService.recallFor(batch.id, { actor: sessions.OWNER });
  const bySaleNo = Object.fromEntries(recall.sales.map((s) => [s.sale_no, s]));

  assert.equal(recall.sales.length, 3, 'all three are on the list');

  // A walk-in has nobody to ring, and that is the answer rather than a missing one.
  assert.equal(bySaleNo[walkIn.sale.sale_no].is_walk_in, true);
  assert.equal(bySaleNo[walkIn.sale.sale_no].customer_name, null);

  // POS-301: two of the five came back, three did not — and the three are what the
  // store is chasing.
  const back = bySaleNo[returned.sale.sale_no];
  assert.equal(back.qty_milli, 5000);
  assert.equal(back.returned_qty_milli, 2000);
  assert.equal(back.outstanding_qty_milli, 3000);
  assert.equal(back.is_returned, true);

  // POS-401: the sale was reversed and the goods may still have left with the customer.
  // Listed, marked, and counted as outstanding — the store decides, not the report.
  const gone = bySaleNo[voided.sale.sale_no];
  assert.equal(gone.is_voided, true);
  assert.equal(gone.status, 'VOIDED');
  assert.equal(gone.outstanding_qty_milli, 4000);

  // 3 + 3 + 4 still out there, by the report's reckoning.
  assert.equal(recall.summary.outstanding_milli, 10000);
  assert.equal(recall.summary.walk_in_count, 3, 'all three were walk-ins, and none can be rung');

  // 30 received, 12 sold, 2 returned to the shelf and 4 put back by the void: 24.
  //
  // **The voided four are on the shelf and on the list at the same time, and that is
  // not double counting.** INV-201 says the stock came back — the ledger has the
  // compensating movement — while INV-206 says the goods may have gone out of the door
  // with the customer before anybody noticed. The store is the only one who knows
  // which, and a report that resolved it silently would decide who gets no telephone
  // call.
  assert.equal(recall.summary.on_hand_milli, 24000);
  // RPT-106: the list says what it includes, in the words a printed copy needs.
  assert.match(recall.basis, /including sales later voided/);
});

test('INV-206: the recall reads over HTTP, and exports the figures the screen shows', async () => {
  const product = vaccine();
  receive({ product, qtyMilli: 8000, unitCostCentavos: 30000, batchNo: 'RC-4', expiryDate: days(200) });
  const batch = batchesOf(product.id)[0];
  cashSale({ product, qtyMilli: 3000 });

  const res = await call(`/batches/${batch.id}/recall`, { token: tokens.INVENTORY });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sales.length, 1);
  assert.equal(body.summary.outstanding_display, '3 PC');

  // The CSV is the same call, so the two cannot say different things.
  const csv = await call(`/batches/${batch.id}/recall/export.csv`, { token: tokens.OWNER });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /recall_.*RC-4\.csv/);
  const text = await csv.text();
  assert.match(text, /"sale_no","date","customer"/);
  assert.match(text, /"Walk-in"/);
  assert.match(text, /"3 PC"/);

  // TX-426 to export: a manager holds TX-422 and reads the screen, and does not export.
  assert.equal((await call(`/batches/${batch.id}/recall/export.csv`, { token: tokens.CASHIER })).status, 403);
});
