'use strict';

// PR-101–PR-206 — price resolution, discount authority, the below-cost floor, and the
// rules engine TASK-023 added on top of them.
//
// TC-UT-31, TC-UT-32, TC-UT-34 and TC-UT-35 are named unit cases and are here instead,
// for the reason TC-UT-10 and TC-UT-32 already are: a price is a stored row and a
// ceiling is a stored setting. Resolving against a mocked repository would assert the
// mock. They keep their case ids, which is what NFR_5.2 tracks.
//
// The parts that genuinely are pure — the tax engine, basis points — are unit-tested in
// tax.test.js and here without a database.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const db = require('../../config/database');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const customerService = require('../../services/customerService');
const inventoryService = require('../../services/inventoryService');
const pricingService = require('../../services/pricingService');
const settingsService = require('../../services/settingsService');
const storeProfileService = require('../../services/storeProfileService');
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

/** A customer with a negotiated price for one product (PR-103). */
function negotiated({ product, priceCentavos, note = null }) {
  const customer = customerService.create({
    name: `Negotiated Farm ${(seq += 1)}`, customerType: 'FARM', priceLevel: 'RETAIL',
  }, sessions.OWNER);
  customerService.setPrices(customer.id, [{ productId: product.id, priceCentavos, note }], sessions.OWNER);
  return { customer: customerService.find(customer.id) };
}

let seq = 0;
function makeProduct(over = {}) {
  seq += 1;
  return productService.create({
    sku: `PR-${String(seq).padStart(3, '0')}`,
    name: `Priced Feed ${seq}`,
    categoryId: ref.category.id,
    baseUnitId: ref.kg.id,
    taxClass: 'VATABLE',
    retailPriceCentavos: 6250,
    ...over,
  }, sessions.OWNER);
}

