'use strict';

// TASK-033 — the day's total, broken into the groupings a store acts on.
//
// The obligation is the same one TASK-016 set and is worth restating, because this task
// is four new ways to get it wrong: a breakdown that does not add up to the report it
// came from is a defect, not a presentation choice. Every grouping here is checked
// against a figure that was already trusted before this task existed.
//
// The three cases split along the three things that can actually break:
//
//   TC-INT-120  the groupings reconcile — and are seen to fail when one is corrupted
//   TC-INT-121  the catalogue-outward query finds what the line-inward ones cannot
//   TC-INT-122  the ledger's own arithmetic, against the on-hand figure the POS sells on

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../../config/database');
const clock = require('../../config/clock');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const inventoryService = require('../../services/inventoryService');
const shiftService = require('../../services/shiftService');
const saleService = require('../../services/saleService');
const voidService = require('../../services/voidService');
const reportService = require('../../services/reportService');
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';

let ref;
let owner;
let till;
let clerk;
let feed;
let vet;
let sachet;
let dusty;
let twine;
let today;

const sessionFor = (username) => authService
  .verifyToken(authService.login({ username, password: PASSWORD }).token);

test.before(() => {
  temp.openMigrated('analysis');
  temp.seedStore({ withOwner: false, taxMode: 'NONE' });
  ref = temp.seedCatalog();

  for (const [username, role] of [['owner', 'OWNER'], ['till', 'CASHIER'], ['clerk', 'CASHIER']]) {
    temp.seedUser({ username, role, password: PASSWORD });
  }
  owner = sessionFor('owner');

  // Two categories, three units, and one product that will never sell.
  feed = productService.create({
    sku: 'FEED-HG', name: 'Hog Grower Pellets', categoryId: ref.category.id,
    baseUnitId: ref.kg.id, retailPriceCentavos: 6000,
  }, owner);
  vet = productService.create({
    sku: 'VET-DW', name: 'Dewormer', categoryId: ref.otherCategory.id,
    baseUnitId: ref.piece.id, retailPriceCentavos: 12000,
  }, owner);
  sachet = productService.create({
    sku: 'VET-SA', name: 'Vitamin Sachet', categoryId: ref.otherCategory.id,
    baseUnitId: ref.piece.id, retailPriceCentavos: 3500,
  }, owner);
  dusty = productService.create({
    sku: 'MISC-HL', name: 'Rope Halter', categoryId: ref.otherCategory.id,
    baseUnitId: ref.piece.id, retailPriceCentavos: 25000,
  }, owner);
  // The other half of requirement 5: one that barely sells, for the threshold.
  twine = productService.create({
    sku: 'MISC-TW', name: 'Baling Twine', categoryId: ref.otherCategory.id,
    baseUnitId: ref.piece.id, retailPriceCentavos: 15000,
  }, owner);

  for (const [product, cost] of [[feed, 4000], [vet, 7000], [sachet, 2000], [dusty, 15000], [twine, 9000]]) {
    inventoryService.postStandalone({
      productId: product.id, type: 'RECEIPT', qtyMilli: 200000,
      unitCostCentavos: cost, actor: owner,
    });
  }
  // The write-off the movement report exists to make visible.
  inventoryService.postStandalone({
    productId: feed.id, type: 'DAMAGE', qtyMilli: 12000,
    reason: 'Sacks torn in the stockroom', actor: owner,
  });

  till = sessionFor('till');
  till = { ...till, shiftId: shiftService.open({ actor: till, openingFloatCentavos: 200000, confirmed: true }).shift.id };

  // One till sells feed in kilos, the other sells the veterinary shelf by the piece.
  // Both shifts stay open: what this file is about is who rang up what, and closing a
  // drawer is POS-510's subject rather than this one's.
  for (const qty of [10000, 25000, 45000]) {
    saleService.complete({
      lines: [{ productId: feed.id, qtyMilli: qty }],
      tenders: [{ method: 'CASH', amountCentavos: 300000 }],
    }, till);
  }
  clerk = sessionFor('clerk');
  clerk = { ...clerk, shiftId: shiftService.open({ actor: clerk, openingFloatCentavos: 100000, confirmed: true }).shift.id };

  saleService.complete({
    lines: [{ productId: vet.id, qtyMilli: 30000 }, { productId: sachet.id, qtyMilli: 20000 }],
    tenders: [{ method: 'CASH', amountCentavos: 500000 }],
  }, clerk);
  saleService.complete({
    lines: [{ productId: sachet.id, qtyMilli: 40000 }, { productId: twine.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 200000 }],
  }, clerk);

  // A void, so RPT-106's exclusion is exercised in every grouping rather than assumed.
  const voided = saleService.complete({
    lines: [{ productId: vet.id, qtyMilli: 10000 }],
    tenders: [{ method: 'CASH', amountCentavos: 200000 }],
  }, clerk);
  voidService.post({
    saleId: voided.sale.id,
    reason: 'Customer changed their mind at the counter',
  }, owner);

  today = clock.manilaDate(clock.nowUtc());
});

