'use strict';

// The catalog against a real database and over HTTP.
//
// TC-UT-10 and TC-UT-32 are named unit cases in 07_TEST_PLAN.md §3, and both are here
// instead: base-unit immutability is a fact about the ledger and price fall-through is
// a fact about stored price rows. Neither is a pure calculation, and a mocked version
// of either would assert the mock. They keep their case ids, which is what the rule
// coverage obligation (NFR_5.2) actually tracks.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const db = require('../../config/database');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const referenceService = require('../../services/referenceService');
const auditService = require('../../services/auditService');
const productRepository = require('../../repositories/productRepository');
const inventoryService = require('../../services/inventoryService');
const temp = require('../helpers/tempdb');

// Port 0: the OS picks a free one and the real port is read back off the server.
// A fixed port collides whenever two runs overlap or a socket lingers, which is a
// flake that looks like a defect in whatever test happens to be running.
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

/** A product with the fields every case needs, overridable per case. */
const productInput = (over = {}) => ({
  sku: 'FEED-001',
  name: 'Hog Grower Pellets',
  categoryId: ref.category.id,
  brandId: ref.brand.id,
  baseUnitId: ref.kg.id,
  taxClass: 'VATABLE',
  retailPriceCentavos: 6250,
  minStockMilli: 50000,
  ...over,
});