test.before(async () => {
  temp.openEmpty('pricing');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;
  temp.seedStore({ taxMode: 'VAT', withOwner: false });
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

// ── TC-UT-31 — PR-101's precedence ──────────────────────────────────────────

test('TC-UT-31: all four levels of the precedence chain resolve', () => {
  // **Updated by TASK-024, not replaced** (07_TEST_PLAN.md §6.3). This case asserted
  // that the top two levels were stubbed, which was true and worth asserting while it
  // was — a placeholder nobody notices becoming real is how a wrong price ships. It
  // now asserts the opposite half of the same fact: all four answer.
  const levels = pricingService.precedenceLevels();

  assert.deepEqual(levels.map((l) => l.level), [
    'CUSTOMER_SPECIFIC', 'QUANTITY_BREAK', 'PRICE_LEVEL', 'RETAIL',
  ]);
  assert.deepEqual(levels.map((l) => l.release), ['1.1', '1.1', '1.0', '1.0']);
  assert.deepEqual(levels.map((l) => l.rule_id), ['PR-103', 'PR-104', 'PR-101', 'PR-102']);

  // Not one of them is a stub any more: each declines on an empty context rather than
  // returning null unconditionally, which is what the old assertion could not tell
  // apart. So the chain is walked with real data instead.
  const product = makeProduct({ retailPriceCentavos: 6250 });
  const { customer } = negotiated({ product, priceCentavos: 5800 });
  productService.setQuantityBreaks(product.id, 'RETAIL', [
    { minQtyMilli: 20000, priceCentavos: 6000 },
  ], sessions.OWNER);

  // 1 — the customer price, whatever the quantity (PR-103).
  assert.equal(
    pricingService.resolvePrice({ productId: product.id, customer, qtyMilli: 40000 }).precedence,
    'CUSTOMER_SPECIFIC'
  );
  // 2 — the break, for anybody without one (PR-104).
  assert.equal(
    pricingService.resolvePrice({ productId: product.id, customer: null, qtyMilli: 40000 }).precedence,
    'QUANTITY_BREAK'
  );
  // 3 and 4 — the level, and retail beneath it, exactly as in v1.0.
  const plain = makeProduct({ retailPriceCentavos: 6250 });
  productService.setPrices(plain.id, { WHOLESALE: 5800 }, sessions.OWNER);
  assert.equal(
    pricingService.resolvePrice({ productId: plain.id, customer: { price_level: 'WHOLESALE' } }).precedence,
    'PRICE_LEVEL'
  );
  assert.equal(pricingService.resolvePrice({ productId: plain.id, customer: null }).precedence, 'RETAIL');
});

// ── TC-UT-48 — PR-104's bands ───────────────────────────────────────────────

test('TC-UT-48: PR-104 — exactly one band contains a quantity, and it applies to the whole line', () => {
  const product = makeProduct({ retailPriceCentavos: 6250 });
  productService.setQuantityBreaks(product.id, 'RETAIL', [
    { minQtyMilli: 10000, priceCentavos: 6000 },      // 10 KG or more: ₱60.00
    { minQtyMilli: 50000, priceCentavos: 5500 },      // 50 KG or more: ₱55.00
  ], sessions.OWNER);

  const at = (qtyMilli) => pricingService.resolvePrice({ productId: product.id, customer: null, qtyMilli });

  // Below every band is the level price, not the lowest band.
  assert.equal(at(9999).price_centavos, 6250);
  assert.equal(at(9999).precedence, 'RETAIL');

  // **Boundaries land in exactly one band, and it is the one they start.** A band
  // "10 KG or more" that excluded 10 KG is a rule nobody can explain to a customer
  // holding ten kilos.
  assert.equal(at(10000).price_centavos, 6000);
  assert.equal(at(10000).precedence, 'QUANTITY_BREAK');
  assert.equal(at(49999).price_centavos, 6000, 'one short of the next band is still this one');
  assert.equal(at(50000).price_centavos, 5500);
  assert.equal(at(500000).price_centavos, 5500, 'and everything above the top band is the top band');

  // The band is named on the resolution, so a line can say which one it got.
  assert.deepEqual(at(60000).band, { min_qty_milli: 50000, price_centavos: 5500 });

  // PR-104: **to the whole line, not marginally.** 60 KG at the 50 KG band is 60 × ₱55,
  // not 10 × ₱62.50 + 40 × ₱60 + 10 × ₱55. Marginal is the other obvious reading and
  // is invisible until somebody adds up a large order by hand.
  const cart = pricingService.priceCart({
    lines: [{ productId: product.id, qtyMilli: 60000 }],
    taxMode: 'NONE', actorRole: 'OWNER',
  });
  assert.equal(cart.lines[0].unit_price_centavos, 5500);
  assert.equal(cart.lines[0].gross_centavos, 330000, '60 × ₱55.00');
  assert.equal(cart.lines[0].price_level, 'QUANTITY_BREAK');
});

test('TC-UT-48: PR-104 — a band set is validated as a set, where it is defined', () => {
  const product = makeProduct({ retailPriceCentavos: 6250 });

  // Two bands starting at the same quantity have no defined answer, so the refusal is
  // at definition rather than a tie-break at the counter — and it names the pair.
  assert.throws(
    () => productService.setQuantityBreaks(product.id, 'RETAIL', [
      { minQtyMilli: 10000, priceCentavos: 6000 },
      { minQtyMilli: 10000, priceCentavos: 5800 },
    ], sessions.OWNER),
    (err) => err.ruleId === 'PR-104' && /start at 10/.test(err.message) && /may not overlap/.test(err.message)
  );

  // Buying more may not cost more per unit: the dearer band would never be chosen.
  assert.throws(
    () => productService.setQuantityBreaks(product.id, 'RETAIL', [
      { minQtyMilli: 10000, priceCentavos: 5500 },
      { minQtyMilli: 50000, priceCentavos: 6000 },
    ], sessions.OWNER),
    (err) => err.ruleId === 'PR-104' && /costs more than/.test(err.message)
  );

  // A band starting at nothing is the level price wearing another name.
  assert.throws(
    () => productService.setQuantityBreaks(product.id, 'RETAIL', [
      { minQtyMilli: 0, priceCentavos: 5500 },
    ], sessions.OWNER),
    (err) => err.ruleId === 'PR-104' && /starting at nothing/.test(err.message)
  );

  // And a set that could never lower a price is refused rather than left to be found
  // as a break that does not break.
  assert.throws(
    () => productService.setQuantityBreaks(product.id, 'RETAIL', [
      { minQtyMilli: 10000, priceCentavos: 7000 },
    ], sessions.OWNER),
    (err) => err.ruleId === 'PR-104' && /would ever lower a price/.test(err.message)
  );

  // Out of order in, ascending out — so the resolver may walk it once.
  const saved = productService.setQuantityBreaks(product.id, 'RETAIL', [
    { minQtyMilli: 50000, priceCentavos: 5500 },
    { minQtyMilli: 10000, priceCentavos: 6000 },
  ], sessions.OWNER);
  assert.deepEqual(saved.levels.RETAIL.map((b) => b.min_qty_milli), [10000, 50000]);

  // A revision replaces the set whole rather than merging into it, which is the only
  // way "non-overlapping" survives an edit.
  const replaced = productService.setQuantityBreaks(product.id, 'RETAIL', [
    { minQtyMilli: 20000, priceCentavos: 5900 },
  ], sessions.OWNER);
  assert.deepEqual(replaced.levels.RETAIL.map((b) => b.min_qty_milli), [20000]);

  // **An empty set removes the bands**, and the resolver stops using them. This is
  // the state an append-only band table cannot express — writing an empty generation
  // writes no rows, so the old set would have stayed in force and "remove the breaks"
  // would silently do nothing. Found by driving the editor in a real browser.
  const cleared = productService.setQuantityBreaks(product.id, 'RETAIL', [], sessions.OWNER);
  assert.deepEqual(cleared.levels.RETAIL, []);
  assert.equal(
    pricingService.resolvePrice({ productId: product.id, customer: null, qtyMilli: 400000 }).precedence,
    'RETAIL',
    'and a large quantity is back to the level price'
  );

  // The removal is on the trail with both sets, which is where the history lives now.
  const auditService = require('../../services/auditService');
  const trail = auditService.browse({ action: 'DISCOUNT_RULE_CHANGED', entityId: product.id });
  const removal = trail.rows[0];
  assert.deepEqual(removal.after.quantity_breaks, []);
  assert.equal(removal.before.quantity_breaks.length, 1);

  // Levels are independent: clearing retail leaves wholesale alone.
  productService.setQuantityBreaks(product.id, 'WHOLESALE', [
    { minQtyMilli: 10000, priceCentavos: 5000 },
  ], sessions.OWNER);
  productService.setQuantityBreaks(product.id, 'RETAIL', [], sessions.OWNER);
  assert.equal(productService.quantityBreaks(product.id).levels.WHOLESALE.length, 1);
});

// ── TC-UT-49 — PR-103 ───────────────────────────────────────────────────────

test('TC-UT-49: PR-103 — the customer price beats the break, however much they buy', () => {
  const product = makeProduct({ retailPriceCentavos: 6250 });
  productService.setQuantityBreaks(product.id, 'RETAIL', [
    { minQtyMilli: 10000, priceCentavos: 5000 },      // a *cheaper* break than the deal
  ], sessions.OWNER);
  const { customer } = negotiated({ product, priceCentavos: 5800 });

  // The rule says "overrides all others", not "the cheaper of". A farm that negotiated
  // ₱58 pays ₱58 at forty sacks, even though the break would have been ₱50 — and that
  // is the store's own deal to have made badly.
  for (const qtyMilli of [1000, 10000, 400000]) {
    const resolved = pricingService.resolvePrice({ productId: product.id, customer, qtyMilli });
    assert.equal(resolved.price_centavos, 5800, `at ${qtyMilli} milli`);
    assert.equal(resolved.precedence, 'CUSTOMER_SPECIFIC');
    assert.equal(resolved.rule_id, 'PR-103');
  }

  // Somebody without the deal still gets the break.
  assert.equal(
    pricingService.resolvePrice({ productId: product.id, customer: null, qtyMilli: 10000 }).price_centavos,
    5000
  );
});

test('TC-UT-49: PR-103 — a negotiated price is still ceiling-bound and still below-cost-checked', () => {
  const referenceService = require('../../services/referenceService');
  const capped = referenceService.create('categories', { name: `Capped ${Date.now()}`, maxDiscountBp: 500 }, sessions.OWNER);
  const product = makeProduct({ categoryId: capped.id, retailPriceCentavos: 10000 });
  inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli: 100000, unitCostCentavos: 9000, actor: sessions.OWNER,
  });
  const { customer } = negotiated({ product, priceCentavos: 9500 });

  // PR-202 still binds a discount on top of the negotiated price.
  const overCap = pricingService.priceCart({
    lines: [{ productId: product.id, qtyMilli: 1000, discountCentavos: 2000 }],
    customer, taxMode: 'NONE', actorRole: 'OWNER',
  });
  assert.equal(overCap.lines[0].unit_price_centavos, 9500, 'the deal is the price');
  assert.ok(overCap.authorisations.some((a) => a.rule_id === 'PR-202'));

  // PR-105 still applies: a negotiated price below cost is not a licence to sell below
  // cost unnoticed. The authorisation is at the sale, where the cost of the day applies.
  const { customer: cheap } = negotiated({ product, priceCentavos: 8000 });
  const below = pricingService.priceCart({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    customer: cheap, taxMode: 'NONE', actorRole: 'CASHIER',
  });
  assert.ok(below.authorisations.some((a) => a.rule_id === 'PR-105'));

  // And the customer screen warns at the moment of agreeing rather than at the till.
  const agreed = customerService.setPrices(cheap.id, [
    { productId: product.id, priceCentavos: 8000, note: 'Long-standing account' },
  ], sessions.OWNER);
  assert.equal(agreed.below_cost.length, 1);
  assert.match(agreed.below_cost[0].message, /below the .* average cost/);
});