test.after(() => temp.cleanup());

test('TC-INT-120: the category and cashier breakdowns reconcile to the daily report', () => {
  const daily = reportService.daily({ from: today }, owner);
  const byCategory = reportService.byCategory({ from: today }, owner);
  const byCashier = reportService.byCashier({ from: today }, owner);

  // The two anchors are different on purpose, and the difference is the whole reason
  // this case exists: a category is a property of a **line**, and a transaction
  // discount, the change and a return all belong to the **sale**. There is no honest
  // way to split ₱50 off a mixed basket between feed and veterinary supplies, so the
  // category report reconciles to revenue and says so.
  assert.equal(byCategory.reconciliation.balances, true);
  assert.equal(byCategory.reconciliation.report_centavos, daily.profit.revenue_centavos);
  assert.equal(
    byCategory.categories.reduce((sum, row) => sum + row.revenue_centavos, 0),
    daily.profit.revenue_centavos,
    'every peso of revenue lands in exactly one category'
  );

  // A sale has one cashier, so that grouping reconciles to net sales themselves.
  assert.equal(byCashier.reconciliation.balances, true);
  assert.equal(byCashier.reconciliation.report_centavos, daily.totals.gross_sales_net_centavos);
  assert.equal(
    byCashier.cashiers.reduce((sum, row) => sum + row.net_centavos, 0),
    daily.totals.gross_sales_net_centavos
  );

  // RPT-106: the voided sale is in none of it, and is still visible as a void.
  assert.equal(daily.header.voided_excluded_count, 1);
  assert.equal(byCategory.header.voided_excluded_count, 1);
  const vetRow = byCategory.categories.find((row) => row.category_name === 'Veterinary');
  const stillVoided = db.get().prepare("SELECT COUNT(*) AS n FROM sales WHERE status = 'VOIDED'").get().n;
  assert.equal(stillVoided, 1);
  assert.ok(vetRow.revenue_centavos > 0, 'the shelf still sold something');

  // Profit is the sale-line snapshot (RPT-104, MON-005), and it is the same arithmetic
  // as the daily report's — grouped, not recomputed.
  assert.equal(
    byCategory.categories.reduce((sum, row) => sum + row.cost_centavos, 0),
    daily.profit.cost_centavos
  );
  assert.equal(byCategory.totals.gross_profit_centavos, daily.profit.gross_profit_centavos);

  // Requirement 2's own measures, checked against the two columns beside them.
  for (const row of byCashier.cashiers) {
    assert.equal(row.average_sale_centavos, Math.round(row.net_centavos / row.sale_count));
    assert.ok(row.sale_count > 0);
  }
  assert.deepEqual(
    byCashier.cashiers.map((row) => row.cashier).sort(),
    ['clerk', 'till'],
    'both tills appear, and the void does not make a third'
  );
});

test('TC-INT-120: the reconciliation is seen to fail, not merely asserted to pass', () => {
  // A guard that has never been observed failing is a guard nobody has tested, and this
  // one is guarding against a specific shape: the category breakdown joins `products` to
  // `categories`, and an **inner** join silently drops every line whose category cannot
  // be resolved. The report would look entirely correct — fewer rows, a smaller total,
  // no error anywhere — until somebody added the column up.
  //
  // So one product is orphaned from its category, with foreign keys off for exactly as
  // long as that takes, and the reconciliation is asserted to notice.
  const orphaned = db.get().prepare('SELECT id, category_id FROM products WHERE sku = ?').get('FEED-HG');
  const before = reportService.byCategory({ from: today }, owner);

  db.get().pragma('foreign_keys = OFF');
  try {
    db.get().prepare("UPDATE products SET category_id = 'no-such-category' WHERE id = ?").run(orphaned.id);

    const broken = reportService.byCategory({ from: today }, owner);
    assert.equal(broken.reconciliation.balances, false, 'the lost rows are noticed');
    assert.ok(broken.reconciliation.difference_centavos < 0, 'and the report is short, not long');
    assert.equal(
      broken.reconciliation.grouped_centavos + Math.abs(broken.reconciliation.difference_centavos),
      broken.reconciliation.report_centavos,
      'by exactly what went missing'
    );
    assert.ok(broken.categories.length < before.categories.length);
  } finally {
    db.get().prepare('UPDATE products SET category_id = ? WHERE id = ?').run(orphaned.category_id, orphaned.id);
    db.get().pragma('foreign_keys = ON');
  }

  const after = reportService.byCategory({ from: today }, owner);
  assert.equal(after.reconciliation.balances, true);
  assert.equal(after.reconciliation.grouped_centavos, before.reconciliation.grouped_centavos);
});

