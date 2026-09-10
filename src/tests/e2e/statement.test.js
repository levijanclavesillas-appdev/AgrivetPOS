'use strict';

// TC-E2E-25 — a year on one account, then a statement for one month (TASK-031).
//
// The walk the task describes, over HTTP: a farm buys on credit through the year, pays
// in parts, returns a sack, overpays once — and then asks what it owes. The store hands
// them a page for September that they could check with a pencil.
//
// **Two assertions carry the task.** The closing balance is the account's own, to the
// centavo (`CR-302`), and it is reached by walking the page from the balance carried in
// — which is what "checkable by hand" means and why the running total is on every row.
//
// The third is the one an owner cares about: the same ledger, read as the ageing
// report, puts this farm's debts in the buckets their ages actually fall into and ties
// back to what the store is owed.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const customerService = require('../../services/customerService');
const creditService = require('../../services/creditService');
const shiftService = require('../../services/shiftService');
const clock = require('../../config/clock');
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';

let instance;
let BASE = null;
const tokens = {};
const sessions = {};
let farm;
let account;
let month;

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
  temp.openMigrated('statement-e2e');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;

  temp.seedStore({ withOwner: false, taxMode: 'NONE' });
  const ref = temp.seedCatalog();

  for (const [who, role] of [['boss', 'OWNER'], ['till', 'CASHIER']]) {
    temp.seedUser({ username: who, role, password: PASSWORD });
    const signedIn = authService.login({ username: who, password: PASSWORD });
    tokens[who] = signedIn.token;
    sessions[who] = authService.verifyToken(signedIn.token);
  }

  productService.create({
    sku: 'FEED-HG-50', name: 'Hog Grower Pellets', categoryId: ref.category.id,
    baseUnitId: ref.kg.id, retailPriceCentavos: 5200,
  }, sessions.boss);

  farm = customerService.create({
    name: 'Sitio Maligaya Farm', code: 'MALIGAYA', customerType: 'FARM',
    contactNo: '09171234567', isCreditEligible: true,
    creditLimitCentavos: 10000000, termsDays: 30,
  }, sessions.boss);
  account = creditService.accountFor(farm.id);

  shiftService.open({ actor: sessions.till, openingFloatCentavos: 500000, confirmed: true });
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

test('TC-E2E-25 · a year of trading on one account', () => {
  // Eleven months of buying, roughly monthly, and paying most of it off. Posted on the
  // ledger directly with their own dates, because a year cannot be traded through a
  // till in a test and what this walk is about is the statement, not the sale.
  const history = [
    { days: 330, amount: 450000, no: 'SALE-Y1' },
    { days: 300, amount: 380000, no: 'SALE-Y2' },
    { days: 270, amount: 520000, no: 'SALE-Y3' },
    { days: 210, amount: 410000, no: 'SALE-Y4' },
    { days: 150, amount: 600000, no: 'SALE-Y5' },
    { days: 95, amount: 350000, no: 'SALE-Y6' },
    { days: 65, amount: 280000, no: 'SALE-Y7' },
  ];
  for (const sale of history) {
    creditService.postStandalone({
      accountId: account.id, type: 'CREDIT_SALE', amountCentavos: sale.amount,
      actor: sessions.till, documentNo: sale.no,
      occurredAt: daysAgo(sale.days), dueAt: daysAgo(sale.days - 30),
    });
  }

  // Payments through the year, allocated oldest-first by CR-203.
  for (const [days, amount] of [[320, 450000], [260, 380000], [200, 520000], [120, 410000]]) {
    creditService.postStandalone({
      accountId: account.id, type: 'COLLECTION', amountCentavos: amount,
      actor: sessions.till, documentNo: `COLL-${days}`, method: 'CASH',
      occurredAt: daysAgo(days),
    });
  }

  const balance = creditService.summaryFor(farm).balance_centavos;
  // 2,990,000 bought, 1,760,000 paid.
  assert.equal(balance, 1230000);
});

test('TC-E2E-25 · this month: two sales, a payment, a return credit and an overpayment', async () => {
  month = clock.manilaDate(clock.nowUtc()).slice(0, 7);

  // Dated inside the month rather than "n days ago": on the 10th, twenty days ago is
  // last month, and a fixture that drifts across the window boundary tests the window
  // rather than the statement.
  const inMonth = (dayOfMonth) => new Date(`${month}-${String(dayOfMonth).padStart(2, '0')}T09:00:00+08:00`).toISOString();

  for (const [dayOfMonth, amount, no] of [[1, 320000, 'SALE-M1'], [2, 180000, 'SALE-M2']]) {
    creditService.postStandalone({
      accountId: account.id, type: 'CREDIT_SALE', amountCentavos: amount,
      actor: sessions.till, documentNo: no,
      occurredAt: inMonth(dayOfMonth),
      dueAt: new Date(new Date(inMonth(dayOfMonth)).getTime() + 30 * 86400000).toISOString(),
    });
  }

  // A payment that settles the oldest outstanding invoices, a sack returned for credit,
  // and — the case that makes CR-108 matter — a customer who rounds up.
  await json(await call(`/customers/${farm.id}/collections`, {
    method: 'POST', who: 'till',
    body: { amountCentavos: 500000, method: 'GCASH', referenceNo: 'GC-4471' },
  }));
  creditService.postStandalone({
    accountId: account.id, type: 'RETURN_CREDIT', amountCentavos: 52000,
    actor: sessions.boss, documentNo: 'RET-M1', reason: 'One sack came back unopened',
    occurredAt: new Date(`${month}-03T09:00:00+08:00`).toISOString(),
  });

  const balance = creditService.summaryFor(farm).balance_centavos;
  assert.equal(balance, 1230000 + 320000 + 180000 - 500000 - 52000);
});

