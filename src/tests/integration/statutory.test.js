'use strict';

// FT-309 — the senior citizen and PWD statutory discount. TAX-004, TAX-005, TAX-002,
// TAX-003, PR-204.
//
// The two named cases are `TC-INT-101` and `TC-INT-102`, and between them they answer
// the question the feature exists to answer twice over: **is it off, and does it stay
// off** (the store is not required to grant it until its accountant says so), and
// **when it is on, does the record the law asks for reach the paper**.
//
// The store here is VAT-registered, deliberately. In `NONE` — which is the first
// store's mode — the arithmetic is a 20% price cut and any implementation gets it
// right; in `VAT` it is an exemption *and* a discount, and the wrong reading (20% off
// the inclusive price) differs from the right one by ₱96 on a ₱1,120 line. `TC-UT-51`
// asserts that arithmetic in isolation; this file asserts that the sale, the receipt
// and the report all carry the same answer.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const inventoryService = require('../../services/inventoryService');
const shiftService = require('../../services/shiftService');
const saleService = require('../../services/saleService');
const settingsService = require('../../services/settingsService');
const reportService = require('../../services/reportService');
const auditService = require('../../services/auditService');
const clock = require('../../config/clock');
const saleRepository = require('../../repositories/saleRepository');
const productRepository = require('../../repositories/productRepository');
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

let seq = 0;

/** A product priced at ₱1,120 the kilo, VAT-inclusive — TC-UT-51's own figures. */
function stocked({ retail = 112000, cost = 60000, eligible = false, taxClass = 'VATABLE' } = {}) {
  seq += 1;
  const product = productService.create({
    sku: `SC-${String(seq).padStart(3, '0')}`,
    name: `Statutory Line ${seq}`,
    categoryId: ref.category.id,
    baseUnitId: ref.kg.id,
    taxClass,
    retailPriceCentavos: retail,
    statutoryDiscountEligible: eligible,
  }, sessions.OWNER);

  inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli: 100000, unitCostCentavos: cost, actor: sessions.OWNER,
  });
  return productRepository.findById(product.id);
}

const ID = Object.freeze({ idType: 'SENIOR_CITIZEN', idNo: '12-3456789', name: 'Lolo Ambrosio Cruz' });

const enable = (on) => settingsService.set('statutory_discount_enabled', on, sessions.OWNER);

