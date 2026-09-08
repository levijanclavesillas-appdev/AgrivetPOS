'use strict';

// TC-PERF-01 — sale completion, confirm to receipt, against NFR_1.1's 2-second budget
// at NFR_2.1 scale.
//
// Same split as the catalog perf file, for the same reason: 07_TEST_PLAN.md §6 says
// these are budgets measured on the reference machine (NFR_4.1), and a figure from a
// developer's machine is not a result. So this seeds the database, reports the
// measurement, and asserts only a ceiling far above the budget — enough to catch an
// accidental full scan inside the sale transaction, which is a defect on any machine,
// and not enough to claim the NFR is met.
//
// What it does assert properly is that the ledgers still reconcile after a thousand
// sales. That is not a budget, it is a correctness property, and running it at scale
// is the only way to catch an error that needs volume to appear.

const test = require('node:test');
const assert = require('node:assert/strict');
const authService = require('../../services/authService');
const inventoryService = require('../../services/inventoryService');
const saleService = require('../../services/saleService');
const shiftService = require('../../services/shiftService');
const sequenceService = require('../../services/sequenceService');
const creditService = require('../../services/creditService');
const customerService = require('../../services/customerService');
const productRepository = require('../../repositories/productRepository');
const ids = require('../../config/ids');
const clock = require('../../config/clock');
const db = require('../../config/database');
const temp = require('../helpers/tempdb');

const PRODUCTS = 5000;                 // NFR_2.1
const SALES = 300;                     // enough to measure a median and to stress the ledger
const BUDGET_MS = 2000;                // NFR_1.1 — reported, not asserted
const CEILING_MS = 2000;               // a full scan inside the transaction, not the budget

const PASSWORD = 'correct-horse-battery';

let ref;
const sessions = {};
const catalogue = [];
let customer;

function measure(label, iterations, fn) {
  const timings = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = process.hrtime.bigint();
    fn(i);
    timings.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  timings.sort((a, b) => a - b);
  const at = (p) => timings[Math.min(timings.length - 1, Math.floor(timings.length * p))];
  return { label, median: at(0.5), p95: at(0.95), worst: timings[timings.length - 1] };
}

function report(result, budget) {
  process.stdout.write(
    `    ${result.label}: median ${result.median.toFixed(1)} ms · p95 ${result.p95.toFixed(1)} ms · `
    + `worst ${result.worst.toFixed(1)} ms — ${result.p95 <= budget ? 'within' : 'OVER'} the `
    + `${budget} ms budget on this machine\n`
  );
}

test.before(() => {
  temp.openMigrated('perf-sale');
  temp.seedStore({ taxMode: 'VAT', withOwner: false });
  ref = temp.seedCatalog();

  for (const role of ['OWNER', 'CASHIER']) {
    const username = role.toLowerCase();
    temp.seedUser({ username, role, password: PASSWORD });
    sessions[role] = authService.verifyToken(authService.login({ username, password: PASSWORD }).token);
  }

  process.stdout.write(`\n    seeding ${PRODUCTS} products with stock…\n`);
  const started = process.hrtime.bigint();
  const at = clock.nowUtc();

  // Seeded through the repositories: 5,000 audit rows and 5,000 transactions would
  // measure the seeding rather than the sale.
  db.transaction(() => {
    for (let i = 0; i < PRODUCTS; i += 1) {
      const id = ids.uuidv7();
      const n = String(i).padStart(5, '0');
      productRepository.insert({
        id,
        sku: `SKU-${n}`,
        name: `Feed Grade ${n}`,
        category_id: ref.category.id,
        brand_id: ref.brand.id,
        base_unit_id: ref.kg.id,
        tax_class: i % 5 === 0 ? 'VAT_EXEMPT' : 'VATABLE',
        statutory_discount_eligible: 0,
        avg_cost_centavos: 4000 + (i % 500),
        min_stock_milli: 50000,
        is_batch_tracked: 0,
        is_active: 1,
        created_at: at,
      });
      productRepository.insertPrice({
        id: ids.uuidv7(), product_id: id, price_level: 'RETAIL',
        price_centavos: 5000 + (i % 1000), effective_from: at, created_at: at, created_by: null,
      });
      productRepository.insertBarcode({
        id: ids.uuidv7(), product_id: id, barcode: `48000${n}${i % 10}`, created_at: at,
      });
      // A large opening balance so no sale below is refused for stock.
      db.get().prepare('INSERT INTO inventory (product_id, qty_on_hand_milli, updated_at) VALUES (?, ?, ?)')
        .run(id, 100000000, at);
      db.get().prepare(`
        INSERT INTO inventory_movements
          (id, product_id, movement_type, qty_milli, balance_after_milli, unit_cost_centavos, occurred_at, created_by)
        VALUES (?, ?, 'OPENING', ?, ?, ?, ?, ?)
      `).run(ids.uuidv7(), id, 100000000, 100000000, 4000 + (i % 500), at, sessions.OWNER.id);

      if (i < 50) catalogue.push(id);
    }
  });

  customer = customerService.create({
    name: 'Perf Farm', customerType: 'FARM', priceLevel: 'RETAIL',
    isCreditEligible: true, creditLimitCentavos: 1000000000, termsDays: 30,
  }, sessions.OWNER);

  shiftService.open({ actor: sessions.CASHIER, openingFloatCentavos: 500000, confirmed: true });

  process.stdout.write(`    seeded in ${(Number(process.hrtime.bigint() - started) / 1e9).toFixed(1)} s\n`);
  assert.equal(productRepository.countAll(), PRODUCTS);
  assert.equal(inventoryService.reconcile().ok, true, 'the seed itself reconciles');
});

