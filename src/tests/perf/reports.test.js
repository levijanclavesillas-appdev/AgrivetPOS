'use strict';

// TC-PERF-05 — the dashboard against NFR_1.5's 3-second budget at 100,000 sale lines.
//
// Same split as the other two perf files, for the reason 07_TEST_PLAN.md §6 gives:
// these are budgets measured on the reference machine (NFR_4.1), and a figure from a
// developer's machine is not a result. So this seeds to scale, reports the
// measurement, and asserts only a ceiling far above the budget — enough to catch a
// dashboard that scans the whole sales table on every tile, which is a defect on any
// machine, and not enough to claim the NFR is met.
//
// The seed writes sale rows directly rather than driving saleService a hundred
// thousand times. That is deliberate: what is being measured is the **read**, and
// three hours of writes to measure a 200 ms query would mean this file never runs.
// The rows are shaped exactly as saleService writes them, and the first assertion is
// that the reports agree with a hand-computed figure over the seeded data — if the
// seed were wrong, every measurement below would be measuring the wrong thing.

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../../config/database');
const ids = require('../../config/ids');
const clock = require('../../config/clock');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const inventoryService = require('../../services/inventoryService');
const shiftService = require('../../services/shiftService');
const reportService = require('../../services/reportService');
const temp = require('../helpers/tempdb');

const PRODUCTS = 200;
const SALES = 25000;
const LINES_PER_SALE = 4;              // 100,000 sale lines — NFR_2.1's reporting scale
// Spread over a quarter, because a range filter that never narrows anything is not
// being measured. The first version of this file put every sale on one day and
// reported that a year cost the same as a day — which was true, and meaningless.
const DAYS = 90;
const BUDGET_MS = 3000;                // NFR_1.5 — reported, not asserted
const CEILING_MS = 3000;               // a full scan per tile, not the budget

const PASSWORD = 'correct-horse-battery';

let owner;
let shift;
let today;
const catalogue = [];

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

const report = (m) => process.stdout.write(
  `    ${m.label}: median ${m.median.toFixed(1)} ms · p95 ${m.p95.toFixed(1)} ms · worst ${m.worst.toFixed(1)} ms`
  + ` — ${m.worst < BUDGET_MS ? 'within' : 'OVER'} the ${BUDGET_MS} ms budget on this machine\n`
);

/** The figures the seed is built from, so the tests can check themselves against it. */
const EXPECTED = {
  grossCentavos: 0, netCentavos: 0, costCentavos: 0, revenueCentavos: 0,
  tenderedCentavos: 0, saleCount: 0, fromDate: null,
};

