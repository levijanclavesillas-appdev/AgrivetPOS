'use strict';

// FT-501 – FT-504 — suppliers, purchase orders and goods receipt.
//
// The five named cases are `TC-INT-76` to `TC-INT-80`. Each one asserts a rule that
// costs money when it is wrong, and three of them assert an **absence**, which is the
// harder half: PO-103 says a purchase order moves no stock, PO-202 says a damaged
// quantity moves none, and PO-206 says a posted receipt cannot be edited. A test that
// only ever checks that something happened will not notice any of the three.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const inventoryService = require('../../services/inventoryService');
const settingsService = require('../../services/settingsService');
const auditService = require('../../services/auditService');
const supplierService = require('../../services/supplierService');
const purchaseOrderService = require('../../services/purchaseOrderService');
const goodsReceiptService = require('../../services/goodsReceiptService');
const inventoryRepository = require('../../repositories/inventoryRepository');
const productRepository = require('../../repositories/productRepository');
const temp = require('../helpers/tempdb');

// Port 0: the OS picks a free one. A fixed port collides whenever two runs overlap.
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
    sku: `PUR-${String(sku).padStart(3, '0')}`,
    name: `Purchasing Test Feed ${sku}`,
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
  return supplierService.create({ name: `Feed Mill ${supplierSeq}`, termsDays: 30, ...over }, sessions.OWNER);
}

/** A sent order for one product, which is the starting point of most of these. */
function sentOrder({ product, qtyMilli = 2500000, unitCostCentavos = 3900, supplier = null }) {
  const forSupplier = supplier || makeSupplier();
  const draft = purchaseOrderService.create({
    supplierId: forSupplier.id,
    lines: [{ productId: product.id, qtyMilli, unitCostCentavos }],
  }, sessions.OWNER);
  return { order: purchaseOrderService.submit(draft.id, sessions.OWNER), supplier: forSupplier };
}

