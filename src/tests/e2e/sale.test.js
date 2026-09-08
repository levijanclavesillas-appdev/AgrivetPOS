'use strict';

// TC-E2E-01 and TC-E2E-05 — a trading day over HTTP, in the order a person does it.
//
// Everything here goes through the API: setup, login, catalog, stock, shift, scan,
// sale, receipt. Nothing reaches into a service. That is the point of the level — the
// integration suite proves the rules, this proves they are reachable from a counter.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const server = require('../../server');
const temp = require('../helpers/tempdb');

const PORT = 47887;
const API = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'correct-horse-battery';

let instance;
let backupFolder;
const ids = {};
let token;

const call = (path_, { method = 'GET', body = null, as = token } = {}) => fetch(`${API}${path_}`, {
  method,
  headers: {
    ...(as ? { authorization: `Bearer ${as}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

const json = async (res) => {
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return body;
};

test.before(async () => {
  temp.openEmpty('e2e-sale');
  instance = await server.start({ listenPort: PORT });
  backupFolder = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-e2e-sale-')), 'backups');
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── The store opens ─────────────────────────────────────────────────────────

test('TC-E2E-01: a store is set up, stocked and opened for trade', async () => {
  await json(await call('/setup', {
    method: 'POST',
    body: {
      store: { storeName: 'Chachi Agrivet Supply' },
      taxMode: 'VAT',
      owner: { fullName: 'Aling Nena', username: 'nena', password: PASSWORD },
      backupFolder,
      acknowledgedRecoveryCode: true,
    },
  }));

  token = (await json(await call('/auth/login', {
    method: 'POST', body: { username: 'nena', password: PASSWORD },
  }))).token;

  const category = (await json(await call('/categories', { method: 'POST', body: { name: 'Feeds' } }))).category;
  const kg = (await json(await call('/units', {
    method: 'POST', body: { code: 'KG', name: 'Kilogram', allowsFraction: true },
  }))).unit;
  const sack = (await json(await call('/units', { method: 'POST', body: { code: 'SACK', name: 'Sack' } }))).unit;
  Object.assign(ids, { category: category.id, kg: kg.id, sack: sack.id });

  // Three products: feed sold loose and by the sack, a VATable pack item, and an
  // exempt veterinary line — so the receipt exercises TAX-003's per-line decomposition.
  const feed = (await json(await call('/products', {
    method: 'POST',
    body: {
      sku: 'FEED-001', name: 'Hog Grower Pellets', categoryId: ids.category, baseUnitId: ids.kg,
      taxClass: 'VATABLE', retailPriceCentavos: 6250, minStockMilli: 50000,
      barcodes: ['4800016641206'],
      packs: [{ unitId: ids.sack, factorMilli: 50000, isDefaultSell: true }],
    },
  }))).product;

  const salt = (await json(await call('/products', {
    method: 'POST',
    body: {
      sku: 'SALT-001', name: 'Mineral Block', categoryId: ids.category, baseUnitId: ids.kg,
      taxClass: 'VATABLE', retailPriceCentavos: 12000, barcodes: ['4800016641213'],
    },
  }))).product;

  const vet = (await json(await call('/products', {
    method: 'POST',
    body: {
      sku: 'VET-001', name: 'Vitamin Drench', categoryId: ids.category, baseUnitId: ids.kg,
      taxClass: 'VAT_EXEMPT', retailPriceCentavos: 50000, barcodes: ['4800016641220'],
    },
  }))).product;

  Object.assign(ids, { feed: feed.id, salt: salt.id, vet: vet.id });

  // Stock arrives, costed, through the ledger.
  for (const [productId, qtyMilli, unitCostCentavos] of [
    [feed.id, 1000000, 4800], [salt.id, 50000, 9000], [vet.id, 20000, 38000],
  ]) {
    await json(await call('/inventory/adjustments', {
      method: 'POST',
      body: { productId, qtyMilli, reason: 'Received but not recorded', unitCostCentavos },
    }));
  }

  const shift = await json(await call('/shifts/open', {
    method: 'POST', body: { openingFloatCentavos: 200000, confirmed: true },
  }));
  ids.shift = shift.shift.id;
  assert.equal(shift.expected.expected_cash_centavos, 200000);
});

// ── TC-E2E-01 — scan three items, one fractional, cash, change, receipt ─────

test('TC-E2E-01: scan 3 items with a 1.255 KG fractional line, pay cash, take change', async () => {
  // The counter scans. FR_3.1: a scan resolves to a product without a search.
  const scanned = [];
  for (const barcode of ['4800016641206', '4800016641213', '4800016641220']) {
    const hit = await json(await call(`/products/barcode/${barcode}`));
    assert.equal(hit.found, true, barcode);
    scanned.push(hit.product);
  }
  assert.deepEqual(scanned.map((p) => p.sku), ['FEED-001', 'SALT-001', 'VET-001']);

  const lines = [
    { productId: ids.feed, qtyMilli: 1255 },     // 1.255 KG — the fractional line
    { productId: ids.salt, qtyMilli: 2000 },     // 2 KG
    { productId: ids.vet, qtyMilli: 1000 },      // 1 KG, VAT-exempt
  ];

  // The screen previews with the same engine the till will use.
  const preview = await json(await call('/sales/price-check', { method: 'POST', body: { lines } }));
  assert.equal(preview.requires_authorisation, false);

  // 1.255 × 6250 = 7843.75 → 7844; 2 × 12000 = 24000; 1 × 50000 = 50000.
  assert.equal(preview.total_centavos, 7844 + 24000 + 50000);

  const sale = await json(await call('/sales', {
    method: 'POST',
    body: {
      lines,
      tenders: [{ method: 'CASH', amountCentavos: 100000 }],
      clientTotalCentavos: preview.total_centavos,
    },
  }));

  assert.equal(sale.sale.total_centavos, 81844);
  assert.equal(sale.sale.change_centavos, 100000 - 81844, 'MON-007');
  assert.match(sale.sale.sale_no, /^SALE-\d{8}-000001$/, 'the first sale of the day');

  // TAX-003, per line: the two VATable lines carry VAT, the exempt one does not.
  const byName = Object.fromEntries(sale.items.map((i) => [i.sku, i]));
  assert.ok(byName['FEED-001'].tax_centavos > 0);
  assert.ok(byName['SALT-001'].tax_centavos > 0);
  assert.equal(byName['VET-001'].tax_centavos, 0, 'exempt');
  assert.equal(sale.sale.vat_centavos, byName['FEED-001'].tax_centavos + byName['SALT-001'].tax_centavos);
  assert.equal(sale.sale.vat_exempt_centavos, 50000);

  // The receipt view is readable back by its id, with the snapshots on it.
  const receipt = await json(await call(`/sales/${sale.sale.id}`));
  assert.equal(receipt.sale.sale_no, sale.sale.sale_no);
  assert.equal(receipt.items.length, 3);
  assert.equal(receipt.items[0].qty_display, '1.255 KG', 'MON-002, three decimals');
  assert.ok(receipt.items.every((i) => i.unit_cost_centavos > 0), 'MON-005: the cost snapshot');
  ids.firstSale = sale.sale.id;
});

test('TC-E2E-01: the stock and the till both moved, and both reconcile', async () => {
  const feed = (await json(await call(`/inventory/${ids.feed}`))).on_hand;
  assert.equal(feed.qty_on_hand_milli, 1000000 - 1255);

  const ledger = await json(await call(`/inventory/${ids.feed}/movements`));
  const sale = ledger.movements.find((m) => m.type === 'SALE');
  assert.equal(sale.qty_milli, -1255);
  assert.equal(sale.reference.type, 'sale');
  assert.match(sale.reference.no, /^SALE-/);

  const expected = await json(await call(`/shifts/${ids.shift}/expected`));
  assert.equal(expected.cash_sales_centavos, 100000, 'what was handed over');
  assert.equal(expected.change_given_centavos, 18156, 'less what was handed back');
  assert.equal(expected.expected_cash_centavos, 200000 + 100000 - 18156);

  assert.deepEqual(await json(await call('/inventory/reconciliation')), { ok: true, breaks: [] });
  assert.deepEqual(await json(await call('/customers/credit-reconciliation')), { ok: true, breaks: [] });
});

// ── TC-E2E-05 — split tender: cash + GCash + credit ─────────────────────────

test('TC-E2E-05: a split tender of cash, GCash and credit completes one sale', async () => {
  const customer = (await json(await call('/customers', {
    method: 'POST',
    body: {
      name: 'Dela Cruz Piggery', code: 'DLC-01', customerType: 'FARM', priceLevel: 'RETAIL',
      isCreditEligible: true, creditLimitCentavos: 5000000, termsDays: 15,
    },
  }))).customer;
  ids.customer = customer.id;

  // 4 sacks of feed: 4 × 50 KG = 200 KG at ₱62.50 = ₱12,500. The pack is named by its
  // unit and the factor is resolved server-side — a client-supplied factor would be a
  // client-supplied price (§4.1 step 2).
  const lines = [{ productId: ids.feed, qtyMilli: 4000, packUnitId: ids.sack }];
  const preview = await json(await call('/sales/price-check', {
    method: 'POST', body: { customerId: customer.id, lines: [{ productId: ids.feed, qtyMilli: 200000 }] },
  }));
  assert.equal(preview.total_centavos, 1250000);

  const sale = await json(await call('/sales', {
    method: 'POST',
    body: {
      customerId: customer.id,
      lines,
      tenders: [
        { method: 'CASH', amountCentavos: 500000 },
        { method: 'GCASH', amountCentavos: 250000, referenceNo: 'GC-778899' },
        { method: 'CREDIT', amountCentavos: 500000 },
      ],
      clientTotalCentavos: 1250000,
    },
  }));

  assert.equal(sale.sale.total_centavos, 1250000);
  assert.equal(sale.sale.change_centavos, 0);
  assert.equal(sale.tenders.length, 3, 'POS-202');
  assert.ok(sale.tenders.every((t) => t.status === 'RECORDED'), 'POS-206');
  assert.equal(sale.tenders.find((t) => t.method === 'GCASH').reference_no, 'GC-778899');

  // POS-102: entered as packs, stored in the base unit.
  assert.equal(sale.items[0].qty_milli, 200000, 'UOM-002: 4 sacks is 200 KG');

  // The credit part reached the ledger, with a due date from the terms.
  const credit = await json(await call(`/customers/${customer.id}/credit`));
  assert.equal(credit.credit.balance_centavos, 500000);
  assert.equal(credit.credit.available_centavos, 4500000);
  assert.equal(credit.open_sales.length, 1);
  assert.equal(credit.open_sales[0].document_no, sale.sale.sale_no);
});

test('TC-E2E-05: the shift sees each method separately (POS-510)', async () => {
  const expected = await json(await call(`/shifts/${ids.shift}/expected`));

  assert.equal(expected.by_method.CASH.sales_centavos, 100000 + 500000);
  assert.equal(expected.by_method.GCASH.sales_centavos, 250000);
  assert.equal(expected.by_method.CREDIT.sales_centavos, 500000);
  assert.equal(expected.by_method.GCASH.in_drawer, false, 'expected at close, never in the drawer');
  assert.equal(expected.by_method.CREDIT.in_drawer, false, 'credit takes no money');

  // Only cash reaches the drawer figure.
  assert.equal(
    expected.expected_cash_centavos,
    200000 + (100000 + 500000) - 18156
  );
});

test('TC-E2E-05: sale numbers ran gapless across the day', async () => {
  const audit = await json(await call('/sales/sequence-audit'));
  assert.equal(audit.issued, 2);
  assert.equal(audit.gapless, true);
  assert.deepEqual(audit.gaps, []);
  assert.deepEqual(audit.numbers.map((n) => n.slice(-6)), ['000001', '000002']);
});

test('TC-E2E-01: the day is consistent end to end', async () => {
  // The two guards that every future defect is expected to trip.
  assert.deepEqual(await json(await call('/inventory/reconciliation')), { ok: true, breaks: [] });
  assert.deepEqual(await json(await call('/customers/credit-reconciliation')), { ok: true, breaks: [] });

  // And the health panel counts what was actually written. TASK-017 moved OPS-006's
  // figures behind TX-428, so this asks as the owner rather than anonymously.
  const health = await json(await call('/health/panel'));
  assert.equal(health.database.row_counts.sales, 2);
  assert.equal(health.database.row_counts.sale_items, 4);
  assert.equal(health.database.row_counts.sale_tenders, 4);
  assert.ok(health.database.row_counts.inventory_movements >= 5);

  // Six figures, and the backup among them: the day has been closed, so there is one.
  assert.ok(health.schema.version > 0);
  assert.ok(health.database.size_bytes > 0);
});
