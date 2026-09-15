'use strict';

// TASK-066 — a café or restaurant: made to order (INV-114), orders before payment
// (POS-109), the kitchen ticket (POS-110), a line's note (POS-111) and the dine-in
// service charge (POS-112).
//
// One café, through the API the counter uses, with its receipt printer set to the
// browser so every ticket and receipt comes back as text a test can read:
//
//   1. Set up as a café, it starts a café's defaults: orders on, tickets on the receipt
//      printer, the 20% on, a new product made to order.
//   2. A made-to-order meal sells with no stock and moves none; nothing can receive,
//      count or adjust it; a product with stock cannot become one.
//   3. Table 4 orders. The kitchen gets the order; then only what changed.
//   4. Table 4 pays, with a bottled water added at the counter: a sale under the store's
//      number with the order's table, the 10% charge, the water's stock moved and the
//      meal's not, and the kitchen told about the water.
//   5. A take-out paid at once gets a number of its own and a full ticket.
//   6. An order called off needs a reason, is audited, and tells the kitchen to stop.
//   7. A shift closes with an order still open, which the next shift is paid for.
//   8. The daily report still adds up, with the service charge a term of its own.
//   9. A shop does not take orders, and a void or a return of a meal moves no stock.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const server = require('../../server');
const authService = require('../../services/authService');
const settingsService = require('../../services/settingsService');
const setupService = require('../../services/setupService');
const productService = require('../../services/productService');
const inventoryService = require('../../services/inventoryService');
const pricingService = require('../../services/pricingService');
const referenceService = require('../../services/referenceService');
const auditRepository = require('../../repositories/auditRepository');
const inventoryRepository = require('../../repositories/inventoryRepository');
const syncTables = require('../../config/syncTables');
const temp = require('../helpers/tempdb');

const OWNER = { username: 'kape', password: 'kape-password-26', fullName: 'Kape Owner' };
const CASHIER = { username: 'jolina', password: 'jolina-password-26' };
let instance;
let BASE;
const tokens = {};
const ref = {};