// ── PR-206 — a break is an automatic discount ───────────────────────────────

test('PR-206: a quantity break and a manual discount do not compound; the larger applies', () => {
  const product = makeProduct({ retailPriceCentavos: 10000 });
  productService.setQuantityBreaks(product.id, 'RETAIL', [
    { minQtyMilli: 10000, priceCentavos: 9000 },      // 10 KG saves ₱10 a kilo
  ], sessions.OWNER);

  // The break saves ₱100 over 10 KG. A ₱40 manual discount is smaller, so the break
  // applies and the manual figure does not — they do not add to ₱140.
  const breakWins = pricingService.priceCart({
    lines: [{ productId: product.id, qtyMilli: 10000, discountCentavos: 4000 }],
    taxMode: 'NONE', actorRole: 'OWNER',
  });
  assert.equal(breakWins.lines[0].unit_price_centavos, 9000);
  assert.equal(breakWins.lines[0].line_discount_centavos, 0, 'the break is a price, not a discount on top');
  assert.equal(breakWins.lines[0].net_centavos, 90000, 'not ₱1,000 − ₱100 − ₱40');
  assert.equal(breakWins.lines[0].discount_source, 'AUTOMATIC');
  assert.equal(breakWins.lines[0].discount_choice.suppressed.source, 'MANUAL');

  // A ₱200 manual discount is larger, so **the break does not apply at all**: the line
  // is charged at the level price less the ₱200, not at the band price less it.
  const manualWins = pricingService.priceCart({
    lines: [{ productId: product.id, qtyMilli: 10000, discountCentavos: 20000 }],
    taxMode: 'NONE', actorRole: 'OWNER',
  });
  assert.equal(manualWins.lines[0].unit_price_centavos, 10000, 'back to the level price');
  assert.equal(manualWins.lines[0].line_discount_centavos, 20000);
  assert.equal(manualWins.lines[0].net_centavos, 80000, 'not ₱900 − ₱200');
  assert.equal(manualWins.lines[0].discount_source, 'MANUAL');
  assert.equal(manualWins.lines[0].price_level, 'RETAIL', 'and the line says the break did not apply');
});

// ── TC-INT-93 ───────────────────────────────────────────────────────────────

test('TC-INT-93: overlapping bands are refused at definition, over HTTP, naming the pair', async () => {
  const product = makeProduct({ retailPriceCentavos: 6250 });

  const refused = await call(`/products/${product.id}/quantity-breaks`, {
    token: tokens.OWNER, method: 'PUT',
    body: {
      priceLevel: 'RETAIL',
      bands: [
        { minQtyMilli: 10000, priceCentavos: 6000 },
        { minQtyMilli: 10000, priceCentavos: 5900 },
      ],
    },
  });
  assert.equal(refused.status, 400);
  const error = (await refused.json()).error;
  assert.equal(error.rule_id, 'PR-104');
  assert.match(error.message, /start at 10/);

  // Nothing was written — a set is refused whole, not partly.
  const after = await (await call(`/products/${product.id}/quantity-breaks`, { token: tokens.OWNER })).json();
  assert.deepEqual(after.levels.RETAIL, []);

  // A cashier may not define one at all: TX-411 is a selling price.
  const byCashier = await call(`/products/${product.id}/quantity-breaks`, {
    token: tokens.CASHIER, method: 'PUT',
    body: { priceLevel: 'RETAIL', bands: [{ minQtyMilli: 10000, priceCentavos: 6000 }] },
  });
  assert.equal(byCashier.status, 403);

  const accepted = await call(`/products/${product.id}/quantity-breaks`, {
    token: tokens.OWNER, method: 'PUT',
    body: { priceLevel: 'RETAIL', bands: [{ minQtyMilli: 10000, priceCentavos: 6000 }] },
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).levels.RETAIL.length, 1);
});

test('TC-INT-93: a customer price is TX-411’s, not TX-413’s, and both values are audited', async () => {
  const auditService = require('../../services/auditService');
  const product = makeProduct({ retailPriceCentavos: 6250 });
  const customer = customerService.create({
    name: `Deal Farm ${Date.now()}`, customerType: 'FARM', priceLevel: 'RETAIL',
  }, sessions.OWNER);

  // A cashier may edit a customer (TX-413) and may not agree a price for one.
  const byCashier = await call(`/customers/${customer.id}/prices`, {
    token: tokens.CASHIER, method: 'PUT',
    body: { prices: [{ productId: product.id, priceCentavos: 5800 }] },
  });
  assert.equal(byCashier.status, 403);
  assert.equal((await byCashier.json()).error.rule_id, 'TX-411');

  const agreed = await call(`/customers/${customer.id}/prices`, {
    token: tokens.OWNER, method: 'PUT',
    body: { prices: [{ productId: product.id, priceCentavos: 5800, note: 'Agreed on the phone' }] },
  });
  assert.equal(agreed.status, 200);
  const body = await agreed.json();
  assert.equal(body.prices.length, 1);
  assert.equal(body.prices[0].price_centavos, 5800);
  assert.match(body.note, /overrides every other level/);

  // AUD-601: both values, and PR-103's consequence recorded rather than implied.
  const trail = auditService.browse({ action: 'PRICE_CHANGED', entityId: customer.id });
  assert.equal(trail.rows.length, 1);
  assert.equal(trail.rows[0].before.price_centavos, null);
  assert.equal(trail.rows[0].after.price_centavos, 5800);
  assert.equal(trail.rows[0].after.overrides_quantity_break, true);
  assert.match(trail.rows[0].reason, /Agreed on the phone/);

  // Superseded, not updated: a second agreement is a second row and the newest wins.
  customerService.setPrices(customer.id, [{ productId: product.id, priceCentavos: 5600 }], sessions.OWNER);
  const now = customerService.priceList(customer.id);
  assert.equal(now.prices.length, 1, 'one price per product');
  assert.equal(now.prices[0].price_centavos, 5600);
  assert.equal(auditService.browse({ action: 'PRICE_CHANGED', entityId: customer.id }).total, 2);
});