test.before(async () => {
  temp.openEmpty('statutory');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;
  temp.seedStore({ taxMode: 'VAT', withOwner: false });
  ref = temp.seedCatalog();

  for (const role of ['OWNER', 'MANAGER', 'CASHIER']) {
    const username = role.toLowerCase();
    temp.seedUser({ username, role, password: PASSWORD });
    const signedIn = authService.login({ username, password: PASSWORD });
    tokens[role] = signedIn.token;
    sessions[role] = authService.verifyToken(signedIn.token);
  }

  shiftService.open({ actor: sessions.CASHIER, openingFloatCentavos: 500000, confirmed: true });
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── TC-INT-101 — TAX-004: off, refused while off, and owner-only to turn on ──

test('TC-INT-101: it ships off, and the counter is told so before it is offered', async () => {
  assert.equal(settingsService.get('statutory_discount_enabled'), false,
    'TAX-004 ships OFF: whether an agrivet’s stock qualifies is a question for the store’s accountant');

  // The counter reads the switch from the server rather than deciding for itself, so
  // SCR-301 can hide the key in a store that does not grant the discount.
  const policy = await (await call('/sales/pricing-policy', { token: tokens.CASHIER })).json();
  assert.equal(policy.statutory.enabled, false);
  assert.equal(policy.statutory.discount_bp, 2000, 'the rate is the server’s, never the screen’s (OPS-005)');
  assert.deepEqual(policy.statutory.id_types.map((t) => t.id), ['SENIOR_CITIZEN', 'PWD']);
});

test('TC-INT-101: a claim while off is refused — not quietly priced at nothing', async () => {
  const product = stocked({ eligible: true });

  const res = await call('/sales/price-check', {
    token: tokens.CASHIER,
    method: 'POST',
    body: { lines: [{ productId: product.id, qtyMilli: 1000 }], statutory: ID },
  });

  assert.equal(res.status, 409);
  const { error } = await res.json();
  assert.equal(error.rule_id, 'TAX-004');
  assert.match(error.message, /does not grant/);

  // The failure this refusal exists to prevent: a cart priced as though the claim had
  // been honoured, handed over with nothing taken off and nothing said.
  const refused = await call('/sales', {
    token: tokens.CASHIER,
    method: 'POST',
    body: {
      lines: [{ productId: product.id, qtyMilli: 1000 }],
      tenders: [{ method: 'CASH', amountCentavos: 112000 }],
      statutory: ID,
    },
  });
  assert.equal(refused.status, 409);
  assert.equal(saleRepository.countAll(), 0, 'and nothing was written');
});

test('TC-INT-101: turning it on is owner-only, and the trail says who and when', async () => {
  const refused = await call('/settings', {
    token: tokens.MANAGER, method: 'PUT', body: { statutory_discount_enabled: true },
  });
  assert.equal(refused.status, 403, 'TX-424: a manager tunes the figures they work with, not this one');
  assert.equal(settingsService.get('statutory_discount_enabled'), false);

  const res = await call('/settings', {
    token: tokens.OWNER,
    method: 'PUT',
    body: { statutory_discount_enabled: true, reason: 'Accountant confirmed the household lines qualify' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).changed, ['statutory_discount_enabled']);
  assert.equal(settingsService.get('statutory_discount_enabled'), true);

  // AUD-601: before, after, actor and reason. "Who decided to start granting this, and
  // on whose advice" is the question an assessment asks years later.
  const [row] = auditService.list({ entityId: 'statutory_discount_enabled' });
  assert.equal(row.action, 'SETTING_CHANGED');
  assert.equal(row.actor_username, 'owner');
  assert.deepEqual(JSON.parse(row.before_value), { statutory_discount_enabled: false });
  assert.deepEqual(JSON.parse(row.after_value), { statutory_discount_enabled: true });
  assert.match(row.reason, /Accountant confirmed/);

  enable(false);
});

test('TC-INT-101: on, but the ID is incomplete — refused, because the record is the claim', async () => {
  enable(true);
  const product = stocked({ eligible: true });
  const line = { productId: product.id, qtyMilli: 1000 };

  for (const claim of [
    { idType: 'SENIOR', idNo: '12-3456789', name: 'Lolo Ambrosio' },   // not one of the two
    { idType: 'PWD', idNo: '', name: 'Lolo Ambrosio' },                 // no number
    { idType: 'PWD', idNo: '77-1', name: '   ' },                       // no name
  ]) {
    const res = await call('/sales/price-check', {
      token: tokens.CASHIER, method: 'POST', body: { lines: [line], statutory: claim },
    });
    assert.equal(res.status, 400, JSON.stringify(claim));
    assert.equal((await res.json()).error.rule_id, 'TAX-004');
  }

  // TAX-004's per-product flag: the entitlement covers goods for the beneficiary's own
  // use, and feed for a farm is not that. A claim that reaches no line is refused
  // rather than priced at nothing — the cashier has already asked for the card.
  const ordinary = stocked({ eligible: false });
  const res = await call('/sales/price-check', {
    token: tokens.CASHIER,
    method: 'POST',
    body: { lines: [{ productId: ordinary.id, qtyMilli: 1000 }], statutory: ID },
  });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error.message, /None of these products is eligible/);
  enable(false);
});

// ── TC-INT-102 — the record reaches the sale, the receipt and the report ────

test('TC-INT-102: the ID and the name reach the sale, the receipt and the report', async () => {
  enable(true);
  const product = stocked({ eligible: true });

  const priced = await (await call('/sales/price-check', {
    token: tokens.CASHIER,
    method: 'POST',
    body: { lines: [{ productId: product.id, qtyMilli: 1000 }], statutory: ID },
  })).json();

  // TAX-002 / TAX-003 end to end: ₱1,120 inclusive → ₱1,000 exempt → ₱800 payable.
  assert.equal(priced.lines[0].vat_exemption_centavos, 12000);
  assert.equal(priced.lines[0].statutory_discount_centavos, 20000);
  assert.equal(priced.lines[0].tax_class, 'VAT_EXEMPT');
  assert.equal(priced.total_centavos, 80000);
  assert.equal(priced.tax_amount_centavos, 0, 'an exempt line yields no VAT');

  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 80000 }],
    statutory: ID,
  }, sessions.CASHIER);

  // The sale row: statutory kept apart from both voluntary figures (requirement 7).
  assert.equal(sale.sale.statutory_discount_centavos, 20000);
  assert.equal(sale.sale.line_discount_centavos, 0);
  assert.equal(sale.sale.txn_discount_centavos, 0);
  assert.equal(sale.sale.total_centavos, 80000);
  assert.equal(sale.sale.vat_exempt_centavos, 80000, 'TAX-007: the line is in the exempt bucket');
  assert.equal(sale.sale.vat_centavos, 0);

  // PR-204: recorded in sale_discounts with its type and its actor, like every other
  // discount — and with the three columns TAX-004 requires, which no other type fills.
  const rows = saleRepository.discountsFor(sale.sale.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].discount_type, 'STATUTORY');
  assert.equal(rows[0].original_centavos, 100000, 'taken on the VAT-exclusive amount');
  assert.equal(rows[0].discount_centavos, 20000);
  assert.equal(rows[0].discount_bp, 2000);
  assert.equal(rows[0].statutory_id_type, 'SENIOR_CITIZEN');
  assert.equal(rows[0].statutory_id_no, ID.idNo);
  assert.equal(rows[0].statutory_name, ID.name);
  assert.equal(rows[0].applied_by, sessions.CASHIER.id);

  // The receipt. The law requires the discount, the ID and the name on the document;
  // a discount printed without them is one the store cannot claim back.
  const printed = saleService.printReceipt(sale.sale.id).document.text;
  assert.match(printed, /SC disc/);
  assert.match(printed, /200\.00/);
  assert.match(printed, new RegExp(`SC ID ${ID.idNo}`));
  assert.match(printed, new RegExp(`Name ${ID.name}`));

  // The report. Separate from the voluntary discounts, because they are different
  // claims: the store deducts one and simply gave the other away.
  const day = reportService.daily({ from: clock.manilaDate(sale.sale.occurred_at) }, sessions.OWNER);
  assert.equal(day.totals.statutory_discount_centavos, 20000);
  assert.equal(day.totals.voluntary_discount_centavos, 0);
  assert.equal(day.totals.discount_centavos, 20000);
  assert.match(day.reconciliation.statement, /statutory/);
  assert.equal(day.reconciliation.reconciles, true,
    'gross − discounts − returns = net still holds with a statutory line in the day');
  assert.equal(day.totals.gross_centavos, 100000,
    'gross is what was rung up net of the VAT the exempt line never carried');

  enable(false);
});

