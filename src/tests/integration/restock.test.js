'use strict';

// TASK-072 — what to buy, asked for and approved. PO-107 to PO-109.
//
// Three of these assert an **absence**, which is the harder half and the reason the
// module is worth having:
//
//   PO-109  a product with enough already on order is suggested nothing. This is the
//           fault the module exists to fix — INV-109 compares the shelf with the minimum
//           and cannot see the forty sacks on a PENDING order, so a buyer reading the
//           low-stock list twice in a week orders them twice.
//   PO-107  nothing in the module writes an inventory movement.
//   PO-108  a conversion that cannot finish writes no orders at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const inventoryService = require('../../services/inventoryService');
const settingsService = require('../../services/settingsService');
const supplierService = require('../../services/supplierService');
const purchaseOrderService = require('../../services/purchaseOrderService');
const goodsReceiptService = require('../../services/goodsReceiptService');
const restockService = require('../../services/restockService');
const temp = require('../helpers/tempdb');

let BASE = null;
const PASSWORD = 'correct-horse-battery';

let instance;
let ref;
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

let sku = 0;
function makeProduct(over = {}) {
  sku += 1;
  return productService.create({
    sku: `RST-${String(sku).padStart(3, '0')}`,
    name: `Restock Test Feed ${sku}`,
    categoryId: ref.category.id,
    baseUnitId: ref.kg.id,
    retailPriceCentavos: 6250,
    minStockMilli: 0,
    ...over,
  }, sessions.OWNER);
}

let supplierSeq = 0;
function makeSupplier(over = {}) {
  supplierSeq += 1;
  return supplierService.create({ name: `Restock Mill ${supplierSeq}`, termsDays: 30, ...over }, sessions.OWNER);
}

/** Put stock on the shelf without going near the module under test. */
function stock(product, qtyMilli) {
  inventoryService.post({
    productId: product.id,
    type: 'OPENING',
    qtyMilli,
    unitCostCentavos: 3900,
    reason: 'Opening balance',
    actor: sessions.OWNER,
  });
}

const find = (list, productId) => list.products.find((p) => p.product_id === productId);