test.before(async () => {
  temp.openEmpty('catalog');
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

// ── Creation and the required fields ────────────────────────────────────────

test('a product cannot be created without SKU, name, category, base unit and retail price', () => {
  const owner = sessions.OWNER;

  const missing = [
    [{ sku: '' }, 'VR-201'],
    [{ name: 'X' }, 'VR-202'],
    [{ categoryId: null }, 'VR-209'],
    [{ baseUnitId: null }, 'VR-209'],
    [{ retailPriceCentavos: undefined }, 'VR-203'],
    [{ retailPriceCentavos: -1 }, 'VR-203'],
    [{ minStockMilli: -5 }, 'VR-204'],
  ];

  for (const [over, ruleId] of missing) {
    assert.throws(
      () => productService.create(productInput(over), owner),
      (err) => err.status === 400 && err.ruleId === ruleId,
      `expected ${ruleId} for ${JSON.stringify(over)}`
    );
  }
  assert.equal(productRepository.countAll(), 0, 'nothing written by any refusal');
});

test('a created product carries its reference names, its unit and its retail price', () => {
  const product = productService.create(productInput(), sessions.OWNER);

  assert.equal(product.sku, 'FEED-001');
  assert.equal(product.category.name, 'Feeds');
  assert.equal(product.brand.name, 'B-MEG');
  assert.equal(product.base_unit.code, 'KG');
  assert.equal(product.base_unit.allows_fraction, true);
  assert.equal(product.tax_class, 'VATABLE');
  assert.equal(product.prices.RETAIL, 6250);
  assert.equal(product.min_stock_display, '50 KG', 'UOM-005 labels a threshold with its unit');

  const [row] = auditService.browse({ action: 'PRODUCT_CREATED' }).rows;
  assert.equal(row.after.sku, 'FEED-001');
});

test('a duplicate SKU is rejected case-insensitively (VR-201)', () => {
  assert.throws(
    () => productService.create(productInput({ sku: 'feed-001', name: 'Another Feed' }), sessions.OWNER),
    (err) => err.status === 409 && err.ruleId === 'VR-201'
  );
});

test('an inactive category or unit cannot be used on a new product', () => {
  const spare = referenceService.create('categories', { name: 'Retired Line' }, sessions.OWNER);
  referenceService.deactivate('categories', spare.id, sessions.OWNER);

  assert.throws(
    () => productService.create(productInput({ sku: 'FEED-X', categoryId: spare.id }), sessions.OWNER),
    (err) => err.status === 400 && err.ruleId === 'VR-209'
  );
});

// ── UOM-003 / TC-UT-10 — the base unit ──────────────────────────────────────

test('TC-UT-10: the base unit is editable before any movement exists', () => {
  const product = productService.create(productInput({ sku: 'FEED-002', name: 'Broiler Starter' }), sessions.OWNER);
  assert.equal(productRepository.countMovements(product.id), 0, 'nothing in the ledger yet');

  const moved = productService.update(product.id, { baseUnitId: ref.piece.id }, sessions.OWNER);
  assert.equal(moved.base_unit.code, 'PC', 'a draft product may still be corrected');

  productService.update(product.id, { baseUnitId: ref.kg.id }, sessions.OWNER);
});

test('TC-UT-10: the base unit is refused once a movement exists, and the message says why', () => {
  const product = productService.create(productInput({ sku: 'FEED-003', name: 'Layer Mash' }), sessions.OWNER);

  // A real movement through the real service (TASK-007). Until migration 003 existed
  // this case built a stub table as a fixture; it does not need to any more, and a
  // fixture that outlives the thing it stood in for is how a test starts asserting
  // its own scaffolding.
  inventoryService.postStandalone({
    productId: product.id,
    type: 'RECEIPT',
    qtyMilli: 500000,
    unitCostCentavos: 4800,
    actor: sessions.OWNER,
  });

  assert.equal(productRepository.countMovements(product.id), 1);

  let err;
  try {
    productService.update(product.id, { baseUnitId: ref.sack.id }, sessions.OWNER);
  } catch (caught) {
    err = caught;
  }

  assert.ok(err, 'UOM-003: the base unit is frozen once history exists');
  assert.equal(err.status, 409);
  assert.equal(err.ruleId, 'UOM-003');
  // 04_UX_SPEC.md §3 requires the reason to be shown, and a refusal an operator
  // cannot act on just gets worked around.
  assert.match(err.message, /reinterpret/i, 'why it is refused');
  assert.match(err.message, /create a new product/i, 'and the correction path UOM-003 gives');

  assert.equal(productService.get(product.id, sessions.OWNER).base_unit.code, 'KG', 'unchanged');

  // Everything else about the product is still editable — the freeze is on the unit.
  const renamed = productService.update(product.id, { name: 'Layer Mash 50' }, sessions.OWNER);
  assert.equal(renamed.name, 'Layer Mash 50');
});

// ── VR-205 — barcodes ───────────────────────────────────────────────────────

test('two barcodes resolve to the same product', () => {
  const product = productService.create(
    productInput({ sku: 'FEED-004', name: 'Hog Finisher', barcodes: ['4800016641206'] }),
    sessions.OWNER
  );
  productService.attachBarcode(product.id, '4800016641213', sessions.OWNER);

  for (const code of ['4800016641206', '4800016641213']) {
    const found = productService.findByBarcode(code, sessions.CASHIER);
    assert.equal(found.found, true, code);
    assert.equal(found.product.id, product.id);
  }
});

test('a barcode is globally unique across products (VR-205)', () => {
  const other = productService.create(productInput({ sku: 'FEED-005', name: 'Chick Booster' }), sessions.OWNER);

  assert.throws(
    () => productService.attachBarcode(other.id, '4800016641206', sessions.OWNER),
    (err) => err.status === 409 && err.ruleId === 'VR-205' && /another product/.test(err.message)
  );
});

test('a detached barcode frees the code for another product', () => {
  const product = productService.create(
    productInput({ sku: 'FEED-006', name: 'Pig Pre-Starter', barcodes: ['8901234567894'] }),
    sessions.OWNER
  );
  const [barcode] = productService.attachBarcode(product.id, '8901234567900', sessions.OWNER)
    .filter((b) => b.barcode === '8901234567900');

  productService.detachBarcode(product.id, barcode.id, sessions.OWNER);
  assert.equal(productService.findByBarcode('8901234567900', sessions.OWNER).found, false);

  const other = productRepository.findBySku('FEED-005');
  assert.doesNotThrow(() => productService.attachBarcode(other.id, '8901234567900', sessions.OWNER));
});

test('TC-INT-30: an unknown barcode returns an attach-offer, not a 404', async () => {
  const res = await call('/products/barcode/9990001112223', { token: tokens.CASHIER });

  // A 404 here is a dead end the UI swallows: the counter has the item in hand and the
  // useful next step is to attach the code, not to be told nothing was found.
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.found, false);
  assert.equal(body.barcode, '9990001112223');
  assert.equal(body.offer.action, 'ATTACH_BARCODE');
  assert.equal(body.offer.rule_id, 'VR-205');
});

test('a weight-embedded barcode is refused at the counter rather than offered', async () => {
  const res = await call('/products/barcode/2012345678909', { token: tokens.CASHIER });

  // Not an attach-offer: attaching it would bind one weighing's label to a product
  // forever, and every later weighing would scan as something else.
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.rule_id, 'VR-205');
  assert.match(body.error.message, /weight/i);
});