test('TC-UT-31: resolution takes the first level that has a price, and says which', () => {
  const product = makeProduct({ retailPriceCentavos: 6250 });
  productService.setPrices(product.id, { WHOLESALE: 5800, DEALER: 5500 }, sessions.OWNER);

  const cases = [
    [{ price_level: 'RETAIL' }, 6250, 'RETAIL'],
    [{ price_level: 'WHOLESALE' }, 5800, 'WHOLESALE'],
    [{ price_level: 'DEALER' }, 5500, 'DEALER'],
    [null, 6250, 'RETAIL'],
  ];

  for (const [customer, expectedPrice, expectedLevel] of cases) {
    const resolved = pricingService.resolvePrice({ productId: product.id, customer });
    assert.equal(resolved.price_centavos, expectedPrice, expectedLevel);
    // PR-101's last sentence: the resolved level is recorded on the sale line, which is
    // what makes a price on a six-month-old receipt explicable.
    assert.equal(resolved.resolved_level, expectedLevel);
    assert.equal(resolved.fell_through, false);
  }
});

// ── TC-UT-32 — PR-102's fall-through ────────────────────────────────────────

test('TC-UT-32: a wholesale customer with no wholesale price is charged retail, not zero', () => {
  const product = makeProduct({ retailPriceCentavos: 6250 });

  for (const level of ['WHOLESALE', 'DEALER']) {
    const resolved = pricingService.resolvePrice({
      productId: product.id, customer: { price_level: level },
    });

    // Zero would give the product away, and it is the kind of defect that only shows up
    // in the day's takings.
    assert.equal(resolved.price_centavos, 6250, `${level} falls through`);
    assert.equal(resolved.resolved_level, 'RETAIL');
    assert.equal(resolved.requested_level, level);
    assert.equal(resolved.fell_through, true, 'and the line records that it fell through');
    assert.equal(resolved.rule_id, 'PR-102');
  }
});

test('TC-UT-32: a product with no retail price at all is refused, never priced at zero', () => {
  const product = makeProduct();
  db.get().prepare('DELETE FROM product_prices WHERE product_id = ?').run(product.id);

  assert.throws(
    () => pricingService.resolvePrice({ productId: product.id, customer: { price_level: 'WHOLESALE' } }),
    (err) => err.status === 409 && err.ruleId === 'PR-102'
  );
});

test('the catalog and the pricing engine share one resolver', () => {
  // Two price resolvers is exactly the drift these documents warn about: the day they
  // disagreed, the counter and the report would each be sure they were right.
  const product = makeProduct({ retailPriceCentavos: 4200 });
  productService.setPrices(product.id, { WHOLESALE: 3900 }, sessions.OWNER);

  const viaCatalog = productService.resolvePrice(product.id, 'WHOLESALE');
  const viaEngine = pricingService.resolvePrice({
    productId: product.id, customer: { price_level: 'WHOLESALE' },
  });

  assert.equal(viaCatalog.price_centavos, viaEngine.price_centavos);
  assert.equal(viaCatalog.resolved_level, viaEngine.resolved_level);
});

// ── TC-UT-34 — PR-201 / PR-203 discount ceilings ────────────────────────────

test('TC-UT-34: a cashier discount above 2% is refused, naming who can approve it', () => {
  // PR-201: Cashier 2%, Manager 5%, Owner 100% — and they are settings, not constants.
  assert.equal(pricingService.roleCeilingBp('CASHIER'), 200);
  assert.equal(pricingService.roleCeilingBp('MANAGER'), 500);
  assert.equal(pricingService.roleCeilingBp('OWNER'), 10000);

  const under = pricingService.evaluateDiscount({
    role: 'CASHIER', lineTotalCentavos: 100000, discountCentavos: 2000,
  });
  assert.equal(under.allowed, true, 'exactly 2% is within the ceiling');
  assert.equal(under.requested_bp, 200);

  const over = pricingService.evaluateDiscount({
    role: 'CASHIER', lineTotalCentavos: 100000, discountCentavos: 3000,
  });

  // PR-203: not refused outright — it opens a manager override prompt. So the decision
  // names an approver rather than ending the sale.
  assert.equal(over.allowed, false);
  assert.equal(over.reason, 'ABOVE_CEILING');
  assert.equal(over.rule_id, 'PR-203');
  assert.equal(over.requested_bp, 300);
  assert.equal(over.ceiling_bp, 200);
  assert.equal(over.requires_role, 'MANAGER or OWNER');
  assert.match(over.message, /3% is above your 2% limit/);
  assert.match(over.message, /manager or owner can approve it/);
});

test('TC-UT-34: an approval already given is honoured rather than re-prompted', () => {
  const approved = pricingService.evaluateDiscount({
    role: 'CASHIER', lineTotalCentavos: 100000, discountCentavos: 4000, approverRole: 'MANAGER',
  });
  assert.equal(approved.allowed, true);
  assert.equal(approved.authorised, true);
  assert.equal(approved.approved_by_role, 'MANAGER');

  // But a manager cannot approve past their own ceiling either.
  const tooBig = pricingService.evaluateDiscount({
    role: 'CASHIER', lineTotalCentavos: 100000, discountCentavos: 8000, approverRole: 'MANAGER',
  });
  assert.equal(tooBig.allowed, false);
  assert.equal(tooBig.requires_role, 'OWNER');
});