test.before(async () => {
  temp.openEmpty('restock');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;
  temp.seedStore({ withOwner: false });
  ref = temp.seedCatalog();

  for (const role of ['OWNER', 'MANAGER', 'CASHIER', 'INVENTORY']) {
    const username = role.toLowerCase();
    temp.seedUser({ username, role, password: PASSWORD });
    const signedIn = authService.login({ username, password: PASSWORD });
    tokens[role] = signedIn.token;
    sessions[role] = authService.verifyToken(signedIn.token);
  }
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── The arithmetic (PO-109) ─────────────────────────────────────────────────

test('PO-109: the suggestion nets off what is already on order', () => {
  // 50 wanted (minimum 25 at cover 2), 10 on the shelf, 15 coming: buy 25.
  assert.equal(
    restockService.suggest({ minStockMilli: 25000, onHandMilli: 10000, onOrderMilli: 15000, cover: 2 }),
    25000
  );
  // Enough already coming: nothing to buy, and never a negative.
  assert.equal(
    restockService.suggest({ minStockMilli: 25000, onHandMilli: 10000, onOrderMilli: 90000, cover: 2 }),
    0
  );
  // No minimum set is not the same question as "you have enough", and must not answer
  // it. Null is the row asking; zero would be the row lying.
  assert.equal(
    restockService.suggest({ minStockMilli: 0, onHandMilli: 0, onOrderMilli: 0, cover: 2 }),
    null
  );
  assert.equal(
    restockService.suggest({ minStockMilli: 25000, onHandMilli: 0, onOrderMilli: 0, cover: 1 }),
    25000
  );
});

test('PO-109: a product with an open order is suggested nothing, and says what is coming', () => {
  const product = makeProduct({ minStockMilli: 50000 });
  stock(product, 10000);

  const before = find(restockService.suggestions(), product.id);
  assert.equal(before.on_order_milli, 0);
  assert.equal(before.suggested_qty_milli, 90000);     // 50 × 2 − 10
  assert.equal(before.source, 'BELOW_MINIMUM');

  const supplier = makeSupplier();
  const draft = purchaseOrderService.create({
    supplierId: supplier.id,
    lines: [{ productId: product.id, qtyMilli: 200000, unitCostCentavos: 3900 }],
  }, sessions.OWNER);
  purchaseOrderService.submit(draft.id, sessions.OWNER);

  const after = find(restockService.suggestions(), product.id);
  assert.equal(after.on_order_milli, 200000);
  assert.equal(after.suggested_qty_milli, 0, 'two hundred already coming covers a target of a hundred');
});

test('PO-109: a DRAFT order is not "already coming"', () => {
  const product = makeProduct({ minStockMilli: 40000 });
  stock(product, 1000);
  purchaseOrderService.create({
    supplierId: makeSupplier().id,
    lines: [{ productId: product.id, qtyMilli: 500000, unitCostCentavos: 3900 }],
  }, sessions.OWNER);

  // Nobody has been told to send it, so nothing is on its way.
  assert.equal(find(restockService.suggestions(), product.id).on_order_milli, 0);
});

test('PO-109: what has arrived stops counting as on order', () => {
  // The minimum is well above what the delivery brings, so the product is still on the
  // list afterwards — otherwise this would prove only that a restocked product leaves it.
  const product = makeProduct({ minStockMilli: 200000 });
  const supplier = makeSupplier();
  const draft = purchaseOrderService.create({
    supplierId: supplier.id,
    lines: [{ productId: product.id, qtyMilli: 100000, unitCostCentavos: 3900 }],
  }, sessions.OWNER);
  const order = purchaseOrderService.submit(draft.id, sessions.OWNER);
  assert.equal(find(restockService.suggestions(), product.id).on_order_milli, 100000);

  goodsReceiptService.post({
    poId: order.id,
    supplierDrNo: 'DR-RST-1',
    lines: [{
      poItemId: order.lines[0].id,
      receivedQtyMilli: 60000,
      damagedQtyMilli: 0,
      unitCostCentavos: 3900,
    }],
  }, sessions.OWNER);

  assert.equal(
    find(restockService.suggestions(), product.id).on_order_milli, 40000,
    'sixty of the hundred arrived; forty is still coming'
  );
});

// ── The gap INV-109 leaves ──────────────────────────────────────────────────

test('a product with no minimum and no stock is listed — INV-109 alone never shows it', () => {
  const product = makeProduct({ minStockMilli: 0 });   // nobody set one

  const row = find(restockService.suggestions(), product.id);
  assert.ok(row, 'an empty shelf is a thing to buy even where nobody set a minimum');
  assert.equal(row.source, 'OUT_OF_STOCK');
  // It has no target, so it asks rather than inventing one.
  assert.equal(row.suggested_qty_milli, null);
  assert.equal(row.target_milli, null);

  // And once it has stock it drops off, because no minimum means no threshold to be under.
  stock(product, 5000);
  assert.equal(find(restockService.suggestions(), product.id), undefined);
});

test('INV-114: a made-to-order product is never on the list', () => {
  // It keeps no stock, so productService refuses it a minimum — which is precisely why
  // the OUT_OF_STOCK derivation, which needs no minimum, has to exclude it explicitly.
  const product = makeProduct({ minStockMilli: 0, isStocked: false });
  assert.equal(find(restockService.suggestions(), product.id), undefined);
  assert.throws(
    () => restockService.create({ lines: [{ productId: product.id, qtyMilli: 1000 }] }, sessions.INVENTORY),
    (err) => err.ruleId === 'INV-114'
  );
});

// ── The document ────────────────────────────────────────────────────────────

test('PO-107: a request is raised, numbered, and moves no stock', () => {
  const product = makeProduct({ minStockMilli: 30000 });
  stock(product, 1000);
  const onHandBefore = inventoryService.onHand(product.id).qty_on_hand_milli;

  const request = restockService.create({
    note: 'Weekly order',
    lines: [{ productId: product.id, qtyMilli: 59000, supplierId: makeSupplier().id, unitCostCentavos: 3900 }],
  }, sessions.INVENTORY);

  assert.match(request.rr_no, /^RR-\d{8}-\d{6}$/);
  assert.equal(request.status, 'DRAFT');
  assert.equal(request.line_count, 1);
  assert.equal(request.items[0].qty_milli, 59000);

  // PO-107: nothing moved.
  assert.equal(inventoryService.onHand(product.id).qty_on_hand_milli, onHandBefore);
});

test('a request refuses an unknown product on the second line, and writes neither', () => {
  const good = makeProduct({ minStockMilli: 1000 });
  assert.throws(
    () => restockService.create({
      lines: [
        { productId: good.id, qtyMilli: 5000 },
        { productId: 'no-such-product', qtyMilli: 5000 },
      ],
    }, sessions.INVENTORY),
    (err) => err.status === 400 && /line 2/.test(err.message)
  );

  const mine = restockService.search({ limit: 200 }).requests
    .filter((r) => r.line_count === 1 && r.status === 'DRAFT');
  assert.ok(
    mine.every((r) => restockService.get(r.id).items[0].product_id !== 'no-such-product'),
    'the half-written request was not left behind'
  );
});

test('a request needs at least one line, and a quantity above nothing', () => {
  const product = makeProduct();
  assert.throws(
    () => restockService.create({ lines: [] }, sessions.INVENTORY),
    (err) => err.status === 400 && err.ruleId === 'PO-107'
  );
  assert.throws(
    () => restockService.create({ lines: [{ productId: product.id, qtyMilli: 0 }] }, sessions.INVENTORY),
    (err) => err.status === 400 && err.ruleId === 'MON-002'
  );
  assert.throws(
    () => restockService.create({
      lines: [
        { productId: product.id, qtyMilli: 1000 },
        { productId: product.id, qtyMilli: 2000 },
      ],
    }, sessions.INVENTORY),
    (err) => err.status === 400 && /twice/.test(err.message)
  );
});

// ── The ask and the answer (AUD-601, AUD-603) ───────────────────────────────

test('AUD-603: the clerk asks, the owner answers, and the two are distinct actors', () => {
  const product = makeProduct({ minStockMilli: 30000 });
  const supplier = makeSupplier();
  const request = restockService.create({
    lines: [{ productId: product.id, qtyMilli: 59000, supplierId: supplier.id, unitCostCentavos: 3900 }],
  }, sessions.INVENTORY);

  const submitted = restockService.submit(request.id, sessions.INVENTORY);
  assert.equal(submitted.status, 'SUBMITTED');

  // The person who raised it cannot be the person who approves it.
  assert.throws(
    () => restockService.decide(request.id, { approve: true }, sessions.INVENTORY),
    (err) => err.ruleId === 'AUD-603'
  );

  const approved = restockService.decide(request.id, { approve: true }, sessions.OWNER);
  assert.equal(approved.status, 'APPROVED');
  assert.equal(approved.self_approved, false);
  assert.equal(approved.decided_by_username, 'owner');
  assert.equal(approved.approved_count, 1);
});

test('AUD-601: a rejection says why, and is final', () => {
  const product = makeProduct({ minStockMilli: 30000 });
  const request = restockService.create({
    lines: [{ productId: product.id, qtyMilli: 59000, supplierId: makeSupplier().id }],
  }, sessions.INVENTORY);
  restockService.submit(request.id, sessions.INVENTORY);

  assert.throws(
    () => restockService.decide(request.id, { approve: false, reason: '  ' }, sessions.OWNER),
    (err) => err.status === 400 && err.ruleId === 'AUD-601'
  );

  const rejected = restockService.decide(request.id, { approve: false, reason: 'No money this week' }, sessions.OWNER);
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.decision_reason, 'No money this week');
  assert.equal(rejected.can_convert, false);

  // Final: it is answered by raising another, not by arguing with this one.
  assert.throws(
    () => restockService.decide(request.id, { approve: true }, sessions.OWNER),
    (err) => err.status === 409
  );
});

test('the owner approves nine of eleven: the struck lines are not ordered', () => {
  const supplier = makeSupplier();
  const keep = makeProduct({ minStockMilli: 30000 });
  const strike = makeProduct({ minStockMilli: 30000 });
  const request = restockService.create({
    lines: [
      { productId: keep.id, qtyMilli: 50000, supplierId: supplier.id, unitCostCentavos: 3900 },
      { productId: strike.id, qtyMilli: 50000, supplierId: supplier.id, unitCostCentavos: 3900 },
    ],
  }, sessions.INVENTORY);
  restockService.submit(request.id, sessions.INVENTORY);

  const full = restockService.get(request.id);
  const strikeLine = full.items.find((i) => i.product_id === strike.id);
  const approved = restockService.decide(request.id, {
    approve: true,
    itemDecisions: { [strikeLine.id]: false },
  }, sessions.OWNER);

  assert.equal(approved.approved_count, 1, 'one of the two survived');

  const { purchase_orders: orders } = restockService.convert(request.id, sessions.OWNER);
  assert.equal(orders.length, 1);
  const po = purchaseOrderService.get(orders[0].id);
  assert.equal(po.lines.length, 1);
  assert.equal(po.lines[0].product_id, keep.id);
});

test('approving nothing is a rejection, and is refused as one', () => {
  const product = makeProduct({ minStockMilli: 30000 });
  const request = restockService.create({
    lines: [{ productId: product.id, qtyMilli: 50000, supplierId: makeSupplier().id }],
  }, sessions.INVENTORY);
  restockService.submit(request.id, sessions.INVENTORY);
  const line = restockService.get(request.id).items[0];

  assert.throws(
    () => restockService.decide(request.id, { approve: true, itemDecisions: { [line.id]: false } }, sessions.OWNER),
    (err) => err.status === 400 && /rejection/.test(err.message)
  );
  // And the refusal left the request where it was, not half decided.
  assert.equal(restockService.get(request.id).status, 'SUBMITTED');
});

test('a submitted request is nobody\'s to edit but the approver\'s', () => {
  const product = makeProduct({ minStockMilli: 30000 });
  const request = restockService.create({
    lines: [{ productId: product.id, qtyMilli: 50000, supplierId: makeSupplier().id }],
  }, sessions.INVENTORY);
  restockService.submit(request.id, sessions.INVENTORY);

  assert.throws(
    () => restockService.update(request.id, {
      lines: [{ productId: product.id, qtyMilli: 99000 }],
    }, sessions.INVENTORY),
    (err) => err.status === 409
  );
});

// ── PO-108: it becomes orders ───────────────────────────────────────────────

test('PO-108: one DRAFT order per supplier, linked both ways', () => {
  const millA = makeSupplier();
  const millB = makeSupplier();
  const a1 = makeProduct({ minStockMilli: 30000 });
  const a2 = makeProduct({ minStockMilli: 30000 });
  const b1 = makeProduct({ minStockMilli: 30000 });

  const request = restockService.create({
    lines: [
      { productId: a1.id, qtyMilli: 50000, supplierId: millA.id, unitCostCentavos: 3900 },
      { productId: b1.id, qtyMilli: 60000, supplierId: millB.id, unitCostCentavos: 4100 },
      { productId: a2.id, qtyMilli: 70000, supplierId: millA.id, unitCostCentavos: 4200 },
    ],
  }, sessions.INVENTORY);
  restockService.submit(request.id, sessions.INVENTORY);
  restockService.decide(request.id, { approve: true }, sessions.OWNER);

  const result = restockService.convert(request.id, sessions.OWNER);
  assert.equal(result.purchase_orders.length, 2, 'two suppliers, two orders');
  assert.equal(result.request.status, 'ORDERED');

  const byName = Object.fromEntries(result.purchase_orders.map((o) => [o.supplier_name, o]));
  assert.equal(byName[millA.name].line_count, 2);
  assert.equal(byName[millB.name].line_count, 1);

  // Every order is a DRAFT the buyer still has to read and send (PO-101, PO-104).
  for (const order of result.purchase_orders) {
    const po = purchaseOrderService.get(order.id);
    assert.equal(po.status, 'DRAFT');
    assert.equal(po.can_submit, true);
  }

  // Both directions of the link: the line cites its order, and the quantity survived.
  const items = restockService.get(request.id).items;
  assert.ok(items.every((i) => i.po_id && i.po_no), 'every converted line names its order');
  const aOrder = purchaseOrderService.get(byName[millA.name].id);
  assert.equal(
    aOrder.lines.find((l) => l.product_id === a2.id).qty_milli, 70000,
    'the quantity asked for is the quantity ordered'
  );

  // And it cannot be converted a second time.
  assert.throws(() => restockService.convert(request.id, sessions.OWNER), (err) => err.status === 409);
});

test('PO-108: a line with no supplier is carried and named, not dropped', () => {
  const mill = makeSupplier();
  const known = makeProduct({ minStockMilli: 30000 });
  const orphan = makeProduct({ minStockMilli: 30000 });   // never received from anybody

  const request = restockService.create({
    lines: [
      { productId: known.id, qtyMilli: 50000, supplierId: mill.id, unitCostCentavos: 3900 },
      { productId: orphan.id, qtyMilli: 50000, supplierId: null },
    ],
  }, sessions.INVENTORY);
  restockService.submit(request.id, sessions.INVENTORY);
  const approved = restockService.decide(request.id, { approve: true }, sessions.OWNER);
  assert.equal(approved.no_supplier_count, 1);

  const result = restockService.convert(request.id, sessions.OWNER);
  assert.equal(result.purchase_orders.length, 1, 'the one that could be ordered was');
  assert.deepEqual(result.lines_without_supplier, [orphan.name], 'and the other is named');
});

test('PO-108: nothing approved names a supplier — no order is written at all', () => {
  const orphan = makeProduct({ minStockMilli: 30000 });
  const request = restockService.create({
    lines: [{ productId: orphan.id, qtyMilli: 50000, supplierId: null }],
  }, sessions.INVENTORY);
  restockService.submit(request.id, sessions.INVENTORY);
  restockService.decide(request.id, { approve: true }, sessions.OWNER);

  const before = purchaseOrderService.search({ limit: 500 }).total;
  assert.throws(
    () => restockService.convert(request.id, sessions.OWNER),
    (err) => err.status === 400 && err.ruleId === 'PO-108'
  );
  assert.equal(purchaseOrderService.search({ limit: 500 }).total, before, 'no half-converted orders');
  assert.equal(restockService.get(request.id).status, 'APPROVED', 'and the request is where it was');
});

test('PO-107: converting a request moves no stock', () => {
  const product = makeProduct({ minStockMilli: 30000 });
  stock(product, 2000);
  const before = inventoryService.onHand(product.id).qty_on_hand_milli;

  const request = restockService.create({
    lines: [{ productId: product.id, qtyMilli: 80000, supplierId: makeSupplier().id, unitCostCentavos: 3900 }],
  }, sessions.INVENTORY);
  restockService.submit(request.id, sessions.INVENTORY);
  restockService.decide(request.id, { approve: true }, sessions.OWNER);
  restockService.convert(request.id, sessions.OWNER);

  assert.equal(
    inventoryService.onHand(product.id).qty_on_hand_milli, before,
    'a request, and the draft orders it raised, move nothing (PO-103, PO-107)'
  );
});

// ── The one-person store ────────────────────────────────────────────────────

test('a store with one active user self-approves, and the row says so', (t) => {
  // Deactivate everybody but the owner, so there is genuinely nobody to ask.
  const userService = require('../../services/userService');
  const deactivated = [];
  for (const role of ['MANAGER', 'CASHIER', 'INVENTORY']) {
    userService.update(sessions[role].id, { isActive: false }, sessions.OWNER);
    deactivated.push(sessions[role].id);
  }
  t.after(() => {
    for (const id of deactivated) userService.update(id, { isActive: true }, sessions.OWNER);
  });

  const product = makeProduct({ minStockMilli: 30000 });
  const request = restockService.create({
    lines: [{ productId: product.id, qtyMilli: 50000, supplierId: makeSupplier().id, unitCostCentavos: 3900 }],
  }, sessions.OWNER);

  const submitted = restockService.submit(request.id, sessions.OWNER);
  assert.equal(submitted.status, 'APPROVED', 'there is nobody to ask, so it is not left waiting');
  assert.equal(submitted.self_approved, true, 'and it says that is what happened');
  assert.equal(submitted.can_convert, true);
});

// ── SEC-6 — the permission ──────────────────────────────────────────────────

test('SEC-6: restocking is TX-409 — the clerk reaches it and the cashier does not', async () => {
  const product = makeProduct({ minStockMilli: 30000 });

  const refused = await call('/restock/suggestions', { token: tokens.CASHIER });
  assert.equal(refused.status, 403);

  for (const role of ['OWNER', 'MANAGER', 'INVENTORY']) {
    const res = await call('/restock/suggestions', { token: tokens[role] });
    assert.equal(res.status, 200, `${role} holds TX-409`);
  }

  // Every write too, not merely the read.
  const body = { lines: [{ productId: product.id, qtyMilli: 5000 }] };
  assert.equal((await call('/restock-requests', { token: tokens.CASHIER, method: 'POST', body })).status, 403);

  const created = await call('/restock-requests', { token: tokens.INVENTORY, method: 'POST', body });
  assert.equal(created.status, 201);
  const { request } = await created.json();
  for (const path of ['submit', 'decide', 'cancel', 'orders']) {
    const res = await call(`/restock-requests/${request.id}/${path}`, {
      token: tokens.CASHIER, method: 'POST', body: {},
    });
    assert.equal(res.status, 403, `/${path} is TX-409 too`);
  }
});

test('the list reads over HTTP, with the figures the buyer decides on', async () => {
  const res = await call('/restock/suggestions', { token: tokens.INVENTORY });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.cover_multiplier, 'number');
  assert.ok(Array.isArray(body.products));
  for (const row of body.products) {
    for (const key of ['product_id', 'qty_on_hand_milli', 'on_order_milli', 'source', 'base_unit_code']) {
      assert.ok(key in row, `every row carries ${key}`);
    }
  }
});

test('the cover multiplier is the store\'s, and the suggestion follows it', (t) => {
  const original = settingsService.get('restock_cover_multiplier');
  t.after(() => settingsService.set('restock_cover_multiplier', original, sessions.OWNER));

  const product = makeProduct({ minStockMilli: 20000 });
  stock(product, 1000);

  settingsService.set('restock_cover_multiplier', 1, sessions.OWNER);
  assert.equal(find(restockService.suggestions(), product.id).suggested_qty_milli, 19000);

  settingsService.set('restock_cover_multiplier', 3, sessions.OWNER);
  assert.equal(find(restockService.suggestions(), product.id).suggested_qty_milli, 59000);
});
