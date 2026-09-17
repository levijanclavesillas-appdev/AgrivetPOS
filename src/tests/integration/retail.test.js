'use strict';

// TASK-070 — a sari-sari store: the wholesale switch (PR-107), a pack's own price (PR-108),
// quick keys (POS-113), a unit's selling step, and utang customers added at the counter.
//
// One store, set up through the real service, then a morning through the API the counter
// uses:
//
//   1. Set up as *Sari-sari & wholesale*, it starts that type's defaults.
//   2. A box of 30 coffee sachets sells at the box's price, not 30 × the sachet's, and
//      stock falls by 30. A strip with no price of its own sells at 10 × the sachet.
//   3. A walk-in switched to wholesale pays the box's wholesale price; a product with no
//      wholesale price falls back to retail, and says so. A store without the switch
//      refuses it.
//   4. A pack price below cost needs a manager (PR-105).
//   5. Quick keys are arranged, listed and suggested.
//   6. Aling Nena, added at the counter, buys on credit; over her limit, it needs approval.
//   7. A void of a box puts 30 sachets back, and the day's report adds up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const server = require('../../server');
const authService = require('../../services/authService');
const settingsService = require('../../services/settingsService');
const setupService = require('../../services/setupService');
const inventoryService = require('../../services/inventoryService');
const referenceService = require('../../services/referenceService');
const dataRepository = require('../../repositories/dataRepository');
const inventoryRepository = require('../../repositories/inventoryRepository');
const auditRepository = require('../../repositories/auditRepository');
const temp = require('../helpers/tempdb');

const OWNER = { username: 'aling', password: 'sari-sari-password', fullName: 'Aling Rosa' };
const CASHIER = { username: 'bunso', password: 'bunso-password-26' };
let instance;
let BASE;
const tokens = {};
const ref = {};

