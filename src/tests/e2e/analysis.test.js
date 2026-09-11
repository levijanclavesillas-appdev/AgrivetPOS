'use strict';

// TC-E2E-27 — a quarter of trading across four cashiers and six categories, read four
// ways and reconciling to one net.
//
// The walk TASK-033 describes, over HTTP. The store trades for three months; four
// people work the tills; the stock spans six shelves; a sale is voided and a delivery is
// damaged. Then the owner sits down at the end of it and asks the four questions the
// day's total cannot answer — which shelf, which till, which product, and what is not
// moving — and the inventory clerk asks the fifth.
//
// **The assertion the task exists for is that all of them come back to the same net.**
// Four breakdowns that each look plausible and disagree with the daily report by a few
// hundred pesos is the failure mode here, and it is the one nobody notices until an
// owner adds a column up by hand six weeks later.
//
// **On the backdating.** Every sale below is rung up through `POST /sales` by a real
// cashier with a real shift — there is no path that rings up last month's sale and there
// should not be (`POS-107`). What the fixture then does is move the clock under them, in
// one statement, because a quarter of trading cannot be walked in a test any other way.
// The rows are the ones the POS wrote; only their timestamps are the fixture's.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const db = require('../../config/database');
const clock = require('../../config/clock');
const authService = require('../../services/authService');
const referenceService = require('../../services/referenceService');
const productService = require('../../services/productService');
const inventoryService = require('../../services/inventoryService');
const shiftService = require('../../services/shiftService');
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';

let instance;
let BASE = null;
const tokens = {};
const sessions = {};
const shifts = {};
const products = {};
let today;
let quarterStart;
let voidedSaleNo;

const CASHIERS = ['ana', 'ben', 'cora', 'dan'];

const SHELVES = [
  { name: 'Feeds', sku: 'FEED-HG', product: 'Hog Grower Pellets', unit: 'kg', price: 6000, cost: 4000 },
  { name: 'Veterinary', sku: 'VET-DW', product: 'Dewormer', unit: 'piece', price: 12000, cost: 7000 },
  { name: 'Poultry', sku: 'PLT-BR', product: 'Broiler Starter', unit: 'kg', price: 5500, cost: 3800 },
  { name: 'Hardware', sku: 'HDW-WR', product: 'Chicken Wire', unit: 'piece', price: 45000, cost: 30000 },
  { name: 'Seeds', sku: 'SED-CN', product: 'Hybrid Corn Seed', unit: 'kg', price: 32000, cost: 24000 },
  { name: 'Pesticides', sku: 'PST-GL', product: 'Glyphosate 1L', unit: 'piece', price: 38000, cost: 26000 },
];