test('TC-INT-121: slow movers find what every other report cannot, and fast movers rank both ways', () => {
  const movers = reportService.movers({ from: today }, owner);

  // The product that sold nothing. It has no sale line, so it is in no grouping above
  // and in no `dailyLines` — which is precisely the report's reason to exist.
  const slow = movers.slow.map((row) => row.sku);
  assert.ok(slow.includes('MISC-HL'), 'a product with no sales at all appears');
  assert.equal(movers.slow.length, 1, 'and nothing that sold does');

  const halter = movers.slow.find((row) => row.sku === 'MISC-HL');
  assert.equal(halter.sale_count, 0);
  assert.equal(halter.revenue_centavos, 0);
  // Requirement 6: the figures that make the row actionable rather than only true.
  assert.equal(halter.qty_on_hand_milli, 200000);
  assert.equal(halter.on_hand_value_centavos, 3000000, '200 × ₱150 sitting on the shelf');
  assert.equal(halter.never_sold, true);
  // Requirement 5: created inside the range, so it is flagged rather than judged.
  assert.equal(halter.new_in_range, true);
  assert.match(halter.verdict, /too new to judge/);

  // Two rankings, and they are genuinely different orders — which is the reason the
  // report refuses to merge them. The sachet outsells everything by the piece and is
  // nowhere near the top by money; the feed is the other way round.
  const byRevenue = movers.by_revenue.map((row) => row.sku);
  assert.equal(byRevenue[0], 'FEED-HG', 'feed takes the most money');

  const pieces = movers.by_units.find((group) => group.unit_code === 'PC');
  assert.equal(pieces.products[0].sku, 'VET-SA', '60 sachets outsell 30 dewormers by the piece');
  assert.ok(byRevenue.indexOf('VET-SA') > byRevenue.indexOf('VET-DW'),
    'and the money ranks them the other way round — which is why there are two lists');

  // UOM-001: the units ranking is partitioned by base unit, never merged across them.
  const units = movers.by_units.map((group) => group.unit_code).sort();
  assert.deepEqual(units, ['KG', 'PC']);
  const kilos = movers.by_units.find((group) => group.unit_code === 'KG');
  assert.deepEqual(kilos.products.map((row) => row.sku), ['FEED-HG']);
  assert.match(movers.units_note, /not across them/);

  // The threshold includes zero and goes past it.
  const wider = reportService.movers({ from: today, maxRevenueCentavos: 20000 }, owner);
  assert.ok(wider.slow.length > movers.slow.length, 'a threshold catches the nearly-still ones');
  assert.ok(wider.slow.some((row) => row.sku === 'MISC-TW'), 'one length of twine in a whole day');
  assert.match(wider.slow_note, /₱200\.00 or less/);

  // An inactive product is excluded — a discontinued line is not a slow mover, it is a
  // line the store already decided about.
  productService.update(dusty.id, { isActive: false }, owner);
  try {
    const after = reportService.movers({ from: today }, owner);
    assert.equal(after.slow.length, 0, 'the only slow mover was retired, so there are none');
  } finally {
    productService.update(dusty.id, { isActive: true }, owner);
  }
});

test('TC-INT-122: movement analysis reconciles to the on-hand change', () => {
  const report = reportService.movements({ from: today }, owner);

  // INV-101, as arithmetic. Everything in this fixture was posted today, so the ledger
  // opens at zero and closes at what the shelves hold.
  assert.equal(report.reconciliation.opening_milli, 0);
  assert.equal(report.reconciliation.balances, true);
  assert.equal(report.reconciliation.closing_milli, report.reconciliation.on_hand_total_milli);
  assert.equal(report.reconciliation.matches_on_hand, true);
  assert.equal(report.reconciliation.products_out_of_balance, 0);

  const onHand = db.get().prepare('SELECT COALESCE(SUM(qty_on_hand_milli), 0) AS q FROM inventory').get().q;
  assert.equal(report.reconciliation.closing_milli, onHand);

  const byType = Object.fromEntries(report.types.map((row) => [row.movement_type, row]));

  // Requirement 7's whole point: the store can finally see what it wrote off.
  assert.equal(byType.DAMAGE.movement_count, 1);
  assert.equal(byType.DAMAGE.net_milli, -12000);
  assert.equal(byType.DAMAGE.direction, 'OUT');
  // INV-106: a decrease carries no cost, so the value is an estimate and says so.
  assert.equal(byType.DAMAGE.costed_value_centavos, 0);
  assert.equal(byType.DAMAGE.estimated_value_centavos, 48000, '12 KG at the ₱40 average');
  assert.equal(byType.DAMAGE.value_basis, 'ESTIMATE_AT_CURRENT_AVERAGE');

  // A receipt does carry one, and it is a fact rather than an estimate.
  assert.equal(byType.RECEIPT.value_basis, 'MOVEMENT_COST');
  assert.equal(byType.RECEIPT.estimated_value_centavos, 0);
  assert.equal(byType.RECEIPT.costed_value_centavos, 200 * (4000 + 7000 + 2000 + 15000 + 9000));

  // INV-102 keeps a voided sale's movements — both of them — so the ledger reconciles
  // even though the sale is in no sales figure anywhere (RPT-106).
  assert.equal(byType.SALE_VOID.movement_count, 1);
  assert.equal(byType.SALE.net_milli + byType.SALE_VOID.net_milli, -(80000 + 30000 + 60000 + 1000),
    'the void gave the 10 pieces back, so the net of the two is what actually left');

  // The product grain is where a quantity means anything (UOM-001).
  const damaged = report.products.find((row) => row.movement_type === 'DAMAGE');
  assert.equal(damaged.sku, 'FEED-HG');
  assert.equal(damaged.unit_code, 'KG');
  assert.equal(damaged.net_display, '-12 KG');

  // And the filter narrows to one type without changing the totals above it.
  const only = reportService.movements({ from: today, type: 'DAMAGE' }, owner);
  assert.equal(only.filter_type, 'DAMAGE');
  assert.equal(only.products.length, 1);
  assert.equal(only.types.length, report.types.length, 'the summary is still the whole range');
});