test('TC-UT-34: a role holding no discount grant is a different refusal from a 0% ceiling', () => {
  const clerk = pricingService.evaluateDiscount({
    role: 'INVENTORY', lineTotalCentavos: 100000, discountCentavos: 1,
  });
  assert.equal(clerk.allowed, false);
  assert.equal(clerk.reason, 'NO_AUTHORITY');
  assert.equal(clerk.rule_id, 'TX-402');
  assert.match(clerk.message, /do not have permission/);
});

test('TC-UT-34: the ceilings are settings, and changing one changes the answer', () => {
  const before = settingsService.get('discount_ceiling_cashier_bp');
  db.transaction(() => settingsService.set('discount_ceiling_cashier_bp', 500, sessions.OWNER));

  try {
    const now = pricingService.evaluateDiscount({
      role: 'CASHIER', lineTotalCentavos: 100000, discountCentavos: 3000,
    });
    assert.equal(now.allowed, true, 'PR-201: ceilings are settings, not constants');
  } finally {
    db.transaction(() => settingsService.set('discount_ceiling_cashier_bp', before, sessions.OWNER));
  }
});

test('PR-202: a category ceiling lowers the effective ceiling, never raises it', () => {
  // PR-202 is v1.1 and max_discount_bp is normally NULL, so this changes nothing in a
  // v1.0 store. Computed here because "the lower of role and category" is a property
  // of the ceiling, and a ceiling function ignoring half its inputs is one somebody
  // has to remember to replace.
  assert.equal(pricingService.effectiveCeilingBp('OWNER', { categoryMaxDiscountBp: 300 }), 300);
  assert.equal(pricingService.effectiveCeilingBp('CASHIER', { categoryMaxDiscountBp: 9000 }), 200);
  assert.equal(pricingService.effectiveCeilingBp('CASHIER', { categoryMaxDiscountBp: null }), 200);
});

test('a discount is measured in basis points, rounded half-up', () => {
  assert.equal(pricingService.basisPoints(2000, 100000), 200, '2%');
  assert.equal(pricingService.basisPoints(1, 3), 3333, 'a third of a centavo');
  assert.equal(pricingService.basisPoints(0, 100000), 0);
  assert.equal(pricingService.basisPoints(100000, 100000), 10000, '100%');
  assert.equal(pricingService.maxDiscountCentavos('CASHIER', 7844), 157, '2% of ₱78.44');
  assert.equal(pricingService.maxDiscountCentavos('INVENTORY', 7844), 0, 'no grant, no discount');
});

// ── TC-UT-35 — PR-205's floor ───────────────────────────────────────────────

test('TC-UT-35: a discount may not drive a line negative', () => {
  const over = pricingService.evaluateDiscount({
    role: 'OWNER', lineTotalCentavos: 10000, discountCentavos: 10001,
  });

  assert.equal(over.allowed, false);
  assert.equal(over.reason, 'FLOOR');
  assert.equal(over.rule_id, 'PR-205');
  assert.match(over.message, /may not make a line negative/);

  // Exactly the line total is allowed by the floor — a free item is not a negative one
  // — and then falls to the ceiling question, which only an owner passes.
  const exact = pricingService.evaluateDiscount({
    role: 'OWNER', lineTotalCentavos: 10000, discountCentavos: 10000,
  });
  assert.equal(exact.allowed, true, '100% is within the owner ceiling');
  assert.equal(
    pricingService.evaluateDiscount({ role: 'CASHIER', lineTotalCentavos: 10000, discountCentavos: 10000 }).reason,
    'ABOVE_CEILING'
  );

  assert.throws(
    () => pricingService.evaluateDiscount({ role: 'OWNER', lineTotalCentavos: 100, discountCentavos: -1 }),
    (err) => err.ruleId === 'PR-205'
  );
});

test('TC-UT-35: the sum of discounts may not exceed the subtotal', () => {
  const product = makeProduct({ retailPriceCentavos: 10000 });

  assert.throws(
    () => pricingService.priceCart({
      lines: [{ productId: product.id, qtyMilli: 1000 }],
      taxMode: 'NONE', actorRole: 'OWNER', transactionDiscountCentavos: 10001,
    }),
    (err) => err.status === 400 && err.ruleId === 'PR-205' && /more than the/.test(err.message)
  );
});

test('the assert form throws the error shape a route needs', () => {
  assert.throws(
    () => pricingService.assertDiscountAllowed({
      role: 'CASHIER', lineTotalCentavos: 100000, discountCentavos: 3000,
    }),
    (err) => err.status === 403 && err.ruleId === 'PR-203' && err.requiresRole === 'MANAGER or OWNER'
  );
  assert.throws(
    () => pricingService.assertDiscountAllowed({
      role: 'OWNER', lineTotalCentavos: 100, discountCentavos: 200,
    }),
    (err) => err.status === 400 && err.ruleId === 'PR-205'
  );
});

// ── PR-105 — the below-cost floor ───────────────────────────────────────────

test('PR-105: a price below average cost is refused without TX-404', () => {
  const product = makeProduct({ retailPriceCentavos: 5000 });
  inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli: 100000, unitCostCentavos: 4800,
    actor: sessions.OWNER,
  });

  const fine = pricingService.evaluateBelowCost({
    unitPriceCentavos: 5000, qtyMilli: 1000, avgCostCentavos: 4800, actorRole: 'CASHIER',
  });
  assert.equal(fine.belowCost, false);
  assert.equal(fine.allowed, true);

  const below = pricingService.evaluateBelowCost({
    unitPriceCentavos: 4500, qtyMilli: 1000, avgCostCentavos: 4800, actorRole: 'CASHIER',
  });
  assert.equal(below.belowCost, true);
  assert.equal(below.allowed, false);
  assert.equal(below.rule_id, 'PR-105');
  assert.equal(below.requires_role, 'OWNER or MANAGER');
  assert.equal(below.shortfall_centavos, 300);
  assert.match(below.message, /below the ₱48\.00 average cost/);

  // §10 gives TX-404 to owner and manager, so either acting themselves is enough.
  for (const role of ['OWNER', 'MANAGER']) {
    assert.equal(
      pricingService.evaluateBelowCost({
        unitPriceCentavos: 4500, qtyMilli: 1000, avgCostCentavos: 4800, actorRole: role,
      }).allowed,
      true,
      role
    );
  }
  assert.equal(
    pricingService.evaluateBelowCost({
      unitPriceCentavos: 4500, qtyMilli: 1000, avgCostCentavos: 4800,
      actorRole: 'CASHIER', authorisedByRole: 'MANAGER',
    }).allowed,
    true,
    'or an approval given at the counter'
  );
});