test.before(() => {
  temp.openMigrated('perf-reports');
  temp.seedStore({ withOwner: false, taxMode: 'NONE' });
  const ref = temp.seedCatalog();

  temp.seedUser({ username: 'owner', role: 'OWNER', password: PASSWORD });
  owner = authService.verifyToken(authService.login({ username: 'owner', password: PASSWORD }).token);

  process.stdout.write(`\n    seeding ${SALES} sales × ${LINES_PER_SALE} lines…\n`);
  const started = Date.now();

  for (let i = 0; i < PRODUCTS; i += 1) {
    const product = productService.create({
      sku: `PERF-${String(i).padStart(5, '0')}`,
      name: `Perf Product ${i}`,
      categoryId: ref.category.id,
      baseUnitId: ref.kg.id,
      retailPriceCentavos: 5000 + i,
    }, owner);
    inventoryService.postStandalone({
      productId: product.id, type: 'RECEIPT', qtyMilli: 10000000,
      unitCostCentavos: 3000 + i, actor: owner,
    });
    catalogue.push({ id: product.id, name: product.name, price: 5000 + i, cost: 3000 + i });
  }

  shift = shiftService.open({ actor: owner, openingFloatCentavos: 200000, confirmed: true }).shift;
  today = clock.manilaDate(clock.nowUtc());

  // The rows, written as saleService writes them.
  const insertSale = db.get().prepare(`
    INSERT INTO sales (id, sale_no, customer_id, shift_id, status, price_level, tax_mode,
      subtotal_centavos, line_discount_centavos, txn_discount_centavos, statutory_discount_centavos,
      vatable_centavos, vat_exempt_centavos, zero_rated_centavos, vat_centavos,
      total_centavos, change_centavos, occurred_at, created_by)
    VALUES (@id, @sale_no, NULL, @shift_id, 'COMPLETED', 'RETAIL', 'NONE',
      @subtotal, 0, 0, 0, 0, 0, 0, 0, @total, @change, @occurred_at, @created_by)
  `);
  const insertItem = db.get().prepare(`
    INSERT INTO sale_items (id, sale_id, line_no, product_id, product_name_snapshot, qty_milli,
      sold_unit_id, sold_pack_factor_milli, unit_price_centavos, price_level_applied,
      unit_cost_centavos, discount_centavos, tax_class_snapshot, tax_centavos, line_total_centavos)
    VALUES (@id, @sale_id, @line_no, @product_id, @name, @qty, @unit, 1000, @price, 'RETAIL',
      @cost, 0, 'VATABLE', 0, @total)
  `);
  const insertTender = db.get().prepare(`
    INSERT INTO sale_tenders (id, sale_id, method, amount_centavos, reference_no, status, created_at)
    VALUES (@id, @sale_id, 'CASH', @amount, NULL, 'RECORDED', @at)
  `);

  const at = clock.nowUtc();
  const base = Date.parse(at);
  const dayOf = (s) => new Date(base - (s % DAYS) * 86400000).toISOString();
  EXPECTED.fromDate = clock.manilaDate(dayOf(DAYS - 1));

  db.transaction(() => {
    for (let s = 0; s < SALES; s += 1) {
      const saleId = ids.uuidv7();
      const lines = [];
      let total = 0;

      for (let l = 0; l < LINES_PER_SALE; l += 1) {
        const product = catalogue[(s * LINES_PER_SALE + l) % catalogue.length];
        const qty = 1000 * (1 + (l % 3));
        const lineTotal = Math.round((product.price * qty) / 1000);
        total += lineTotal;
        EXPECTED.costCentavos += Math.round((product.cost * qty) / 1000);
        lines.push({
          id: ids.uuidv7(), sale_id: saleId, line_no: l + 1, product_id: product.id,
          name: product.name, qty, unit: ref.kg.id, price: product.price,
          cost: product.cost, total: lineTotal,
        });
      }

      // The sale before its lines: sale_items references sales(id), and foreign keys
      // are on (05_TECH_SPEC.md §3.2).
      const change = 100;
      insertSale.run({
        id: saleId, sale_no: `PERF-${String(s).padStart(8, '0')}`, shift_id: shift.id,
        subtotal: total, total, change, occurred_at: dayOf(s), created_by: owner.id,
      });
      for (const line of lines) insertItem.run(line);
      insertTender.run({ id: ids.uuidv7(), sale_id: saleId, amount: total + change, at });

      EXPECTED.grossCentavos += total;
      EXPECTED.netCentavos += total;
      EXPECTED.revenueCentavos += total;
      EXPECTED.tenderedCentavos += total + change;
      EXPECTED.saleCount += 1;
    }
  });

  process.stdout.write(`    seeded in ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
});

test.after(() => temp.cleanup());

test('the seed is what the tests think it is', () => {
  // Every measurement below is meaningless if the rows are not the shape the reports
  // read. This is the first assertion for that reason.
  const lines = db.get().prepare('SELECT COUNT(*) AS n FROM sale_items').get().n;
  assert.equal(lines, SALES * LINES_PER_SALE);

  const daily = reportService.daily({ from: EXPECTED.fromDate, to: today }, owner);
  assert.equal(daily.totals.sale_count, EXPECTED.saleCount);
  assert.equal(daily.totals.gross_centavos, EXPECTED.grossCentavos);
  assert.equal(daily.totals.net_centavos, EXPECTED.netCentavos);
  assert.equal(daily.totals.tendered_centavos, EXPECTED.tenderedCentavos);
  assert.equal(daily.profit.cost_centavos, EXPECTED.costCentavos);
  assert.equal(daily.reconciliation.reconciles, true, 'and 100,000 lines still reconcile');
});

test('TC-PERF-05: the dashboard at 100,000 sale lines', () => {
  const m = measure('dashboard', 10, () => reportService.dashboard({ date: today }, owner));
  report(m);

  // The ceiling, not the budget. A dashboard that scans the sales table once per tile
  // lands in the tens of seconds here, which is what this catches.
  assert.ok(m.worst < CEILING_MS, `worst ${m.worst.toFixed(0)} ms exceeded the ${CEILING_MS} ms ceiling`);
});

test('the reports behind the tiles, measured one at a time', () => {
  for (const m of [
    measure('daily sales', 10, () => reportService.daily({ from: today }, owner)),
    measure('payments', 10, () => reportService.payments({ from: today }, owner)),
    measure('valuation', 10, () => reportService.valuation(owner)),
    measure('gross profit', 10, () => reportService.daily({ from: today, lineLimit: 1 }, owner).profit),
  ]) report(m);
});

test('the range filter narrows the work, rather than reading everything every time', () => {
  const day = measure('one day', 5, () => reportService.daily({ from: today }, owner));
  const quarter = measure('the whole quarter', 5,
    () => reportService.daily({ from: EXPECTED.fromDate, to: today }, owner));
  report(day);
  report(quarter);

  // A quarter costing the same as a day would mean the date index is doing nothing.
  // The ratio is asserted loosely because it is a shape, not a budget.
  assert.ok(quarter.median > day.median, 'a quarter reads more than a day');
  assert.ok(quarter.worst < CEILING_MS);
});

test('008: no reporting statement reads a table it could read an index for', () => {
  // A plan is machine-independent, so unlike every figure above this is a real
  // assertion. A covering index silently dropped by a future migration shows up here
  // as a table scan long before anyone notices the dashboard getting slower.
  const params = {
    fromAt: '2026-01-01T00:00:00.000Z', toAt: '2026-12-31T23:59:59.999Z',
    shiftId: null, limit: 500,
  };
  const plansFor = (sql) => db.get().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params)
    .map((row) => row.detail).join(' | ');

  const items = plansFor(`
    SELECT SUM(i.line_total_centavos - i.tax_centavos) AS r,
           SUM(((i.unit_cost_centavos * i.qty_milli) + 500) / 1000) AS c
    FROM sale_items i JOIN sales s ON s.id = i.sale_id
    WHERE s.status <> 'VOIDED' AND s.occurred_at >= @fromAt AND s.occurred_at <= @toAt
      AND (@shiftId IS NULL OR s.shift_id = @shiftId)`);
  assert.match(items, /COVERING INDEX idx_saleitems_report/);
  assert.equal(/SCAN i\b/.test(items), false, 'sale_items is never scanned');

  const tenders = plansFor(`
    SELECT t.method, SUM(t.amount_centavos) FROM sale_tenders t JOIN sales s ON s.id = t.sale_id
    WHERE s.status <> 'VOIDED' AND s.occurred_at >= @fromAt AND s.occurred_at <= @toAt
      AND (@shiftId IS NULL OR s.shift_id = @shiftId)
    GROUP BY t.method`);
  assert.match(tenders, /INDEX idx_tender_report/);
  assert.equal(/SCAN t\b/.test(tenders), false, 'sale_tenders is never scanned');
});

test('the figures above are not a release gate', () => {
  // 07_TEST_PLAN.md §6: NFR_1.5 is met on the reference machine or it is not met.
  assert.ok(true);
});