const call = (pathname, { method = 'GET', body = null, who = 'boss' } = {}) => fetch(`${BASE}${pathname}`, {
  method,
  headers: {
    ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

const json = async (res) => {
  const body = await res.json();
  assert.ok(res.ok, `${res.status} ${JSON.stringify(body)}`);
  return body;
};

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

test.before(async () => {
  temp.openMigrated('analysis-e2e');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;

  temp.seedStore({ withOwner: false, taxMode: 'NONE' });
  const ref = temp.seedCatalog();

  temp.seedUser({ username: 'boss', role: 'OWNER', password: PASSWORD });
  temp.seedUser({ username: 'stock', role: 'INVENTORY', password: PASSWORD });
  for (const who of CASHIERS) temp.seedUser({ username: who, role: 'CASHIER', password: PASSWORD });

  for (const who of ['boss', 'stock', ...CASHIERS]) {
    const signedIn = authService.login({ username: who, password: PASSWORD });
    tokens[who] = signedIn.token;
    sessions[who] = authService.verifyToken(signedIn.token);
  }

  const units = { kg: ref.kg.id, piece: ref.piece.id };
  const categories = { Feeds: ref.category.id, Veterinary: ref.otherCategory.id };
  for (const name of ['Poultry', 'Hardware', 'Seeds', 'Pesticides']) {
    categories[name] = referenceService.create('categories', { name }, sessions.boss).id;
  }

  for (const shelf of SHELVES) {
    const product = productService.create({
      sku: shelf.sku, name: shelf.product, categoryId: categories[shelf.name],
      baseUnitId: units[shelf.unit], retailPriceCentavos: shelf.price,
    }, sessions.boss);
    inventoryService.postStandalone({
      productId: product.id, type: 'RECEIPT', qtyMilli: 2000000,
      unitCostCentavos: shelf.cost, actor: sessions.boss,
    });
    products[shelf.sku] = product;
  }

  // A seventh product that is stocked and never sells — the one the slow-mover report
  // exists to find, and the one no other report in the system can see.
  products['MISC-HL'] = productService.create({
    sku: 'MISC-HL', name: 'Rope Halter', categoryId: categories.Hardware,
    baseUnitId: units.piece, retailPriceCentavos: 25000,
  }, sessions.boss);
  inventoryService.postStandalone({
    productId: products['MISC-HL'].id, type: 'RECEIPT', qtyMilli: 40000,
    unitCostCentavos: 15000, actor: sessions.boss,
  });

  // The write-off the clerk will go looking for at the end.
  inventoryService.postStandalone({
    productId: products['FEED-HG'].id, type: 'DAMAGE', qtyMilli: 45000,
    reason: 'Sacks soaked when the stockroom roof leaked', actor: sessions.boss,
  });

  // The shelves were stocked before the quarter began, which is what makes a product
  // that sold nothing a slow mover rather than a new line. Same device as the sales
  // below, for the same reason: the catalogue has no route that backdates itself.
  db.get().prepare('UPDATE products SET created_at = ?').run(daysAgo(120));

  for (const who of CASHIERS) {
    shifts[who] = shiftService.open({
      actor: sessions[who], openingFloatCentavos: 200000, confirmed: true,
    }).shift;
    sessions[who] = { ...sessions[who], shiftId: shifts[who].id };
  }

  today = clock.manilaDate(clock.nowUtc());
  quarterStart = clock.manilaDate(daysAgo(89));
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

test('TC-E2E-27 · a quarter of trading, four tills, six shelves', async () => {
  // Each cashier works a different part of the store, which is what makes the two
  // breakdowns say different things — a cashier report that only restates the category
  // report is a cashier report nobody needs.
  const basket = {
    ana: [['FEED-HG', 20000], ['PLT-BR', 10000]],
    ben: [['VET-DW', 3000], ['PST-GL', 2000]],
    cora: [['HDW-WR', 2000], ['SED-CN', 5000]],
    dan: [['FEED-HG', 50000]],
  };

  const made = [];
  for (let week = 0; week < 12; week += 1) {
    for (const who of CASHIERS) {
      const lines = basket[who].map(([sku, qtyMilli]) => ({ productId: products[sku].id, qtyMilli }));
      const sale = await json(await call('/sales', {
        method: 'POST', who,
        body: { lines, tenders: [{ method: 'CASH', amountCentavos: 500000 }] },
      }));
      made.push({ id: sale.sale.id, days: 7 * week + 1 });
    }
  }

  // One sale voided, so RPT-106's exclusion is exercised by every report below rather
  // than assumed by all of them.
  const doomed = await json(await call('/sales', {
    method: 'POST', who: 'ana',
    body: {
      lines: [{ productId: products['SED-CN'].id, qtyMilli: 10000 }],
      tenders: [{ method: 'CASH', amountCentavos: 500000 }],
    },
  }));
  voidedSaleNo = doomed.sale.sale_no;
  await json(await call(`/sales/${doomed.sale.id}/void`, {
    method: 'POST', who: 'boss',
    body: { reason: 'Rang up the wrong seed variety for the farm' },
  }));

  // The clock, moved under rows the POS itself wrote. See the note at the top of this
  // file: there is no route that rings up last month's sale, and there should not be.
  const move = db.get().prepare('UPDATE sales SET occurred_at = ? WHERE id = ?');
  const moveMovements = db.get().prepare(
    'UPDATE inventory_movements SET occurred_at = ? WHERE reference_type = ? AND reference_id = ?'
  );
  db.transaction(() => {
    for (const sale of made) {
      move.run(daysAgo(sale.days), sale.id);
      moveMovements.run(daysAgo(sale.days), 'SALE', sale.id);
    }
  });

  assert.equal(made.length, 48, 'twelve weeks, four tills');
});

test('TC-E2E-27 · the quarter read four ways, all of it reconciling to one net', async () => {
  const rangeQuery = `from=${quarterStart}&to=${today}`;

  const daily = await json(await call(`/reports/daily?${rangeQuery}`));
  const byCategory = await json(await call(`/reports/by-category?${rangeQuery}`));
  const byCashier = await json(await call(`/reports/by-cashier?${rangeQuery}`));
  const byProduct = await json(await call(`/reports/by-product?${rangeQuery}&sort=revenue&limit=50`));

  assert.equal(daily.totals.sale_count, 48, 'the voided sale is in none of it');
  assert.equal(daily.header.voided_excluded_count, 1);

  // Six shelves, and every peso of revenue on exactly one of them.
  assert.equal(byCategory.categories.length, 6);
  assert.equal(byCategory.reconciliation.balances, true);
  assert.equal(byCategory.reconciliation.report_centavos, daily.profit.revenue_centavos);

  // Four tills, and every peso of sales on exactly one of them.
  assert.equal(byCashier.cashiers.length, 4);
  assert.equal(byCashier.reconciliation.balances, true);
  assert.equal(byCashier.reconciliation.report_centavos, daily.totals.gross_sales_net_centavos);
  assert.deepEqual(byCashier.cashiers.map((row) => row.cashier).sort(), CASHIERS);

  // The two breakdowns are of the same money and say different things, which is the
  // reason to have both: Ana's till is feed and poultry, Cora's is hardware and seed.
  const ana = byCashier.cashiers.find((row) => row.cashier === 'ana');
  const cora = byCashier.cashiers.find((row) => row.cashier === 'cora');
  assert.equal(ana.sale_count, 12);
  assert.equal(ana.average_sale_centavos, Math.round(ana.net_centavos / ana.sale_count));
  assert.ok(cora.net_centavos > ana.net_centavos, 'hardware and seed is the bigger basket');
  assert.ok(cora.margin_bp < ana.margin_bp, 'and the thinner margin, which is the point');

  // The product report is the same arithmetic a third time, and it agrees too.
  assert.equal(byProduct.products.length, 6);
  assert.equal(
    byProduct.products.reduce((sum, row) => sum + row.revenue_centavos, 0),
    daily.profit.revenue_centavos
  );
  assert.equal(byProduct.totals.shown_revenue_centavos, byProduct.totals.revenue_centavos);

  // And the sort is the reader's, which is requirement 3's whole content.
  const byQuantity = await json(await call(`/reports/by-product?${rangeQuery}&sort=quantity&limit=50`));
  assert.equal(byQuantity.sort, 'quantity');
  assert.notDeepEqual(
    byQuantity.products.map((row) => row.sku),
    byProduct.products.map((row) => row.sku),
    'money and units are not the same order'
  );

  // RPT-106 on every one of them, which is the header a bookkeeper dates the file by.
  for (const report of [byCategory, byCashier, byProduct]) {
    assert.equal(report.header.from_date, quarterStart);
    assert.equal(report.header.to_date, today);
    assert.equal(report.header.includes_voided, false);
    assert.equal(report.header.voided_excluded_count, 1);
    assert.equal(report.header.generated_by, 'boss');
  }
});

test('TC-E2E-27 · what is not moving, which no other report can see', async () => {
  const movers = await json(await call(`/reports/movers?from=${quarterStart}&to=${today}&top=3`));

  // Two rankings, and they are different orders. Corn seed takes more money than
  // broiler starter; broiler starter moves more kilos. A store reorders on the second.
  assert.equal(movers.by_revenue.length, 3);
  const revenueOrder = movers.by_revenue.map((row) => row.sku);
  const kilos = movers.by_units.find((group) => group.unit_code === 'KG');
  assert.ok(kilos.products.length > 0);
  assert.notDeepEqual(kilos.products.map((row) => row.sku), revenueOrder.slice(0, kilos.products.length));

  // UOM-001: kilos and pieces are ranked apart and never against each other.
  assert.deepEqual(movers.by_units.map((group) => group.unit_code).sort(), ['KG', 'PC']);
  assert.match(movers.units_note, /not across them/);

  // The halter. Stocked at the start of the quarter, sold nothing, and in no other
  // report in the system — every one of them starts at a sale line it does not have.
  assert.equal(movers.slow.length, 1);
  const halter = movers.slow[0];
  assert.equal(halter.sku, 'MISC-HL');
  assert.equal(halter.never_sold, true);
  assert.equal(halter.qty_on_hand_display, '40 PC');
  assert.equal(halter.on_hand_value_centavos, 600000, '₱6,000 tied up in rope');
  assert.equal(halter.verdict, 'Never sold');

  // It is not in the by-product report at any limit, which is the point being made.
  const everything = await json(await call(`/reports/by-product?from=${quarterStart}&to=${today}&limit=1000`));
  assert.equal(everything.products.some((row) => row.sku === 'MISC-HL'), false);
});

test('TC-E2E-27 · the clerk reads the ledger, and the owner’s report is not theirs', async () => {
  // TX-422, not TX-421. The inventory clerk holds no sales permission at all, and the
  // whole reason movement analysis is a separate screen is that they need this and
  // must not have the takings.
  const refused = await call(`/reports/daily?from=${quarterStart}&to=${today}`, { who: 'stock' });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.rule_id, 'TX-421');

  const movements = await json(await call(
    `/reports/movements?from=${quarterStart}&to=${today}`, { who: 'stock' }
  ));

  // INV-101, printed: opening plus what moved is closing, and closing is the shelf.
  assert.equal(movements.reconciliation.balances, true);
  assert.equal(movements.reconciliation.matches_on_hand, true);
  assert.equal(movements.reconciliation.products_out_of_balance, 0);

  const byType = Object.fromEntries(movements.types.map((row) => [row.movement_type, row]));

  // The figure the store could not see before this task: ₱1,800 of feed soaked by a
  // leaking roof, named as an estimate because INV-106 costs nothing on the way out.
  assert.equal(byType.DAMAGE.movement_count, 1);
  assert.equal(byType.DAMAGE.estimated_value_centavos, 180000);
  assert.equal(byType.DAMAGE.costed_value_centavos, 0);
  assert.equal(byType.DAMAGE.value_basis, 'ESTIMATE_AT_CURRENT_AVERAGE');

  // A receipt knows what it cost, and says so as a fact rather than an estimate.
  assert.equal(byType.RECEIPT.value_basis, 'MOVEMENT_COST');
  assert.equal(byType.RECEIPT.estimated_value_centavos, 0);

  // INV-102 keeps the voided sale's movements — both directions — even though the sale
  // is in no sales figure anywhere. That is the difference between out of net and out
  // of sight, and it is why the ledger still reconciles.
  assert.equal(byType.SALE_VOID.movement_count, 1);
  assert.equal(byType.SALE_VOID.net_milli, 10000);

  const damaged = movements.products.find((row) => row.movement_type === 'DAMAGE');
  assert.equal(damaged.sku, 'FEED-HG');
  assert.equal(damaged.net_display, '-45 KG');

  // And the file, which is what actually leaves the building (TX-426 — the clerk does
  // not hold it, so the owner takes the export).
  const forbidden = await call(
    `/reports/movements/export.csv?from=${quarterStart}&to=${today}`, { who: 'stock' }
  );
  assert.equal(forbidden.status, 403);

  const exported = await call(`/reports/movements/export.csv?from=${quarterStart}&to=${today}`);
  assert.equal(exported.status, 200);
  const csv = await exported.text();
  assert.match(csv, /"Report","MOVEMENTS"/);
  assert.match(csv, new RegExp(`"Range","${quarterStart} to ${today}"`));
  assert.match(csv, /"Damaged","1"/);
  assert.match(csv, /"Value basis"/);
});