test('PR-105 measures the price after the discount, not the list price', () => {
  // A 50% discount on a product priced at cost sells it below cost just as surely as a
  // mis-keyed price does.
  const decision = pricingService.evaluateBelowCost({
    unitPriceCentavos: 5000, qtyMilli: 2000, discountCentavos: 5000,
    avgCostCentavos: 4800, actorRole: 'CASHIER',
  });

  assert.equal(decision.effective_unit_centavos, 2500, '₱100 of feed less ₱50, over 2 KG');
  assert.equal(decision.belowCost, true);
  assert.equal(decision.allowed, false);
});

test('a product with no recorded cost does not trip the floor', () => {
  // avg_cost is zero until the first costed receipt (MON-004). Treating that as "below
  // cost" would block every sale of a newly created product.
  const decision = pricingService.evaluateBelowCost({
    unitPriceCentavos: 1, qtyMilli: 1000, avgCostCentavos: 0, actorRole: 'CASHIER',
  });
  assert.equal(decision.belowCost, false);
  assert.equal(decision.allowed, true);
});

// ── The whole cart, and MON-003's order of operations ───────────────────────

test('priceCart follows MON-003: line discount, then transaction discount, then tax', () => {
  const a = makeProduct({ retailPriceCentavos: 6250, taxClass: 'VATABLE' });
  const b = makeProduct({ retailPriceCentavos: 5000, taxClass: 'VAT_EXEMPT' });

  const cart = pricingService.priceCart({
    taxMode: 'VAT',
    actorRole: 'OWNER',
    lines: [
      { productId: a.id, qtyMilli: 1255, discountCentavos: 100 },   // 1.255 KG × ₱62.50
      { productId: b.id, qtyMilli: 2000 },                          // 2 KG × ₱50.00
    ],
    transactionDiscountCentavos: 500,
  });

  // MON-003 step 1: 1.255 × 6250 = 7843.75, rounded half-up to 7844 (TC-UT-12's figure).
  assert.equal(cart.lines[0].gross_centavos, 7844);
  assert.equal(cart.lines[0].net_centavos, 7744, 'less the ₱1.00 line discount');
  assert.equal(cart.lines[1].gross_centavos, 10000);

  assert.equal(cart.subtotal_centavos, 7744 + 10000);

  // MON-006: apportioned in proportion to line total, remainder to the largest line,
  // and the parts sum to the whole exactly.
  const shares = cart.lines.map((l) => l.transaction_discount_centavos);
  assert.equal(shares.reduce((x, y) => x + y, 0), 500);
  assert.equal(cart.total_centavos, 7744 + 10000 - 500);

  // TAX-003: decomposed per line, after every discount, by each product's own class.
  assert.ok(cart.lines[0].tax_amount_centavos > 0, 'the VATable line carries VAT');
  assert.equal(cart.lines[1].tax_amount_centavos, 0, 'the exempt line carries none');
  assert.equal(
    cart.tax_amount_centavos,
    cart.lines.reduce((sum, l) => sum + l.tax_amount_centavos, 0)
  );
  assert.equal(cart.tax_summary.vat_rate, '12%');
});

test('priceCart re-resolves server-side and ignores what the client claims', () => {
  const product = makeProduct({ retailPriceCentavos: 6250 });

  const cart = pricingService.priceCart({
    taxMode: 'NONE',
    actorRole: 'CASHIER',
    // A tampered renderer sending its own price. §4.1 step 2: never trusted.
    lines: [{ productId: product.id, qtyMilli: 1000, unitPriceCentavos: 1, priceCentavos: 1 }],
  });

  assert.equal(cart.lines[0].unit_price_centavos, 6250, 'the server price, not the sent one');
  assert.equal(cart.total_centavos, 6250);
});

test('priceCart reports what needs authorising rather than throwing at the first problem', () => {
  const product = makeProduct({ retailPriceCentavos: 10000 });
  inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli: 10000, unitCostCentavos: 9500, actor: sessions.OWNER,
  });

  const cart = pricingService.priceCart({
    taxMode: 'NONE',
    actorRole: 'CASHIER',
    lines: [{ productId: product.id, qtyMilli: 1000, discountCentavos: 1000 }],   // 10%
  });

  // This line trips two rules at once: 10% is above the cashier's 2% ceiling, and
  // ₱90.00 after the discount is below the ₱95.00 average cost. The screen needs both
  // in one answer — being told about the discount, getting it approved, resubmitting
  // and only then hearing about the price makes the counter fetch the manager twice.
  assert.equal(cart.requires_authorisation, true);
  assert.deepEqual(cart.authorisations.map((a) => a.rule_id), ['PR-203', 'PR-105']);
  // 10% is above the manager's 5% ceiling too, so only an owner can approve it.
  assert.equal(cart.authorisations[0].requires_role, 'OWNER');
  assert.equal(cart.authorisations[1].requires_role, 'OWNER or MANAGER');

  const authorised = pricingService.priceCart({
    taxMode: 'NONE', actorRole: 'CASHIER', approverRole: 'OWNER',
    lines: [{ productId: product.id, qtyMilli: 1000, discountCentavos: 1000 }],
  });
  assert.equal(authorised.requires_authorisation, false);
});

test('a withdrawn product cannot be priced into a cart (INV-105)', () => {
  const product = makeProduct();
  productService.deactivate(product.id, sessions.OWNER);

  assert.throws(
    () => pricingService.priceCart({
      taxMode: 'NONE', actorRole: 'OWNER', lines: [{ productId: product.id, qtyMilli: 1000 }],
    }),
    (err) => err.status === 409 && err.ruleId === 'INV-105'
  );
});

// ── Over HTTP ───────────────────────────────────────────────────────────────

