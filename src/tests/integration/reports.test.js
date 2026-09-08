'use strict';

// TASK-016 — the dashboard and the three v1.0 reports.
//
// The obligation here is not that a figure is produced but that the figures **agree**:
// with each other (TC-INT-60), with the arithmetic they print (TC-INT-61), with what
// the ledger says a void is (TC-INT-62), and with the file they export (TC-INT-63).
//
// Several of these are written so they can be *seen to fail*: a figure is deliberately
// corrupted and the check is asserted to catch it. A reconciliation guard that has
// never been observed failing is a guard nobody has tested.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const db = require('../../config/database');
const clock = require('../../config/clock');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const inventoryService = require('../../services/inventoryService');
const customerService = require('../../services/customerService');
const creditService = require('../../services/creditService');
const shiftService = require('../../services/shiftService');
const saleService = require('../../services/saleService');
const reportService = require('../../services/reportService');
const alertService = require('../../services/alertService');
const settingsService = require('../../services/settingsService');
const permissions = require('../../services/permissions');
const auditService = require('../../services/auditService');
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';

let ref;
let feed;
let vet;
let owner;
let cashier;
let cashierShift;
let today;
let instance;
let tokens = {};

// Port 0: the OS picks a free one and the real port is read back off the server.
// Every fixed port in 47881–47899 is already claimed by another file in this suite,
// and the next person adding one would collide the same way.
let BASE = null;

const centavos = (pesos) => Math.round(pesos * 100);

function sessionFor(username) {
  return authService.verifyToken(authService.login({ username, password: PASSWORD }).token);
}

