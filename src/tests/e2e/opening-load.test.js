'use strict';

// TC-E2E-21 — a whole cutover from three CSVs, then a sale, then both reconciliations.
//
// `TC-E2E-10` is the same morning done by hand, through the catalogue screens, and it
// is the path `Q-4` chose for the first store. This is the path for the second one:
// eight hundred products and a notebook of credit balances, where hand entry is not a
// slower option but an impossible one.
//
// The journey, over HTTP, as the operator drives it:
//
//   1. The store is set up and empty. Categories, brands and units are created first —
//      the load resolves against them and refuses to invent them, because a category
//      carries a discount ceiling (`PR-204`) and a unit is what every quantity in the
//      product means (`UOM-001`).
//   2. The three templates are downloaded, which is where the columns come from.
//   3. The files are rehearsed. They are wrong, the way a first attempt is wrong, and
//      the report names every bad row with the line the operator can scroll to.
//   4. The spreadsheet is fixed and rehearsed again — clean, and still nothing written.
//   5. The load runs: backup, one transaction, both reconciliations reported.
//   6. **Then the store trades.** A sale against loaded stock to a loaded customer, on
//      credit, and the gross profit is right — which is the whole reason `OPS-106`
//      insists on the cost. A cutover that loads and cannot then sell has proved
//      nothing about the day it exists for.
//   7. Both ledgers still reconcile afterwards, with the sale in them.
//
// The last two steps are the ones that make this an end-to-end case rather than a
// second integration test. `TC-INT-98` asserts the average cost is set; only a sale
// proves the figure is the one the margin is computed from.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const server = require('../../server');
const csv = require('../../config/csv');
const temp = require('../helpers/tempdb');

const PASSWORD = 'sack-of-feed-2026';
const CUTOVER = '2026-08-31';

let instance;
let BASE;
let token;
const made = {};
const files = {};