test('POST /sales/price-check prices a cart without committing anything', async () => {
  const product = makeProduct({ retailPriceCentavos: 6250 });
  const customer = customerService.create({
    name: 'Wholesale Farm', customerType: 'FARM', priceLevel: 'WHOLESALE',
  }, sessions.OWNER);
  productService.setPrices(product.id, { WHOLESALE: 5800 }, sessions.OWNER);

  const res = await call('/sales/price-check', {
    token: tokens.CASHIER,
    method: 'POST',
    body: { customerId: customer.id, lines: [{ productId: product.id, qtyMilli: 2000 }] },
  });

  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.lines[0].unit_price_centavos, 5800, 'the wholesale price');
  assert.equal(body.lines[0].price_level, 'WHOLESALE');
  assert.equal(body.total_centavos, 11600);
  assert.equal(body.tax_mode, 'VAT', 'TAX-001: the store’s mode, not the client’s');
  assert.ok(body.tax_summary, 'and the VAT block a VAT store prints');

  // Nothing was written: no movement, no sale, no ledger row.
  const movements = db.get()
    .prepare('SELECT COUNT(*) AS n FROM inventory_movements WHERE product_id = ?')
    .get(product.id).n;
  assert.equal(movements, 0);
});

test('the price check needs TX-401, and the client cannot choose the tax mode', async () => {
  const product = makeProduct();

  const refused = await call('/sales/price-check', {
    token: tokens.INVENTORY, method: 'POST',
    body: { lines: [{ productId: product.id, qtyMilli: 1000 }] },
  });
  assert.equal(refused.status, 403, 'TX-401 is the counter’s permission');
  assert.equal((await refused.json()).error.rule_id, 'TX-401');

  const sneaky = await call('/sales/price-check', {
    token: tokens.CASHIER, method: 'POST',
    body: { taxMode: 'NONE', lines: [{ productId: product.id, qtyMilli: 1000 }] },
  });
  assert.equal((await sneaky.json()).tax_mode, 'VAT', 'a sent mode is ignored');
});

test('the pricing policy is served rather than hard-coded in the screen', async () => {
  const res = await call('/sales/pricing-policy', { token: tokens.CASHIER });
  const body = await res.json();

  assert.equal(body.discount_ceiling_bp, 200, 'the cashier’s own ceiling');
  assert.equal(body.vat_rate, '12%');
  assert.equal(body.tax_mode, 'VAT');
  assert.deepEqual(body.price_levels, ['RETAIL', 'WHOLESALE', 'DEALER']);
  assert.equal(body.precedence.length, 4);

  const owner = await (await call('/sales/pricing-policy', { token: tokens.OWNER })).json();
  assert.equal(owner.discount_ceiling_bp, 10000);
});

test('the store’s tax mode drives the engine end to end', async () => {
  const product = makeProduct({ retailPriceCentavos: 112000, taxClass: 'VATABLE' });

  const asVat = await (await call('/sales/price-check', {
    token: tokens.CASHIER, method: 'POST', body: { lines: [{ productId: product.id, qtyMilli: 1000 }] },
  })).json();
  assert.equal(asVat.tax_amount_centavos, 12000, 'TC-UT-18’s figure, over HTTP');

  // Switching the store to NON_VAT is a settings change (TAX-001), and the same cart
  // then computes no tax at all — no migration, no product edit.
  // setTaxMode owns its own transaction (§8.3); wrapping it would nest.
  storeProfileService.setTaxMode('NON_VAT', sessions.OWNER);
  try {
    const asNonVat = await (await call('/sales/price-check', {
      token: tokens.CASHIER, method: 'POST', body: { lines: [{ productId: product.id, qtyMilli: 1000 }] },
    })).json();

    assert.equal(asNonVat.tax_amount_centavos, 0);
    assert.equal(asNonVat.tax_summary, null);
    assert.equal(asNonVat.total_centavos, 112000, 'the price the customer pays is unchanged');
  } finally {
    storeProfileService.setTaxMode('VAT', sessions.OWNER);
  }
});

// ── TC-INT-92 — the whole precedence, in one pass (TASK-023) ────────────────