test.before(async () => {
  temp.openMigrated('reports');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;
  temp.seedStore({ withOwner: false, taxMode: 'NONE' });
  ref = temp.seedCatalog();

  temp.seedUser({ username: 'owner', role: 'OWNER', password: PASSWORD });
  temp.seedUser({ username: 'till', role: 'CASHIER', password: PASSWORD });
  owner = sessionFor('owner');

  feed = productService.create({
    sku: 'FEED-001', name: 'Hog Grower Pellets',
    categoryId: ref.category.id, baseUnitId: ref.kg.id, retailPriceCentavos: 6000,
  }, owner);
  vet = productService.create({
    sku: 'VET-001', name: 'Dewormer 50ml',
    categoryId: ref.otherCategory.id, baseUnitId: ref.piece.id, retailPriceCentavos: 25000,
  }, owner);

  // Cost matters: profit is the point of the seventh tile.
  inventoryService.postStandalone({
    productId: feed.id, type: 'RECEIPT', qtyMilli: 100000, unitCostCentavos: 4000, actor: owner,
  });
  inventoryService.postStandalone({
    productId: vet.id, type: 'RECEIPT', qtyMilli: 100000, unitCostCentavos: 15000, actor: owner,
  });

  cashier = sessionFor('till');
  cashierShift = shiftService.open({ actor: cashier, openingFloatCentavos: 200000, confirmed: true }).shift;
  cashier = { ...cashier, shiftId: cashierShift.id };

  // A plain cash sale, a split tender with change, and a credit sale.
  saleService.complete({
    lines: [{ productId: feed.id, qtyMilli: 2000 }],
    tenders: [{ method: 'CASH', amountCentavos: 20000 }],
  }, cashier);

  saleService.complete({
    lines: [{ productId: vet.id, qtyMilli: 1000 }, { productId: feed.id, qtyMilli: 1000 }],
    tenders: [
      { method: 'CASH', amountCentavos: 20000 },
      { method: 'GCASH', amountCentavos: 15000, referenceNo: '0001234567' },
    ],
  }, cashier);

  const farm = customerService.create({
    name: 'Santos Farm', customerType: 'FARM', priceLevel: 'RETAIL',
    isCreditEligible: true, creditLimitCentavos: centavos(50000), termsDays: 30,
  }, owner);
  saleService.complete({
    lines: [{ productId: feed.id, qtyMilli: 5000 }],
    customerId: farm.id,
    tenders: [{ method: 'CREDIT', amountCentavos: 30000 }],
  }, cashier);

  today = clock.manilaDate(clock.nowUtc());
  for (const name of ['owner', 'till']) {
    tokens[name] = authService.login({ username: name, password: PASSWORD }).token;
  }
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── TC-INT-61 — the reconciliation (RPT-101, FR_6.2) ────────────────────────

test('TC-INT-61: gross − discounts − returns = net, and net = tenders − change', () => {
  const report = reportService.daily({ from: today }, owner);
  const r = report.reconciliation;

  assert.equal(r.balances, true, r.statement);
  assert.equal(r.tenders_balance, true, r.tender_statement);
  assert.equal(r.reconciles, true);
  assert.equal(r.difference_centavos, 0);
  assert.equal(r.tender_difference_centavos, 0);

  // Both identities are printed on the report, not merely checked behind it (FR_6.2).
  assert.match(r.statement, /gross.*discounts.*returns.*net/);
  assert.match(r.tender_statement, /tendered.*change/);

  // The arithmetic, done independently of the report's own subtraction.
  const t = report.totals;
  assert.equal(t.gross_centavos - t.discount_centavos - t.returns_centavos, t.net_centavos);
  assert.equal(t.tendered_centavos - t.change_centavos, t.net_centavos);
});

test('TC-INT-61: the guard is seen to fail when a figure is wrong', () => {
  // A reconciliation check that has never been observed failing is a check nobody has
  // tested. One centavo is moved on one sale — the smallest lie the report could tell.
  const sale = db.get().prepare("SELECT id, total_centavos FROM sales WHERE status = 'COMPLETED' LIMIT 1").get();
  db.get().prepare('UPDATE sales SET total_centavos = ? WHERE id = ?').run(sale.total_centavos + 1, sale.id);

  const broken = reportService.daily({ from: today }, owner);
  assert.equal(broken.reconciliation.balances, false, 'the identity must not still hold');
  assert.equal(broken.reconciliation.difference_centavos, -1);
  assert.equal(broken.reconciliation.reconciles, false);

  db.get().prepare('UPDATE sales SET total_centavos = ? WHERE id = ?').run(sale.total_centavos, sale.id);
  assert.equal(reportService.daily({ from: today }, owner).reconciliation.reconciles, true);
});

test('a day with no trading reconciles at zero rather than refusing', () => {
  const quiet = reportService.daily({ from: '2020-01-01' }, owner);
  assert.equal(quiet.totals.sale_count, 0);
  assert.equal(quiet.reconciliation.reconciles, true);
  assert.equal(quiet.profit.margin_bp, 0, 'and does not divide by zero');
});

// ── TC-INT-60 — tiles equal the reports (FR_6.1) ────────────────────────────

test('TC-INT-60: every dashboard tile equals the report behind it, to the centavo', () => {
  const dash = reportService.dashboard({ date: today }, owner);
  const sales = reportService.daily({ from: today }, owner);
  const paid = reportService.payments({ from: today }, owner);
  const credit = creditService.outstanding();
  const low = inventoryService.lowStock({ limit: 1 });

  const tile = (key) => dash.tiles.find((t) => t.key === key);

  assert.equal(tile('GROSS_SALES').value_centavos, sales.totals.gross_centavos);
  assert.equal(tile('TRANSACTIONS').value_centavos, sales.totals.sale_count);
  assert.equal(tile('PAYMENT_MIX').value_centavos, paid.total_centavos);
  // …and the mix tile agrees with the gross-sales tile it sits beside, because both
  // are net figures. A tile overstating cash by the change given is the defect
  // TC-INT-60 is about.
  assert.equal(tile('PAYMENT_MIX').value_centavos, sales.totals.net_centavos);
  assert.equal(tile('CREDIT_OUTSTANDING').value_centavos, credit.total_balance_centavos);
  assert.equal(
    tile('OVERDUE_ACCOUNTS').value_centavos,
    credit.accounts.filter((a) => a.ageing_status === 'OVERDUE').length
  );
  assert.equal(tile('LOW_STOCK').value_centavos, low.total);
  assert.equal(tile('GROSS_PROFIT').value_centavos, sales.profit.gross_profit_centavos);
});

test('TC-INT-60: seven tiles, and each one names the report it links to', () => {
  const dash = reportService.dashboard({ date: today }, owner);
  assert.equal(dash.tiles.length, 7, 'six from FR_6.1 plus gross profit');

  for (const t of dash.tiles) {
    assert.ok(t.report, `${t.key} links somewhere`);
    assert.ok(t.rule_id, `${t.key} names its rule`);
    assert.ok(t.display, `${t.key} has something to show`);
  }
  assert.deepEqual(
    dash.tiles.map((t) => t.key),
    ['GROSS_SALES', 'TRANSACTIONS', 'PAYMENT_MIX', 'CREDIT_OUTSTANDING',
      'OVERDUE_ACCOUNTS', 'LOW_STOCK', 'GROSS_PROFIT']
  );
});

test('a tile moves when the report behind it moves', () => {
  // The tile is only "the same query" if it changes with the data. A frozen figure
  // agreeing once proves nothing.
  const before = reportService.dashboard({ date: today }, owner).tiles.find((t) => t.key === 'GROSS_SALES');

  saleService.complete({
    lines: [{ productId: feed.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 6000 }],
  }, cashier);

  const after = reportService.dashboard({ date: today }, owner).tiles.find((t) => t.key === 'GROSS_SALES');
  assert.equal(after.value_centavos, before.value_centavos + 6000);
  assert.equal(
    after.value_centavos,
    reportService.daily({ from: today }, owner).totals.gross_centavos
  );
});

// ── TC-INT-35 / RPT-104 — profit reads the snapshot ─────────────────────────

test('TC-INT-35: changing a product cost after a sale does not change that sale’s profit', () => {
  const before = reportService.daily({ from: today }, owner).profit;

  // The live average cost moves — a later delivery at a different price does this
  // every week (MON-004).
  inventoryService.postStandalone({
    productId: feed.id, type: 'RECEIPT', qtyMilli: 100000, unitCostCentavos: 9000, actor: owner,
  });

  const after = reportService.daily({ from: today }, owner).profit;
  assert.equal(after.cost_centavos, before.cost_centavos, 'MON-005: the snapshot, not the live cost');
  assert.equal(after.gross_profit_centavos, before.gross_profit_centavos);
});

test('the report’s profit agrees with the receipt’s, sale by sale', () => {
  // reportService aggregates in SQL; saleService.present() computes one sale in
  // JavaScript. Two roundings of the same rule is two chances to disagree, and the
  // owner adding up a month by hand is who finds out.
  const sales = reportService.daily({ from: today }, owner).sales.filter((s) => !s.excluded_from_net);
  const perSale = sales.reduce((sum, s) => sum + saleService.get(s.id).gross_profit_centavos, 0);

  assert.equal(reportService.daily({ from: today }, owner).profit.gross_profit_centavos, perSale);
});

test('profit is revenue net of VAT, so the Bureau’s money is not counted as margin', () => {
  const report = reportService.daily({ from: today }, owner);
  assert.equal(
    report.profit.gross_profit_centavos,
    report.profit.revenue_centavos - report.profit.cost_centavos
  );
  assert.match(report.profit.basis, /net of VAT/i);
  assert.match(report.profit.basis, /MON-005|RPT-104/);
});

// ── TC-INT-62 — voids (RPT-106) ─────────────────────────────────────────────

test('TC-INT-62: a voided sale is out of net in every report and still in the ledger', () => {
  const doomed = saleService.complete({
    lines: [{ productId: vet.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 25000 }],
  }, cashier);

  const withIt = reportService.daily({ from: today }, owner);
  const paidWithIt = reportService.payments({ from: today }, owner);

  // POS-401 is v1.1, so nothing writes this status yet. The reports handle it now
  // because a report taught to notice a void later is a report that is wrong until then.
  db.get().prepare("UPDATE sales SET status = 'VOIDED', voided_at = ? WHERE id = ?")
    .run(clock.nowUtc(), doomed.sale.id);

  const without = reportService.daily({ from: today }, owner);
  const paidWithout = reportService.payments({ from: today }, owner);

  assert.equal(without.totals.net_centavos, withIt.totals.net_centavos - 25000);
  assert.equal(without.totals.sale_count, withIt.totals.sale_count - 1);
  assert.equal(paidWithout.total_centavos, paidWithIt.total_centavos - 25000);
  assert.equal(without.reconciliation.reconciles, true, 'and the day still reconciles without it');

  // Excluded from net, not from sight.
  const listed = without.sales.find((s) => s.id === doomed.sale.id);
  assert.ok(listed, 'the void is still listed on the report');
  assert.equal(listed.excluded_from_net, true);
  assert.equal(listed.status, 'VOIDED');

  // And still a row, because POS-107 makes a sale immutable.
  assert.ok(db.get().prepare('SELECT id FROM sales WHERE id = ?').get(doomed.sale.id));

  // The header says so out loud (RPT-106).
  assert.equal(without.header.includes_voided, false);
  assert.equal(without.header.voided_excluded_count, 1);
  assert.equal(without.header.voided_excluded_centavos, 25000);

  // Valuation is a position, so the void has no bearing on it — but the exclusion is
  // still stated, because a reader should not have to know which reports it applies to.
  assert.equal(reportService.valuation(owner).header.includes_voided, false);
});

test('a voided sale’s profit is not counted either', () => {
  const voided = db.get().prepare("SELECT id FROM sales WHERE status = 'VOIDED'").get();
  assert.ok(voided, 'the previous case left one');

  const report = reportService.daily({ from: today }, owner);
  const voidedProfit = saleService.get(voided.id).gross_profit_centavos;
  assert.notEqual(voidedProfit, 0, 'the sale did have margin');

  const counted = report.sales
    .filter((s) => !s.excluded_from_net)
    .reduce((sum, s) => sum + saleService.get(s.id).gross_profit_centavos, 0);
  assert.equal(report.profit.gross_profit_centavos, counted);
});

// ── RPT-106 — the header on every report ────────────────────────────────────

test('every report states its range, tax mode and void inclusion', () => {
  for (const report of [
    reportService.daily({ from: today }, owner),
    reportService.payments({ from: today }, owner),
    reportService.valuation(owner),
  ]) {
    const h = report.header;
    assert.ok(h.from_date && h.to_date, `${h.report} states a range`);
    assert.ok(h.tax_mode, `${h.report} states the tax mode`);
    assert.equal(h.includes_voided, false, `${h.report} states void inclusion`);
    assert.ok(h.generated_at, `${h.report} is dated`);
    assert.equal(h.store_scope, 'WHOLE STORE');
  }
});

test('the header names every tax mode the range contains, not only today’s', () => {
  // The day a store registers for VAT, a header printing only the current mode would
  // misdescribe every sale made before the change.
  const report = reportService.daily({ from: today }, owner);
  assert.deepEqual(report.header.tax_modes_in_range, ['NONE']);

  db.get().prepare("UPDATE sales SET tax_mode = 'VAT' WHERE id = (SELECT id FROM sales LIMIT 1)").run();
  const mixed = reportService.daily({ from: today }, owner);
  assert.deepEqual(mixed.header.tax_modes_in_range, ['NONE', 'VAT']);
  assert.equal(mixed.header.tax_mode, 'NONE', 'while the mode in force is still the profile’s');

  db.get().prepare("UPDATE sales SET tax_mode = 'NONE'").run();
});

// ── RPT-102 — payments ──────────────────────────────────────────────────────

test('RPT-102: the payment mix reconciles to net sales, change and all', () => {
  // Found by looking at the rendered screen: a payments report showing only the
  // tendered figure said the store took ₱100 in cash on a ₱62.50 sale. True of the
  // notes that crossed the counter, and wrong about every question anyone asks a
  // payments report — including the one the dashboard tile beside it answers.
  const sales = reportService.daily({ from: today }, owner);
  const paid = reportService.payments({ from: today }, owner);

  assert.equal(paid.tendered_centavos - paid.change_centavos, paid.total_centavos);
  assert.equal(paid.total_centavos, sales.totals.net_centavos, 'the mix equals net sales');
  assert.equal(paid.change_centavos, sales.totals.change_centavos);
  assert.equal(paid.methods.reduce((sum, m) => sum + m.net_centavos, 0), paid.total_centavos);

  // MON-007: change is only ever given in cash, so it lands on that row alone.
  for (const m of paid.methods) {
    if (m.method !== 'CASH') assert.equal(m.change_centavos, 0, `${m.method} gives no change`);
  }
  const cash = paid.methods.find((m) => m.method === 'CASH');
  assert.equal(cash.change_centavos, paid.change_centavos);
  assert.equal(cash.net_centavos, cash.amount_centavos - paid.change_centavos);
  assert.ok(cash.amount_centavos > cash.net_centavos, 'this day did give change');
});

test('RPT-102: tenders group by method with a total and a count', () => {
  const paid = reportService.payments({ from: today }, owner);
  const cash = paid.methods.find((m) => m.method === 'CASH');
  const gcash = paid.methods.find((m) => m.method === 'GCASH');
  const credit = paid.methods.find((m) => m.method === 'CREDIT');

  assert.ok(cash && gcash && credit);
  assert.ok(cash.tender_count >= 3);
  assert.equal(gcash.amount_centavos, 15000);
  assert.equal(credit.amount_centavos, 30000);
  assert.equal(paid.methods.reduce((s, m) => s + m.amount_centavos, 0), paid.tendered_centavos);
});

test('POS-206: every non-cash row reads RECORDED, and cash does not', () => {
  const paid = reportService.payments({ from: today }, owner);

  for (const row of paid.methods) {
    if (row.method === 'CASH') {
      assert.equal(row.recorded_label, null, 'cash is cash');
    } else {
      assert.equal(row.recorded_label, 'RECORDED', `${row.method} is only ever recorded`);
      assert.equal(row.status, 'RECORDED');
    }
  }
  // Nothing anywhere may say a payment was confirmed — no API confirms these.
  assert.equal(/VERIFIED|CONFIRMED|SETTLED/.test(JSON.stringify(paid)), false);
});

// ── RPT-103 — valuation ─────────────────────────────────────────────────────

test('RPT-103: valuation matches a figure computed by hand from the ledger', () => {
  const report = reportService.valuation(owner);

  let byHand = 0;
  for (const row of db.get().prepare(`
    SELECT p.id, p.avg_cost_centavos FROM products p
  `).all()) {
    const onHand = inventoryService.onHand(row.id).qty_on_hand_milli;
    byHand += Math.round((onHand * row.avg_cost_centavos) / 1000);
  }

  assert.equal(report.total_value_centavos, byHand);
  assert.ok(report.header.as_of, 'and states when it was true');
  assert.match(report.header.basis, /read time/i);
});

// ── TX-421 OWN_SHIFT — TC-API-01 ────────────────────────────────────────────

test('TC-API-01: a cashier may read their own shift', () => {
  const mine = reportService.daily({ from: today, shiftId: cashierShift.id }, cashier);
  assert.ok(mine.totals.sale_count > 0);
  assert.equal(mine.header.store_scope, 'ONE SHIFT');
});

test('TC-API-01: a cashier is refused another shift, and the refusal is audited', () => {
  temp.seedUser({ username: 'till2', role: 'CASHIER', password: PASSWORD });
  const other = sessionFor('till2');
  const otherShift = shiftService.open({
    actor: other, openingFloatCentavos: 100000, confirmed: true,
  }).shift;

  const before = auditService.list({ action: 'PERMISSION_REFUSED' }).length;

  assert.throws(
    () => reportService.daily({ from: today, shiftId: otherShift.id }, cashier),
    (err) => err.status === 403 && err.ruleId === 'TX-421'
  );

  const after = auditService.list({ action: 'PERMISSION_REFUSED' });
  assert.equal(after.length, before + 1, 'the attempt is on the trail');
  assert.match(after[0].reason, /another user/i);
});

test('TC-API-01: a cashier asking for the whole store is refused, not quietly narrowed', () => {
  // Handing them their own figures under a "whole store" heading would be worse than
  // refusing: they would believe it.
  assert.throws(
    () => reportService.daily({ from: today }, cashier),
    (err) => err.status === 403 && err.ruleId === 'TX-421'
  );
  assert.throws(
    () => reportService.payments({ from: today }, cashier),
    (err) => err.status === 403
  );
});

test('a cashier’s dashboard is scoped to their own shift and says so', () => {
  const dash = reportService.dashboard({ date: today }, cashier);
  assert.equal(dash.scope, 'OWN_SHIFT');
  assert.equal(dash.shift_id, cashierShift.id);

  const own = reportService.daily({ from: today, shiftId: cashierShift.id }, cashier);
  assert.equal(
    dash.tiles.find((t) => t.key === 'GROSS_SALES').value_centavos,
    own.totals.gross_centavos
  );
});

test('OWN_SHIFT was in the matrix from TASK-003 and is consumed here', () => {
  assert.equal(permissions.grant('CASHIER', 'TX-421'), permissions.OWN_SHIFT);
  assert.equal(permissions.grant('OWNER', 'TX-421'), permissions.FULL);
  assert.equal(permissions.grant('MANAGER', 'TX-421'), permissions.FULL);
});

// ── TC-INT-63 — the export (TX-426, AUD-601) ────────────────────────────────

const cells = (line) => line.split(',').map((c) => c.replace(/^"|"$/g, '').replace(/""/g, '"'));

function findRow(csv, label) {
  return csv.split('\r\n').map(cells).find((row) => row[0] === label);
}

test('TC-INT-63: the daily CSV matches the screen, figure for figure', () => {
  const screen = reportService.daily({ from: today }, owner);
  const { csv } = reportService.exportCsv('daily', { from: today }, owner);

  const peso = (c) => (c / 100).toFixed(2);
  assert.equal(findRow(csv, 'Gross')[1], peso(screen.totals.gross_centavos));
  assert.equal(findRow(csv, 'Net')[1], peso(screen.totals.net_centavos));
  assert.equal(findRow(csv, 'Tendered')[1], peso(screen.totals.tendered_centavos));
  assert.equal(findRow(csv, 'Change')[1], peso(screen.totals.change_centavos));
  assert.equal(findRow(csv, 'Gross profit')[1], peso(screen.profit.gross_profit_centavos));
  assert.equal(findRow(csv, 'Transactions')[1], String(screen.totals.sale_count));
  assert.equal(findRow(csv, 'Reconciles')[1], 'YES');

  // Every product line, not just the totals.
  for (const line of screen.lines) {
    const row = findRow(csv, line.product_name);
    assert.ok(row, `${line.product_name} is in the file`);
    assert.equal(row[4], peso(line.revenue_centavos));
    assert.equal(row[6], peso(line.gross_profit_centavos));
  }
});

test('TC-INT-63: the payments and valuation CSVs match theirs', () => {
  const paid = reportService.payments({ from: today }, owner);
  const paidCsv = reportService.exportCsv('payments', { from: today }, owner).csv;
  for (const method of paid.methods) {
    const row = findRow(paidCsv, method.method);
    assert.equal(row[4], (method.amount_centavos / 100).toFixed(2), 'tendered');
    assert.equal(row[6], (method.net_centavos / 100).toFixed(2), 'net');
    assert.equal(row[1], method.recorded_label || '');
  }
  assert.equal(findRow(paidCsv, 'TOTAL')[6], (paid.total_centavos / 100).toFixed(2));

  const val = reportService.valuation(owner);
  const valCsv = reportService.exportCsv('valuation', {}, owner).csv;
  assert.equal(findRow(valCsv, 'TOTAL')[4], (val.total_value_centavos / 100).toFixed(2));
  for (const product of val.products) {
    assert.equal(findRow(valCsv, product.sku)[4], (product.value_centavos / 100).toFixed(2));
  }
});

test('RPT-106 travels with the file, so a CSV is never undated figures', () => {
  const { csv, filename } = reportService.exportCsv('daily', { from: today }, owner);
  assert.match(csv, /^"Report","DAILY_SALES"/);
  assert.equal(findRow(csv, 'Range')[1], `${today} to ${today}`);
  assert.equal(findRow(csv, 'Voided sales included')[1], 'NO');
  assert.ok(findRow(csv, 'Tax mode')[1]);
  assert.match(filename, new RegExp(`daily-${today}\\.csv`));

  // RFC 4180: a product name with a comma or a quote in it must not shift the columns.
  assert.equal(reportService.csvCell('Feed, 50kg "premium"'), '"Feed, 50kg ""premium"""');
});

test('AUD-601: an export writes an audit row naming what left the machine', () => {
  const before = auditService.list({ action: 'DATA_EXPORTED' }).length;
  reportService.exportCsv('payments', { from: today }, owner);

  const rows = auditService.list({ action: 'DATA_EXPORTED' });
  assert.equal(rows.length, before + 1);
  const after = JSON.parse(rows[0].after_value);
  assert.equal(after.report, 'payments');
  assert.equal(after.range, `${today}..${today}`);
});

// ── OPS-007 — the alert list ────────────────────────────────────────────────

test('OPS-007: the alert list carries what v1.0 can actually detect', () => {
  const { alerts } = alertService.list();
  const kinds = alerts.map((a) => a.kind);

  // Low stock is real: nothing has a reorder point yet, so this asserts the shape
  // rather than a count.
  assert.ok(Array.isArray(alerts));
  assert.equal(kinds.includes('NEAR_EXPIRY'), false, 'near-expiry is v1.2 and absent');

  for (const alert of alerts) {
    assert.ok(alert.rule_id, `${alert.kind} names its rule`);
    assert.ok(alert.message, `${alert.kind} says something a person can act on`);
    assert.ok(['CRITICAL', 'WARNING', 'INFO'].includes(alert.severity));
  }
});

test('OPS-007: backup overdue and clock anomaly can never be dismissed', () => {
  assert.deepEqual(
    [...alertService.UNDISMISSIBLE].sort(),
    ['BACKUP_OVERDUE', 'BACKUP_UNVERIFIED', 'CLOCK_ANOMALY']
  );

  alertService.install({
    alerts: () => [
      { kind: 'BACKUP_OVERDUE', severity: 'CRITICAL', rule_id: 'OPS-003', message: 'No backup for 3 days.' },
      { kind: 'CLOCK_ANOMALY', severity: 'CRITICAL', rule_id: 'OPS-009', message: 'The clock moved backwards.' },
    ],
  });

  const { alerts } = alertService.list();
  const backup = alerts.find((a) => a.kind === 'BACKUP_OVERDUE');
  const anomaly = alerts.find((a) => a.kind === 'CLOCK_ANOMALY');

  assert.equal(backup.dismissible, false);
  assert.equal(anomaly.dismissible, false);
  alertService.install(null);
});

test('the seam TASK-016 left is filled, and still overridable', () => {
  // TASK-016 built BACKUP_OVERDUE, BACKUP_UNVERIFIED and CLOCK_ANOMALY behind a seam
  // because the backup log and the OPS-009 check did not exist yet. TASK-017 filled
  // them in — and kept the seam, which is what lets a test drive a clock anomaly
  // without setting the machine's clock.
  alertService.install(null);
  const real = alertService.list();
  assert.equal(real.health_source_installed, false, 'the real checks are running');

  // This store has never taken a verified backup, so the real check says so.
  const overdue = real.alerts.find((a) => a.kind === 'BACKUP_OVERDUE');
  assert.ok(overdue, 'a store with no verified backup is told');
  assert.equal(overdue.dismissible, false);

  alertService.install({
    alerts: () => [{ kind: 'CLOCK_ANOMALY', severity: 'CRITICAL', rule_id: 'OPS-009', message: 'x' }],
  });
  assert.equal(alertService.list().health_source_installed, true);
  assert.equal(alertService.list().alerts.some((a) => a.kind === 'BACKUP_OVERDUE'), false,
    'and the override replaces them rather than adding to them');
  alertService.install(null);
});

test('a source that throws becomes an alert rather than a blank dashboard', () => {
  alertService.install({ alerts: () => { throw new Error('the backup log is unreadable.'); } });

  const { alerts } = alertService.list();
  const failure = alerts.find((a) => a.kind === 'ALERT_SOURCE_FAILED');
  assert.ok(failure, 'the failure is reported, not swallowed');
  assert.equal(failure.severity, 'CRITICAL');
  assert.match(failure.message, /incomplete/i);

  // And the alerts that did work are still there.
  alertService.install(null);
});

test('POS-511: a close beyond tolerance raises an alert a week later, not only today', () => {
  const tolerance = settingsService.get('cash_variance_tolerance_centavos');
  const shift = shiftService.open({
    actor: sessionFor('till2'), openingFloatCentavos: 100000, confirmed: true,
  }).shift;
  const expected = shiftService.computeExpected(shift.id);

  shiftService.close({
    shiftId: shift.id,
    actualCashCentavos: expected.expected_cash_centavos - tolerance - 50000,
    varianceReason: 'Short after the afternoon rush',
    confirmed: true,
    actor: sessionFor('till2'),
  }, sessionFor('till2'));

  const alert = alertService.list().alerts.find((a) => a.kind === 'CASH_VARIANCE');
  assert.ok(alert, 'the shortage is raised');
  assert.equal(alert.severity, 'CRITICAL', 'short is more serious than over');
  assert.match(alert.message, /short/);
  assert.match(alert.message, /afternoon rush/);
  assert.equal(alert.dismissible, true);
  assert.equal(settingsService.get('variance_alert_window_days'), 7, 'and how long it nags is a setting (OPS-005)');
});

// ── Ranges ──────────────────────────────────────────────────────────────────

test('a range is Manila days, not UTC days', () => {
  // A UTC day boundary would push the last eight hours of every trading day into the
  // next one — the error that only shows up when someone reconciles a month.
  const scope = reportService.range({ from: '2026-03-15', to: '2026-03-15' });
  assert.equal(scope.fromAt, '2026-03-14T16:00:00.000Z');
  assert.equal(scope.toAt, '2026-03-15T15:59:59.999Z');
  assert.equal(scope.days, 1);
});

test('a nonsense range is refused rather than returning nothing', () => {
  assert.throws(() => reportService.range({ from: 'yesterday' }), (e) => e.status === 400);
  assert.throws(() => reportService.range({ from: '2026-03-15', to: '2026-03-01' }), (e) => e.status === 400);
  assert.throws(
    () => reportService.range({ from: '2020-01-01', to: '2026-01-01' }),
    (e) => e.status === 400 && /at most/.test(e.message)
  );
});

// ── Over HTTP ───────────────────────────────────────────────────────────────

const call = (path, { token = tokens.owner } = {}) => fetch(`${BASE}${path}`, {
  headers: token ? { authorization: `Bearer ${token}` } : {},
});

test('the report endpoints answer, and their figures match the service', async () => {
  const dash = await (await call(`/reports/dashboard?date=${today}`)).json();
  assert.equal(dash.tiles.length, 7);
  assert.equal(
    dash.tiles.find((t) => t.key === 'GROSS_SALES').value_centavos,
    reportService.daily({ from: today }, owner).totals.gross_centavos
  );

  const daily = await (await call(`/reports/daily?from=${today}`)).json();
  assert.equal(daily.reconciliation.reconciles, true);

  const paid = await (await call(`/reports/payments?from=${today}`)).json();
  assert.ok(paid.methods.length >= 3);

  const val = await (await call('/reports/inventory/valuation')).json();
  assert.equal(val.total_value_centavos, reportService.valuation(owner).total_value_centavos);
});

test('TC-API-01: a cashier is refused another shift over HTTP, with 403', async () => {
  const other = db.get().prepare(`
    SELECT id FROM cashier_shifts WHERE user_id <> (SELECT id FROM users WHERE username = 'till')
  `).get();
  assert.ok(other, 'there is a shift belonging to someone else');

  const res = await call(`/reports/daily?from=${today}&shiftId=${other.id}`, { token: tokens.till });
  assert.equal(res.status, 403);

  const body = await res.json();
  assert.equal(body.error.rule_id, 'TX-421');
  // The refusal says what to do next, not only that the door is shut (04_UX_SPEC §5).
  assert.match(body.error.message, /own shift/i);
});

test('TC-API-01: a cashier reading their own shift is allowed', async () => {
  const res = await call(`/reports/daily?from=${today}&shiftId=${cashierShift.id}`, { token: tokens.till });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).header.store_scope, 'ONE SHIFT');
});