// ── UOM-002 / VR-207 — packs ────────────────────────────────────────────────

test('adding or removing a pack answers in the same shape the product detail speaks', () => {
  // The two used to differ: the detail nested the unit and the pack routes returned the
  // repository's flat row. A screen that re-rendered from the reply of the call it had
  // just made read `pack.unit.id` off `undefined` and threw — the pack was written, and
  // only the answer was the wrong shape, which is why an API test and a reload both
  // looked fine.
  const product = productService.create(productInput({ sku: 'FEED-SHAPE', name: 'Shaped Feed' }), sessions.OWNER);

  const added = productService.addPack(
    product.id, { unitId: ref.sack.id, factorMilli: 50000 }, sessions.OWNER
  );
  const fromDetail = productService.get(product.id, sessions.OWNER).packs;

  assert.deepEqual(added, fromDetail, 'the same rows, said the same way');
  assert.deepEqual(Object.keys(added[0]).sort(), ['factor_milli', 'id', 'is_default_sell', 'unit']);
  assert.equal(added[0].unit.id, ref.sack.id);
  assert.equal(added[0].unit.code, 'SACK');
  assert.equal(added[0].is_default_sell, false, 'a boolean, not a 0');

  const afterRemoval = productService.removePack(product.id, added[0].id, sessions.OWNER);
  assert.deepEqual(afterRemoval, productService.get(product.id, sessions.OWNER).packs);
});

test('a pack converts against the base unit, and a zero or negative factor is refused', () => {
  const product = productService.create(productInput({ sku: 'FEED-007', name: 'Sacked Feed' }), sessions.OWNER);

  const packs = productService.addPack(
    product.id, { unitId: ref.sack.id, factorMilli: 50000, isDefaultSell: true }, sessions.OWNER
  );
  assert.equal(packs.length, 1);
  assert.equal(packs[0].factor_milli, 50000, 'legacy §16: 1 SACK = 50 KG, expressed against the base unit');

  for (const factor of [0, -1, 1.5, 'many', null]) {
    assert.throws(
      () => productService.addPack(product.id, { unitId: ref.piece.id, factorMilli: factor }, sessions.OWNER),
      (err) => err.status === 400 && err.ruleId === 'VR-207',
      `factor ${factor}`
    );
  }
});

test('a pack may not be in the base unit itself, nor duplicated', () => {
  const product = productRepository.findBySku('FEED-007');

  assert.throws(
    () => productService.addPack(product.id, { unitId: ref.kg.id, factorMilli: 1000 }, sessions.OWNER),
    (err) => err.ruleId === 'UOM-002' && /already how stock is counted/.test(err.message)
  );
  assert.throws(
    () => productService.addPack(product.id, { unitId: ref.sack.id, factorMilli: 25000 }, sessions.OWNER),
    (err) => err.status === 409 && err.ruleId === 'UOM-002'
  );
});

test('only one pack is the default sell unit', () => {
  const product = productRepository.findBySku('FEED-007');
  productService.addPack(product.id, { unitId: ref.piece.id, factorMilli: 1000, isDefaultSell: true }, sessions.OWNER);

  const packs = productRepository.packsFor(product.id);
  assert.equal(packs.filter((p) => p.is_default_sell).length, 1);
  assert.equal(packs.find((p) => p.is_default_sell).unit_code, 'PC');
});

