'use strict';

// TC-E2E-06 — a full trading day → close shift → variance → reason → backup written
// and verified.
//
// The day is scripted so that every term of POS-509 is non-zero: cash sales, a GCash
// sale, a credit sale, a cash collection, change given, cash in and cash out. Then the
// drawer is counted ₱200 short, which is what makes the close interesting — a day that
// balances proves only that the arithmetic ran.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const server = require('../../server');
const temp = require('../helpers/tempdb');

const PORT = 47883;
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
  temp.openEmpty('e2e-close');
  instance = await server.start({ listenPort: PORT });
  backupFolder = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-e2e-close-')), 'backups');
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

test('TC-E2E-06: the store opens for the day', async () => {
  await json(await call('/setup', {
    method: 'POST',
    body: {
      store: { storeName: 'Chachi Agrivet Supply', address: 'Poblacion' },
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

  const feed = (await json(await call('/products', {
    method: 'POST',
    body: {
      sku: 'FEED-001', name: 'Hog Grower Pellets', categoryId: category.id, baseUnitId: kg.id,
      taxClass: 'VATABLE', retailPriceCentavos: 10000,
    },
  }))).product;
  ids.feed = feed.id;

  await json(await call('/inventory/adjustments', {
    method: 'POST',
    body: { productId: feed.id, qtyMilli: 1000000, reason: 'Received but not recorded', unitCostCentavos: 6000 },
  }));

  ids.customer = (await json(await call('/customers', {
    method: 'POST',
    body: {
      name: 'Dela Cruz Piggery', customerType: 'FARM',
      isCreditEligible: true, creditLimitCentavos: 5000000, termsDays: 15,
    },
  }))).customer.id;

  const shift = await json(await call('/shifts/open', {
    method: 'POST', body: { openingFloatCentavos: 200000, confirmed: true },
  }));
  ids.shift = shift.shift.id;
  assert.equal(shift.expected.expected_cash_centavos, 200000, 'the float, and nothing else yet');
});

test('TC-E2E-06: a full day of trading moves every term of POS-509', async () => {
  // Cash sale with change: ₱500 of feed, ₱1,000 handed over.
  const cash = await json(await call('/sales', {
    method: 'POST',
    body: {
      lines: [{ productId: ids.feed, qtyMilli: 5000 }],
      tenders: [{ method: 'CASH', amountCentavos: 100000 }],
    },
  }));
  assert.equal(cash.sale.total_centavos, 50000);
  assert.equal(cash.sale.change_centavos, 50000);

  // GCash sale — expected at close, never in the drawer.
  await json(await call('/sales', {
    method: 'POST',
    body: {
      lines: [{ productId: ids.feed, qtyMilli: 3000 }],
      tenders: [{ method: 'GCASH', amountCentavos: 30000, referenceNo: 'GC-DAY-01' }],
    },
  }));

  // Credit sale — no money moves today.
  await json(await call('/sales', {
    method: 'POST',
    body: {
      customerId: ids.customer,
      lines: [{ productId: ids.feed, qtyMilli: 10000 }],
      tenders: [{ method: 'CREDIT', amountCentavos: 100000 }],
    },
  }));

  // A collection against an older balance — cash in the drawer (CR-205).
  await json(await call(`/customers/${ids.customer}/collections`, {
    method: 'POST', body: { amountCentavos: 40000, method: 'CASH' },
  }));

  // Till movements both ways.
  await json(await call(`/shifts/${ids.shift}/till`, {
    method: 'POST', body: { direction: 'IN', amountCentavos: 10000, reason: 'Change fund top-up' },
  }));
  await json(await call(`/shifts/${ids.shift}/till`, {
    method: 'POST', body: { direction: 'OUT', amountCentavos: 15000, reason: 'Owner withdrawal' },
  }));

  const expected = await json(await call(`/shifts/${ids.shift}/expected`));

  // POS-509, every term non-zero except refunds (v1.1).
  assert.equal(expected.opening_float_centavos, 200000);
  assert.equal(expected.cash_sales_centavos, 100000, 'what was handed over');
  assert.equal(expected.change_given_centavos, 50000, 'less what was handed back');
  assert.equal(expected.cash_collections_centavos, 40000);
  assert.equal(expected.cash_in_centavos, 10000);
  assert.equal(expected.cash_out_centavos, 15000);
  assert.equal(expected.cash_refunds_centavos, 0);
  assert.equal(expected.expected_cash_centavos, 200000 + 100000 + 40000 + 10000 - 15000 - 50000);
  assert.equal(expected.expected_cash_centavos, 285000);

  // And the non-cash methods are expected at close without being in the drawer.
  assert.equal(expected.by_method.GCASH.expected_centavos, 30000);
  assert.equal(expected.by_method.CREDIT.expected_centavos, 100000);
  assert.equal(expected.by_method.GCASH.in_drawer, false);
});

test('TC-E2E-06: a drawer counted ₱200 short cannot be closed silently', async () => {
  const res = await call(`/shifts/${ids.shift}/close`, {
    method: 'POST', body: { actualCashCentavos: 265000, actualByMethod: { GCASH: 30000 } },
  });

  // POS-510: the count is never forced to balance, and the difference is never hidden.
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.rule_id, 'POS-510');
  assert.match(body.error.message, /CASH is ₱200\.00 short/);

  const stillOpen = await json(await call(`/shifts/${ids.shift}/summary`));
  assert.equal(stillOpen.shift.status, 'OPEN');
  assert.equal(stillOpen.closing, null);
});

test('TC-E2E-06: with a reason it closes, audits the variance and backs the day up', async () => {
  const closing = await json(await call(`/shifts/${ids.shift}/close`, {
    method: 'POST',
    body: {
      actualCashCentavos: 265000,
      actualByMethod: { GCASH: 30000, QRPH: 0, CREDIT: 100000 },
      varianceReason: 'Two ₱100 notes missing after the afternoon rush; counted three times',
    },
  }));

  assert.equal(closing.variance_centavos, -20000);
  assert.equal(closing.beyond_tolerance, true);
  assert.equal(closing.tolerance_centavos, 10000);
  assert.equal(closing.shift.status, 'CLOSED');

  // Per method, as POS-510 requires.
  const byMethod = Object.fromEntries(closing.lines.map((l) => [l.method, l]));
  assert.equal(byMethod.CASH.expected_centavos, 285000);
  assert.equal(byMethod.CASH.actual_centavos, 265000);
  assert.equal(byMethod.GCASH.variance_centavos, 0);
  assert.equal(byMethod.CREDIT.variance_centavos, 0);

  // OPS-001 and OPS-002: written, and opened to check it.
  assert.equal(closing.backup.ok, true);
  assert.equal(closing.backup.verified, true);
  assert.equal(closing.backup.trigger, 'SHIFT_CLOSE');
  assert.ok(fs.existsSync(closing.backup.file_path));
  assert.deepEqual(closing.alerts, []);

  // The summary the store keeps with the drawer count.
  assert.match(closing.summary.text, /Cash variance: ₱200\.00 short/);
  assert.match(closing.summary.text, /Reason: Two ₱100 notes missing/);
  assert.match(closing.summary.text, /This is not an official receipt/);
});

test('TC-E2E-06: the variance is on the audit trail with its reason (AUD-602)', async () => {
  const trail = await json(await call('/audit?action=SHIFT_CLOSED_WITH_VARIANCE'));

  assert.equal(trail.total, 1);
  const row = trail.rows[0];
  assert.equal(row.actor.username, 'nena');
  assert.equal(row.after.variance_centavos, -20000);
  assert.equal(row.after.beyond_tolerance, true);
  assert.match(row.reason, /Two ₱100 notes missing/);
  assert.equal(row.shift_id, ids.shift);
});

test('TC-E2E-06: the closed day is immutable and still reconciles', async () => {
  // POS-511 — nothing may be back-dated into it.
  const till = await call(`/shifts/${ids.shift}/till`, {
    method: 'POST', body: { direction: 'IN', amountCentavos: 20000, reason: 'Petty cash' },
  });
  assert.equal(till.status, 409);
  assert.equal((await till.json()).error.rule_id, 'POS-511');

  const reclose = await call(`/shifts/${ids.shift}/close`, {
    method: 'POST', body: { actualCashCentavos: 285000 },
  });
  assert.equal(reclose.status, 409);
  assert.equal((await reclose.json()).error.rule_id, 'POS-511');

  // And a sale can no longer be rung — there is no open shift (POS-501).
  const sale = await call('/sales', {
    method: 'POST',
    body: {
      lines: [{ productId: ids.feed, qtyMilli: 1000 }],
      tenders: [{ method: 'CASH', amountCentavos: 10000 }],
    },
  });
  assert.equal(sale.status, 409);
  assert.equal((await sale.json()).error.rule_id, 'POS-501');

  // Both ledgers still agree after a full day and a close.
  assert.deepEqual(await json(await call('/inventory/reconciliation')), { ok: true, breaks: [] });
  assert.deepEqual(await json(await call('/customers/credit-reconciliation')), { ok: true, breaks: [] });
});

test('TC-E2E-06: the backup is a database with the day in it', async () => {
  const summary = await json(await call(`/shifts/${ids.shift}/summary`));
  assert.equal(summary.closing.variance_centavos, -20000);
  assert.equal(summary.closing.lines.length, 4);

  // Opened independently: OPS-002's point is that somebody has looked inside it.
  const backups = fs.readdirSync(backupFolder).filter((f) => f.endsWith('.db'));
  assert.equal(backups.length, 1, 'one close, one backup');

  const Database = require('better-sqlite3');
  const copy = new Database(path.join(backupFolder, backups[0]), { readonly: true, fileMustExist: true });
  try {
    assert.equal(copy.pragma('integrity_check')[0].integrity_check, 'ok');
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 3, "the day's three sales");
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM cashier_closings').get().n, 1);
    assert.equal(
      copy.prepare('SELECT variance_centavos AS v FROM cashier_closings').get().v,
      -20000,
      'including the variance that was signed off'
    );
  } finally {
    copy.close();
  }
});
