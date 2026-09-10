'use strict';

// FT-409 — the bad-debt write-off (TASK-034). `TC-INT-123` to `TC-INT-125`.
//
// **`TC-INT-125` is the case the rule exists for.** A write-off credits an account
// exactly as a payment does, so a naive implementation makes the store's collection
// performance improve every time it gives up on a debt — a month where nobody paid and
// ₱40,000 was written off would read as the best month of the year. The case asserts
// that every collections figure is *identical* either side of a write-off, and that the
// write-off is findable in its own report.
//
// The other two are the authority and the ageing. `TX-417` is owner-only and the
// refusal is audited, because "who tried to write off a debt" is a question worth being
// able to answer. And a written-off invoice has to **stop being chased**: that is
// `TASK-028`'s lesson in the same place — a credit that moved a balance without
// allocating left an account square by balance and overdue by ageing, and it is the
// ageing that reaches the collections worklist.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const authService = require('../../services/authService');
const customerService = require('../../services/customerService');
const creditService = require('../../services/creditService');
const collectionService = require('../../services/collectionService');
const shiftService = require('../../services/shiftService');
const auditService = require('../../services/auditService');
const shiftRepository = require('../../repositories/shiftRepository');
const temp = require('../helpers/tempdb');

let BASE = null;
const PASSWORD = 'correct-horse-battery';

let instance;
const tokens = {};
const sessions = {};
let cashierShift;