// ── PR-102 / TC-UT-32 — price fall-through ──────────────────────────────────

test('TC-UT-32: a product with no wholesale price returns retail, never zero', () => {
  const product = productService.create(
    productInput({ sku: 'FEED-008', name: 'Retail Only Feed', retailPriceCentavos: 6250 }),
    sessions.OWNER
  );

  const retail = productService.resolvePrice(product.id, 'RETAIL');
  assert.deepEqual(
    { price: retail.price_centavos, resolved: retail.resolved_level, fell: retail.fell_through },
    { price: 6250, resolved: 'RETAIL', fell: false }
  );

  for (const level of ['WHOLESALE', 'DEALER']) {
    const resolved = productService.resolvePrice(product.id, level);
    // Falling through to zero would give the product away, and it is the kind of defect
    // that only shows up in the day's takings.
    assert.equal(resolved.price_centavos, 6250, `${level} falls through to retail`);
    assert.equal(resolved.resolved_level, 'RETAIL');
    assert.equal(resolved.fell_through, true, 'and the sale line records that it fell through');
  }
});

test('a wholesale price, once set, is used instead of retail', () => {
  const product = productRepository.findBySku('FEED-008');
  productService.setPrices(product.id, { WHOLESALE: 5800 }, sessions.OWNER);

  const resolved = productService.resolvePrice(product.id, 'WHOLESALE');
  assert.deepEqual(
    { price: resolved.price_centavos, resolved: resolved.resolved_level, fell: resolved.fell_through },
    { price: 5800, resolved: 'WHOLESALE', fell: false }
  );
  assert.equal(productService.resolvePrice(product.id, 'DEALER').price_centavos, 6250, 'dealer still falls through');
});

test('a price change writes exactly one audit row carrying both values (TC-UT-05)', () => {
  // The canonical TC-UT-05 instance, which TASK-005 could not supply because products
  // did not exist yet.
  const product = productRepository.findBySku('FEED-008');
  const before = auditService.browse({ action: 'PRICE_CHANGED', entityId: product.id }).total;

  productService.setPrices(product.id, { RETAIL: 6500 }, sessions.OWNER, sessions.OWNER, { reason: 'Supplier increase' });

  const rows = auditService.browse({ action: 'PRICE_CHANGED', entityId: product.id });
  assert.equal(rows.total, before + 1, 'exactly one row');
  assert.deepEqual(rows.rows[0].before, { RETAIL: 6250 });
  assert.deepEqual(rows.rows[0].after, { RETAIL: 6500 });
  assert.equal(rows.rows[0].reason, 'Supplier increase');
});

test('a price row supersedes rather than overwrites, so past prices survive', () => {
  const product = productRepository.findBySku('FEED-008');
  const history = productRepository.priceHistory(product.id).filter((r) => r.price_level === 'RETAIL');

  assert.ok(history.length >= 2, 'both the old and the new price are on record');
  assert.equal(history[0].price_centavos, 6500, 'newest first');
});

test('a future-dated price does not change what the counter charges today', () => {
  const product = productRepository.findBySku('FEED-008');
  const nextYear = '2027-01-01T00:00:00.000Z';

  productService.setPrices(product.id, { RETAIL: 7000 }, sessions.OWNER, sessions.OWNER, { effectiveFrom: nextYear });

  assert.equal(productService.resolvePrice(product.id, 'RETAIL').price_centavos, 6500, 'today');
  assert.equal(
    productService.resolvePrice(product.id, 'RETAIL', { at: '2027-06-01T00:00:00.000Z' }).price_centavos,
    7000,
    'and the new list takes effect on its own day'
  );
});