const call = async (p, { token = tokens.owner, method = 'GET', body = null } = {}) => {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-cafe-backups-'));

test.before(async () => {
  temp.openEmpty('cafe');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;
  setupService.complete({
    industry: 'CAFE',
    store: { storeName: 'Kape sa Kanto' },
    taxMode: 'NONE',
    owner: OWNER,
    backupFolder: backups,
    acknowledgedRecoveryCode: true,
  });
  tokens.owner = authService.login({ username: OWNER.username, password: OWNER.password }).token;
  const owner = authService.verifyToken(tokens.owner);
  ref.owner = owner;
  temp.seedUser({ username: CASHIER.username, role: 'CASHIER', password: CASHIER.password });
  tokens.cashier = authService.login(CASHIER).token;

  // The receipt printer is the browser's print dialog, so every document comes back as text.
  settingsService.set('printer_transport', 'BROWSER', owner);
  ref.meals = referenceService.create('categories', { name: 'Rice Bowls' }, owner);
  ref.drinks = referenceService.create('categories', { name: 'Drinks' }, owner);
  ref.srv = referenceService.create('units', { code: 'SRV', name: 'Serving' }, owner);
  ref.bot = referenceService.create('units', { code: 'BOT', name: 'Bottle' }, owner);
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
  fs.rmSync(backups, { recursive: true, force: true });
});

// ── 1. The store type ───────────────────────────────────────────────────────

test('TASK-066: a café starts with a café\'s defaults', () => {
  const status = setupService.status();
  assert.equal(status.industry.code, 'CAFE');
  assert.equal(status.industry.display_name, 'Chachi POS (Café / Restaurant)');
  assert.deepEqual(status.industry.product_defaults, { isBatchTracked: false, statutoryDiscountEligible: true, isStocked: false });
  assert.equal(settingsService.get('open_orders_enabled'), true, 'POS-109');
  assert.equal(settingsService.get('kitchen_printer'), 'RECEIPT', 'POS-110');
  assert.equal(settingsService.get('statutory_discount_enabled'), true, 'RA 9994 covers restaurant meals');
  assert.equal(settingsService.get('service_charge_bp'), 0, 'a service charge is the owner\'s decision');
  assert.ok(settingsService.get('return_reasons').includes('Wrong order served'));
});

// ── 2. Made to order (INV-114) ──────────────────────────────────────────────

test('INV-114: a made-to-order product is created without stock, and nothing can treat it as stock', async () => {
  const create = (body) => call('/products', { method: 'POST', body });
  const bibimbap = await create({ sku: 'BIBIMBAP', name: 'Bibimbap', categoryId: ref.meals.id, baseUnitId: ref.srv.id, retailPriceCentavos: 11500, isStocked: false });
  assert.equal(bibimbap.status, 201, JSON.stringify(bibimbap.body));
  assert.equal(bibimbap.body.product.is_stocked, false);
  ref.bibimbap = bibimbap.body.product;
  ref.latte = (await create({ sku: 'LATTE', name: 'Iced Latte', categoryId: ref.drinks.id, baseUnitId: ref.srv.id, retailPriceCentavos: 8900, isStocked: false })).body.product;
  ref.water = (await create({ sku: 'WATER', name: 'Bottled Water', categoryId: ref.drinks.id, baseUnitId: ref.bot.id, retailPriceCentavos: 2500 })).body.product;
  assert.equal(ref.water.is_stocked, true, 'stocked unless said otherwise');
  inventoryService.postStandalone({ productId: ref.water.id, type: 'OPENING', qtyMilli: 24000, unitCostCentavos: 1200, actor: ref.owner });

  // It cannot also be batch-tracked, or have a minimum.
  const batched = await create({ sku: 'SOUP', name: 'Soup', categoryId: ref.meals.id, baseUnitId: ref.srv.id, retailPriceCentavos: 6000, isStocked: false, isBatchTracked: true });
  assert.equal(batched.status, 400);
  assert.equal(batched.body.error.rule_id, 'INV-114');

  // Nothing receives, adjusts or counts it.
  assert.throws(() => inventoryService.postStandalone({ productId: ref.bibimbap.id, type: 'OPENING', qtyMilli: 5000, unitCostCentavos: 100, actor: ref.owner }),
    (err) => err.ruleId === 'INV-114' && /made to order/.test(err.message));
  const supplier = (await call('/suppliers', { method: 'POST', body: { name: 'Mindanao Food Supply' } })).body.supplier;
  const po = await call('/purchase-orders', { method: 'POST', body: { supplierId: supplier.id, lines: [{ productId: ref.bibimbap.id, qtyMilli: 1000, unitCostCentavos: 100 }] } });
  assert.equal(po.status, 409);
  assert.equal(po.body.error.rule_id, 'INV-114');

  // A product with stock on the shelf cannot become made to order.
  const refused = await call(`/products/${ref.water.id}`, { method: 'PUT', body: { isStocked: false } });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error.message, /24 BOT on hand/);

  // And the counter sees it has no stock to show.
  assert.equal((await call(`/inventory/${ref.bibimbap.id}`)).body.on_hand.is_stocked, false);
});

// ── 3. The order and the kitchen (POS-109, POS-110, POS-111) ────────────────

