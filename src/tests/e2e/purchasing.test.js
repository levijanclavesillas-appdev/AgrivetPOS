'use strict';

// TC-E2E-16 — a delivery, through the endpoints SCR-801 to SCR-804 call.
//
// The walk the task file describes: order fifty sacks, take a delivery of forty-seven
// sound and three split at a higher price than was agreed, have it authorised, and
// find the stock, the cost and the ledger all right afterwards.
//
// Every step goes over HTTP with a real session, because the rules were already proved
// by the integration cases and what this asserts is that a person can reach them —
// including the two refusals, which is the part a screen is most likely to get wrong.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const inventoryService = require('../../services/inventoryService');
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';

// Fifty-kilo sacks. The ledger works in thousandths of the base unit (MON-002), so a
// sack is 50,000 and fifty sacks is 2,500,000.
const SACK_MILLI = 50000;
const ORDERED_SACKS = 50;
const DAMAGED_SACKS = 3;
const ORDERED_COST_CENTAVOS = 3900;   // ₱39.00/kg — ₱1,950 a sack
const CHARGED_COST_CENTAVOS = 4680;   // ₱46.80/kg — ₱2,340 a sack, 20% above

let instance;
let BASE = null;
const tokens = {};
let product;
let supplier;
let order;

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

test.before(async () => {
  temp.openMigrated('purchasing-e2e');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;

  temp.seedStore({ withOwner: false, taxMode: 'NONE' });
  const ref = temp.seedCatalog();

  // The owner, and the clerk who actually unloads the van. The split matters: the
  // clerk holds TX-409 and is not a manager, so AUD-603's distinct actors apply and
  // the authorisation in the middle of this walk is a real one.
  for (const [who, role] of [['boss', 'OWNER'], ['clerk', 'INVENTORY']]) {
    temp.seedUser({ username: who, role, password: PASSWORD });
    tokens[who] = authService.login({ username: who, password: PASSWORD }).token;
  }
  const owner = authService.verifyToken(tokens.boss);

  product = productService.create({
    sku: 'HG-50',
    name: 'Hog Grower Pellets',
    categoryId: ref.category.id,
    baseUnitId: ref.kg.id,
    retailPriceCentavos: 5200,
    minStockMilli: 500000,
  }, owner);

  // Two sacks already on the floor at ₱36.00, so the average has somewhere to move
  // from and the final figure is a weighted one rather than just the delivery's price.
  inventoryService.postStandalone({
    productId: product.id, type: 'OPENING', qtyMilli: 2 * SACK_MILLI,
    unitCostCentavos: 3600, actor: owner,
  });
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

test('TC-E2E-16 · the store registers the mill it buys from', async () => {
  const created = await json(await call('/suppliers', {
    method: 'POST',
    body: { name: 'B-MEG Feeds', code: 'BMEG', contactNo: '09171234567', termsDays: 30 },
  }));
  supplier = created.supplier;
  assert.equal(supplier.terms_label, '30 days');

  // VR-401 — the second spelling of one account is refused before it exists.
  await refusal(
    await call('/suppliers', { method: 'POST', body: { name: 'b-meg feeds' } }),
    { status: 409, ruleId: 'VR-401' }
  );

  const listed = await json(await call('/suppliers?q=b-meg'));
  assert.equal(listed.suppliers.length, 1);
});

test('TC-E2E-16 · fifty sacks are ordered, and nothing has arrived', async () => {
  const draft = await json(await call('/purchase-orders', {
    method: 'POST',
    body: {
      supplierId: supplier.id,
      expectedAt: '2026-09-15',
      lines: [{
        productId: product.id,
        qtyMilli: ORDERED_SACKS * SACK_MILLI,
        unitCostCentavos: ORDERED_COST_CENTAVOS,
      }],
    },
  }));
  assert.equal(draft.purchase_order.status, 'DRAFT');
  assert.equal(draft.purchase_order.total_centavos, 9750000, '₱97,500 — fifty sacks at ₱1,950');

  const sent = await json(await call(`/purchase-orders/${draft.purchase_order.id}/submit`, { method: 'POST' }));
  order = sent.purchase_order;
  assert.equal(order.status, 'PENDING');
  assert.equal(order.can_cancel, true, 'right up until the first sack comes off the van');

  // PO-103 — the whole point. The order exists and the shelf has not moved.
  const stock = await json(await call(`/inventory/${product.id}`));
  assert.equal(stock.on_hand.qty_on_hand_milli, 2 * SACK_MILLI, 'still the two sacks that were there');
});

test('TC-E2E-16 · the delivery is refused because it costs more than was agreed', async () => {
  const detail = await json(await call(`/purchase-orders/${order.id}`));
  const line = detail.purchase_order.lines[0];
  assert.equal(line.outstanding_qty_milli, ORDERED_SACKS * SACK_MILLI);

  // The clerk keys in what the van brought and what the invoice says.
  const refused = await refusal(
    await call('/goods-receipts', {
      who: 'clerk',
      method: 'POST',
      body: {
        poId: order.id,
        supplierDrNo: 'DR-9931',
        lines: [{
          poItemId: line.id,
          receivedQtyMilli: ORDERED_SACKS * SACK_MILLI,
          damagedQtyMilli: DAMAGED_SACKS * SACK_MILLI,
          unitCostCentavos: CHARGED_COST_CENTAVOS,
          damageNote: 'three sacks split in transit',
        }],
      },
    }),
    { status: 403, ruleId: 'PO-205' }
  );

  // 05_TECH_SPEC.md §8.6: a refusal the UI cannot explain is an unfinished refusal.
  // SCR-803 renders the panel from exactly these three fields.
  assert.equal(refused.requires_role, 'MANAGER or OWNER');
  assert.match(refused.message, /20\.0% above the ordered cost of ₱39\.00/);

  // And it posted nothing while it was refusing.
  const stock = await json(await call(`/inventory/${product.id}`));
  assert.equal(stock.on_hand.qty_on_hand_milli, 2 * SACK_MILLI);
});

test('TC-E2E-16 · the owner authorises it and the delivery posts', async () => {
  const detail = await json(await call(`/purchase-orders/${order.id}`));
  const line = detail.purchase_order.lines[0];

  const posted = await json(await call('/goods-receipts', {
    who: 'clerk',
    method: 'POST',
    body: {
      poId: order.id,
      supplierDrNo: 'DR-9931',
      invoiceNo: 'SI-20260915-114',
      // The owner signed in on the inline panel; the server resolves the username
      // against the users table rather than believing anything else in this body.
      approver: { username: 'boss' },
      approvalReason: 'Rang the mill — feed corn is up, the price is right',
      lines: [{
        poItemId: line.id,
        receivedQtyMilli: ORDERED_SACKS * SACK_MILLI,
        damagedQtyMilli: DAMAGED_SACKS * SACK_MILLI,
        unitCostCentavos: CHARGED_COST_CENTAVOS,
        damageNote: 'three sacks split in transit',
      }],
    },
  }));

  const gr = posted.goods_receipt;
  assert.match(gr.gr_no, /^GR-\d{8}-\d{6}$/);
  assert.equal(gr.approved_by, 'boss', 'AUD-603 — two actors, and they are two people');
  assert.equal(gr.has_cost_variance, true, 'flagged on the receipt, not only in the trail');
  assert.equal(gr.is_immutable, true);

  // PO-201's four figures, and PO-202's arithmetic in front of the person who counted.
  const posted_line = gr.lines[0];
  assert.equal(posted_line.ordered_qty_milli, ORDERED_SACKS * SACK_MILLI);
  assert.equal(posted_line.received_qty_milli, ORDERED_SACKS * SACK_MILLI);
  assert.equal(posted_line.damaged_qty_milli, DAMAGED_SACKS * SACK_MILLI);
  assert.equal(posted_line.sound_qty_milli, 47 * SACK_MILLI, 'forty-seven sacks of stock');
  assert.equal(posted_line.cost_variance_bp, 2000);
  assert.equal(posted_line.posted_to_stock, true);

  assert.equal(gr.total_centavos, 47 * SACK_MILLI * CHARGED_COST_CENTAVOS / 1000);
  assert.equal(posted.goods_receipt.po_no, order.po_no);
});

test('TC-E2E-16 · the stock, the cost and the ledger are all right afterwards', async () => {
  // The shelf: two sacks that were there, plus forty-seven sound. Not fifty.
  const stock = await json(await call(`/inventory/${product.id}`));
  assert.equal(stock.on_hand.qty_on_hand_milli, 49 * SACK_MILLI);
  assert.equal(stock.on_hand.qty_on_hand_display, '2450 KG');

  // The ledger: one RECEIPT movement for the sound quantity, carrying the actual cost,
  // and none for the damage.
  const ledger = await json(await call(`/inventory/${product.id}/movements`));
  const receipts = ledger.movements.filter((m) => m.type === 'RECEIPT');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].qty_milli, 47 * SACK_MILLI);
  assert.equal(receipts[0].unit_cost_centavos, CHARGED_COST_CENTAVOS);
  assert.equal(receipts[0].reference.type, 'goods_receipt');
  assert.match(receipts[0].reference.no, /^GR-/);

  // MON-004: (100,000 × 3,600 + 2,350,000 × 4,680) / 2,450,000 = 4,635.9… → 4,636.
  const detail = await json(await call(`/products/${product.id}`));
  assert.equal(detail.product.avg_cost_centavos, 4636, 'PO-203 — moved at the ₱46.80 charged');

  // INV-101, asked rather than assumed.
  assert.equal(inventoryService.reconcile().ok, true);

  // The order closed itself, and the delivery is on it.
  const closed = await json(await call(`/purchase-orders/${order.id}`));
  assert.equal(closed.purchase_order.status, 'RECEIVED');
  assert.equal(closed.purchase_order.can_cancel, false, 'PO-105');
  assert.equal(closed.purchase_order.receipts.length, 1);
  assert.equal(closed.purchase_order.lines[0].outstanding_qty_milli, 0);

  // PO-206: and there is no way back into it.
  await refusal(
    await call(`/goods-receipts/${closed.purchase_order.receipts[0].id}`, { method: 'PUT', body: {} }),
    { status: 409, ruleId: 'PO-206' }
  );

  // The store's own record of what the mill charged, which is what the next order will
  // be checked against.
  const history = await json(await call(`/products/${product.id}/purchase-history`));
  assert.equal(history.receipts.length, 1);
  assert.equal(history.receipts[0].unit_cost_centavos, CHARGED_COST_CENTAVOS);
  assert.equal(history.receipts[0].supplier_name, 'B-MEG Feeds');
});

test('TC-E2E-16 · the three split sacks are a number the store can take to the mill', async () => {
  const deliveries = await json(await call(`/goods-receipts?supplierId=${supplier.id}`));
  assert.equal(deliveries.goods_receipts.length, 1);

  const gr = await json(await call(`/goods-receipts/${deliveries.goods_receipts[0].id}`));
  const line = gr.goods_receipt.lines[0];
  assert.equal(line.damaged_display, '150 KG');
  assert.equal(line.damage_note, 'three sacks split in transit');

  // PO-202: recorded against the supplier, and it never became stock. The remedy is a
  // supplier return (TASK-020), which is why the figure is kept rather than netted off.
  assert.equal(
    line.received_qty_milli - line.damaged_qty_milli, line.sound_qty_milli,
    'the damaged quantity is part of what arrived, not extra to it'
  );

  // The flagged-deliveries filter SCR-801 offers, so an exception is findable later
  // rather than only visible on the day.
  const flagged = await json(await call('/goods-receipts?flaggedOnly=true'));
  assert.equal(flagged.goods_receipts.length, 1);
  assert.equal(flagged.goods_receipts[0].has_cost_variance, true);
});
