'use strict';

// FT-406 and FT-407 — the ageing report and the statement (TASK-031).
//
// `TC-INT-114` to `TC-INT-116`. One arithmetic read two ways, which is why they are one
// task: the statement is what a customer is handed, the ageing is what the owner reads
// about all of them, and building them apart is how the total on the report stops
// matching the sum of the statements.
//
// **`TC-INT-114` is the case the whole task turns on.** `CR-302`'s last clause says the
// closing balance must equal the account balance at that date, and a statement that
// closes at ₱6,200 against a profile saying ₱6,150 is worse than no statement — the
// customer will find the ₱50 and the store will not. So the service compares the two
// derivations itself and refuses to hand over a statement that disagrees; this asserts
// the agreement across every kind of movement the ledger can hold.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const authService = require('../../services/authService');
const customerService = require('../../services/customerService');
const creditService = require('../../services/creditService');
const collectionService = require('../../services/collectionService');
const shiftService = require('../../services/shiftService');
const clock = require('../../config/clock');
const temp = require('../helpers/tempdb');

let BASE = null;
const PASSWORD = 'correct-horse-battery';

let instance;
const tokens = {};
const sessions = {};

const call = (path, { token = null, method = 'GET', body = null } = {}) => fetch(`${BASE}${path}`, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

let seq = 0;
const day = (offsetDays) => {
  const at = new Date(Date.now() + offsetDays * 86400000);
  return at.toISOString();
};

/** A credit customer, and their account. */
function farm({ name = null, terms = 30 } = {}) {
  seq += 1;
  const customer = customerService.create({
    name: name || `Statement Farm ${seq}`,
    customerType: 'FARM',
    contactNo: '09171234567',
    isCreditEligible: true,
    creditLimitCentavos: 100000000,
    termsDays: terms,
  }, sessions.OWNER);
  return { customer, account: creditService.accountFor(customer.id) };
}

/** A credit sale on the ledger, dated, with its own due date (CR-105). */
function debit(account, amountCentavos, { daysAgo = 0, termsDays = 30, no = null } = {}) {
  seq += 1;
  return creditService.postStandalone({
    accountId: account.id,
    type: 'CREDIT_SALE',
    amountCentavos,
    actor: sessions.CASHIER,
    documentNo: no || `SALE-STMT-${seq}`,
    occurredAt: day(-daysAgo),
    dueAt: day(-daysAgo + termsDays),
  });
}

test.before(async () => {
  temp.openEmpty('statements');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;
  temp.seedStore({ withOwner: false, taxMode: 'NONE' });

  for (const role of ['OWNER', 'MANAGER', 'CASHIER', 'INVENTORY']) {
    const username = role.toLowerCase();
    temp.seedUser({ username, role, password: PASSWORD });
    const signedIn = authService.login({ username, password: PASSWORD });
    tokens[role] = signedIn.token;
    sessions[role] = authService.verifyToken(signedIn.token);
  }

  shiftService.open({ actor: sessions.CASHIER, openingFloatCentavos: 200000, confirmed: true });
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── TC-INT-114 — CR-302 ─────────────────────────────────────────────────────

test('TC-INT-114: the closing balance equals the account balance, across every kind of movement', () => {
  const { customer, account } = farm();

  // An opening balance from the notebook, two credit sales, a collection that settles
  // one and part of the other, and a return credit — the five shapes the ledger holds.
  creditService.postStandalone({
    accountId: account.id, type: 'OPENING', amountCentavos: 250000,
    actor: sessions.OWNER, documentNo: 'OPEN-1', reason: 'From the blue notebook',
    occurredAt: day(-120),
  });
  debit(account, 400000, { daysAgo: 60, no: 'SALE-A' });
  debit(account, 300000, { daysAgo: 20, no: 'SALE-B' });
  collectionService.record({
    customerId: customer.id, amountCentavos: 500000, method: 'CASH',
  }, sessions.CASHIER);
  creditService.postStandalone({
    accountId: account.id, type: 'RETURN_CREDIT', amountCentavos: 50000,
    actor: sessions.MANAGER, documentNo: 'RET-1', reason: 'Two sacks came back',
  });

  const statement = creditService.statement(customer.id, {
    from: '2000-01-01', to: '2100-01-01', actor: sessions.OWNER,
  });

  // 2,500 + 4,000 + 3,000 − 5,000 − 500 = 4,000.
  assert.equal(statement.opening_balance_centavos, 0, 'nothing before the account existed');
  assert.equal(statement.closing_balance_centavos, 400000);

  // CR-103: the same figure the profile shows, which is the whole of CR-302's last
  // clause. Not "close enough" — the same integer.
  const profile = creditService.summaryFor(customer);
  assert.equal(statement.closing_balance_centavos, profile.balance_centavos);

  // The running balance walks the page: a customer following it down with a finger
  // arrives at the closing figure, or the statement is not checkable by hand.
  assert.equal(statement.lines.at(-1).running_balance_centavos, statement.closing_balance_centavos);
  let walked = statement.opening_balance_centavos;
  for (const line of statement.lines) {
    walked += line.amount_centavos;
    assert.equal(line.running_balance_centavos, walked, `${line.document_no} broke the running total`);
  }

  // Every row names what it was, which is requirement 3 and the difference between a
  // statement and a column of numbers.
  assert.deepEqual(
    statement.lines.map((line) => line.type),
    ['OPENING', 'CREDIT_SALE', 'CREDIT_SALE', 'COLLECTION', 'RETURN_CREDIT']
  );
});

test('TC-INT-114: a window that opens mid-history carries the balance in, and closes on the ledger', () => {
  const { customer, account } = farm();
  debit(account, 200000, { daysAgo: 90, no: 'SALE-OLD' });
  debit(account, 150000, { daysAgo: 5, no: 'SALE-NEW' });

  const today = clock.manilaDate(clock.nowUtc());
  const from = clock.manilaDate(day(-10));
  const statement = creditService.statement(customer.id, { from, to: today, actor: sessions.OWNER });

  // The opening figure is derived as the balance *before* the window — never stored,
  // because there is nowhere to keep it that would not be a second answer to a question
  // CR-103 has already answered.
  assert.equal(statement.opening_balance_centavos, 200000, 'the old sale is carried in, not listed');
  assert.deepEqual(statement.lines.map((line) => line.document_no), ['SALE-NEW']);
  assert.equal(statement.closing_balance_centavos, 350000);
  assert.equal(statement.closing_balance_centavos, creditService.summaryFor(customer).balance_centavos);
});

test('TC-INT-114: a period with no movement still states both balances', () => {
  const { customer, account } = farm();
  debit(account, 120000, { daysAgo: 200, no: 'SALE-QUIET' });

  const quiet = clock.manilaDate(day(-3));
  const statement = creditService.statement(customer.id, { from: quiet, to: quiet, actor: sessions.OWNER });

  assert.equal(statement.lines.length, 0);
  assert.equal(statement.opening_balance_centavos, 120000);
  assert.equal(statement.closing_balance_centavos, 120000);
  // "Nothing happened" is an answer a customer came in for, and the statement says it
  // rather than printing an empty page.
  assert.match(statement.basis, /Nothing was bought or paid in this period/);
});

test('TC-INT-114 / CR-108: an account in credit closes negative and is described, not signed', () => {
  const { customer, account } = farm({ name: 'Overpaying Farm' });
  debit(account, 100000, { daysAgo: 10, no: 'SALE-OVER' });
  collectionService.record({
    customerId: customer.id, amountCentavos: 145000, method: 'CASH', acceptOverpayment: true,
  }, sessions.CASHIER);

  const statement = creditService.statement(customer.id, {
    from: '2000-01-01', to: '2100-01-01', actor: sessions.OWNER,
  });

  assert.equal(statement.closing_balance_centavos, -45000);
  assert.equal(statement.is_in_credit, true);
  // The words SCR-401 already uses. "−₱450" is a minus sign somebody will read past,
  // and a customer told they owe ₱450 when the store owes them ₱450 is a complaint.
  assert.match(statement.closing_label, /₱450\.00 in credit/);
  assert.match(statement.closing_label, /the store owes this to Overpaying Farm/);
});

// ── TC-INT-115 — CR-301 ─────────────────────────────────────────────────────

test('TC-INT-115: one account with two debts of different ages appears in two buckets', () => {
  const { customer, account } = farm({ name: 'Two Bucket Farm' });
  // Due 100 days ago and 10 days ago: 90+ and 1–30.
  debit(account, 500000, { daysAgo: 130, termsDays: 30, no: 'SALE-ANCIENT' });
  debit(account, 200000, { daysAgo: 40, termsDays: 30, no: 'SALE-RECENT' });

  const report = creditService.ageingReport();
  const row = report.accounts.find((a) => a.customer_id === customer.id);

  // The rule buckets a debit, not an account. Bucketing the account by its oldest debt
  // would report the whole ₱7,000 as 90+ and tell the owner their problem is more than
  // twice what it is.
  assert.equal(row.buckets.D90_PLUS, 500000);
  assert.equal(row.buckets.D1_30, 200000);
  assert.equal(row.outstanding_centavos, 700000);
  assert.equal(row.buckets.NOT_DUE, 0);
  assert.equal(row.debits.length, 2);
  assert.deepEqual(row.debits.map((d) => d.bucket).sort(), ['D1_30', 'D90_PLUS']);
});

test('TC-INT-115: the buckets, the accounts and the ledger all reconcile', () => {
  const report = creditService.ageingReport();

  // Per bucket and per account are the same rows added along different axes.
  const perAccount = report.accounts.reduce((sum, row) => sum + row.outstanding_centavos, 0);
  const perBucket = report.buckets.reduce((sum, row) => sum + row.total_centavos, 0);
  assert.equal(perAccount, perBucket);
  assert.equal(perBucket, report.totals.bucketed_centavos);

  // And the reconciliation the report states about itself: aged debt less the credit
  // customers are holding is exactly what the ledger says. The settled parts cancel on
  // both sides, so this is an equality and not an approximation.
  assert.equal(report.reconciles, true, report.reconciliation_note);
  assert.equal(
    report.totals.bucketed_centavos - report.totals.unapplied_credit_centavos,
    report.totals.receivable_centavos + report.totals.in_credit_centavos
  );
  assert.match(report.reconciliation_note, /exactly what the ledger says/);

  // CR-108: the overpaying farm from TC-INT-114 is money the store owes, counted apart
  // from the debt rather than netted into somebody else's bucket.
  assert.ok(report.totals.in_credit_accounts >= 1);
  assert.ok(report.totals.in_credit_centavos < 0);
});

test('TC-INT-115: a debt not yet due is bucketed as such, and still counted', () => {
  const { customer, account } = farm({ name: 'Current Farm' });
  debit(account, 90000, { daysAgo: 1, termsDays: 30, no: 'SALE-FRESH' });

  const report = creditService.ageingReport();
  const row = report.accounts.find((a) => a.customer_id === customer.id);

  assert.equal(row.buckets.NOT_DUE, 90000);
  assert.equal(row.oldest_days_past_due, 0);
  // It is in the totals: every unsettled debit has to land somewhere, or the buckets
  // stop adding up to what the store is owed.
  assert.equal(report.reconciles, true, report.reconciliation_note);
});

// ── TC-INT-116 — CR-203 ─────────────────────────────────────────────────────

test('TC-INT-116: the statement names the invoices each collection settled, oldest first', () => {
  const { customer, account } = farm({ name: 'Allocating Farm' });
  debit(account, 300000, { daysAgo: 50, no: 'SALE-1' });
  debit(account, 200000, { daysAgo: 30, no: 'SALE-2' });
  debit(account, 100000, { daysAgo: 10, no: 'SALE-3' });

  // ₱4,000 against ₱6,000: settles the first in full and ₱1,000 of the second.
  collectionService.record({
    customerId: customer.id, amountCentavos: 400000, method: 'GCASH', referenceNo: 'GC-778',
  }, sessions.CASHIER);

  const statement = creditService.statement(customer.id, {
    from: '2000-01-01', to: '2100-01-01', actor: sessions.OWNER,
  });
  const collection = statement.lines.find((line) => line.type === 'COLLECTION');

  // The sentence a customer is actually asking for when they query a balance.
  assert.deepEqual(
    collection.settled.map((s) => [s.document_no, s.amount_centavos]),
    [['SALE-1', 300000], ['SALE-2', 100000]],
    'CR-203: oldest first, and how much of each'
  );

  // The remaining debt ages from each debit's own due date, so the part-paid invoice
  // keeps its age rather than being made young by the payment.
  const report = creditService.ageingReport();
  const row = report.accounts.find((a) => a.customer_id === customer.id);
  assert.equal(row.outstanding_centavos, 200000);
  assert.equal(row.debits.find((d) => d.document_no === 'SALE-2').outstanding_centavos, 100000);
  assert.equal(row.debits.find((d) => d.document_no === 'SALE-3').outstanding_centavos, 100000);
});

// ── Over HTTP, and who may read it ──────────────────────────────────────────

test('both are behind TX-421, and a cashier reads neither', async () => {
  const { customer, account } = farm();
  debit(account, 50000, { daysAgo: 5 });

  const statement = await call(`/customers/${customer.id}/statement`, { token: tokens.OWNER });
  assert.equal(statement.status, 200);
  assert.equal((await statement.json()).customer.id, customer.id);

  assert.equal((await call('/reports/ageing', { token: tokens.MANAGER })).status, 200);

  // TX-421 grants a cashier OWN_SHIFT for the sales reports, and the receivable is not
  // a shift's figure — the service refuses on the rule rather than the middleware
  // letting them through to a page of other people's debts.
  const refused = await call(`/customers/${customer.id}/statement`, { token: tokens.CASHIER });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.rule_id, 'TX-421');
  assert.equal((await call('/reports/ageing', { token: tokens.INVENTORY })).status, 403);
});

test('both export, with the figures the screen shows', async () => {
  const { customer, account } = farm({ name: 'Exporting Farm' });
  debit(account, 275000, { daysAgo: 45, no: 'SALE-EXP' });

  // No range asked for: a statement means this month, which is what a customer at the
  // counter means by "my statement". The older sale is carried in rather than listed —
  // the same opening balance the screen would show.
  const thisMonth = await call(`/customers/${customer.id}/statement/export.csv`, { token: tokens.OWNER });
  assert.equal(thisMonth.status, 200);
  const month = await thisMonth.text();
  assert.match(month, /"Brought forward","2,750.00"/);
  assert.equal(/"SALE-EXP"/.test(month), false, 'a sale before the window is carried, not repeated');

  const statement = await call(
    `/customers/${customer.id}/statement/export.csv?from=2000-01-01&to=2100-01-01`,
    { token: tokens.OWNER }
  );
  assert.equal(statement.status, 200);
  const text = await statement.text();
  assert.match(text, /"Statement","Exporting Farm"/);
  assert.match(text, /"SALE-EXP"/);
  assert.match(text, /"Balance owing","2,750.00"/);

  const ageing = await call('/reports/ageing/export.csv', { token: tokens.OWNER });
  assert.equal(ageing.status, 200);
  const rows = await ageing.text();
  assert.match(rows, /"customer","contact","Not yet due","1–30 days"/);
  assert.match(rows, /"Reconciles","YES"/);

  // TX-426 is the owner's and the manager's, so both may take it out — and a cashier,
  // who cannot read the receivable at all, is refused before the export permission is
  // even considered.
  assert.equal((await call('/reports/ageing/export.csv', { token: tokens.MANAGER })).status, 200);
  assert.equal((await call('/reports/ageing/export.csv', { token: tokens.CASHIER })).status, 403);
});