// ── TAX-005 in a real cart ──────────────────────────────────────────────────

test('TC-INT-102: TAX-005 — 20% statutory and 5% by hand yield 20%, not 25%', async () => {
  enable(true);
  const product = stocked({ eligible: true });

  // ₱1,000 exclusive. The statutory 20% is ₱200; the cashier types ₱50 as well.
  const priced = await (await call('/sales/price-check', {
    token: tokens.OWNER,
    method: 'POST',
    body: {
      lines: [{ productId: product.id, qtyMilli: 1000, discountCentavos: 5000, discountReason: 'Regular' }],
      statutory: ID,
    },
  })).json();

  assert.equal(priced.lines[0].statutory_discount_centavos, 20000);
  assert.equal(priced.lines[0].line_discount_centavos, 0, 'the hand discount does not apply as well');
  assert.equal(priced.total_centavos, 80000, 'not ₱750 — they do not add together');
  assert.equal(priced.lines[0].discount_source, 'STATUTORY');
  assert.match(priced.lines[0].statutory_choice.why, /do not add together/);

  // Symmetric: a ₱300 clearance beats the ₱200 entitlement, and the beneficiary is not
  // made worse off for presenting an ID. The line is still exempt.
  const larger = await (await call('/sales/price-check', {
    token: tokens.OWNER,
    method: 'POST',
    body: {
      lines: [{ productId: product.id, qtyMilli: 1000, discountCentavos: 30000 }],
      statutory: ID,
    },
  })).json();

  assert.equal(larger.lines[0].statutory_discount_centavos, 0);
  assert.equal(larger.lines[0].line_discount_centavos, 30000);
  assert.equal(larger.lines[0].tax_class, 'VAT_EXEMPT', 'TAX-002: the exemption is not the store’s to withhold');
  assert.equal(larger.total_centavos, 70000);
  enable(false);
});