test('a product with no retail price at all is refused rather than priced at zero (PR-102)', () => {
  // Reached by data rather than by the API — create() requires retail — so the guard
  // holds for an import or a hand-edited database too.
  const product = productRepository.findBySku('FEED-005');
  db.get().prepare('DELETE FROM product_prices WHERE product_id = ?').run(product.id);

  assert.equal(productService.isSellable(product.id), false);
  assert.throws(
    () => productService.resolvePrice(product.id, 'RETAIL'),
    (err) => err.status === 409 && err.ruleId === 'PR-102'
  );
});

// ── TX-412 / TC-API-01 — the cost field ─────────────────────────────────────

test('TC-API-01: cost is absent for a cashier and present for an owner', async () => {
  const product = productRepository.findBySku('FEED-001');
  productService.setCost(product.id, 4800, sessions.OWNER);

  const asOwner = await (await call(`/products/${product.id}`, { token: tokens.OWNER })).json();
  assert.equal(asOwner.product.avg_cost_centavos, 4800);
  assert.ok(asOwner.product.avg_cost_as_of);

  for (const role of ['MANAGER', 'CASHIER', 'INVENTORY']) {
    const res = await call(`/products/${product.id}`, { token: tokens[role] });
    assert.equal(res.status, 200, `${role} may still read the product`);
    const body = await res.json();

    // 04_UX_SPEC.md §3: the field is *absent*, not disabled and not null. A null would
    // tell a cashier there is a cost they may not see, which is a different statement.
    assert.equal('avg_cost_centavos' in body.product, false, `${role} sees no cost`);
    assert.equal('avg_cost_as_of' in body.product, false, `${role} sees no cost date`);
  }
});

test('cost is absent from the list as well as the detail', async () => {
  const res = await call('/products?q=Hog', { token: tokens.CASHIER });
  const body = await res.json();

  assert.ok(body.products.length > 0);
  for (const product of body.products) {
    assert.equal('avg_cost_centavos' in product, false);
    assert.ok('retail_price_centavos' in product, 'the selling price is not the cost');
  }
});

test('only the owner may change a cost, and the change is audited (TX-412)', async () => {
  const product = productRepository.findBySku('FEED-001');

  for (const role of ['MANAGER', 'INVENTORY', 'CASHIER']) {
    const res = await call(`/products/${product.id}/cost`, {
      token: tokens[role], method: 'PUT', body: { avgCostCentavos: 1 },
    });
    assert.equal(res.status, 403, `${role} may not change a cost`);
    assert.equal((await res.json()).error.rule_id, 'TX-412');
  }

  const ok = await call(`/products/${product.id}/cost`, {
    token: tokens.OWNER, method: 'PUT', body: { avgCostCentavos: 5000, reason: 'Opening load correction' },
  });
  assert.equal(ok.status, 200);

  const [row] = auditService.browse({ action: 'COST_CHANGED', entityId: product.id }).rows;
  assert.deepEqual(row.before, { avg_cost_centavos: 4800 });
  assert.deepEqual(row.after, { avg_cost_centavos: 5000 });
});

// ── TX-410 / TX-411 — who may edit what ─────────────────────────────────────

test('an inventory clerk may edit a product but not its selling price', async () => {
  const product = productRepository.findBySku('FEED-001');

  const edit = await call(`/products/${product.id}`, {
    token: tokens.INVENTORY, method: 'PUT', body: { description: 'Sold by the sack or loose' },
  });
  assert.equal(edit.status, 200, 'TX-410');

  const price = await call(`/products/${product.id}/prices`, {
    token: tokens.INVENTORY, method: 'PUT', body: { RETAIL: 1 },
  });
  assert.equal(price.status, 403, 'TX-411 is not TX-410');
  assert.equal((await price.json()).error.rule_id, 'TX-411');
});

test('a cashier may scan but not list, create or edit', async () => {
  assert.equal((await call('/products', { token: tokens.CASHIER })).status, 200, 'TX-422 at VIEW');

  const created = await call('/products', {
    token: tokens.CASHIER, method: 'POST', body: productInput({ sku: 'NOPE-1' }),
  });
  assert.equal(created.status, 403);
  assert.equal((await created.json()).error.rule_id, 'TX-410');
});