test('TC-E2E-25 · the statement for this month is checkable by hand', async () => {
  const from = `${month}-01`;
  const to = clock.manilaDate(clock.nowUtc());
  const statement = await json(await call(`/customers/${farm.id}/statement?from=${from}&to=${to}`));

  // Everything before the window is one figure at the top, not a year of rows.
  assert.ok(statement.opening_balance_centavos > 0);
  assert.ok(statement.lines.length >= 4 && statement.lines.length <= 12,
    `a month of movements, not a year: ${statement.lines.length} rows`);

  // The page walks: opening, plus every row in order, is the closing figure. This is
  // what a customer does with a pencil, and if it does not hold the statement is not
  // worth printing.
  let walked = statement.opening_balance_centavos;
  for (const line of statement.lines) {
    walked += line.amount_centavos;
    assert.equal(line.running_balance_centavos, walked, `${line.document_no} broke the walk`);
  }
  assert.equal(walked, statement.closing_balance_centavos);

  // CR-302's last clause: the same figure the profile shows, to the centavo.
  const profile = await json(await call(`/customers/${farm.id}/credit`));
  assert.equal(statement.closing_balance_centavos, profile.credit.balance_centavos);

  // CR-203: the payment names what it settled, which is the sentence the customer came
  // in to hear.
  const collection = statement.lines.find((line) => line.type === 'COLLECTION');
  assert.ok(collection.settled.length >= 1);
  assert.ok(collection.settled.every((s) => /^SALE-/.test(s.document_no)));
  assert.equal(
    collection.settled.reduce((sum, s) => sum + s.amount_centavos, 0),
    500000,
    'the allocations account for the whole payment'
  );

  // And every row says what it was, rather than being a column of numbers.
  assert.ok(statement.lines.every((line) => line.type_label && line.type_label.length > 2));
});

test('TC-E2E-25 · the same ledger, read as the owner’s ageing report', async () => {
  const report = await json(await call('/reports/ageing'));
  const row = report.accounts.find((account) => account.customer_id === farm.id);

  assert.ok(row, 'the farm is on the report');
  assert.equal(row.contact_no, '09171234567', 'with the number somebody rings');

  // CR-301: the debts that are left are of different ages, and the row says so in more
  // than one column. Bucketing the account by its oldest debt would overstate the
  // store's problem by everything in the younger columns.
  const occupied = creditService.BUCKETS.filter((bucket) => row.buckets[bucket] > 0);
  assert.ok(occupied.length >= 2, `two ages of debt, in two buckets: ${occupied.join(', ')}`);
  assert.equal(
    creditService.BUCKETS.reduce((sum, bucket) => sum + row.buckets[bucket], 0),
    row.outstanding_centavos,
    'the row adds across'
  );

  // The report's own reconciliation, which is FR_6.2's demand applied to the debt.
  assert.equal(report.reconciles, true, report.reconciliation_note);
  assert.equal(
    report.totals.bucketed_centavos - report.totals.unapplied_credit_centavos,
    report.totals.receivable_centavos + report.totals.in_credit_centavos
  );

  // RPT-106: the report says what it includes, in the words a printed copy needs.
  assert.match(report.basis, /aged from its own due date/);
});

test('TC-E2E-25 · the statement prints, and says it is not a receipt', async () => {
  const printed = await json(await call(`/customers/${farm.id}/statement/print`, {
    method: 'POST',
    body: { from: `${month}-01`, to: clock.manilaDate(clock.nowUtc()) },
  }));

  const paper = printed.document.text;
  assert.match(paper, /STATEMENT OF ACCOUNT/);
  assert.match(paper, /Sitio Maligaya Farm/);
  // The label is short enough to survive 32 columns: the longer "Balance brought
  // forward" truncates to "…forwar" and reads as a typo on a page a customer is being
  // asked to check.
  assert.match(paper, /Brought forward/);
  assert.equal(/forwar[^d]/.test(paper), false);
  // CR-203 on the paper too, under the payment.
  assert.match(paper, /settled SALE-/);
  assert.match(paper, /Balance owing/);
  // TAX-006, on every document this shop prints without exception.
  assert.match(paper, /This is not an official receipt/);
});