test('POS-109/110/111: table 4\'s order goes to the kitchen, and then only what changed', async () => {
  assert.equal((await call('/shifts/open', { token: tokens.cashier, method: 'POST', body: { openingFloatCentavos: 100000, confirmed: true } })).status, 201);

  const refusedType = await call('/open-orders', { token: tokens.cashier, method: 'POST', body: { lines: [{ productId: ref.bibimbap.id, qtyMilli: 1000 }] } });
  assert.equal(refusedType.status, 400, 'how it is served is asked for');

  const sent = await call('/open-orders', {
    token: tokens.cashier, method: 'POST',
    body: {
      orderType: 'DINE_IN', tableLabel: 'Table 4',
      lines: [
        { productId: ref.bibimbap.id, qtyMilli: 2000 },
        { productId: ref.latte.id, qtyMilli: 1000, note: 'less ice, or no ice' },
      ],
    },
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  ref.order = sent.body.order;
  assert.equal(ref.order.order_no, 1);
  assert.equal(ref.order.table_label, 'Table 4');
  assert.equal(ref.order.total_centavos, 2 * 11500 + 8900);
  assert.equal(sent.body.printed.transport, 'BROWSER');
  const ticket = sent.body.printed.text;
  assert.match(ticket, /KITCHEN/);
  assert.match(ticket, /ORDER 1/);
  assert.match(ticket, /Dine-in · Table 4/);
  assert.match(ticket, /2 x Bibimbap/);
  assert.match(ticket, /1 x Iced Latte\n\s+less ice, o-r no ice/, 'the note under its line, made safe for TAX-006');
  assert.doesNotMatch(ticket, /115\.00|230\.00/, 'no prices on a kitchen ticket');
  assert.match(ticket, /This is not an official receipt/);

  const listed = (await call('/open-orders', { token: tokens.cashier })).body.orders;
  assert.deepEqual(listed.map((o) => [o.order_no, o.table_label, o.unsent_changes]), [[1, 'Table 4', false]]);

  // One bibimbap fewer, another latte the same way.
  const changed = await call(`/open-orders/${ref.order.id}`, {
    token: tokens.cashier, method: 'PUT',
    body: {
      orderType: 'DINE_IN', tableLabel: 'Table 4',
      lines: [
        { productId: ref.bibimbap.id, qtyMilli: 1000 },
        { productId: ref.latte.id, qtyMilli: 2000, note: 'less ice, or no ice' },
      ],
    },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.changes, 2);
  const changes = changed.body.printed.text;
  assert.match(changes, /KITCHEN - CHANGES/);
  assert.match(changes, /- 1 x Bibimbap/);
  assert.match(changes, /\+ 1 x Iced Latte/);
  assert.doesNotMatch(changes, /2 x Bibimbap/, 'what the kitchen already has is not sent again');

  // Sending it again unchanged prints nothing.
  const same = await call(`/open-orders/${ref.order.id}`, {
    token: tokens.cashier, method: 'PUT',
    body: { orderType: 'DINE_IN', tableLabel: 'Table 4', lines: [{ productId: ref.bibimbap.id, qtyMilli: 1000 }, { productId: ref.latte.id, qtyMilli: 2000, note: 'less ice, or no ice' }] },
  });
  assert.equal(same.body.changes, 0);
  assert.equal(same.body.printed, null);
});

// ── 4. Paying (POS-109, POS-112) ────────────────────────────────────────────

test('POS-112: table 4 pays with the 10% dine-in charge, and the kitchen hears about the water', async () => {
  settingsService.set('service_charge_bp', 1000, ref.owner);

  const lines = [
    { productId: ref.bibimbap.id, qtyMilli: 1000 },
    { productId: ref.latte.id, qtyMilli: 2000, note: 'less ice, or no ice' },
    { productId: ref.water.id, qtyMilli: 1000 },
  ];
  const preview = await call('/sales/price-check', { token: tokens.cashier, method: 'POST', body: { lines, orderType: 'DINE_IN' } });
  const itemsTotal = 11500 + 2 * 8900 + 2500;
  assert.equal(preview.body.service_charge_bp, 1000);
  assert.equal(preview.body.service_charge_centavos, Math.round(itemsTotal / 10));
  assert.equal(preview.body.total_centavos, itemsTotal + Math.round(itemsTotal / 10));
  const takeOut = await call('/sales/price-check', { token: tokens.cashier, method: 'POST', body: { lines, orderType: 'TAKE_OUT' } });
  assert.equal(takeOut.body.service_charge_centavos, 0, 'dine-in only');

  const total = preview.body.total_centavos;
  const sold = await call('/sales', {
    token: tokens.cashier, method: 'POST',
    body: { openOrderId: ref.order.id, lines, tenders: [{ method: 'CASH', amountCentavos: 100000 }], clientTotalCentavos: total },
  });
  assert.equal(sold.status, 201, JSON.stringify(sold.body));
  const sale = sold.body.sale;
  assert.match(sale.sale_no, /^SALE-\d{8}-000001$/, 'a sale under the store\'s own number (POS-108)');
  assert.deepEqual([sale.order_type, sale.table_label, sale.order_no], ['DINE_IN', 'Table 4', 1]);
  assert.equal(sale.service_charge_centavos, 3180);
  assert.equal(sale.total_centavos, itemsTotal + 3180);
  assert.equal(sold.body.items.find((i) => i.name === 'Iced Latte').note, 'less ice, or no ice');

  const receipt = sold.body.printed.text;
  assert.match(receipt, /Order 1 · Dine-in · Table 4/);
  assert.match(receipt, /less ice, o-r no ice/);
  assert.match(receipt, /Service charge 10%\s+31\.80/);
  assert.match(receipt, /TOTAL\s+349\.80/);

  // The meal moved no stock; the water did.
  assert.equal(inventoryRepository.qtyOnHand(ref.bibimbap.id), 0);
  assert.equal(inventoryRepository.movementsForReference('sale', sale.id).map((m) => m.product_id).join(), ref.water.id);
  assert.equal(inventoryRepository.qtyOnHand(ref.water.id), 23000);

  // The kitchen hears only what it had not: the water.
  const kitchen = sold.body.kitchen.printed.text;
  assert.match(kitchen, /KITCHEN - CHANGES/);
  assert.match(kitchen, /\+ 1 x Bottled Water/);
  assert.doesNotMatch(kitchen, /Bibimbap|Latte/);

  // Paid is paid.
  assert.deepEqual((await call('/open-orders', { token: tokens.cashier })).body.orders, []);
  const again = await call('/sales', { token: tokens.cashier, method: 'POST', body: { openOrderId: ref.order.id, lines, tenders: [{ method: 'CASH', amountCentavos: 100000 }] } });
  assert.equal(again.status, 409);
  assert.match(again.body.error.message, /Order 1 has already been paid/);
});

test('POS-109: a take-out paid at once gets a number of its own, and the whole order goes to the kitchen', async () => {
  const sold = await call('/sales', {
    token: tokens.cashier, method: 'POST',
    body: { orderType: 'TAKE_OUT', tableLabel: 'Ana', lines: [{ productId: ref.bibimbap.id, qtyMilli: 1000, note: 'no egg' }], tenders: [{ method: 'CASH', amountCentavos: 11500 }] },
  });
  assert.equal(sold.status, 201, JSON.stringify(sold.body));
  assert.deepEqual([sold.body.sale.order_no, sold.body.sale.order_type, sold.body.sale.service_charge_centavos], [2, 'TAKE_OUT', 0]);
  const kitchen = sold.body.kitchen.printed.text;
  assert.match(kitchen, /^\s*KITCHEN\n/);
  assert.match(kitchen, /ORDER 2/);
  assert.match(kitchen, /Take-out · Ana/);
  assert.match(kitchen, /1 x Bibimbap\n\s+no egg/);
});

// ── 6. Calling one off ──────────────────────────────────────────────────────

test('POS-109: an order called off needs a reason, is audited, and tells the kitchen to stop', async () => {
  const sent = await call('/open-orders', {
    token: tokens.cashier, method: 'POST',
    body: { orderType: 'DINE_IN', tableLabel: 'Table 7', lines: [{ productId: ref.latte.id, qtyMilli: 3000 }] },
  });
  const id = sent.body.order.id;
  assert.equal(sent.body.order.order_no, 3);

  const noReason = await call(`/open-orders/${id}/cancel`, { token: tokens.cashier, method: 'POST', body: {} });
  assert.equal(noReason.status, 400);

  const cancelled = await call(`/open-orders/${id}/cancel`, { token: tokens.cashier, method: 'POST', body: { reason: 'Customer left before it was served' } });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.order.status, 'VOIDED');
  assert.match(cancelled.body.printed.text, /KITCHEN - ORDER CANCELLED/);
  assert.match(cancelled.body.printed.text, /- 3 x Iced Latte/);

  const rows = auditRepository.list({ action: 'OPEN_ORDER_VOIDED', limit: 5 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'Customer left before it was served');

  const paying = await call('/sales', { token: tokens.cashier, method: 'POST', body: { openOrderId: id, lines: [{ productId: ref.latte.id, qtyMilli: 3000 }], tenders: [{ method: 'CASH', amountCentavos: 50000 }] } });
  assert.equal(paying.status, 409, 'a cancelled order is not paid for');
});

// ── 7. The shift closes with an order open ──────────────────────────────────

test('POS-109: a shift closes with an order still being eaten, and the next shift is paid for it', async () => {
  const sent = await call('/open-orders', {
    token: tokens.cashier, method: 'POST',
    body: { orderType: 'DINE_IN', tableLabel: 'Table 2', lines: [{ productId: ref.bibimbap.id, qtyMilli: 1000 }] },
  });
  const id = sent.body.order.id;

  const current = (await call('/shifts/current', { token: tokens.cashier })).body;
  assert.equal(current.open_orders.count, 1);
  const cash = current.expected.expected_cash_centavos;
  const closed = await call(`/shifts/${current.shift.id}/close`, {
    token: tokens.cashier, method: 'POST', body: { actualCashCentavos: cash, actualByMethod: {} },
  });
  assert.equal(closed.status, 201, JSON.stringify(closed.body));
  assert.deepEqual(closed.body.open_orders.orders.map((o) => [o.order_no, o.table_label]), [[4, 'Table 2']]);

  // The owner opens the next shift and table 2 pays.
  assert.equal((await call('/shifts/open', { method: 'POST', body: { openingFloatCentavos: 50000, confirmed: true } })).status, 201);
  const listed = (await call('/open-orders')).body.orders;
  assert.deepEqual(listed.map((o) => o.order_no), [4], 'still open on the next shift');
  const paid = await call('/sales', {
    method: 'POST',
    body: { openOrderId: id, lines: [{ productId: ref.bibimbap.id, qtyMilli: 1000 }], tenders: [{ method: 'CASH', amountCentavos: 20000 }] },
  });
  assert.equal(paid.status, 201, JSON.stringify(paid.body));
  assert.equal(paid.body.sale.service_charge_centavos, 1150);
  assert.equal(paid.body.kitchen.printed, null, 'nothing new for the kitchen');
});

// ── 8. The report ───────────────────────────────────────────────────────────

test('POS-112: the daily report adds up, with the service charge a term of its own', async () => {
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const daily = (await call(`/reports/daily?from=${today}&to=${today}`)).body;
  assert.equal(daily.totals.service_charge_centavos, 3180 + 1150);
  assert.equal(daily.reconciliation.balances, true, daily.reconciliation.statement);
  assert.equal(daily.reconciliation.reconciles, true);
  assert.match(daily.reconciliation.statement, /\+ ₱43\.30 service charge/);
});

test('POS-112: in VAT mode the service charge carries VAT like the meal it is charged on', () => {
  const priced = pricingService.priceCart({
    lines: [{ productId: ref.bibimbap.id, qtyMilli: 1000 }], taxMode: 'VAT', serviceChargeBp: 1000,
  });
  assert.equal(priced.service_charge_centavos, 1150);
  assert.equal(priced.total_centavos, 12650);
  // 115.00 and 11.50 are each VAT-inclusive: 102.68 + 10.27 VATable, 12.32 + 1.23 VAT.
  assert.equal(priced.tax_summary.vatable_sales_centavos, 10268 + 1027);
  assert.equal(priced.tax_amount_centavos, 1232 + 123);
  assert.equal(priced.service_charge_vat_centavos, 123);
});

// ── 9. The rest of the counter ──────────────────────────────────────────────

test('INV-114: voiding a meal moves no stock, and its return puts nothing on a shelf', async () => {
  const sold = await call('/sales', { method: 'POST', body: { orderType: 'TAKE_OUT', lines: [{ productId: ref.bibimbap.id, qtyMilli: 1000 }, { productId: ref.water.id, qtyMilli: 2000 }], tenders: [{ method: 'CASH', amountCentavos: 20000 }] } });
  assert.equal(sold.status, 201, JSON.stringify(sold.body));
  const water = inventoryRepository.qtyOnHand(ref.water.id);
  const voided = await call(`/sales/${sold.body.sale.id}/void`, { method: 'POST', body: { reason: 'Rung up on the wrong order' } });
  assert.equal(voided.status, 201, JSON.stringify(voided.body));
  assert.equal(inventoryRepository.qtyOnHand(ref.water.id), water + 2000, 'the water goes back');
  assert.equal(inventoryRepository.movementsForReference('sale_void', sold.body.sale.id).length, 1, 'and only the water');

  const again = await call('/sales', { method: 'POST', body: { orderType: 'TAKE_OUT', lines: [{ productId: ref.latte.id, qtyMilli: 1000 }], tenders: [{ method: 'CASH', amountCentavos: 8900 }] } });
  const returnable = (await call(`/sales/${again.body.sale.id}/returnable`)).body;
  const line = returnable.lines[0];
  const returned = await call(`/sales/${again.body.sale.id}/returns`, {
    method: 'POST',
    body: { reason: 'Wrong order served', lines: [{ saleItemId: line.sale_item_id, qtyMilli: 1000, disposition: 'WRITE_OFF' }] },
  });
  assert.equal(returned.status, 201, JSON.stringify(returned.body));
  assert.equal(inventoryRepository.movementsForReference('sale_return', returned.body.sale_return.id).length, 0);
});

test('POS-109: a shop does not take orders before payment; open orders and the kitchen printer stay on this counter', async () => {
  settingsService.set('open_orders_enabled', false, ref.owner);
  const refused = await call('/open-orders', { method: 'POST', body: { orderType: 'DINE_IN', lines: [{ productId: ref.bibimbap.id, qtyMilli: 1000 }] } });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.rule_id, 'POS-109');
  const sold = await call('/sales', { method: 'POST', body: { lines: [{ productId: ref.water.id, qtyMilli: 1000 }], tenders: [{ method: 'CASH', amountCentavos: 2500 }] } });
  assert.equal(sold.status, 201);
  assert.deepEqual([sold.body.sale.order_type, sold.body.sale.order_no, sold.body.sale.service_charge_centavos], [null, null, 0], 'a shop\'s sale, as before');
  settingsService.set('open_orders_enabled', true, ref.owner);

  assert.ok(syncTables.LOCAL_TABLES.includes('open_orders'));
  for (const key of ['kitchen_printer', 'kitchen_printer_host', 'kitchen_printer_port']) assert.ok(syncTables.LOCAL_SETTINGS.includes(key), key);
});

test('INV-114: a made-to-order product is never low on stock, and takes no minimum', () => {
  productService.update(ref.water.id, { minStockMilli: 50000 }, ref.owner);
  assert.deepEqual(inventoryService.lowStock().products.map((p) => p.sku), ['WATER']);
  assert.throws(() => productService.update(ref.latte.id, { minStockMilli: 1000 }, ref.owner),
    (err) => err.ruleId === 'INV-114');
});
