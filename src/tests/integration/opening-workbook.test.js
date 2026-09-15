'use strict';

// The onboarding workbook, end to end — pharmacy edition, OPS-105 – OPS-107.
//
//   `TC-INT-129` — a workbook **written by another application** loads an empty store in
//   one pass: its categories, units, brands and supplier, then the products that point
//   at them, their packs, their batch-tracked opening stock and the credit balances.
//   The fixture is `src/tests/fixtures/opening-workbook.xlsx`, made by ExcelJS from our
//   own template (`tools/opening-template/fixture.js`), because what `config/xlsx.js`
//   has to read is what a spreadsheet application writes on save — shared strings,
//   numbers typed into Text columns, date serials, a formula — and not what our writer
//   wrote.
//
//   `TC-INT-130` — sending the same workbook again is safe, and says so: the reference
//   rows the store already has are left as they are (a warning each), the products are
//   refused as already in the catalogue, and every problem carries **the row number
//   Excel shows**, blank rows included. Nothing is written.
//
//   `TC-INT-131` — the three refusals that would otherwise have come from inside the
//   transaction, after a check that called the workbook clean: a pack in a product's
//   own base unit, a fraction of a tablet, and one barcode on two new products.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const server = require('../../server');
const authService = require('../../services/authService');
const settingsService = require('../../services/settingsService');
const creditService = require('../../services/creditService');
const openingDataService = require('../../services/openingDataService');
const openingWorkbookService = require('../../services/openingWorkbookService');
const productRepository = require('../../repositories/productRepository');
const referenceRepository = require('../../repositories/referenceRepository');
const supplierRepository = require('../../repositories/supplierRepository');
const customerRepository = require('../../repositories/customerRepository');
const batchRepository = require('../../repositories/batchRepository');
const dataRepository = require('../../repositories/dataRepository');
const csv = require('../../config/csv');
const temp = require('../helpers/tempdb');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'opening-workbook.xlsx');
const PASSWORD = 'correct-horse-battery';

let BASE = null;
let instance;
const tokens = {};
const sessions = {};