const call = (pathname, { method = 'GET', body = null, tok = token } = {}) => fetch(`${BASE}${pathname}`, {
  method,
  headers: {
    ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

const json = async (res) => {
  const body = await res.json();
  assert.ok(res.ok, `${res.status} ${JSON.stringify(body)}`);
  return body;
};

const file = (headers, rows) => csv.stringify([headers, ...rows]);

test.before(async () => {
  temp.openMigrated('opening-load');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── 1. An empty store, and the reference data the load resolves against ─────

test('TC-E2E-21: a fresh install is set up, and its catalogue is empty', async () => {
  const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-opening-backups-'));

  await json(await call('/setup', {
    method: 'POST', tok: null,
    body: {
      store: {
        storeName: 'Chachi Agrivet — Second Store', address: 'Isulan, Sultan Kudarat',
        contactNo: '09171234567', tin: null,
      },
      taxMode: 'NONE',
      owner: { username: 'chachi', fullName: 'Chachi Dela Cruz', password: PASSWORD, pin: '441703' },
      backupFolder: backups,
      acknowledgedRecoveryCode: true,
    },
  }));

  token = (await json(await call('/auth/login', {
    method: 'POST', tok: null, body: { username: 'chachi', password: PASSWORD },
  }))).token;

  assert.equal((await json(await call('/products'))).total, 0);
});

test('TC-E2E-21: the reference data is created first, because the load will not invent it', async () => {
  made.feeds = (await json(await call('/categories', { method: 'POST', body: { name: 'Feeds' } }))).category;
  made.vet = (await json(await call('/categories', { method: 'POST', body: { name: 'Veterinary' } }))).category;
  made.brand = (await json(await call('/brands', { method: 'POST', body: { name: 'B-MEG' } }))).brand;
  made.kg = (await json(await call('/units', {
    method: 'POST', body: { name: 'Kilogram', code: 'KG', allowsFraction: true },
  }))).unit;
  made.pc = (await json(await call('/units', {
    method: 'POST', body: { name: 'Piece', code: 'PC', allowsFraction: false },
  }))).unit;
});

// ── 2. The templates ────────────────────────────────────────────────────────

test('TC-E2E-21: the operator downloads a template per file', async () => {
  for (const kind of ['products', 'stock', 'balances']) {
    const response = await call(`/data/opening/template/${kind}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), new RegExp(`agrivet_opening_${kind}\\.csv`));

    const rows = csv.parse(await response.text());
    assert.ok(rows.length >= 2, 'a header and at least one example row to copy');
    made[`${kind}Headers`] = rows[0];
  }

  // The stock template asks for the cost by name. `OPS-106` is a column on a
  // spreadsheet before it is a rule in a service, and an operator who is never asked
  // for the cost cannot supply it.
  assert.ok(made.stockHeaders.map(csv.normaliseHeader).includes('unit_cost'));
});

// ── 3. The first rehearsal, which fails the way a first attempt does ────────

test('TC-E2E-21: the first rehearsal names every bad row, and writes nothing', async () => {
  const wrong = {
    products: file(
      ['sku', 'name', 'category', 'base_unit', 'retail_price', 'brand'],
      [
        ['HG-50', 'Hog Grower Pellets', 'Feeds', 'KG', '52.00', 'B-MEG'],
        ['LM-50', 'Layer Mash', 'Feeds', 'KG', '48.00', ''],
        ['VET-AMOX', 'Amoxicillin 100ml', 'Veterinary', 'PC', '320.00', ''],
        ['DRUM-01', 'Molasses', 'Feeds', 'DRUM', '900.00', ''],     // UOM-001: no such unit
      ]
    ),
    stock: file(
      ['sku', 'quantity', 'unit_cost'],
      [
        ['HG-50', '250', '39.00'],
        ['LM-50', '180', ''],                                       // OPS-106: no cost
        ['VET-AMOX', '12', '210.00'],
      ]
    ),
    balances: file(
      ['customer', 'balance', 'code', 'credit_limit', 'terms_days'],
      [
        ['Sitio Maligaya Farm', '12500.00', 'MALIGAYA', '50000.00', '30'],
        ['Aling Nena', '-850.00', '', '5000.00', '15'],             // OPS-107: not negative
      ]
    ),
  };

  const report = await json(await call('/data/opening/validate', { method: 'POST', body: wrong }));
  assert.equal(report.ok, false);
  assert.equal(report.problems.length, 3);

  // Each one carries the rule and the line the operator scrolls to.
  const byRule = Object.fromEntries(report.problems.map((p) => [p.rule_id, p]));
  assert.equal(byRule['UOM-001'].line, 5);
  assert.match(byRule['UOM-001'].message, /no unit "DRUM"/);
  assert.equal(byRule['OPS-106'].line, 3);
  assert.match(byRule['OPS-106'].message, /no unit cost/);
  assert.equal(byRule['OPS-107'].line, 3);
  assert.match(byRule['OPS-107'].message, /store credit/);

  // Three bad rows out of nine, and the summary says which files they are in — so the
  // operator can see how much of the work is already right.
  assert.equal(report.summary.products.accepted, 3);
  assert.equal(report.summary.stock.accepted, 2);
  assert.equal(report.summary.balances.accepted, 1);

  // And nothing has been written. This is the promise the rehearsal is for.
  assert.equal((await json(await call('/products'))).total, 0);
  assert.equal((await json(await call('/customers'))).total, 0);
});

// ── 4. The spreadsheet is fixed, and rehearsed again ────────────────────────

test('TC-E2E-21: the corrected files rehearse clean, still writing nothing', async () => {
  files.products = file(
    ['sku', 'name', 'category', 'base_unit', 'retail_price', 'brand', 'wholesale_price', 'min_stock', 'barcode'],
    [
      ['HG-50', 'Hog Grower Pellets', 'Feeds', 'KG', '52.00', 'B-MEG', '50.00', '100', '4800012345678'],
      ['LM-50', 'Layer Mash', 'Feeds', 'KG', '48.00', '', '', '100', ''],
      ['VET-AMOX', 'Amoxicillin 100ml', 'Veterinary', 'PC', '320.00', '', '', '5', ''],
    ]
  );
  files.stock = file(
    ['sku', 'quantity', 'unit_cost', 'note'],
    [
      ['HG-50', '250', '39.00', 'Counted 31 Aug'],
      ['LM-50', '180', '35.00', ''],
      ['VET-AMOX', '12', '210.00', ''],
    ]
  );
  files.balances = file(
    ['customer', 'balance', 'code', 'contact_no', 'credit_limit', 'terms_days'],
    [
      ['Sitio Maligaya Farm', '12500.00', 'MALIGAYA', '09171234567', '50000.00', '30'],
      ['Aling Nena', '850.00', '', '', '5000.00', '15'],
    ]
  );

  const report = await json(await call('/data/opening/validate', { method: 'POST', body: files }));
  assert.equal(report.ok, true);
  assert.deepEqual(report.problems, []);
  assert.equal((await json(await call('/products'))).total, 0, 'a clean rehearsal is still a rehearsal');
});

// ── 5. The load ─────────────────────────────────────────────────────────────

test('TC-E2E-21: the load runs once, after its backup, and reports both reconciliations', async () => {
  const result = await json(await call('/data/opening', {
    method: 'POST',
    body: { ...files, cutoverAt: CUTOVER, reason: 'Cutover from the blue notebook' },
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.loaded, { products: 3, stock: 3, customers: 2, balances: 2 });
  assert.equal(result.cutover_at, `${CUTOVER}T00:00:00.000Z`);

  // OPS-103: the way back is named before anything was written.
  assert.ok(result.pre_load_backup.file_name);
  assert.equal(result.pre_load_backup.verified, true);

  // Requirement 8: not "1,200 rows loaded", but whether the ledgers agree.
  assert.equal(result.reconciliation.inventory_balances, true);
  assert.equal(result.reconciliation.credit_balances, true);
  assert.match(result.reconciliation.statement, /INV-101, CR-103/);

  // The catalogue exists, priced and stocked, with the cost that makes margin real.
  const listed = (await json(await call('/products?q=HG-50'))).products[0];
  assert.equal(listed.retail_price_centavos, 5200);
  assert.equal(listed.qty_on_hand_milli, 250000);

  const detail = (await json(await call(`/products/${listed.id}`))).product;
  assert.equal(detail.avg_cost_centavos, 3900, 'MON-004: the opening cost, not zero');
  assert.equal(detail.prices.WHOLESALE, 5000);
  made.hog = detail;

  // OPS-107: the balance is on the statement, dated at cutover, in its own words.
  const customers = await json(await call('/customers?q=Maligaya'));
  made.farm = customers.customers[0];
  const credit = await json(await call(`/customers/${made.farm.id}/credit`));
  assert.equal(credit.credit.balance_centavos, 1250000);

  const chronological = [...credit.transactions.rows].reverse();
  assert.equal(chronological[0].type, 'OPENING');
  assert.equal(chronological[0].document_no, 'OPENING-BALANCE');
  assert.equal(chronological[0].occurred_at, `${CUTOVER}T00:00:00.000Z`);
});

test('TC-E2E-21: the load is in the audit trail, with what the store opened worth', async () => {
  const { rows } = await json(await call('/audit?action=DATA_IMPORTED'));
  const entry = rows.find((e) => e.entity_type === 'opening_load');
  assert.ok(entry, 'AUD-601: the cutover is somebody\'s, and dated');

  const after = typeof entry.after === 'string' ? JSON.parse(entry.after) : entry.after;
  // 250×39.00 + 180×35.00 + 12×210.00 = 9,750 + 6,300 + 2,520 = ₱18,570.
  assert.equal(after.opening_stock_value_centavos, 1857000);
  assert.equal(after.opening_balance_total_centavos, 1335000);
});

// ── 6. And then the store trades ────────────────────────────────────────────

test('TC-E2E-21: the store opens and sells loaded stock to a loaded customer, on credit', async () => {
  await json(await call('/shifts/open', {
    method: 'POST', body: { openingFloatCentavos: 200000, confirmed: true },
  }));

  // Scanned by the barcode the CSV carried — the load is not finished until the
  // counter can reach what it wrote.
  const scanned = await json(await call('/products/barcode/4800012345678'));
  assert.equal((scanned.product || scanned).id, made.hog.id);

  const sale = await json(await call('/sales', {
    method: 'POST',
    body: {
      lines: [{ productId: made.hog.id, qtyMilli: 50000 }],       // 50 KG
      customerId: made.farm.id,
      tenders: [{ method: 'CREDIT', amountCentavos: 260000 }],
    },
  }));

  assert.equal(sale.sale.total_centavos, 5200 * 50);

  // The figure OPS-106 exists for. Loaded at a cost of zero this would have read as
  // ₱2,600.00 of pure profit, looked entirely plausible, and been wrong for ever —
  // MON-005 has already snapshotted the cost onto the line.
  assert.equal(sale.gross_profit_centavos, (5200 - 3900) * 50);

  const after = await json(await call(`/inventory/${made.hog.id}`));
  assert.equal(after.on_hand.qty_on_hand_milli, 200000, '250 KG less 50');
});

test('TC-E2E-21: the credit sale lands on top of the opening balance, in order', async () => {
  const credit = await json(await call(`/customers/${made.farm.id}/credit`));

  // CR-103: the balance is the transactions, and the opening line is still the first
  // of them. A statement that started mid-story with an unsourced figure is exactly
  // what OPS-107 exists to prevent.
  assert.equal(credit.credit.balance_centavos, 1250000 + 260000);

  const chronological = [...credit.transactions.rows].reverse();
  assert.equal(chronological[0].type, 'OPENING');
  assert.equal(chronological[chronological.length - 1].type, 'CREDIT_SALE');
});

// ── 7. And it all still reconciles ──────────────────────────────────────────

test('TC-E2E-21: both ledgers reconcile after the load and the trading on top of it', () => {
  const inventoryService = require('../../services/inventoryService');
  const creditService = require('../../services/creditService');

  // INV-101 and CR-103, on a store whose entire history is a spreadsheet and one sale.
  assert.deepEqual(inventoryService.reconcile(), { ok: true, breaks: [], batch_breaks: [] });
  assert.deepEqual(creditService.reconcile().breaks, []);
  assert.equal(creditService.reconcile().ok, true);
});

test('TC-E2E-21: loading the same files again is refused, not silently doubled', async () => {
  // The mistake with the shortest path to it: the operator is not sure the first run
  // worked and presses it again. Every SKU is now in the catalogue, so every row is
  // rejected by name — and a second OPENING movement, which would read as a delivery
  // nobody made, is not posted.
  const again = await call('/data/opening', { method: 'POST', body: { ...files, cutoverAt: CUTOVER } });
  assert.equal(again.status, 400);
  assert.match((await again.json()).error.message, /Nothing has been written/);

  const listed = (await json(await call('/products?q=HG-50'))).products[0];
  assert.equal(listed.qty_on_hand_milli, 200000, 'untouched by the refused second run');
});