test('TAX-005: a basket discount does not reach a statutory line by the back door', async () => {
  enable(true);
  const eligible = stocked({ eligible: true });
  const ordinary = stocked({ eligible: false });

  const priced = await (await call('/sales/price-check', {
    token: tokens.OWNER,
    method: 'POST',
    body: {
      lines: [
        { productId: eligible.id, qtyMilli: 1000 },
        { productId: ordinary.id, qtyMilli: 1000 },
      ],
      transactionDiscountCentavos: 10000,
      statutory: ID,
    },
  })).json();

  const [statutoryLine, ordinaryLine] = priced.lines;
  assert.equal(statutoryLine.transaction_discount_centavos, 0,
    'a line under the entitlement takes no share: 20% and a share of the basket is the 25% TAX-005 forbids');
  assert.equal(ordinaryLine.transaction_discount_centavos, 10000, 'the whole share lands on the rest of the basket');
  assert.equal(priced.total_centavos, 80000 + 112000 - 10000);

  // And where there is no rest of the basket, the discount is refused rather than
  // silently dropped or silently compounded.
  const refused = await call('/sales/price-check', {
    token: tokens.OWNER,
    method: 'POST',
    body: {
      lines: [{ productId: eligible.id, qtyMilli: 1000 }],
      transactionDiscountCentavos: 10000,
      statutory: ID,
    },
  });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.rule_id, 'TAX-005');
  enable(false);
});

test('TAX-004: an ordinary line in the same basket is untouched', async () => {
  enable(true);
  const eligible = stocked({ eligible: true });
  const ordinary = stocked({ eligible: false });

  const sale = saleService.complete({
    lines: [
      { productId: eligible.id, qtyMilli: 1000 },
      { productId: ordinary.id, qtyMilli: 1000 },
    ],
    tenders: [{ method: 'CASH', amountCentavos: 192000 }],
    statutory: ID,
  }, sessions.CASHIER);

  assert.equal(sale.sale.total_centavos, 80000 + 112000);
  assert.equal(sale.sale.statutory_discount_centavos, 20000, 'only the eligible line');
  // TAX-003 per line, not in aggregate: one line exempt, the other still VATable.
  assert.equal(sale.sale.vat_exempt_centavos, 80000);
  assert.equal(sale.sale.vatable_centavos, 100000);
  assert.equal(sale.sale.vat_centavos, 12000);

  assert.deepEqual(sale.items.map((i) => i.tax_class), ['VAT_EXEMPT', 'VATABLE']);
  assert.equal(sale.sale.statutory.name, ID.name);
  assert.equal(sale.sale.statutory.id_type_label, 'Senior citizen');
  enable(false);
});