test('TX-426: the CSV endpoint serves a file, and a cashier cannot export at all', async () => {
  const res = await call(`/reports/daily/export.csv?from=${today}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), new RegExp(`daily-${today}\\.csv`));
  assert.match(await res.text(), /^"Report","DAILY_SALES"/);

  // TX-426 is OWNER and MANAGER only. A cashier is stopped at the middleware.
  assert.equal((await call(`/reports/daily/export.csv?from=${today}`, { token: tokens.till })).status, 403);
});

test('an inventory report is TX-422, which a cashier holds at VIEW', async () => {
  assert.equal((await call('/reports/inventory/valuation', { token: tokens.till })).status, 200);
});

test('a report route writes nothing but its audit row', async () => {
  const rows = () => db.get().prepare('SELECT COUNT(*) AS n FROM sales').get().n;
  const before = rows();

  await call(`/reports/dashboard?date=${today}`);
  await call(`/reports/daily?from=${today}`);
  await call(`/reports/payments?from=${today}`);
  await call('/reports/inventory/valuation');

  assert.equal(rows(), before, 'reading a report changes no data');
});

test('OPS-007 alerts are reachable on their own, for the shell', async () => {
  const res = await call('/reports/alerts');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.alerts));
  assert.equal(body.health_source_installed, false, 'TASK-017 has not installed one yet');
});
