'use strict';

// TC-E2E-02 — credit sale to a farm customer within limit → balance rises →
// collection → balance falls → acknowledgement.
//
// The whole credit story over HTTP, in the order the store lives it: a farm buys feed
// on account in the morning, pays part of it at the end of the week, and is handed a
// piece of paper saying so. That last step is the one legacy/PRD_v1.1.md never
// specified and CR-206 added.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const server = require('../../server');
const temp = require('../helpers/tempdb');

const PORT = 47885;
const API = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'correct-horse-battery';

let instance;
let backupFolder;
let token;
const ids = {};

const call = (path_, { method = 'GET', body = null } = {}) => fetch(`${API}${path_}`, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
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
  temp.openEmpty('e2e-collection');
  instance = await server.start({ listenPort: PORT });
  backupFolder = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-e2e-coll-')), 'backups');
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

test('TC-E2E-02: a store opens with feed in stock and a farm on the books', async () => {
  await json(await call('/setup', {
    method: 'POST',
    body: {
      store: { storeName: 'Chachi Agrivet Supply', address: 'Poblacion' },
      taxMode: 'NON_VAT',
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

  const feed = (await json(await call('/products', {
    method: 'POST',
    body: {
      sku: 'FEED-001', name: 'Hog Grower Pellets', categoryId: category.id, baseUnitId: kg.id,
      taxClass: 'VATABLE', retailPriceCentavos: 6250,
    },
  }))).product;
  ids.feed = feed.id;

  await json(await call('/inventory/adjustments', {
    method: 'POST',
    body: { productId: feed.id, qtyMilli: 1000000, reason: 'Received but not recorded', unitCostCentavos: 4800 },
  }));

  const customer = (await json(await call('/customers', {
    method: 'POST',
    body: {
      name: 'Dela Cruz Piggery', code: 'DLC-01', contactNo: '0917 123 4567',
      customerType: 'FARM', priceLevel: 'RETAIL',
      isCreditEligible: true, creditLimitCentavos: 5000000, termsDays: 15,
    },
  }))).customer;
  ids.customer = customer.id;

  assert.equal(customer.credit.available_centavos, 5000000);
  assert.equal(customer.credit.ageing_status, 'PAID', 'nothing owed yet');

  ids.shift = (await json(await call('/shifts/open', {
    method: 'POST', body: { openingFloatCentavos: 200000, confirmed: true },
  }))).shift.id;
});

test('TC-E2E-02: two credit sales within limit make the balance rise', async () => {
  // 100 KG on Monday, 60 KG on Wednesday. Both on account.
  for (const qtyMilli of [100000, 60000]) {
    const sale = await json(await call('/sales', {
      method: 'POST',
      body: {
        customerId: ids.customer,
        lines: [{ productId: ids.feed, qtyMilli }],
        tenders: [{ method: 'CREDIT', amountCentavos: (qtyMilli / 1000) * 6250 }],
      },
    }));
    assert.equal(sale.sale.total_centavos, (qtyMilli / 1000) * 6250);
    (ids.sales ||= []).push(sale.sale.sale_no);
  }

  const credit = await json(await call(`/customers/${ids.customer}/credit`));
  assert.equal(credit.credit.balance_centavos, 625000 + 375000);
  assert.equal(credit.credit.available_centavos, 5000000 - 1000000);
  assert.equal(credit.open_sales.length, 2, 'two invoices, each with its own due date');
  assert.deepEqual(credit.open_sales.map((s) => s.document_no), ids.sales);
});

test('TC-E2E-02: a part payment settles the oldest invoice and part of the next', async () => {
  const before = await json(await call(`/shifts/${ids.shift}/expected`));

  // ₱8,000 against ₱10,000 owed: the ₱6,250 invoice clears and ₱1,750 lands on the second.
  const collection = await json(await call(`/customers/${ids.customer}/collections`, {
    method: 'POST', body: { amountCentavos: 800000, method: 'CASH' },
  }));

  assert.equal(collection.balance_centavos, 1000000 - 800000);
  assert.equal(collection.allocations.length, 2, 'CR-203: oldest first, across two invoices');
  assert.equal(collection.allocations[0].sale_document_no, ids.sales[0]);
  assert.equal(collection.allocations[0].settled_in_full, true);
  assert.equal(collection.allocations[1].sale_document_no, ids.sales[1]);
  assert.equal(collection.allocations[1].amount_centavos, 800000 - 625000);
  assert.equal(collection.allocations[1].settled_in_full, false);

  // CR-205: cash collected is till cash, and the drawer opened for it.
  const after = await json(await call(`/shifts/${ids.shift}/expected`));
  assert.equal(after.expected_cash_centavos, before.expected_cash_centavos + 800000);
  assert.equal(collection.drawer.reason, 'CASH_COLLECTION');

  ids.collection = collection.acknowledgement.document_no;
});

test('TC-E2E-02: the customer is handed an acknowledgement (CR-206, TAX-006)', async () => {
  const history = await json(await call(`/customers/${ids.customer}/collections`));
  assert.equal(history.total, 1);
  assert.equal(history.collections[0].document_no, ids.collection);
  assert.equal(history.collections[0].allocations.length, 2);

  // What the customer actually holds.
  const credit = await json(await call(`/customers/${ids.customer}/credit`));
  assert.equal(credit.credit.balance_centavos, 200000, 'the balance fell by exactly the payment');
  assert.equal(credit.open_sales.length, 1, 'the settled invoice has dropped out of the ageing');
  assert.equal(credit.open_sales[0].outstanding_centavos, 200000);
  assert.equal(credit.open_sales[0].settled_centavos, 175000, 'part-paid, and it says so');
});

test('TC-E2E-02: the rest is paid, and the account clears', async () => {
  const collection = await json(await call(`/customers/${ids.customer}/collections`, {
    method: 'POST', body: { amountCentavos: 200000, method: 'GCASH', referenceNo: 'GC-556677' },
  }));

  assert.equal(collection.balance_centavos, 0);
  assert.equal(collection.allocations[0].settled_in_full, true);
  assert.equal(collection.drawer, null, 'GCash puts nothing in the drawer');

  const credit = await json(await call(`/customers/${ids.customer}/credit`));
  assert.equal(credit.credit.ageing_status, 'PAID');
  assert.equal(credit.open_sales.length, 0);
  assert.equal(credit.credit.available_centavos, 5000000, 'the whole limit is free again');

  // CR-202: two payments, two documents, never merged.
  const history = await json(await call(`/customers/${ids.customer}/collections`));
  assert.equal(history.total, 2);
  assert.notEqual(history.collections[0].document_no, history.collections[1].document_no);
});

test('TC-E2E-02: every ledger still reconciles, and the till agrees', async () => {
  assert.deepEqual(await json(await call('/customers/credit-reconciliation')), { ok: true, breaks: [] });
  assert.deepEqual(await json(await call('/inventory/reconciliation')), { ok: true, breaks: [] });

  const expected = await json(await call(`/shifts/${ids.shift}/expected`));
  assert.equal(expected.cash_collections_centavos, 800000);
  assert.equal(expected.by_method.GCASH.collections_centavos, 200000);
  assert.equal(expected.by_method.GCASH.in_drawer, false);
  assert.equal(expected.cash_sales_centavos, 0, 'both sales were on credit');

  // POS-509, term by term, on a day that had credit sales and two collections.
  assert.equal(
    expected.expected_cash_centavos,
    expected.opening_float_centavos + expected.cash_sales_centavos + expected.cash_collections_centavos
      + expected.cash_in_centavos - expected.cash_out_centavos - expected.cash_refunds_centavos
      - expected.change_given_centavos
  );
  assert.equal(expected.expected_cash_centavos, 200000 + 800000);
});