test('TC-INT-92: every rule resolves in one pass, and every blocking decision is reported', () => {
  const referenceService = require('../../services/referenceService');
  const discountRuleService = require('../../services/discountRuleService');

  // A category capped at 5% (PR-202), and a product in it priced at ₱100 with an
  // average cost of ₱90 — so a discount over 10% is also below cost (PR-105).
  const capped = referenceService.create('categories', { name: 'Capped Vet Lines', maxDiscountBp: 500 }, sessions.OWNER);
  const vet = makeProduct({ categoryId: capped.id, retailPriceCentavos: 10000 });
  inventoryService.postStandalone({
    productId: vet.id, type: 'RECEIPT', qtyMilli: 100000, unitCostCentavos: 9000, actor: sessions.OWNER,
  });

  const plain = makeProduct({ retailPriceCentavos: 10000 });
  inventoryService.postStandalone({
    productId: plain.id, type: 'RECEIPT', qtyMilli: 100000, unitCostCentavos: 2000, actor: sessions.OWNER,
  });

  const before = settingsService.get('transaction_discount_tiers');
  settingsService.set('transaction_discount_tiers', [
    { min_subtotal_centavos: 100000, discount_bp: 200, label: '2% over ₱1,000' },
    { min_subtotal_centavos: 500000, discount_bp: 500, label: '5% over ₱5,000' },
  ], sessions.OWNER);

  try {
    // ── PR-202 binds an OWNER, whose role ceiling is 100% ──
    //
    // This is the case the rule exists for and the one a backwards implementation gets
    // wrong: the owner outranks everybody and is still stopped by the category. They
    // are **not** stopped by PR-105 — TX-404 is theirs — so this cart reports exactly
    // one refusal, and it is the category's.
    const overCap = pricingService.priceCart({
      lines: [{ productId: vet.id, qtyMilli: 1000, discountCentavos: 2000 }],   // 20% of ₱100
      taxMode: 'NONE',
      actorRole: 'OWNER',
    });
    assert.equal(overCap.requires_authorisation, true);
    assert.deepEqual(overCap.authorisations.map((a) => a.rule_id), ['PR-202']);

    const capRefusal = overCap.authorisations[0];
    assert.match(capRefusal.message, /above the 5% cap on Capped Vet Lines/);
    assert.match(capRefusal.message, /overrides any role ceiling/);
    assert.equal(capRefusal.requires_role, null, 'nobody at the counter can release a category cap');
    assert.equal(overCap.lines[0].category_max_discount_bp, 500);

    // ── Requirement 6: **both** blocking decisions on one line, in one pass ──
    //
    // The same 20% keyed by a cashier is above their 2% ceiling (the role binds here,
    // being lower than the category's 5%) *and* prices the line below the ₱90 average
    // cost. A counter told about one, sent to fetch a manager, and only then told about
    // the other has been made to ask twice for one sale — which is the behaviour
    // TASK-009 established this reporting to prevent.
    const both = pricingService.priceCart({
      lines: [{ productId: vet.id, qtyMilli: 1000, discountCentavos: 2000 }],
      taxMode: 'NONE',
      actorRole: 'CASHIER',
    });
    assert.deepEqual(both.authorisations.map((a) => a.rule_id).sort(), ['PR-105', 'PR-203']);

    // And the role is what bound, not the category — the lower of the two, in the
    // direction that happens to be the ordinary one.
    assert.equal(both.lines[0].discount_decision.bound_by, 'ROLE');
    assert.match(
      both.authorisations.find((a) => a.rule_id === 'PR-203').message,
      /above your 2% limit/
    );

    // ── PR-106 applies to the basket, and only one band ──
    const basket = pricingService.priceCart({
      lines: [{ productId: plain.id, qtyMilli: 60000 }],       // 60 KG at ₱100 = ₱6,000
      taxMode: 'NONE',
      actorRole: 'CASHIER',
    });
    assert.equal(basket.pre_discount_subtotal_centavos, 600000);
    assert.equal(basket.transaction_tier.applies, true);
    assert.equal(basket.transaction_tier.discount_bp, 500, 'the 5% band, not 2% + 5%');
    assert.equal(basket.transaction_discount_centavos, 30000);
    assert.equal(basket.transaction_discount_source, 'AUTOMATIC');
    assert.equal(basket.total_centavos, 570000);
    // A tier is the owner's standing decision, so it exercises nobody's ceiling — a
    // cashier whose limit is 2% may still sell a basket that earns 5%.
    assert.equal(basket.requires_authorisation, false);

    // ── PR-206 at the transaction level: the tier against a hand-typed figure ──
    const beaten = pricingService.priceCart({
      lines: [{ productId: plain.id, qtyMilli: 60000 }],
      taxMode: 'NONE',
      actorRole: 'OWNER',
      transactionDiscountCentavos: 10000,                      // ₱100 by hand
    });
    assert.equal(beaten.transaction_discount_centavos, 30000, 'the ₱300 tier wins, and they do not add');
    assert.equal(beaten.transaction_discount_source, 'AUTOMATIC');
    assert.equal(beaten.transaction_discount_choice.suppressed.source, 'MANUAL');
    assert.equal(beaten.transaction_discount_choice.suppressed.centavos, 10000);

    // And the other way round: a hand-typed figure larger than the band applies, and
    // is then subject to the ceiling, because a person chose it.
    const bigger = pricingService.priceCart({
      lines: [{ productId: plain.id, qtyMilli: 60000 }],
      taxMode: 'NONE',
      actorRole: 'OWNER',
      transactionDiscountCentavos: 60000,                      // ₱600 by hand, 10%
    });
    assert.equal(bigger.transaction_discount_centavos, 60000);
    assert.equal(bigger.transaction_discount_source, 'MANUAL');
    assert.equal(bigger.transaction_discount_choice.suppressed.source, 'AUTOMATIC');

    // A cashier typing the same figure is refused, and the refusal is in the same list
    // the lines' refusals are in — a caller that only walked the lines would have
    // completed it.
    const overCeiling = pricingService.priceCart({
      lines: [{ productId: plain.id, qtyMilli: 60000 }],
      taxMode: 'NONE',
      actorRole: 'CASHIER',
      transactionDiscountCentavos: 60000,
    });
    assert.equal(overCeiling.requires_authorisation, true);
    const txnRefusal = overCeiling.authorisations.find((a) => a.line === null);
    assert.ok(txnRefusal, 'the transaction discount has its own entry');
    assert.equal(txnRefusal.rule_id, 'PR-203');
    assert.ok(txnRefusal.requires_role);

    // ── PR-205 still caps the lot ──
    assert.throws(
      () => pricingService.priceCart({
        lines: [{ productId: plain.id, qtyMilli: 60000, discountCentavos: 600000 }],
        taxMode: 'NONE',
        actorRole: 'OWNER',
        transactionDiscountCentavos: 100000,
      }),
      (err) => err.ruleId === 'PR-205'
    );

    // ── The quantity-break seam TASK-023 left, now filled by TASK-024 ──
    //
    // It answers nothing for a product with no bands defined, which is this one — so
    // the assertion is unchanged in meaning: a line with no break and no manual figure
    // carries no discount, and PR-206 had nothing to weigh.
    assert.deepEqual(pricingService.automaticLineDiscount(), {
      centavos: 0, rule_id: 'PR-104', why: null,
    });
    assert.equal(basket.lines[0].discount_source, 'NONE');
  } finally {
    settingsService.set('transaction_discount_tiers', before, sessions.OWNER);
  }
});

test('TC-INT-92: the policy endpoint serves the tiers, so no screen holds a copy', async () => {
  const before = settingsService.get('transaction_discount_tiers');
  settingsService.set('transaction_discount_tiers', [
    { min_subtotal_centavos: 250000, discount_bp: 300, label: '3% over ₱2,500' },
  ], sessions.OWNER);

  try {
    const res = await call('/sales/pricing-policy', { token: tokens.CASHIER });
    assert.equal(res.status, 200);
    const body = await res.json();

    // Requirement 7, and TC-UI-07's obligation applied to the counter.
    assert.equal(body.discount_rules.transaction_tiers.bands.length, 1);
    assert.equal(body.discount_rules.transaction_tiers.bands[0].discount_bp, 300);
    assert.equal(body.discount_rules.compounding.compounds, false);
    assert.ok(Array.isArray(body.discount_rules.category_ceilings.categories));

    // The cashier's own ceiling still comes with it, as it did before.
    assert.equal(body.discount_ceiling_bp, settingsService.get('discount_ceiling_cashier_bp'));
  } finally {
    settingsService.set('transaction_discount_tiers', before, sessions.OWNER);
  }
});