test('TC-INT-122: the ledger and the materialised figure disagreeing is reported, not hidden', () => {
  // INV-101 is a promise about two numbers, and the report is one of the few places it
  // can be checked. Breaking the materialised side must be visible here — a report that
  // recomputed on-hand from the ledger would agree with itself and notice nothing.
  const row = db.get().prepare('SELECT product_id, qty_on_hand_milli FROM inventory LIMIT 1').get();
  db.get().prepare('UPDATE inventory SET qty_on_hand_milli = qty_on_hand_milli + 1000 WHERE product_id = ?')
    .run(row.product_id);

  try {
    const broken = reportService.movements({ from: today }, owner);
    assert.equal(broken.reconciliation.balances, true, 'the ledger still agrees with itself');
    assert.equal(broken.reconciliation.matches_on_hand, false, 'and disagrees with the shelf figure');
  } finally {
    db.get().prepare('UPDATE inventory SET qty_on_hand_milli = ? WHERE product_id = ?')
      .run(row.qty_on_hand_milli, row.product_id);
  }

  assert.equal(reportService.movements({ from: today }, owner).reconciliation.matches_on_hand, true);
});

test('TC-INT-120: TX-421 refuses a cashier the store’s breakdown and serves them their own', () => {
  const cashier = sessionFor('till');

  for (const report of ['byCategory', 'byCashier', 'byProduct', 'movers']) {
    assert.throws(
      () => reportService[report]({ from: today }, cashier),
      (err) => err.status === 403 && err.ruleId === 'TX-421',
      `${report} refuses a store-wide read by a cashier`
    );
  }

  // Their own shift is served, and it is a real answer rather than an empty one.
  const own = reportService.byCategory({ from: today, shiftId: till.shiftId }, cashier);
  assert.equal(own.header.store_scope, 'ONE SHIFT');
  assert.deepEqual(own.categories.map((row) => row.category_name), ['Feeds']);
  assert.equal(own.reconciliation.balances, true);

  // And another till's is not.
  assert.throws(
    () => reportService.byCashier({ from: today, shiftId: clerk.shiftId }, cashier),
    (err) => err.status === 403 && err.ruleId === 'TX-421'
  );
});

test('TC-INT-120: every one of them exports, with RPT-106’s header in the file', () => {
  for (const report of ['by-category', 'by-cashier', 'by-product', 'movers', 'movements']) {
    const { csv, filename } = reportService.exportCsv(report, { from: today }, owner);
    assert.match(filename, new RegExp(`^${report}-${today}\\.csv$`));
    // The disclosure travels with the file: a CSV mailed to a bookkeeper with no range
    // and no statement about voids is a spreadsheet of numbers nobody can date.
    assert.match(csv, /"Range","2\d{3}-\d{2}-\d{2}/);
    assert.match(csv, /"Voided sales excluded"/);
    assert.match(csv, /"Generated by","owner"/);
    assert.ok(csv.endsWith('\r\n'));
  }

  // Figure for figure with the screen (TASK-016's criterion), in pesos as displayed.
  const built = reportService.byCategory({ from: today }, owner);
  const { csv } = reportService.exportCsv('by-category', { from: today }, owner);
  for (const row of built.categories) {
    assert.ok(csv.includes(`"${row.category_name}"`), `${row.category_name} is in the file`);
    assert.ok(csv.includes(`"${(row.revenue_centavos / 100).toFixed(2)}"`));
  }
  assert.match(csv, /"Reconciles","YES"/);
});
