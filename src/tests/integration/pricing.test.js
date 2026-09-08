'use strict';

// PR-101–PR-205 — price resolution, discount authority and the below-cost floor.
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

test('TC-UT-31: the precedence chain has all four levels, with the two v1.1 ones stubbed', () => {
  // Built now and left returning null on purpose. Retrofitting a precedence order into
  // a shipped pricing engine is how the wrong price reaches a customer, so TASK-024
  // fills in a resolver and changes nothing else.
  const levels = pricingService.precedenceLevels();

  assert.deepEqual(levels.map((l) => l.level), [
    'CUSTOMER_SPECIFIC', 'QUANTITY_BREAK', 'PRICE_LEVEL', 'RETAIL',
  ]);
  assert.deepEqual(levels.map((l) => l.release), ['1.1', '1.1', '1.0', '1.0']);
  assert.deepEqual(levels.map((l) => l.rule_id), ['PR-103', 'PR-104', 'PR-101', 'PR-102']);

  // The two unbuilt ones resolve to nothing rather than to a price.
  for (const step of pricingService.PRECEDENCE.slice(0, 2)) {
    assert.equal(step.resolve({}), null, `${step.level} is v1.1`);
  }
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