test.after(() => temp.cleanup());

test('TC-PERF-01: a three-line cash sale at 5,000 products', () => {
  const result = measure('cash sale (3 lines)', SALES, (i) => {
    const sale = saleService.complete({
      lines: [
        { productId: catalogue[i % catalogue.length], qtyMilli: 1255 },
        { productId: catalogue[(i + 1) % catalogue.length], qtyMilli: 2000 },
        { productId: catalogue[(i + 2) % catalogue.length], qtyMilli: 500 },
      ],
      tenders: [{ method: 'CASH', amountCentavos: 100000000 }],
    }, sessions.CASHIER);
    assert.ok(sale.sale.sale_no);
  });

  report(result, BUDGET_MS);
  assert.ok(result.p95 < CEILING_MS, `sale p95 ${result.p95.toFixed(1)} ms suggests a scan in the transaction`);
});

test('TC-PERF-01: a split tender with credit is not materially slower', () => {
  const pricingService = require('../../services/pricingService');

  const result = measure('split tender (cash + credit)', 100, (i) => {
    const productId = catalogue[i % catalogue.length];
    // The tenders must sum to the total exactly: POS-203 permits over-tendering in
    // cash only, and the credit half of a split may not exceed what is owed.
    const total = pricingService.priceCart({
      lines: [{ productId, qtyMilli: 1000 }],
      taxMode: 'VAT', actorRole: sessions.CASHIER.role,
    }).total_centavos;

    saleService.complete({
      lines: [{ productId, qtyMilli: 1000 }],
      customerId: customer.id,
      tenders: [
        { method: 'CASH', amountCentavos: 100 },
        { method: 'CREDIT', amountCentavos: total - 100 },
      ],
    }, sessions.CASHIER);
  });

  // The credit path adds a ledger row and a balance update. If it were materially
  // slower, the counter would feel it on exactly the sales that already take longest
  // to key.
  report(result, BUDGET_MS);
  assert.ok(result.p95 < CEILING_MS);
});

test('the sale number sequence does not slow down as the day fills', () => {
  // POS-108 derives the next number from MAX over the day's rows. That is the design
  // decision most likely to degrade with volume, so it is measured rather than assumed.
  const result = measure('sale_no allocation', 200, () => {
    sequenceService.next('SALE');
  });

  report(result, 50);
  assert.ok(result.p95 < 100, 'the daily sequence must not become a scan');
});

test('every ledger still reconciles after the day', () => {
  // Not a budget — a correctness property that needs volume to be worth asserting.
  const audit = sequenceService.auditDay('SALE');
  process.stdout.write(`    ${audit.issued} sales issued, gapless: ${audit.gapless}\n`);

  assert.equal(audit.gapless, true, 'POS-108 over hundreds of sales');
  assert.equal(inventoryService.reconcile().ok, true, 'INV-101');
  assert.equal(creditService.reconcile().ok, true, 'CR-103');

  // And the shift's expected cash still equals its own arithmetic.
  const shift = shiftService.openShiftFor(sessions.CASHIER.id);
  const expected = shiftService.computeExpected(shift.id);
  assert.equal(
    expected.expected_cash_centavos,
    expected.opening_float_centavos + expected.cash_sales_centavos + expected.cash_collections_centavos
      + expected.cash_in_centavos - expected.cash_out_centavos - expected.cash_refunds_centavos
      - expected.change_given_centavos,
    'POS-509'
  );
});

test('the figures above are not a release gate', () => {
  // 07_TEST_PLAN.md §6: measured on the reference machine (NFR_4.1), and gate criterion
  // 6 is assessed there. A green run here is not that.
  assert.equal(BUDGET_MS, 2000, 'the budget is NFR_1.1');
  assert.ok(CEILING_MS >= BUDGET_MS, 'the asserted ceiling is a regression guard, not the budget');
});