test.before(async () => {
  temp.openEmpty('purchasing');
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

// ── VR-401 — the supplier ───────────────────────────────────────────────────

test('VR-401: a supplier name is required and unique, whatever its case', () => {
  const supplier = supplierService.create({ name: 'B-MEG Feeds', termsDays: 30 }, sessions.OWNER);
  assert.equal(supplier.name, 'B-MEG Feeds');
  assert.equal(supplier.terms_label, '30 days');

  // NOCASE: two spellings of one account would be two purchase histories, and the
  // store could see neither whole.
  assert.throws(
    () => supplierService.create({ name: 'b-meg feeds' }, sessions.OWNER),
    (err) => err.ruleId === 'VR-401' && err.status === 409
  );
  assert.throws(
    () => supplierService.create({ name: 'X' }, sessions.OWNER),
    (err) => err.ruleId === 'VR-401' && err.status === 400
  );
});

test('VR-401: a supplier is deactivated, never deleted, and not while an order stands', async () => {
  const product = makeProduct();
  const { order, supplier } = sentOrder({ product });

  assert.throws(
    () => supplierService.deactivate(supplier.id, sessions.OWNER),
    (err) => err.ruleId === 'VR-401' && /outstanding/.test(err.message)
  );

  purchaseOrderService.cancel(order.id, { reason: 'Mill has no stock' }, sessions.OWNER);
  assert.equal(supplierService.deactivate(supplier.id, sessions.OWNER).is_active, false);

  const res = await call(`/suppliers/${supplier.id}`, { token: tokens.OWNER, method: 'DELETE' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.rule_id, 'VR-401');
});

// ── PO-101 — the order's shape ──────────────────────────────────────────────

test('PO-101: an order carries supplier, dates, lines of quantity and cost, and a status', () => {
  const product = makeProduct();
  const supplier = makeSupplier();

  const order = purchaseOrderService.create({
    supplierId: supplier.id,
    expectedAt: '2026-09-20',
    referenceNo: 'MILL-4471',
    notes: 'Collect from the Isulan depot',
    lines: [{
      productId: product.id, qtyMilli: 2500000, unitCostCentavos: 3900,
      orderUnitId: ref.sack.id, packFactorMilli: 50000,
    }],
  }, sessions.OWNER);

  assert.match(order.po_no, /^PO-\d{8}-\d{6}$/, 'VR-103 — its own dated sequence');
  assert.equal(order.supplier.id, supplier.id);
  assert.equal(order.supplier.terms_days, 30, 'the terms come from the supplier, not the order');
  assert.equal(order.expected_at, '2026-09-20');
  assert.equal(order.reference_no, 'MILL-4471');
  assert.equal(order.status, 'DRAFT');
  assert.equal(order.revision, 1);

  const line = order.lines[0];
  assert.equal(line.qty_milli, 2500000);
  assert.equal(line.unit_cost_centavos, 3900, 'per base unit, as every other cost here is');
  // MON-003, rounded once: 2,500 KG at ₱39.00 is ₱97,500.
  assert.equal(line.line_total_centavos, 9750000);
  assert.equal(order.total_centavos, 9750000);
  // UOM-002: what the buyer ordered in, kept beside the base-unit figure.
  assert.equal(line.order_unit_code, 'SACK');
  assert.equal(line.order_pack_factor_milli, 50000);
  assert.equal(line.product_name, product.name, 'a snapshot, as sale_items keeps one');

  // An order with no lines is not an order.
  assert.throws(
    () => purchaseOrderService.create({ supplierId: supplier.id, lines: [] }, sessions.OWNER),
    (err) => err.ruleId === 'PO-101'
  );
  // And one product on two lines makes "how much is outstanding" unanswerable.
  assert.throws(
    () => purchaseOrderService.create({
      supplierId: supplier.id,
      lines: [
        { productId: product.id, qtyMilli: 1000, unitCostCentavos: 100 },
        { productId: product.id, qtyMilli: 1000, unitCostCentavos: 100 },
      ],
    }, sessions.OWNER),
    (err) => err.ruleId === 'PO-101' && /twice/.test(err.message)
  );
});

// ── TC-INT-76 — PO-103 ──────────────────────────────────────────────────────

test('TC-INT-76: PO-103 — no purchase order operation writes an inventory movement', () => {
  const product = makeProduct();
  const before = inventoryRepository.qtyOnHand(product.id);
  const supplier = makeSupplier();

  const draft = purchaseOrderService.create({
    supplierId: supplier.id,
    expectedAt: '2026-09-20',
    lines: [{ productId: product.id, qtyMilli: 2500000, unitCostCentavos: 3900 }],
  }, sessions.OWNER);

  // Every operation the lifecycle offers, one after another.
  purchaseOrderService.submit(draft.id, sessions.OWNER);
  purchaseOrderService.update(draft.id, {
    lines: [{ productId: product.id, qtyMilli: 3000000, unitCostCentavos: 4000 }],
    reason: 'Mill raised the price before shipping',
  }, sessions.OWNER);
  purchaseOrderService.cancel(draft.id, { reason: 'Ordered elsewhere' }, sessions.OWNER);

  assert.deepEqual(
    inventoryRepository.movementsForReference('purchase_order', draft.id), [],
    'a purchase order references no movement'
  );
  assert.equal(
    inventoryRepository.qtyOnHand(product.id), before,
    'raising, sending, amending and cancelling an order left on hand exactly where it was'
  );
  // The stronger form: the product has no movement of any kind, from any reference.
  assert.equal(
    inventoryRepository.countMovementsFor(product.id, {}), 0,
    'INV-101 — on hand still means what is on the shelf, not what is expected'
  );
  assert.equal(
    productRepository.findById(product.id).avg_cost_centavos, 0,
    'INV-106 — an order carries a cost and moves no average; only a receipt does'
  );
});

// ── TC-INT-77 — PO-202 ──────────────────────────────────────────────────────

test('TC-INT-77: PO-202 — the damaged quantity is recorded and moves no stock', () => {
  const product = makeProduct();
  const { order } = sentOrder({ product, qtyMilli: 2500000, unitCostCentavos: 3900 });
  const line = purchaseOrderService.get(order.id).lines[0];

  // Fifty sacks of fifty kilos arrive; three are split.
  const receipt = goodsReceiptService.post({
    poId: order.id,
    supplierDrNo: 'DR-9931',
    lines: [{
      poItemId: line.id,
      receivedQtyMilli: 2500000,
      damagedQtyMilli: 150000,
      unitCostCentavos: 3900,
      damageNote: 'three sacks split in transit',
    }],
  }, sessions.OWNER);

  const posted = receipt.lines[0];
  assert.equal(posted.received_qty_milli, 2500000, 'what arrived is recorded whole');
  assert.equal(posted.damaged_qty_milli, 150000, 'and so is what arrived broken');
  assert.equal(posted.sound_qty_milli, 2350000);

  assert.equal(
    inventoryRepository.qtyOnHand(product.id), 2350000,
    'PO-202 — only the sound quantity became stock'
  );

  // One movement, for the sound figure, and none for the damage.
  const movements = inventoryRepository.movementsForReference('goods_receipt', receipt.id);
  assert.equal(movements.length, 1, 'a damaged quantity posts no movement of its own');
  assert.equal(movements[0].qty_milli, 2350000);
  assert.equal(movements[0].movement_type, 'RECEIPT');

  // The number the store can take to the supplier survives on the row.
  assert.equal(posted.damage_note, 'three sacks split in transit');
  assert.equal(inventoryService.reconcile().ok, true, 'INV-101 still reconciles');
});

test('PO-202: a line that arrived entirely broken is recorded and posts nothing', () => {
  const product = makeProduct();
  const { order } = sentOrder({ product, qtyMilli: 100000, unitCostCentavos: 3900 });
  const line = purchaseOrderService.get(order.id).lines[0];

  const receipt = goodsReceiptService.post({
    poId: order.id,
    lines: [{
      poItemId: line.id, receivedQtyMilli: 100000, damagedQtyMilli: 100000,
      unitCostCentavos: 3900, damageNote: 'the whole pallet was soaked',
    }],
  }, sessions.OWNER);

  assert.equal(receipt.lines[0].sound_qty_milli, 0);
  assert.equal(receipt.lines[0].posted_to_stock, false, 'no movement of zero reaches the ledger');
  assert.equal(receipt.lines[0].movement_id, null);
  assert.equal(inventoryRepository.qtyOnHand(product.id), 0);
  assert.equal(
    productRepository.findById(product.id).avg_cost_centavos, 0,
    'a delivery that became no stock set no cost'
  );
});

test('PO-202: more damaged than arrived is refused rather than stored', () => {
  const product = makeProduct();
  const { order } = sentOrder({ product, qtyMilli: 100000 });
  const line = purchaseOrderService.get(order.id).lines[0];

  assert.throws(
    () => goodsReceiptService.post({
      poId: order.id,
      lines: [{ poItemId: line.id, receivedQtyMilli: 50000, damagedQtyMilli: 60000, unitCostCentavos: 3900 }],
    }, sessions.OWNER),
    (err) => err.ruleId === 'PO-202' && /part of what was received/.test(err.message)
  );
});

// ── TC-INT-78 — PO-203 ──────────────────────────────────────────────────────

test('TC-INT-78: PO-203 — the average moves at the received cost, not the ordered cost', () => {
  const product = makeProduct();
  // A hundred kilos already on hand at ₱30.00, so the average has somewhere to move
  // from and "it took the received cost" is distinguishable from "it took the only
  // number present".
  inventoryService.postStandalone({
    productId: product.id, type: 'OPENING', qtyMilli: 100000, unitCostCentavos: 3000,
    actor: sessions.OWNER,
  });
  assert.equal(productRepository.findById(product.id).avg_cost_centavos, 3000);

  const { order } = sentOrder({ product, qtyMilli: 100000, unitCostCentavos: 3900 });
  const line = purchaseOrderService.get(order.id).lines[0];

  // Ordered at ₱39.00, charged at ₱42.00.
  goodsReceiptService.post({
    poId: order.id,
    approver: { username: 'owner' },
    approvalReason: 'The mill raised the price',
    lines: [{ poItemId: line.id, receivedQtyMilli: 100000, unitCostCentavos: 4200 }],
  }, sessions.OWNER);

  // MON-004: (100000 × 3000 + 100000 × 4200) / 200000 = 3600.
  const after = productRepository.findById(product.id).avg_cost_centavos;
  assert.equal(after, 3600, 'the average moved on the actual ₱42.00, not the ordered ₱39.00');

  // The figure the ordered cost would have produced, asserted as the wrong answer, so
  // a future change that silently reads the PO fails here rather than in a margin
  // report nobody re-derives.
  assert.notEqual(after, 3450, 'the ordered cost would have given ₱34.50 and is not what was used');
});

test('PO-203: both costs stay on the line, so the variance is answerable for ever', () => {
  const product = makeProduct();
  const { order } = sentOrder({ product, qtyMilli: 100000, unitCostCentavos: 4000 });
  const line = purchaseOrderService.get(order.id).lines[0];

  const receipt = goodsReceiptService.post({
    poId: order.id,
    lines: [{ poItemId: line.id, receivedQtyMilli: 100000, unitCostCentavos: 4100 }],
  }, sessions.OWNER);

  const posted = receipt.lines[0];
  assert.equal(posted.unit_cost_centavos, 4100, 'the actual');
  assert.equal(posted.ordered_unit_cost_centavos, 4000, 'and what it was measured against');
  assert.equal(posted.cost_variance_bp, 250, '2.5%, within the default 10% tolerance');
  assert.equal(posted.is_cost_variance, false);
});

// ── TC-INT-79 — PO-102 and PO-105 ───────────────────────────────────────────

test('TC-INT-79: PO-102 — the status machine, and only the transitions it allows', () => {
  const product = makeProduct();
  const supplier = makeSupplier();

  const draft = purchaseOrderService.create({
    supplierId: supplier.id,
    lines: [{ productId: product.id, qtyMilli: 2000000, unitCostCentavos: 3900 }],
  }, sessions.OWNER);
  assert.equal(draft.status, 'DRAFT');
  assert.equal(draft.can_edit, true);
  assert.equal(draft.can_receive, false, 'nothing is delivered against an order nobody has sent');

  const sent = purchaseOrderService.submit(draft.id, sessions.OWNER);
  assert.equal(sent.status, 'PENDING');
  assert.equal(sent.can_edit, false);
  assert.equal(sent.can_amend, true, 'PO-104 — amended from here, not overwritten');

  // Sending it twice is not a transition the machine has.
  assert.throws(
    () => purchaseOrderService.submit(draft.id, sessions.OWNER),
    (err) => err.ruleId === 'PO-102'
  );

  const line = purchaseOrderService.get(draft.id).lines[0];
  const partial = goodsReceiptService.post({
    poId: draft.id,
    lines: [{ poItemId: line.id, receivedQtyMilli: 1200000, unitCostCentavos: 3900 }],
  }, sessions.OWNER);
  assert.equal(partial.purchase_order.status, 'PARTIALLY_RECEIVED');

  const rest = goodsReceiptService.post({
    poId: draft.id,
    lines: [{ poItemId: line.id, receivedQtyMilli: 800000, unitCostCentavos: 3900 }],
  }, sessions.OWNER);
  assert.equal(rest.purchase_order.status, 'RECEIVED', 'complete when every line is');

  // A closed order takes no more deliveries and no more edits.
  assert.throws(
    () => goodsReceiptService.post({
      poId: draft.id,
      lines: [{ poItemId: line.id, receivedQtyMilli: 1000, unitCostCentavos: 3900 }],
    }, sessions.OWNER),
    (err) => err.ruleId === 'PO-102'
  );
  assert.throws(
    () => purchaseOrderService.update(draft.id, { notes: 'later' }, sessions.OWNER),
    (err) => err.ruleId === 'PO-104'
  );
});

test('TC-INT-79: PO-105 — an order with anything received against it cannot be cancelled', () => {
  const product = makeProduct();
  const { order } = sentOrder({ product, qtyMilli: 2000000, unitCostCentavos: 3900 });
  const line = purchaseOrderService.get(order.id).lines[0];

  // Cancellable right up until the moment the first sack comes off the van.
  assert.equal(purchaseOrderService.get(order.id).can_cancel, true);

  goodsReceiptService.post({
    poId: order.id,
    lines: [{ poItemId: line.id, receivedQtyMilli: 500000, unitCostCentavos: 3900 }],
  }, sessions.OWNER);

  const after = purchaseOrderService.get(order.id);
  assert.equal(after.status, 'PARTIALLY_RECEIVED');
  assert.equal(after.can_cancel, false);

  assert.throws(
    () => purchaseOrderService.cancel(order.id, { reason: 'Changed my mind' }, sessions.OWNER),
    (err) => err.ruleId === 'PO-105' && /already had goods delivered/.test(err.message)
  );

  // And the stock that did arrive is untouched by the refused cancellation.
  assert.equal(inventoryRepository.qtyOnHand(product.id), 500000);
});

test('TC-INT-79: PO-104 — a sent order is amended into a revision, not overwritten', () => {
  const product = makeProduct();
  const { order } = sentOrder({ product, qtyMilli: 2000000, unitCostCentavos: 3900 });
  assert.equal(order.revision, 1);

  const amended = purchaseOrderService.update(order.id, {
    lines: [{ productId: product.id, qtyMilli: 2500000, unitCostCentavos: 4100 }],
    reason: 'Mill can supply more, at a higher price',
  }, sessions.OWNER);

  assert.equal(amended.revision, 2);
  assert.equal(amended.po_no, order.po_no, 'the number the supplier was told does not move');
  assert.equal(amended.reference_label, `${order.po_no} rev 2`);
  assert.equal(amended.lines[0].qty_milli, 2500000);

  // AUD-601 with both values: the superseded revision is where the trail keeps it.
  const trail = auditService.browse({ entityType: 'purchase_orders', entityId: order.id });
  const row = trail.rows.find((entry) => entry.action === 'PURCHASE_ORDER_AMENDED');
  assert.ok(row, 'the amendment is audited');
  assert.equal(row.before.revision, 1);
  assert.equal(row.before.lines[0].qty_milli, 2000000, 'revision 1 is still readable');
  assert.equal(row.after.lines[0].qty_milli, 2500000);

  // A save that changes nothing the supplier was told does not climb the counter — a
  // revision number that moves every time somebody opens the screen says nothing about
  // which version the mill is holding.
  const again = purchaseOrderService.update(order.id, { notes: 'ring them Thursday' }, sessions.OWNER);
  assert.equal(again.revision, 2);
});

// ── TC-INT-80 — PO-204 and PO-205 ───────────────────────────────────────────

test('TC-INT-80: PO-204 — over-receipt needs authorisation and is flagged', () => {
  const product = makeProduct();
  const { order } = sentOrder({ product, qtyMilli: 1000000, unitCostCentavos: 3900 });
  const line = purchaseOrderService.get(order.id).lines[0];

  // The clerk holds TX-409 and is not a manager, so AUD-603's distinct actors apply.
  const overRun = () => goodsReceiptService.post({
    poId: order.id,
    lines: [{ poItemId: line.id, receivedQtyMilli: 1200000, unitCostCentavos: 3900 }],
  }, sessions.INVENTORY);

  assert.throws(overRun, (err) => err.ruleId === 'PO-204'
    && err.status === 403
    && err.requiresRole === 'MANAGER or OWNER'
    && /more than was ordered/.test(err.message));

  assert.equal(inventoryRepository.qtyOnHand(product.id), 0, 'the refused delivery posted nothing');

  // A cashier is not an authority the rule recognises, whoever asks.
  assert.throws(
    () => goodsReceiptService.post({
      poId: order.id,
      approver: { username: 'cashier' },
      lines: [{ poItemId: line.id, receivedQtyMilli: 1200000, unitCostCentavos: 3900 }],
    }, sessions.INVENTORY),
    (err) => err.ruleId === 'PO-204' && /cannot authorise/.test(err.message)
  );

  const receipt = goodsReceiptService.post({
    poId: order.id,
    approver: { username: 'manager' },
    approvalReason: 'The mill shipped a full pallet',
    lines: [{ poItemId: line.id, receivedQtyMilli: 1200000, unitCostCentavos: 3900 }],
  }, sessions.INVENTORY);

  assert.equal(receipt.has_over_receipt, true, 'flagged on the receipt, not only in the trail');
  assert.equal(receipt.lines[0].is_over_receipt, true);
  assert.equal(receipt.approved_by, 'manager');
  assert.equal(inventoryRepository.qtyOnHand(product.id), 1200000);

  // AUD-603's two-actor row.
  const trail = auditService.browse({ action: 'OVERRIDE_OVER_RECEIPT' });
  const row = trail.rows.find((entry) => entry.entity_id === receipt.id);
  assert.ok(row, 'the override is its own audit row');
  assert.equal(row.actor.username, 'inventory');
  assert.equal(row.approver.username, 'manager');
});

test('TC-INT-80: PO-205 — a cost outside tolerance needs authorisation and is flagged', () => {
  const product = makeProduct();
  assert.equal(settingsService.get('cost_variance_tolerance_bp'), 1000, '10% by default');

  const { order } = sentOrder({ product, qtyMilli: 1000000, unitCostCentavos: 4000 });
  const line = purchaseOrderService.get(order.id).lines[0];

  // ₱44.00 against ₱40.00 is exactly 10% — at the tolerance, not beyond it.
  const atTheLine = goodsReceiptService.post({
    poId: order.id,
    lines: [{ poItemId: line.id, receivedQtyMilli: 100000, unitCostCentavos: 4400 }],
  }, sessions.INVENTORY);
  assert.equal(atTheLine.lines[0].cost_variance_bp, 1000);
  assert.equal(atTheLine.has_cost_variance, false, 'the tolerance is a ceiling, not a threshold');

  // ₱46.00 is 15% above and needs a manager.
  assert.throws(
    () => goodsReceiptService.post({
      poId: order.id,
      lines: [{ poItemId: line.id, receivedQtyMilli: 100000, unitCostCentavos: 4600 }],
    }, sessions.INVENTORY),
    (err) => err.ruleId === 'PO-205' && err.requiresRole === 'MANAGER or OWNER'
  );

  // Below is a mis-key too: it inflates every margin the store reports until somebody
  // notices, so the rule's word is "differs" and the check is unsigned.
  assert.throws(
    () => goodsReceiptService.post({
      poId: order.id,
      lines: [{ poItemId: line.id, receivedQtyMilli: 100000, unitCostCentavos: 400 }],
    }, sessions.INVENTORY),
    (err) => err.ruleId === 'PO-205' && /below/.test(err.message)
  );

  const receipt = goodsReceiptService.post({
    poId: order.id,
    approver: { username: 'owner' },
    approvalReason: 'Confirmed with the mill by phone',
    lines: [{ poItemId: line.id, receivedQtyMilli: 100000, unitCostCentavos: 4600 }],
  }, sessions.INVENTORY);

  assert.equal(receipt.has_cost_variance, true);
  assert.equal(receipt.lines[0].cost_variance_bp, 1500);
  assert.equal(
    productRepository.findById(product.id).avg_cost_centavos > 4400, true,
    'PO-203 — and the authorised cost is the one the average moved to'
  );
});

test('PO-204, PO-205: a manager receiving goods is the authority the rules ask for', () => {
  const product = makeProduct();
  const { order } = sentOrder({ product, qtyMilli: 1000000, unitCostCentavos: 4000 });
  const line = purchaseOrderService.get(order.id).lines[0];

  // INV-108 already makes this carve-out for a large adjustment, and for the same
  // reason: requiring a second, distinct person would make an over-receipt impossible
  // in a store where the manager unloads the van, which is most of them.
  const receipt = goodsReceiptService.post({
    poId: order.id,
    lines: [{ poItemId: line.id, receivedQtyMilli: 1500000, unitCostCentavos: 5000 }],
  }, sessions.MANAGER);

  assert.equal(receipt.authorisation.required, true);
  assert.equal(receipt.authorisation.self_authorised, true);
  assert.equal(receipt.approved_by, null, 'there was no second actor to record');

  // AUD-601 — and the trail says which of the two it was, because "a manager did this
  // himself" and "no authorisation was needed" read identically otherwise.
  const trail = auditService.browse({ entityType: 'goods_receipts', entityId: receipt.id });
  const row = trail.rows.find((entry) => entry.action === 'GOODS_RECEIVED');
  assert.equal(row.after.self_authorised, true);
  assert.equal(row.after.authorisation_required, true);
});

test('SEC-6: an approver is resolved against the users table, never taken from the body', () => {
  const product = makeProduct();
  const { order } = sentOrder({ product, qtyMilli: 1000000, unitCostCentavos: 4000 });
  const line = purchaseOrderService.get(order.id).lines[0];

  // A hand-crafted request asserting a role it does not hold. The stored role is the
  // one that counts, and a name nobody has is nobody.
  assert.throws(
    () => goodsReceiptService.post({
      poId: order.id,
      approver: { username: 'cashier', role: 'OWNER' },
      lines: [{ poItemId: line.id, receivedQtyMilli: 1500000, unitCostCentavos: 4000 }],
    }, sessions.INVENTORY),
    (err) => err.status === 403 && /cannot authorise/.test(err.message)
  );
  assert.throws(
    () => goodsReceiptService.post({
      poId: order.id,
      approver: { username: 'nobody', role: 'OWNER' },
      lines: [{ poItemId: line.id, receivedQtyMilli: 1500000, unitCostCentavos: 4000 }],
    }, sessions.INVENTORY),
    (err) => err.status === 403 && /does not exist/.test(err.message)
  );
  assert.equal(inventoryRepository.qtyOnHand(product.id), 0);
});

// ── PO-206, PO-207 ──────────────────────────────────────────────────────────

test('PO-206: a posted receipt is immutable, through the service and through the API', async () => {
  const product = makeProduct();
  const { order } = sentOrder({ product, qtyMilli: 100000, unitCostCentavos: 3900 });
  const line = purchaseOrderService.get(order.id).lines[0];
  const receipt = goodsReceiptService.post({
    poId: order.id,
    lines: [{ poItemId: line.id, receivedQtyMilli: 100000, unitCostCentavos: 3900 }],
  }, sessions.OWNER);

  // The service exports no update and the repository has no path to one — asserted
  // rather than assumed, because "we did not write one" is a fact that erodes.
  assert.equal(typeof goodsReceiptService.update, 'undefined');
  const repo = require('../../repositories/goodsReceiptRepository');
  for (const forbidden of ['updateFields', 'update', 'deleteItem', 'remove']) {
    assert.equal(typeof repo[forbidden], 'undefined', `goodsReceiptRepository.${forbidden} must not exist`);
  }

  for (const method of ['PUT', 'DELETE']) {
    const res = await call(`/goods-receipts/${receipt.id}`, { token: tokens.OWNER, method });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.rule_id, 'PO-206');
    assert.match(body.error.message, /adjustment|return/);
  }
});

test('PO-207: a direct receipt works, needs a supplier, and obeys every other rule', () => {
  const product = makeProduct();
  const supplier = makeSupplier();

  const receipt = goodsReceiptService.post({
    supplierId: supplier.id,
    supplierDrNo: 'DR-4410',
    lines: [{ productId: product.id, receivedQtyMilli: 200000, damagedQtyMilli: 20000, unitCostCentavos: 4500 }],
  }, sessions.OWNER);

  assert.equal(receipt.po_id, null, 'the counter purchase has no order behind it');
  assert.equal(receipt.supplier.id, supplier.id);
  assert.equal(receipt.lines[0].ordered_qty_milli, 0, 'nothing was ordered, so nothing is outstanding');
  assert.equal(receipt.lines[0].is_over_receipt, false, 'PO-204 has no ordered quantity to exceed');

  // PO-202 and PO-203 apply unchanged.
  assert.equal(inventoryRepository.qtyOnHand(product.id), 180000);
  assert.equal(productRepository.findById(product.id).avg_cost_centavos, 4500);

  // A delivery from nobody is not a record of anything.
  assert.throws(
    () => goodsReceiptService.post({
      lines: [{ productId: product.id, receivedQtyMilli: 1000, unitCostCentavos: 4500 }],
    }, sessions.OWNER),
    (err) => err.status === 404
  );
});

test('PO-205, PO-207: a direct receipt is measured against the prevailing average', () => {
  const product = makeProduct();
  const supplier = makeSupplier();

  // Nothing to be a variance from yet, so the check does not apply.
  goodsReceiptService.post({
    supplierId: supplier.id,
    lines: [{ productId: product.id, receivedQtyMilli: 100000, unitCostCentavos: 4000 }],
  }, sessions.INVENTORY);
  assert.equal(productRepository.findById(product.id).avg_cost_centavos, 4000);

  // Now there is. PO-207 says a direct receipt follows every other receipt rule, and
  // a mis-keyed cost at the counter destroys a margin exactly as thoroughly as one
  // against an order — so the average stands in for the ordered figure.
  assert.throws(
    () => goodsReceiptService.post({
      supplierId: supplier.id,
      lines: [{ productId: product.id, receivedQtyMilli: 100000, unitCostCentavos: 40000 }],
    }, sessions.INVENTORY),
    (err) => err.ruleId === 'PO-205' && /average cost/.test(err.message)
  );
});

// ── TX-409, INV-107 ─────────────────────────────────────────────────────────

test('TX-409: purchasing is refused to a cashier, server-side, and audited', async () => {
  for (const path of ['/suppliers', '/purchase-orders', '/goods-receipts']) {
    const res = await call(path, { token: tokens.CASHIER });
    assert.equal(res.status, 403, `${path} is not a cashier's`);
    assert.equal((await res.json()).error.rule_id, 'TX-409');
  }

  const refusals = auditService.browse({ action: 'PERMISSION_REFUSED' });
  assert.ok(
    refusals.rows.some((entry) => entry.entity_id === 'TX-409'),
    'SEC-6 — the attempt is in the trail, not merely blocked at the time'
  );
});

test('INV-107: a delivery that fails part-way commits nothing at all', () => {
  const product = makeProduct();
  const other = makeProduct();
  const supplier = makeSupplier();

  const before = {
    first: inventoryRepository.qtyOnHand(product.id),
    second: inventoryRepository.qtyOnHand(other.id),
    receipts: require('../../repositories/goodsReceiptRepository').countAll(),
  };

  // The second line names a product twice, which is refused after the first line has
  // already been costed. Nothing may survive that.
  assert.throws(() => goodsReceiptService.post({
    supplierId: supplier.id,
    lines: [
      { productId: product.id, receivedQtyMilli: 100000, unitCostCentavos: 4000 },
      { productId: product.id, receivedQtyMilli: 100000, unitCostCentavos: 4000 },
    ],
  }, sessions.OWNER));

  assert.equal(inventoryRepository.qtyOnHand(product.id), before.first);
  assert.equal(inventoryRepository.qtyOnHand(other.id), before.second);
  assert.equal(require('../../repositories/goodsReceiptRepository').countAll(), before.receipts);
  assert.equal(inventoryService.reconcile().ok, true);
});

test('VR-103: the document numbers are gapless, and a rolled-back one is not consumed', () => {
  const product = makeProduct();
  const supplier = makeSupplier();
  const sequenceService = require('../../services/sequenceService');

  const before = sequenceService.auditDay('GOODS_RECEIPT');

  assert.throws(() => goodsReceiptService.post({
    supplierId: supplier.id,
    lines: [{ productId: product.id, receivedQtyMilli: 0, unitCostCentavos: 4000 }],
  }, sessions.OWNER));

  const after = sequenceService.auditDay('GOODS_RECEIPT');
  assert.equal(after.issued, before.issued, 'a refused delivery consumed no number');
  assert.equal(after.gapless, true);
  assert.equal(sequenceService.auditDay('PURCHASE_ORDER').gapless, true);
});