const call = async (p, { token = tokens.cashier, method = 'GET', body = null } = {}) => {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const priceCheck = (body) => call('/sales/price-check', { method: 'POST', body });
const sell = async (body, token = tokens.cashier) => {
  const preview = await priceCheck(body);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const tenders = body.tenders || [{ method: 'CASH', amountCentavos: preview.body.total_centavos }];
  return call('/sales', { token, method: 'POST', body: { ...body, tenders, clientTotalCentavos: preview.body.total_centavos } });
};

const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-retail-backups-'));

test.before(async () => {
  temp.openEmpty('retail');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;
  setupService.complete({
    industry: 'RETAIL',
    store: { storeName: 'Rosa Sari-Sari Store' },
    taxMode: 'NONE',
    owner: OWNER,
    backupFolder: backups,
    acknowledgedRecoveryCode: true,
  });
  tokens.owner = authService.login({ username: OWNER.username, password: OWNER.password }).token;
  ref.owner = authService.verifyToken(tokens.owner);
  temp.seedUser({ username: CASHIER.username, role: 'CASHIER', password: CASHIER.password });
  tokens.cashier = authService.login(CASHIER).token;

  ref.coffee = referenceService.create('categories', { name: 'Coffee' }, ref.owner);
  ref.rice = referenceService.create('categories', { name: 'Rice' }, ref.owner);
  ref.pc = referenceService.create('units', { code: 'PC', name: 'Piece' }, ref.owner);
  ref.box = referenceService.create('units', { code: 'BOX', name: 'Box' }, ref.owner);
  ref.strip = referenceService.create('units', { code: 'STRIP', name: 'Strip' }, ref.owner);
  ref.kg = referenceService.create('units', { code: 'KG', name: 'Kilo', allowsFraction: true, stepMilli: 250 }, ref.owner);
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
  fs.rmSync(backups, { recursive: true, force: true });
});

// ── 1. The store type ───────────────────────────────────────────────────────

test('TASK-070: a sari-sari store starts with its own defaults', () => {
  const status = setupService.status();
  assert.equal(status.industry.code, 'RETAIL');
  assert.equal(status.industry.display_name, 'Chachi POS (Sari-sari & wholesale)');
  assert.deepEqual(status.industry.product_defaults, { isBatchTracked: false, statutoryDiscountEligible: false });
  assert.equal(settingsService.get('statutory_discount_enabled'), false, 'the grocery benefit is a separate 5%');
  assert.equal(settingsService.get('wholesale_switch_enabled'), true, 'PR-107');
  assert.equal(settingsService.get('quick_keys_enabled'), true, 'POS-113');
  assert.equal(settingsService.get('counter_customer_credit_limit_centavos'), 50000);
  assert.equal(settingsService.get('counter_customer_terms_days'), 15);
  assert.ok(settingsService.get('return_reasons').includes('Damaged or dented'));
  assert.equal(ref.kg.step_milli, 250, 'a unit\'s selling step');
  assert.throws(() => referenceService.create('units', { code: 'CASE', name: 'Case', stepMilli: 500 }, ref.owner),
    /Only a unit that can be sold in part/);
});

// ── 2. A pack's own price (PR-108) ──────────────────────────────────────────

test('PR-108: a box sells at its own price, a strip without one at its contents, and stock moves in sachets', async () => {
  const created = await call('/products', {
    token: tokens.owner, method: 'POST',
    body: {
      sku: 'COFFEE-3IN1', name: '3-in-1 coffee sachet', categoryId: ref.coffee.id, baseUnitId: ref.pc.id,
      retailPriceCentavos: 700, avgCostCentavos: 540,
      packs: [{ unitId: ref.box.id, factorMilli: 30000 }, { unitId: ref.strip.id, factorMilli: 10000 }],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ref.sachet = created.body.product;
  inventoryService.postStandalone({ productId: ref.sachet.id, type: 'OPENING', qtyMilli: 300000, unitCostCentavos: 540, actor: ref.owner });
  const boxPack = (await call(`/products/${ref.sachet.id}`, { token: tokens.owner })).body.product.packs.find((p) => p.unit.code === 'BOX');
  ref.boxPackId = boxPack.id;
  assert.deepEqual(boxPack.prices, { RETAIL: null, WHOLESALE: null, DEALER: null });

  // A cashier may not set prices (TX-411); the owner may.
  assert.equal((await call(`/products/${ref.sachet.id}/packs/${ref.boxPackId}/prices`, { method: 'PUT', body: { RETAIL: 18000 } })).status, 403);
  const priced = await call(`/products/${ref.sachet.id}/packs/${ref.boxPackId}/prices`, { token: tokens.owner, method: 'PUT', body: { RETAIL: 18000, WHOLESALE: 17000 } });
  assert.equal(priced.status, 200, JSON.stringify(priced.body));
  assert.deepEqual(priced.body.product.packs.find((p) => p.unit.code === 'BOX').prices, { RETAIL: 18000, WHOLESALE: 17000, DEALER: null });
  assert.equal(auditRepository.list({ action: 'PRICE_CHANGED', limit: 50 }).filter((r) => /BOX/.test(r.after_value)).length, 2);

  await call('/shifts/open', { method: 'POST', body: { openingFloatCentavos: 50000, confirmed: true } });
  const lines = [
    { productId: ref.sachet.id, qtyMilli: 1000, packUnitId: ref.box.id },
    { productId: ref.sachet.id, qtyMilli: 1000, packUnitId: ref.strip.id },
  ];
  const preview = await priceCheck({ lines });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const [box, strip] = preview.body.lines;
  assert.deepEqual(
    { price: box.unit_price_centavos, perPack: box.priced_per_pack, gross: box.gross_centavos, rule: box.price_rule_id },
    { price: 18000, perPack: true, gross: 18000, rule: 'PR-108' },
    'the box\'s own ₱180, not 30 × ₱7 = ₱210',
  );
  assert.deepEqual(
    { price: strip.unit_price_centavos, perPack: strip.priced_per_pack, gross: strip.gross_centavos },
    { price: 700, perPack: false, gross: 7000 },
    'a strip with no price of its own is 10 × ₱7',
  );

  const before = inventoryRepository.qtyOnHand(ref.sachet.id);
  const sold = await sell({ lines });
  assert.equal(sold.status, 201, JSON.stringify(sold.body));
  assert.equal(sold.body.sale.total_centavos, 25000);
  assert.equal(before - inventoryRepository.qtyOnHand(ref.sachet.id), 40000, '30 + 10 sachets');
  ref.boxSale = sold.body.sale;

  // The sale reads back, and prints, as 1 BOX × 180.00 = 180.00.
  const read = await call(`/sales/${sold.body.sale.id}`);
  const item = read.body.items[0];
  assert.equal(item.gross_centavos, 18000);
  assert.match(item.qty_display, /^1 BOX/);
  assert.equal(dataRepository.rowsOf('sale_items').find((r) => r.sale_id === sold.body.sale.id && r.line_no === 1).priced_per_pack, 1);

  // Cleared, the box goes back to its contents × the sachet.
  await call(`/products/${ref.sachet.id}/packs/${ref.boxPackId}/prices`, { token: tokens.owner, method: 'PUT', body: { RETAIL: null } });
  assert.equal((await priceCheck({ lines: [lines[0]] })).body.lines[0].gross_centavos, 21000);
  await call(`/products/${ref.sachet.id}/packs/${ref.boxPackId}/prices`, { token: tokens.owner, method: 'PUT', body: { RETAIL: 18000 } });
});

// ── 3. The wholesale switch (PR-107) ────────────────────────────────────────

test('PR-107: a walk-in switched to wholesale pays wholesale, falls back to retail where there is none, and says so', async () => {
  const rice = await call('/products', {
    token: tokens.owner, method: 'POST',
    body: { sku: 'RICE-KG', name: 'Well-milled rice', categoryId: ref.rice.id, baseUnitId: ref.kg.id, retailPriceCentavos: 5200 },
  });
  ref.riceProduct = rice.body.product;
  inventoryService.postStandalone({ productId: ref.riceProduct.id, type: 'OPENING', qtyMilli: 50000, unitCostCentavos: 4500, actor: ref.owner });

  const lines = [
    { productId: ref.sachet.id, qtyMilli: 1000, packUnitId: ref.box.id },
    { productId: ref.riceProduct.id, qtyMilli: 2000 },
  ];
  const wholesale = await priceCheck({ lines, priceLevel: 'WHOLESALE' });
  assert.equal(wholesale.status, 200, JSON.stringify(wholesale.body));
  assert.equal(wholesale.body.customer_price_level, 'WHOLESALE');
  assert.equal(wholesale.body.price_level_from_switch, true);
  const [box, riceLine] = wholesale.body.lines;
  assert.deepEqual({ price: box.unit_price_centavos, level: box.price_level }, { price: 17000, level: 'WHOLESALE' });
  assert.deepEqual({ price: riceLine.unit_price_centavos, fellThrough: riceLine.price_fell_through }, { price: 5200, fellThrough: true },
    'no wholesale price for rice: retail, marked');

  const sold = await sell({ lines, priceLevel: 'WHOLESALE' });
  assert.equal(sold.status, 201, JSON.stringify(sold.body));
  assert.equal(sold.body.sale.total_centavos, 17000 + 10400);
  assert.equal(sold.body.sale.price_level, 'WHOLESALE', 'recorded on the sale');

  // A parked cart keeps the switch.
  const saved = await call('/carts/active', { method: 'PUT', body: { lines, priceLevel: 'WHOLESALE' } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const back = await call('/carts/active');
  assert.equal(back.body.cart.price_level, 'WHOLESALE');
  assert.equal(back.body.cart.priced.lines[0].unit_price_centavos, 17000);
  await call('/carts/active', { method: 'PUT', body: { lines: [] } });

  // Dealer is an account's only, and a store without the switch refuses it.
  assert.equal((await priceCheck({ lines, priceLevel: 'DEALER' })).status, 400);
  settingsService.set('wholesale_switch_enabled', false, ref.owner);
  try {
    const refused = await priceCheck({ lines, priceLevel: 'WHOLESALE' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.rule_id, 'PR-107');
  } finally {
    settingsService.set('wholesale_switch_enabled', true, ref.owner);
  }
});

// ── 4. Below cost (PR-105) ──────────────────────────────────────────────────

test('PR-105: a box priced below what 30 sachets cost needs a manager', async () => {
  await call(`/products/${ref.sachet.id}/packs/${ref.boxPackId}/prices`, { token: tokens.owner, method: 'PUT', body: { RETAIL: 15000 } });
  try {
    const preview = await priceCheck({ lines: [{ productId: ref.sachet.id, qtyMilli: 1000, packUnitId: ref.box.id }] });
    assert.equal(preview.body.requires_authorisation, true, '₱150 is below 30 × ₱5.40 = ₱162');
    assert.equal(preview.body.authorisations[0].rule_id, 'PR-105');
  } finally {
    await call(`/products/${ref.sachet.id}/packs/${ref.boxPackId}/prices`, { token: tokens.owner, method: 'PUT', body: { RETAIL: 18000 } });
  }
});

// ── 5. Quick keys (POS-113) ─────────────────────────────────────────────────

test('POS-113: quick keys are suggested, arranged by whoever edits the catalogue, and listed at the counter', async () => {
  const ice = await call('/products', {
    token: tokens.owner, method: 'POST',
    body: { sku: 'ICE', name: 'Ice tube', categoryId: ref.rice.id, baseUnitId: ref.pc.id, retailPriceCentavos: 500 },
  });
  ref.ice = ice.body.product;

  assert.equal((await call('/quick-keys/suggest', { method: 'POST' })).status, 403, 'a cashier does not arrange them');
  const suggested = await call('/quick-keys/suggest', { token: tokens.owner, method: 'POST' });
  assert.equal(suggested.status, 200, JSON.stringify(suggested.body));
  assert.deepEqual(suggested.body.keys.map((k) => k.sku), ['COFFEE-3IN1', 'ICE', 'RICE-KG'], 'the products with no barcode, by name');

  const arranged = await call('/quick-keys', {
    token: tokens.owner, method: 'PUT',
    body: { keys: [
      { productId: ref.ice.id, label: 'Ice' },
      { productId: ref.sachet.id, packUnitId: ref.box.id },
      { productId: ref.riceProduct.id },
    ] },
  });
  assert.equal(arranged.status, 200, JSON.stringify(arranged.body));

  const listed = await call('/quick-keys');
  assert.equal(listed.body.enabled, true);
  assert.deepEqual(listed.body.keys.map((k) => [k.position, k.label, k.pack_unit_code, k.usable]),
    [[1, 'Ice', null, true], [2, '3-in-1 coffee sachet', 'BOX', true], [3, 'Well-milled rice', null, true]]);
  assert.equal(auditRepository.list({ action: 'QUICK_KEYS_CHANGED', limit: 50 }).length, 2);

  const duplicate = await call('/quick-keys', { token: tokens.owner, method: 'PUT', body: { keys: [{ productId: ref.ice.id }, { productId: ref.ice.id }] } });
  assert.equal(duplicate.status, 400);
  assert.equal((await call('/quick-keys', { token: tokens.owner, method: 'PUT', body: { keys: Array.from({ length: 25 }, () => ({ productId: ref.ice.id })) } })).status, 400);
  assert.deepEqual(dataRepository.rowsOf('quick_keys').length, 3, 'a refused arrangement changes nothing');
});

// ── 6. Utang from the counter ───────────────────────────────────────────────

test('TASK-070: Aling Nena, added at the counter, buys on credit up to the counter limit', async () => {
  const added = await call('/customers/quick', { method: 'POST', body: { name: 'Aling Nena' } });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const nena = added.body.customer;
  assert.equal(nena.is_credit_eligible, true);
  const credit = (await call(`/customers/${nena.id}/credit`)).body;
  assert.equal(credit.credit.credit_limit_centavos, 50000);

  const ok = await sell({
    customerId: nena.id,
    lines: [{ productId: ref.riceProduct.id, qtyMilli: 5000 }, { productId: ref.sachet.id, qtyMilli: 10000 }],
    tenders: [{ method: 'CREDIT', amountCentavos: 33000 }],
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));

  const over = await sell({
    customerId: nena.id,
    lines: [{ productId: ref.sachet.id, qtyMilli: 1000, packUnitId: ref.box.id }],
    tenders: [{ method: 'CREDIT', amountCentavos: 18000 }],
  });
  assert.equal(over.status, 403, '₱330 + ₱180 is over ₱500');
  assert.equal(over.body.error.rule_id, 'CR-104');

  // No name, no customer.
  assert.equal((await call('/customers/quick', { method: 'POST', body: { name: ' ' } })).status, 400);
});

// ── 7. The void, and the day ────────────────────────────────────────────────

test('TASK-070: voiding the box sale puts 40 sachets back, and the day\'s report adds up', async () => {
  const before = inventoryRepository.qtyOnHand(ref.sachet.id);
  const voided = await call(`/sales/${ref.boxSale.id}/void`, { token: tokens.owner, method: 'POST', body: { reason: 'Rung up twice' } });
  assert.equal(voided.status, 201, JSON.stringify(voided.body));
  assert.equal(inventoryRepository.qtyOnHand(ref.sachet.id) - before, 40000);

  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const daily = await call(`/reports/daily?date=${today}`, { token: tokens.owner });
  assert.equal(daily.status, 200, JSON.stringify(daily.body));
  const t = daily.body.totals;
  assert.equal(t.gross_centavos - t.discount_centavos + t.service_charge_centavos - t.returns_centavos, t.net_centavos);
  assert.equal(t.net_centavos, 27400 + 33000, 'the wholesale sale and Aling Nena\'s; the voided box sale is out');
});

// ── 8. The opening spreadsheet ──────────────────────────────────────────────

test('PR-108: the Packs sheet loads a pack\'s own prices, and refuses one that is not a price', async () => {
  const csv = (rows) => `${rows.map((r) => r.join(',')).join('\n')}\n`;
  const body = {
    products: csv([['sku', 'name', 'category', 'base_unit', 'retail_price'], ['SODA-PET', 'Soda 290 mL', 'Coffee', 'PC', '15.00']]),
    packs: csv([['sku', 'unit', 'contains', 'retail_price', 'wholesale_price'], ['SODA-PET', 'BOX', '24', '300.00', '285.00']]),
  };
  const bad = await call('/data/opening/validate', { token: tokens.owner, method: 'POST', body: { ...body, packs: body.packs.replace('300.00', 'three hundred') } });
  assert.equal(bad.body.ok, false);
  assert.match(JSON.stringify(bad.body.problems), /not a price for the BOX/);

  const loaded = await call('/data/opening', { token: tokens.owner, method: 'POST', body });
  assert.equal(loaded.status, 201, JSON.stringify(loaded.body));
  const soda = (await call('/products?q=SODA-PET', { token: tokens.owner })).body;
  const id = (soda.rows || soda.products)[0].id;
  const box = (await call(`/products/${id}`, { token: tokens.owner })).body.product.packs[0];
  assert.deepEqual(box.prices, { RETAIL: 30000, WHOLESALE: 28500, DEALER: null });
});