const call = (p, { token = null, method = 'GET', body = null } = {}) => fetch(`${BASE}${p}`, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

const workbook = () => fs.readFileSync(FIXTURE).toString('base64');
const snapshot = () => Object.fromEntries(
  dataRepository.EXPORTABLE.map((table) => [table, dataRepository.countOf(table)])
);
const file = (headers, rows) => csv.stringify([headers, ...rows]);
const retail = (sku) => productRepository.priceAt(
  productRepository.findBySku(sku).id, 'RETAIL', '2099-01-01T00:00:00.000Z'
).price_centavos;

test.before(async () => {
  temp.openEmpty('opening-workbook');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;
  // No catalogue at all: the store the wizard has just finished setting up.
  temp.seedStore({ storeName: 'Test Drugstore', taxMode: 'NONE', withOwner: false });

  for (const role of ['OWNER', 'CASHIER']) {
    const username = role.toLowerCase();
    temp.seedUser({ username, role, password: PASSWORD });
    const signedIn = authService.login({ username, password: PASSWORD });
    tokens[role] = signedIn.token;
    sessions[role] = authService.verifyToken(signedIn.token);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmacy-workbook-backups-'));
  settingsService.set('backup_folder', dir, sessions.OWNER);
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

test('the workbook downloads as an .xlsx, and only for TX-427', async () => {
  const response = await call('/data/opening/workbook', { token: tokens.OWNER });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), openingWorkbookService.CONTENT_TYPE);
  assert.match(response.headers.get('content-disposition'), /pharmacy_opening_template\.xlsx/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.equals(openingWorkbookService.workbook()), 'the bytes the service writes');

  const refused = await call('/data/opening/workbook', { token: tokens.CASHIER });
  assert.equal(refused.status, 403);
});

test('TC-INT-129: a workbook saved by another application checks clean, sheet by sheet', async () => {
  const before = snapshot();
  const response = await call('/data/opening/validate', {
    token: tokens.OWNER, method: 'POST', body: { workbook: workbook() },
  });
  assert.equal(response.status, 200);
  const report = await response.json();

  assert.equal(report.ok, true, JSON.stringify(report.problems));
  const accepted = Object.fromEntries(Object.entries(report.summary).map(([kind, s]) => [kind, s.accepted]));
  assert.deepEqual(accepted, {
    categories: 3, units: 6, brands: 2, suppliers: 1,
    products: 4, packs: 2, stock: 4, balances: 2,
  });
  assert.deepEqual(snapshot(), before, 'a check writes nothing');
});

test('TC-INT-129: …and loads an empty store in one pass', async () => {
  const response = await call('/data/opening', {
    token: tokens.OWNER, method: 'POST', body: { workbook: workbook(), cutoverAt: '2026-09-01' },
  });
  const result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  assert.deepEqual(result.loaded, {
    categories: 3, units: 6, brands: 2, suppliers: 1,
    products: 4, packs: 2, stock: 4, customers: 2, balances: 2,
  });
  assert.equal(result.reconciliation.inventory_balances, true);
  assert.equal(result.reconciliation.credit_balances, true);

  // The reference sheets, as typed. The ceiling was a number in a Text column.
  assert.equal(referenceRepository.findByLabel('categories', 'Personal Care').max_discount_bp, 1000);
  assert.equal(referenceRepository.findByLabel('units', 'ML').allows_fraction, 1);
  assert.equal(referenceRepository.findByLabel('units', 'TAB').allows_fraction, 0);
  // Not mistaken for the legend: "Optional" is the first word of a real brand.
  assert.ok(referenceRepository.findByLabel('brands', 'Optional Health'));
  const supplier = supplierRepository.findByCode('MPS');
  assert.equal(supplier.name, 'Mindanao Pharma Supply');
  assert.equal(supplier.terms_days, 30);

  // Numbers as the person typed them, not as a double prints.
  const para = productRepository.findBySku('PARA-500');
  assert.equal(retail('PARA-500'), 450);
  assert.equal(para.generic_name, 'Paracetamol');
  assert.equal(para.brand_name, 'Sample Pharma');
  assert.equal(para.is_batch_tracked, 1);
  assert.equal(para.statutory_discount_eligible, 1);
  assert.deepEqual(productRepository.barcodesFor(para.id).map((b) => b.barcode), ['4800012345678']);
  assert.equal(retail('LAG-60'), 455, '4.55, not 4.54');
  const cotton = productRepository.findBySku('COTTON-50');
  assert.deepEqual(productRepository.barcodesFor(cotton.id).map((b) => b.barcode), ['0480001234567'],
    'the leading zero survives');

  // Packs, on the product the same workbook created.
  const packs = productRepository.packsFor(para.id);
  assert.deepEqual(packs.map((p) => [p.unit_code, p.factor_milli, p.is_default_sell]), [['BOX', 100000, 1]]);

  // OPS-106 and INV-202: stock with its cost and its batch. The expiry was a date cell,
  // and the supplier was named by its code.
  assert.equal(para.qty_on_hand_milli, 1000000);
  assert.equal(para.avg_cost_centavos, 280);
  const [batch] = batchRepository.forProduct(para.id);
  assert.equal(batch.batch_no, 'P24091');
  assert.equal(batch.expiry_date, '2027-08-31');
  assert.equal(batch.supplier_id, supplier.id);
  assert.equal(batchRepository.forProduct(productRepository.findBySku('LAG-60').id)[0].expiry_date, '2028-01-15');
  // The cost somebody worked out with a formula: the cached result is the value.
  assert.equal(productRepository.findBySku('COTTON-50').avg_cost_centavos, 2200);

  // OPS-107.
  const nena = customerRepository.findByName('Aling Nena');
  assert.equal(creditService.creditFor(nena.id).credit.balance_centavos, 85050);
  const bhc = customerRepository.findByCode('BHC');
  assert.equal(creditService.creditFor(bhc.id).credit.balance_centavos, 1250000);
});

test('TC-INT-130: the same workbook again is left alone, and reported by Excel row number', async () => {
  const before = snapshot();
  const response = await call('/data/opening/validate', {
    token: tokens.OWNER, method: 'POST', body: { workbook: workbook() },
  });
  const report = await response.json();

  assert.equal(report.ok, false);
  // Every reference row is a warning, not a refusal: re-sending after fixing a product
  // is the normal case, and "Medicines" on the Categories tab is the one it already has.
  assert.equal(report.summary.categories.accepted, 0);
  assert.equal(report.summary.units.accepted, 0);
  const referenceWarnings = report.warnings.filter((w) => /already a (category|unit|brand|supplier)/.test(w.message));
  assert.equal(referenceWarnings.length, 3 + 6 + 2 + 1);

  // Products are refused as already in the catalogue — on the rows the sheet shows.
  // LAG-60 is on row 7 because row 6 was left blank, and row 2 is the legend.
  const skuProblems = report.problems.filter((p) => p.rule_id === 'VR-201');
  assert.deepEqual(skuProblems.map((p) => [p.sheet, p.line, p.message.split(' ')[0]]), [
    ['Products', 3, 'PARA-500'], ['Products', 4, 'ASC-500'], ['Products', 5, 'COTTON-50'], ['Products', 7, 'LAG-60'],
  ]);
  // …and every one of them says which tab, because "row 3" names a row on eight tabs.
  for (const entry of [...report.problems, ...report.warnings]) {
    assert.ok(entry.kind && entry.sheet, JSON.stringify(entry));
  }
  assert.deepEqual(snapshot(), before);
});

test('TC-INT-130: a file that is not a workbook is refused with a sentence', async () => {
  const response = await call('/data/opening/validate', {
    token: tokens.OWNER, method: 'POST',
    body: { workbook: Buffer.from('sku,name\nA,B\n').toString('base64') },
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error.message, /not an Excel workbook/);
});

test('TC-INT-131: a pack in the product’s own base unit is refused at the check, not in the load', () => {
  const report = openingDataService.validate({
    products: file(['sku', 'name', 'category', 'base_unit', 'retail_price'],
      [['NEW-IBU', 'Ibuprofen 200mg', 'Medicines', 'TAB', '3.00']]),
    packs: file(['sku', 'unit', 'contains'], [['NEW-IBU', 'TAB', '1']]),
  });
  assert.equal(report.ok, false);
  assert.match(report.problems[0].message, /cannot be in the base unit itself/);
  assert.equal(report.problems[0].rule_id, 'UOM-002');
});

test('TC-INT-131: half a tablet is not opening stock; half a millilitre is', () => {
  const report = openingDataService.validate({
    products: file(['sku', 'name', 'category', 'base_unit', 'retail_price'], [
      ['NEW-MEF', 'Mefenamic 500mg', 'Medicines', 'TAB', '6.00'],
      ['NEW-DROP', 'Eye drops', 'Medicines', 'ML', '12.00'],
    ]),
    stock: file(['sku', 'quantity', 'unit_cost'], [
      ['NEW-MEF', '2.5', '3.00'],
      ['NEW-DROP', '2.5', '8.00'],
    ]),
  });
  assert.deepEqual(report.problems.map((p) => [p.line, p.rule_id]), [[2, 'UOM-002']]);
  assert.match(report.problems[0].message, /not a whole number of TAB/);
});

test('TC-INT-131: a unit arriving on the Units sheet carries its own fraction rule', () => {
  const report = openingDataService.validate({
    units: file(['code', 'name', 'fractions'], [['SACHET', 'Sachet', ''], ['GR', 'Gram', 'yes']]),
    products: file(['sku', 'name', 'category', 'base_unit', 'retail_price'], [
      ['NEW-ORS', 'Oral rehydration salts', 'Medicines', 'SACHET', '9.00'],
      ['NEW-POW', 'Talc powder', 'Personal Care', 'GR', '0.40'],
    ]),
    stock: file(['sku', 'quantity', 'unit_cost'], [
      ['NEW-ORS', '0.5', '6.00'],
      ['NEW-POW', '0.5', '0.20'],
    ]),
  });
  assert.deepEqual(report.problems.map((p) => [p.line, p.rule_id]), [[2, 'UOM-002']]);
});

test('TC-INT-131: one barcode on two new products is refused on the second row', () => {
  const report = openingDataService.validate({
    products: file(['sku', 'name', 'category', 'base_unit', 'retail_price', 'barcode'], [
      ['NEW-A', 'Product A', 'Medicines', 'PC', '1.00', '4800099900011'],
      ['NEW-B', 'Product B', 'Medicines', 'PC', '1.00', '4800099900011'],
    ]),
  });
  assert.deepEqual(report.problems.map((p) => [p.line, p.rule_id]), [[3, 'VR-205']]);
  assert.match(report.problems[0].message, /also on line 2/);
});

// ── TASK-055: the box's barcode, on the Packs sheet ─────────────────────────

test('TASK-055: a pack\'s barcode loads onto the pack, and a code on two things is refused at the check', () => {
  const base = {
    categories: file(['name'], [['Medicines']]),
    units: file(['code', 'name', 'fractions'], [['TAB', 'Tablet', ''], ['BOX', 'Box', '']]),
    products: file(['sku', 'name', 'category', 'base_unit', 'retail_price', 'barcode'],
      [['PB-CET', 'Cetirizine 10mg', 'Medicines', 'TAB', '8.00', '4809000000011']]),
  };

  // The box's code is the loose one's: the same scan cannot mean one tablet and a box.
  const clash = openingDataService.validate({ ...base,
    packs: file(['sku', 'unit', 'contains', 'barcode'], [['PB-CET', 'BOX', '100', '4809000000011']]) });
  assert.equal(clash.ok, false);
  assert.match(clash.problems[0].message, /also on the Products sheet/);
  assert.equal(clash.problems[0].rule_id, 'VR-205');

  const result = openingDataService.run({ ...base,
    packs: file(['sku', 'unit', 'contains', 'barcode'], [['PB-CET', 'BOX', '100', '4809000000028']]) }, sessions.OWNER);
  assert.equal(result.loaded.packs, 1);
  const product = productRepository.findBySku('PB-CET');
  const codes = productRepository.barcodesFor(product.id).map((b) => [b.barcode, b.pack_unit_code]);
  assert.deepEqual(codes, [['4809000000011', null], ['4809000000028', 'BOX']]);
});
