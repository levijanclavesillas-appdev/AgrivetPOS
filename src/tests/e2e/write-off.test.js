'use strict';

// TC-E2E-28 — a farm three months overdue, written off, and paying six months later.
//
// The walk TASK-034 describes, over HTTP: the debt goes bad, the owner gives up on it,
// and then — as happens — the money turns up anyway. Three things have to be telling
// the truth at the end of that, and they are the three this file asserts.
//
// **The ledger**: the write-off and the later payment both stand. A write-off is not
// reversed by a payment; it is an accounting event that happened, and the append-only
// ledger keeps both because that is what an accountant reads back.
//
// **The statement**: the customer can see all of it, described in words.
//
// **The collections figures**: unchanged by the write-off, and moved by the payment.
// That is `CR-303`'s whole reason for being a rule — without it, giving up on a debt
// improves the store's collection performance.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const authService = require('../../services/authService');
const customerService = require('../../services/customerService');
const creditService = require('../../services/creditService');
const shiftService = require('../../services/shiftService');
const shiftRepository = require('../../repositories/shiftRepository');
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';

let instance;
let BASE = null;
const tokens = {};
const sessions = {};
let farm;
let account;
let shift;

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
  temp.openMigrated('write-off-e2e');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;

  temp.seedStore({ withOwner: false, taxMode: 'NONE' });
  temp.seedCatalog();

  for (const [who, role] of [['boss', 'OWNER'], ['floor', 'MANAGER'], ['till', 'CASHIER']]) {
    temp.seedUser({ username: who, role, password: PASSWORD });
    const signedIn = authService.login({ username: who, password: PASSWORD });
    tokens[who] = signedIn.token;
    sessions[who] = authService.verifyToken(signedIn.token);
  }

  farm = customerService.create({
    name: 'Barangay Malaya Piggery', code: 'MALAYA', customerType: 'FARM',
    contactNo: '09171234567', isCreditEligible: true,
    creditLimitCentavos: 5000000, termsDays: 30,
  }, sessions.boss);
  account = creditService.accountFor(farm.id);

  // Three sales through the spring, none of them paid. The oldest is four months old.
  for (const [days, amount, no] of [[120, 480000, 'SALE-BD-1'], [95, 260000, 'SALE-BD-2'], [70, 150000, 'SALE-BD-3']]) {
    creditService.postStandalone({
      accountId: account.id, type: 'CREDIT_SALE', amountCentavos: amount,
      actor: sessions.till, documentNo: no,
      occurredAt: daysAgo(days), dueAt: daysAgo(days - 30),
    });
  }

  shift = shiftService.open({ actor: sessions.till, openingFloatCentavos: 300000, confirmed: true }).shift;
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

test('TC-E2E-28 · the farm is three months overdue, and the owner can see how overdue', async () => {
  const ageing = await json(await call('/reports/ageing'));
  const row = ageing.accounts.find((account) => account.customer_id === farm.id);

  assert.equal(row.outstanding_centavos, 890000);
  // CR-301: three debts of three ages, in the buckets they actually fall into rather
  // than all in the oldest.
  assert.ok(row.buckets.D61_90 > 0 || row.buckets.D31_60 > 0);
  assert.ok(row.oldest_days_past_due >= 85);
  assert.equal(row.contact_no, '09171234567', 'the number somebody rings before giving up');
});

test('TC-E2E-28 · a manager cannot write it off, and the attempt is on the trail', async () => {
  const refused = await call(`/customers/${farm.id}/write-off`, {
    method: 'POST', who: 'floor',
    body: { amountCentavos: 890000, reason: 'They have stopped answering' },
  });
  assert.equal(refused.status, 403);
  const error = (await refused.json()).error;
  assert.equal(error.rule_id, 'TX-417');
  assert.match(error.message, /owner/i);

  // Nothing moved, and the owner can find out that it was tried.
  const credit = await json(await call(`/customers/${farm.id}/credit`));
  assert.equal(credit.credit.balance_centavos, 890000);

  const trail = await json(await call('/audit?action=PERMISSION_REFUSED&limit=10'));
  assert.ok(trail.rows.some((row) => row.after && row.after.attempted === 'WRITE_OFF'),
    'the attempt is on the audit trail');
});

test('TC-E2E-28 · the owner writes it off, with a reason, and the debt stops being chased', async () => {
  const collectedBefore = shiftRepository.collectionTotalsByMethod(shift.id);

  const result = await json(await call(`/customers/${farm.id}/write-off`, {
    method: 'POST',
    body: {
      amountCentavos: 890000,
      reason: 'Piggery closed after the ASF cull; the owner has left the barangay',
    },
  }));

  assert.equal(result.balance_centavos, 0);
  // CR-203's allocator: all three invoices settled, oldest first, so CR-107 stops
  // ageing them and they leave the collections worklist.
  assert.deepEqual(result.settled.map((row) => row.sale_document_no),
    ['SALE-BD-1', 'SALE-BD-2', 'SALE-BD-3']);

  const ageing = await json(await call('/reports/ageing'));
  assert.equal(ageing.accounts.some((row) => row.customer_id === farm.id), false,
    'the farm has left the ageing report');
  assert.equal(ageing.reconciles, true, ageing.reconciliation_note);

  // **CR-303, the point of the rule.** The store collected nothing today and gave up on
  // ₱8,900. If that reached a collections figure, the worst day of the year would read
  // as the best.
  assert.deepEqual(shiftRepository.collectionTotalsByMethod(shift.id), collectedBefore);

  // And it is counted, in the one report that counts it.
  const report = await json(await call('/reports/write-offs?from=2000-01-01&to=2100-01-01'));
  assert.equal(report.totals.total_centavos, 890000);
  assert.match(report.write_offs[0].reason, /ASF cull/);
  assert.equal(report.write_offs[0].written_off_by, 'boss');
});

test('TC-E2E-28 · six months later the farm pays anyway, and both rows stand', async () => {
  // It happens: the family sells the land and settles what they owed.
  await json(await call(`/customers/${farm.id}/collections`, {
    method: 'POST', who: 'till',
    body: { amountCentavos: 890000, method: 'CASH', acceptOverpayment: true },
  }));

  // CR-108: the payment lands on an account that owes nothing, so it is store credit —
  // money the store now holds for them, which is the honest answer. The write-off is
  // **not** reversed: it happened, and the ledger is append-only.
  const credit = await json(await call(`/customers/${farm.id}/credit`));
  assert.equal(credit.credit.balance_centavos, -890000);
  assert.equal(credit.credit.store_credit_centavos, 890000);

  const statement = await json(await call(
    `/customers/${farm.id}/statement?from=2000-01-01&to=2100-01-01`
  ));
  const types = statement.lines.map((line) => line.type);
  assert.deepEqual(types, ['CREDIT_SALE', 'CREDIT_SALE', 'CREDIT_SALE', 'WRITE_OFF', 'COLLECTION']);
  // In words a customer could read, which is requirement 7.
  assert.equal(statement.lines.find((line) => line.type === 'WRITE_OFF').type_label, 'Write-off');
  assert.match(statement.closing_label, /in credit/);

  // The collections figure moves for the payment — because this time the store was
  // actually paid.
  const collected = shiftRepository.collectionTotalsByMethod(shift.id);
  assert.equal(collected.CASH, 890000);

  // The write-off still stands in its own report, unchanged by the payment.
  const report = await json(await call('/reports/write-offs?from=2000-01-01&to=2100-01-01'));
  assert.equal(report.totals.total_centavos, 890000);

  // And CR-103 holds across all of it.
  assert.equal(creditService.reconcile().ok, true);
});