// ── VR-206 — deactivate, never delete ───────────────────────────────────────

test('a product is deactivated, never deleted', async () => {
  const product = productRepository.findBySku('FEED-004');

  const deleted = await call(`/products/${product.id}`, { token: tokens.OWNER, method: 'DELETE' });
  assert.equal(deleted.status, 409);
  assert.equal((await deleted.json()).error.rule_id, 'VR-206');

  const off = await call(`/products/${product.id}/deactivate`, { token: tokens.OWNER, method: 'POST' });
  assert.equal(off.status, 200);
  assert.equal((await off.json()).product.is_active, false);
  assert.ok(productRepository.findById(product.id), 'the row is still there');

  const [row] = auditService.browse({ action: 'PRODUCT_DEACTIVATED', entityId: product.id }).rows;
  assert.equal(row.after.is_active, 0);
});

test('a category in use cannot be deactivated', () => {
  assert.throws(
    () => referenceService.deactivate('categories', ref.category.id, sessions.OWNER),
    (err) => err.status === 409 && err.ruleId === 'VR-206' && /used by \d+ products/.test(err.message)
  );
});

test('a unit in use as a base unit or a pack unit cannot be deactivated', () => {
  for (const unit of [ref.kg, ref.sack]) {
    assert.throws(
      () => referenceService.deactivate('units', unit.id, sessions.OWNER),
      (err) => err.status === 409 && err.ruleId === 'VR-206',
      unit.code
    );
  }
});

test('reference tables have no delete route either', async () => {
  const res = await call(`/categories/${ref.category.id}`, { token: tokens.OWNER, method: 'DELETE' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.rule_id, 'VR-206');
});

// ── Search (FR_2.1, NFR_1.3) ────────────────────────────────────────────────

test('search matches name, SKU, barcode and brand', async () => {
  const byName = await (await call('/products?q=Grower', { token: tokens.OWNER })).json();
  assert.ok(byName.products.some((p) => p.sku === 'FEED-001'), 'name');

  const bySku = await (await call('/products?q=FEED-003', { token: tokens.OWNER })).json();
  assert.equal(bySku.products[0].sku, 'FEED-003', 'SKU');

  const byBrand = await (await call('/products?q=B-MEG', { token: tokens.OWNER })).json();
  assert.ok(byBrand.total > 1, 'brand');

  // FEED-006's code rather than FEED-004's: the deactivation case above switched
  // FEED-004 off, and search hides inactive products by default — which is the next
  // case's assertion, not this one's.
  const byBarcode = await (await call('/products?q=8901234567894', { token: tokens.OWNER })).json();
  assert.equal(byBarcode.products[0].sku, 'FEED-006', 'barcode');
});

test('an exact SKU or barcode ranks above a partial name match', async () => {
  const res = await (await call('/products?q=FEED-001&includeInactive=true', { token: tokens.OWNER })).json();
  assert.equal(res.products[0].sku, 'FEED-001');
});

test('search hides inactive products unless asked, and filters by category', async () => {
  const active = await (await call('/products?q=Hog', { token: tokens.OWNER })).json();
  assert.equal(active.products.some((p) => p.sku === 'FEED-004'), false, 'deactivated above');

  const all = await (await call('/products?q=Hog&includeInactive=true', { token: tokens.OWNER })).json();
  assert.ok(all.products.some((p) => p.sku === 'FEED-004'));

  const other = await (await call(`/products?category=${ref.otherCategory.id}`, { token: tokens.OWNER })).json();
  assert.equal(other.total, 0, 'no products in Veterinary yet');
});

test('a product carries whether it is sellable at all (PR-102)', async () => {
  const res = await (await call('/products?q=Chick&includeInactive=true', { token: tokens.OWNER })).json();
  const chick = res.products.find((p) => p.sku === 'FEED-005');

  assert.equal(chick.is_sellable, false, 'its prices were deleted above');
  assert.equal(chick.retail_price_centavos, null, 'null, not zero');
});