const call = (path, { token = null, method = 'GET', body = null } = {}) => fetch(`${BASE}${path}`, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

let seq = 0;
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

/** A farm owing the given amounts, each its own dated credit sale. */
function owing(amounts, { name = null, daysOld = 120 } = {}) {
  seq += 1;
  const customer = customerService.create({
    name: name || `Bad Debt Farm ${seq}`, customerType: 'FARM', contactNo: '09171234567',
    isCreditEligible: true, creditLimitCentavos: 100000000, termsDays: 30,
  }, sessions.OWNER);
  const account = creditService.accountFor(customer.id);

  amounts.forEach((amountCentavos, index) => {
    creditService.postStandalone({
      accountId: account.id,
      type: 'CREDIT_SALE',
      amountCentavos,
      actor: sessions.CASHIER,
      documentNo: `SALE-WO-${seq}-${index + 1}`,
      occurredAt: daysAgo(daysOld - index * 10),
      dueAt: daysAgo(daysOld - index * 10 - 30),
    });
  });

  return { customer, account };
}

test.before(async () => {
  temp.openEmpty('write-offs');
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

  cashierShift = shiftService.open({
    actor: sessions.CASHIER, openingFloatCentavos: 200000, confirmed: true,
  }).shift;
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── TC-INT-123 — TX-417 and the reason ──────────────────────────────────────

test('TC-INT-123: only the owner may write off a debt, and the refusal is audited', async () => {
  const { customer } = owing([500000]);

  const refused = await call(`/customers/${customer.id}/write-off`, {
    token: tokens.MANAGER, method: 'POST',
    body: { amountCentavos: 500000, reason: 'The farm has closed' },
  });
  assert.equal(refused.status, 403);
  const error = (await refused.json()).error;
  assert.equal(error.rule_id, 'TX-417');
  // The refusal says what a manager *can* do, rather than stopping at no.
  assert.match(error.message, /take a payment or agree terms/);

  // Audited: "who tried to write off a debt" is a question the owner is entitled to
  // have answered, and a refusal that left no trace could not answer it.
  const trail = auditService.browse({ action: 'PERMISSION_REFUSED', entityId: customer.id });
  assert.equal(trail.rows.length, 1);
  assert.equal(trail.rows[0].after.attempted, 'WRITE_OFF');
  // The trail carries the actor as the row it was written from, so the assertion reads
  // the name rather than the shape.
  assert.equal(trail.rows[0].actor.username || trail.rows[0].actor, 'manager');

  // And nothing moved.
  assert.equal(creditService.summaryFor(customer).balance_centavos, 500000);
});

test('TC-INT-123: a write-off without a reason is refused, and the reason is free text', () => {
  const { customer } = owing([300000]);

  assert.throws(
    () => creditService.writeOff(customer.id, { amountCentavos: 300000, actor: sessions.OWNER }),
    (err) => {
      assert.equal(err.ruleId, 'CR-303');
      // It is the field the accountant reads, and the sentence says so.
      assert.match(err.message, /accountant/);
      return true;
    }
  );

  // Not a dropdown: "why did this money never arrive" has no fixed list, and a reason
  // chosen from five options is a reason nobody wrote.
  const done = creditService.writeOff(customer.id, {
    amountCentavos: 300000,
    reason: 'Farm sold up in June; the family has moved to Cotabato and left no address',
    actor: sessions.OWNER,
  });
  assert.match(done.transaction.reason, /moved to Cotabato/);
});

test('TC-INT-123: a write-off cannot exceed the debt, and never makes store credit', () => {
  const { customer } = owing([200000]);

  assert.throws(
    () => creditService.writeOff(customer.id, {
      amountCentavos: 250000, reason: 'Giving up', actor: sessions.OWNER,
    }),
    (err) => {
      assert.equal(err.ruleId, 'CR-303');
      // CR-108: the store does not owe money to somebody it has just given up on.
      assert.match(err.message, /cannot put an account into credit/);
      assert.match(err.message, /₱2,000\.00/, 'and it says what the debt actually is');
      return true;
    }
  );
  assert.equal(creditService.summaryFor(customer).balance_centavos, 200000);
});

// ── TC-INT-124 — CR-103 and CR-107 ──────────────────────────────────────────

test('TC-INT-124: the balance falls by exactly the amount, and the debits stop ageing', () => {
  const { customer, account } = owing([400000, 250000], { name: 'Ageing Off Farm' });

  const before = creditService.ageingReport();
  const beforeRow = before.accounts.find((row) => row.customer_id === customer.id);
  assert.equal(beforeRow.outstanding_centavos, 650000);
  assert.equal(beforeRow.debits.length, 2);

  const result = creditService.writeOff(customer.id, {
    amountCentavos: 400000,
    reason: 'Three months overdue and the farm will not answer',
    actor: sessions.OWNER,
  });

  // CR-103: derived from the ledger, and moved by exactly the amount.
  assert.equal(result.balance_centavos, 250000);
  assert.equal(creditService.summaryFor(customer).balance_centavos, 250000);
  assert.equal(creditService.reconcile().ok, true);

  // CR-203's allocator, third caller: the oldest invoice is settled and gone from the
  // worklist. Without this the account would be square by balance and overdue by
  // ageing — TASK-028's defect, in a new place.
  assert.equal(result.settled.length, 1);
  assert.equal(result.settled[0].sale_document_no, `SALE-WO-${seq}-1`);
  assert.equal(result.settled[0].settled_in_full, true);

  const after = creditService.ageingReport();
  const afterRow = after.accounts.find((row) => row.customer_id === customer.id);
  assert.equal(afterRow.outstanding_centavos, 250000);
  assert.deepEqual(afterRow.debits.map((d) => d.document_no), [`SALE-WO-${seq}-2`]);
  assert.equal(after.reconciles, true, after.reconciliation_note);

  // CR-302: it is on the statement, as its own kind of row, in words.
  const statement = creditService.statement(customer.id, {
    from: '2000-01-01', to: '2100-01-01', actor: sessions.OWNER,
  });
  const row = statement.lines.find((line) => line.type === 'WRITE_OFF');
  assert.ok(row, 'the write-off is on the statement');
  assert.equal(row.type_label, 'Write-off');
  assert.equal(row.amount_centavos, -400000);

  // AUD-601: the actor, the amount, the reason and what it settled.
  const trail = auditService.browse({ action: 'CREDIT_WRITTEN_OFF', entityId: account.id });
  assert.equal(trail.rows.length, 1);
  assert.equal(trail.rows[0].after.amount_centavos, 400000);
  assert.deepEqual(trail.rows[0].after.settled, [`SALE-WO-${seq}-1`]);
  assert.match(trail.rows[0].reason, /will not answer/);
});

test('TC-INT-124: a written-off account still trades, and a later payment is an ordinary collection', () => {
  const { customer } = owing([300000], { name: 'Paying Later Farm' });
  creditService.writeOff(customer.id, {
    amountCentavos: 300000, reason: 'Gave up in September', actor: sessions.OWNER,
  });
  assert.equal(creditService.summaryFor(customer).balance_centavos, 0);

  // The account is not closed. The customer buys again, and pays.
  const { account } = { account: creditService.accountFor(customer.id) };
  creditService.postStandalone({
    accountId: account.id, type: 'CREDIT_SALE', amountCentavos: 120000,
    actor: sessions.CASHIER, documentNo: 'SALE-AFTER-WO',
  });
  collectionService.record({
    customerId: customer.id, amountCentavos: 120000, method: 'CASH',
  }, sessions.CASHIER);

  // Both rows stand: the write-off is not reversed, and the payment is a payment.
  const statement = creditService.statement(customer.id, {
    from: '2000-01-01', to: '2100-01-01', actor: sessions.OWNER,
  });
  const types = statement.lines.map((line) => line.type);
  assert.deepEqual(types, ['CREDIT_SALE', 'WRITE_OFF', 'CREDIT_SALE', 'COLLECTION']);
  assert.equal(statement.closing_balance_centavos, 0);
});

// ── TC-INT-125 — CR-303, the separation ─────────────────────────────────────

test('TC-INT-125: every collections figure is identical either side of a write-off', () => {
  const { customer } = owing([700000], { name: 'Collections Untouched Farm' });

  // What the store has actually collected on this shift, before.
  const collectedBefore = shiftRepository.collectionTotalsByMethod(cashierShift.id);
  const receivableBefore = creditService.outstanding();

  creditService.writeOff(customer.id, {
    amountCentavos: 700000,
    reason: 'Uncollectable — the debtor has died and the estate is insolvent',
    actor: sessions.OWNER,
  });

  const collectedAfter = shiftRepository.collectionTotalsByMethod(cashierShift.id);

  // **The figure the rule is about.** A write-off credits the account exactly as a
  // payment does; if it reached this total, giving up on ₱7,000 would look like
  // collecting ₱7,000, and the worst month of the year would read as the best.
  assert.deepEqual(collectedAfter, collectedBefore,
    'CR-303: a write-off is in no collections figure');

  // What *does* move is the receivable, and rightly: the store is no longer owed it.
  const receivableAfter = creditService.outstanding();
  assert.equal(
    receivableAfter.total_receivable_centavos,
    receivableBefore.total_receivable_centavos - 700000
  );

  // And it is findable, in the one report that counts it.
  const report = creditService.writeOffReport({ from: '2000-01-01', to: '2100-01-01', actor: sessions.OWNER });
  const row = report.write_offs.find((entry) => entry.customer_name === 'Collections Untouched Farm');
  assert.ok(row, 'the write-off is in the write-offs report');
  assert.equal(row.amount_centavos, 700000);
  assert.match(row.reason, /estate is insolvent/);
  assert.equal(row.written_off_by, 'owner');

  // By customer as well as by row, because "who did we give up on" is the question an
  // owner asks of a year.
  const byCustomer = report.by_customer.find((entry) => entry.customer_name === 'Collections Untouched Farm');
  assert.equal(byCustomer.total_centavos, 700000);
  assert.match(report.basis, /is not a collection/);
});

test('TC-INT-125: the write-offs report is behind TX-421 at store scope, and reads over HTTP', async () => {
  const listed = await call('/reports/write-offs?from=2000-01-01&to=2100-01-01', { token: tokens.OWNER });
  assert.equal(listed.status, 200);
  const body = await listed.json();
  assert.ok(body.totals.count >= 1);
  assert.ok(body.totals.total_centavos > 0);

  // A cashier holds TX-421 for their own shift's figures; what the store gave up on is
  // not a shift's figure.
  const refused = await call('/reports/write-offs', { token: tokens.CASHIER });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.rule_id, 'TX-421');
});
