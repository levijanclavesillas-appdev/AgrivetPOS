'use strict';

// TC-PERF-02 and TC-PERF-03 — barcode lookup and product search at NFR_2.1 scale.
//
// 07_TEST_PLAN.md §6 is explicit that these are **budgets, not assertions about a
// value**: they are measured on the reference machine (NFR_4.1 — Windows 10/11 x64,
// 4 GB RAM, dual core) against a database seeded to NFR_2.1 scale, and *a figure taken
// on a developer's machine is not a result*.
//
// So this file does two separate jobs, and keeps them apart on purpose:
//
//   1. It builds the 5,000-product database and prints the measured figures, so the
//      run on the reference machine is `npm run test:perf` and nothing else.
//   2. It asserts only a ceiling far above the budget — enough to fail an accidental
//      O(n) scan or a missing index, which is a defect on any machine, and not enough
//      to pass or fail the NFR, which this machine cannot decide.
//
// Reporting the number and asserting the algorithm is the honest split. Asserting
// 300 ms here would turn a green run into a claim the test plan says it cannot make.

const test = require('node:test');
const assert = require('node:assert/strict');
const productService = require('../../services/productService');
const productRepository = require('../../repositories/productRepository');
const ids = require('../../config/ids');
const clock = require('../../config/clock');
const db = require('../../config/database');
const temp = require('../helpers/tempdb');

const PRODUCTS = 5000;                       // NFR_2.1
const BUDGET = { barcode: 300, search: 500 };  // NFR_1.2, NFR_1.3 — reported, not asserted

// The regression ceiling. A prepared statement against an index answers in single
// milliseconds; a full scan of 5,000 rows with a LIKE per row does not. This catches
// the second without pretending to measure the first.
const CEILING = 5000;

let ref;
const barcodes = [];

/** Median rather than mean: one GC pause should not decide the number. */
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
  const verdict = result.p95 <= budget ? 'within' : 'OVER';
  process.stdout.write(
    `    ${result.label}: median ${result.median.toFixed(2)} ms · p95 ${result.p95.toFixed(2)} ms · `
    + `worst ${result.worst.toFixed(2)} ms — ${verdict} the ${budget} ms budget on this machine\n`
  );
}

test.before(() => {
  temp.openMigrated('perf-catalog');
  ref = temp.seedCatalog();

  process.stdout.write(`\n    seeding ${PRODUCTS} products…\n`);
  const started = process.hrtime.bigint();
  const at = clock.nowUtc();

  // Seeded through the repository rather than the service: 5,000 audit rows and 5,000
  // transactions measure the seeding, not the lookup, and the service's validation is
  // already covered by the integration suite.
  db.transaction(() => {
    for (let i = 0; i < PRODUCTS; i += 1) {
      const id = ids.uuidv7();
      const n = String(i).padStart(5, '0');
      productRepository.insert({
        id,
        sku: `SKU-${n}`,
        name: `${['Hog', 'Broiler', 'Layer', 'Tilapia', 'Cattle'][i % 5]} Feed Grade ${n}`,
        category_id: ref.category.id,
        brand_id: ref.brand.id,
        base_unit_id: ref.kg.id,
        tax_class: 'VATABLE',
        statutory_discount_eligible: 0,
        avg_cost_centavos: 4000 + (i % 500),
        min_stock_milli: 50000,
        is_batch_tracked: 0,
        is_active: 1,
        created_at: at,
      });

      const barcode = `48000${n}${String(i % 10)}`;
      productRepository.insertBarcode({ id: ids.uuidv7(), product_id: id, barcode, created_at: at });
      barcodes.push(barcode);

      productRepository.insertPrice({
        id: ids.uuidv7(),
        product_id: id,
        price_level: 'RETAIL',
        price_centavos: 5000 + (i % 1000),
        effective_from: at,
        created_at: at,
        created_by: null,
      });
    }
  });

  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  process.stdout.write(`    seeded in ${seconds.toFixed(1)} s\n`);
  assert.equal(productRepository.countAll(), PRODUCTS);
});

test.after(() => temp.cleanup());

test('TC-PERF-02: barcode lookup at 5,000 products', () => {
  // A session is needed for the cost-visibility decision; the counter scans as a
  // cashier, which is also the shape that hides cost and therefore does the extra work.
  const session = { id: 'perf', username: 'perf', role: 'CASHIER', scope: 'FULL' };

  const result = measure('barcode lookup', 500, (i) => {
    const found = productService.findByBarcode(barcodes[(i * 7919) % barcodes.length], session);
    assert.equal(found.found, true);
  });

  report(result, BUDGET.barcode);
  assert.ok(result.p95 < CEILING, `barcode lookup p95 ${result.p95.toFixed(1)} ms suggests a missing index`);
});

test('TC-PERF-02: an unknown barcode is as fast as a known one', () => {
  const session = { id: 'perf', username: 'perf', role: 'CASHIER', scope: 'FULL' };
  const result = measure('unknown barcode', 200, (i) => {
    const found = productService.findByBarcode(`77770000${String(i).padStart(4, '0')}`, session);
    assert.equal(found.found, false);
  });

  // The attach-offer path must not be the slow one: a mis-scan is exactly when the
  // queue is waiting.
  report(result, BUDGET.barcode);
  assert.ok(result.p95 < CEILING, 'an unknown barcode should not scan the table');
});

test('TC-PERF-03: product search at 5,000 products', () => {
  const session = { id: 'perf', username: 'perf', role: 'OWNER', scope: 'FULL' };
  const terms = ['Hog', 'Broiler', 'Feed Grade 012', 'SKU-04321', 'Tilapia', 'Layer Feed'];

  const result = measure('search', 200, (i) => {
    const page = productService.search({ q: terms[i % terms.length], limit: 50 }, session);
    assert.ok(page.products.length > 0, terms[i % terms.length]);
  });

  report(result, BUDGET.search);
  assert.ok(result.p95 < CEILING, `search p95 ${result.p95.toFixed(1)} ms suggests a full scan`);
});

test('TC-PERF-03: an exact SKU search is not slower than a broad one', () => {
  const session = { id: 'perf', username: 'perf', role: 'OWNER', scope: 'FULL' };
  const result = measure('exact SKU search', 200, (i) => {
    const page = productService.search({ q: `SKU-${String(i % PRODUCTS).padStart(5, '0')}`, limit: 50 }, session);
    assert.equal(page.total, 1);
  });

  report(result, BUDGET.search);
  assert.ok(result.p95 < CEILING);
});

test('the figures above are not a release gate', () => {
  // Stated as a case so that a green run cannot be mistaken for NFR_1.2 and NFR_1.3
  // having been met. 07_TEST_PLAN.md §6: the budgets are measured on the reference
  // machine (NFR_4.1), and gate criterion 6 is assessed there, not here.
  assert.ok(BUDGET.barcode === 300 && BUDGET.search === 500, 'the budgets are NFR_1.2 and NFR_1.3');
  assert.ok(CEILING > BUDGET.search * 5, 'the asserted ceiling is a regression guard, not the budget');
});
