'use strict';

// Customers and the credit ledger against a real database and over HTTP.
//
// TC-INT-46 is the one that matters: the balance reconciles to its ledger, and it is a
// permanent regression guard (07_TEST_PLAN.md §7). It is written the way TC-INT-20 was
// — reconciled two independent ways, then deliberately broken to prove the check works.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const db = require('../../config/database');
const authService = require('../../services/authService');
const customerService = require('../../services/customerService');
const creditService = require('../../services/creditService');
const auditService = require('../../services/auditService');
const creditRepository = require('../../repositories/creditRepository');
const customerRepository = require('../../repositories/customerRepository');
const temp = require('../helpers/tempdb');

const PORT = 47891;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
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
function makeCustomer(over = {}) {
  seq += 1;
  return customerService.create({
    name: `Santos Farm ${seq}`,
    customerType: 'FARM',
    priceLevel: 'WHOLESALE',
    ...over,
  }, sessions.OWNER);
}

/** A credit-eligible customer with a limit and terms, and its account. */
function makeCreditCustomer(over = {}) {
  const customer = makeCustomer({
    isCreditEligible: true, creditLimitCentavos: 5000000, termsDays: 15, ...over,
  });
  return { customer, account: creditService.accountFor(customer.id) };
}

test.before(async () => {
  temp.openEmpty('customers');
  instance = await server.start({ listenPort: PORT });
  temp.seedStore({ withOwner: false });

  for (const role of ['OWNER', 'MANAGER', 'CASHIER', 'INVENTORY']) {
    const username = role.toLowerCase();
    temp.seedUser({ username, role, password: PASSWORD });
    const signedIn = authService.login({ username, password: PASSWORD });
    tokens[role] = signedIn.token;
    sessions[role] = authService.verifyToken(signedIn.token);
  }
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── VR-301, VR-302 — the customer record ────────────────────────────────────

test('a customer needs a name of 2 to 120 characters (VR-301)', () => {
  for (const name of ['', 'X', '   ', undefined]) {
    assert.throws(
      () => customerService.create({ name }, sessions.OWNER),
      (err) => err.status === 400 && err.ruleId === 'VR-301',
      JSON.stringify(name)
    );
  }
  assert.equal(customerRepository.countAll(), 0, 'nothing written by a refusal');
});

test('VR-302: a contact number matches a Philippine pattern, however it is written', () => {
  // These are how people actually write a number down. A validator that rejects
  // "0917 123 4567" teaches the counter to leave the field empty.
  for (const contact of ['09171234567', '0917 123 4567', '+639171234567', '(082) 234 5678', '082-2345678']) {
    assert.doesNotThrow(() => customerService.validateContact(contact), contact);
  }
  for (const contact of ['12345', 'ring the bell', '099']) {
    assert.throws(
      () => customerService.validateContact(contact),
      (err) => err.status === 400 && err.ruleId === 'VR-302',
      contact
    );
  }
  assert.equal(customerService.validateContact(''), null, 'optional');
  assert.equal(customerService.validateContact('0917 123 4567'), '0917 123 4567', 'stored as written');
});

test('a customer code is unique, case-insensitively', () => {
  makeCustomer({ code: 'SANTOS' });
  assert.throws(
    () => makeCustomer({ code: 'santos' }),
    (err) => err.status === 409 && err.ruleId === 'VR-301'
  );
});

// ── VR-303 / CR-101 — the credit account ────────────────────────────────────

test('a credit-eligible customer gets an account with a limit and terms (VR-303)', () => {
  const { customer, account } = makeCreditCustomer();

  assert.ok(account, 'the account is created with the customer, not on a second screen');
  assert.equal(account.credit_limit_centavos, 5000000);
  assert.equal(account.terms_days, 15);
  assert.equal(account.balance_centavos, 0);

  const view = customerService.get(customer.id);
  assert.equal(view.credit.available_centavos, 5000000, 'CR-101: limit minus balance');
  assert.equal(view.credit.terms_label, '15 days');
  assert.equal(view.credit.ageing_status, 'PAID', 'nothing outstanding');
});

test('a customer who is not credit-eligible has no account, and that is not zero', () => {
  const customer = makeCustomer();
  // "No credit account" and "an account at zero" are different facts, and a screen
  // showing ₱0.00 available for both cannot tell them apart.
  assert.equal(creditService.accountFor(customer.id), null);
  assert.equal(customerService.get(customer.id).credit, undefined);
});

test('a walk-in cannot be credit-eligible (CR-102)', () => {
  assert.throws(
    () => makeCustomer({ customerType: 'WALK_IN', isCreditEligible: true, creditLimitCentavos: 100 }),
    (err) => err.status === 400 && err.ruleId === 'CR-102'
  );
});

test('making an existing customer credit-eligible opens the account', () => {
  const customer = makeCustomer();
  const updated = customerService.update(
    customer.id,
    { isCreditEligible: true, creditLimitCentavos: 2000000, termsDays: 30 },
    sessions.OWNER
  );

  assert.equal(updated.credit.credit_limit_centavos, 2000000);
  assert.equal(updated.credit.terms_days, 30);
});

// ── TC-UT-40 / CR-102 — who may buy on credit ───────────────────────────────

test('TC-UT-40: a credit tender requires a registered, active, eligible customer', () => {
  // Four separate refusals, each naming which of the four conditions failed. "No credit
  // for you" without saying why is a refusal the counter cannot act on.
  assert.throws(
    () => creditService.assertCreditEligible(null),
    (err) => err.status === 400 && err.ruleId === 'CR-102' && /walk-in/i.test(err.message),
    'no customer at all'
  );
  assert.throws(
    () => creditService.assertCreditEligible('not-a-customer'),
    (err) => err.status === 404,
    'unregistered'
  );

  const plain = makeCustomer();
  assert.throws(
    () => creditService.assertCreditEligible(plain.id),
    (err) => err.status === 409 && err.ruleId === 'CR-102' && /not set up for credit/.test(err.message),
    'registered but not eligible'
  );

  const { customer } = makeCreditCustomer();
  assert.doesNotThrow(() => creditService.assertCreditEligible(customer.id), 'eligible');

  customerService.update(customer.id, { isActive: false }, sessions.OWNER);
  assert.throws(
    () => creditService.assertCreditEligible(customer.id),
    (err) => err.status === 409 && err.ruleId === 'CR-102' && /not an active customer/.test(err.message),
    'deactivated'
  );
});

// ── TC-INT-46 / CR-103 — the balance derives from the ledger ────────────────

test('TC-INT-46: the balance always equals the sum of its credit transactions', () => {
  const { customer, account } = makeCreditCustomer();
  const actor = sessions.CASHIER;

  // A farm's month: an opening balance from the notebook, two credit sales, a part
  // payment, a return and a small correction.
  creditService.postStandalone({ accountId: account.id, type: 'OPENING', amountCentavos: 1200000, actor, documentNo: 'OPEN-001' });
  creditService.postStandalone({ accountId: account.id, type: 'CREDIT_SALE', amountCentavos: 625000, actor, documentNo: 'S-0001', dueAt: '2026-09-20T00:00:00.000Z' });
  creditService.postStandalone({ accountId: account.id, type: 'CREDIT_SALE', amountCentavos: 384400, actor, documentNo: 'S-0002', dueAt: '2026-09-25T00:00:00.000Z' });
  creditService.postStandalone({ accountId: account.id, type: 'COLLECTION', amountCentavos: 500000, actor, documentNo: 'COLL-0001', method: 'CASH' });
  creditService.postStandalone({ accountId: account.id, type: 'RETURN_CREDIT', amountCentavos: 62500, actor, documentNo: 'R-0001', reason: 'Torn sack returned' });
  creditService.postStandalone({ accountId: account.id, type: 'ADJUSTMENT', amountCentavos: -1900, actor, documentNo: 'ADJ-0001', reason: 'Rounding on the notebook balance' });

  const expected = 1200000 + 625000 + 384400 - 500000 - 62500 - 1900;

  assert.equal(creditService.reconcile().ok, true);
  assert.equal(creditRepository.findAccount(account.id).balance_centavos, expected);

  // Asserted independently of the service's own reconciliation query, so the guard is
  // not checking its own arithmetic against itself.
  const ledgerSum = db.get()
    .prepare('SELECT SUM(amount_centavos) AS n FROM customer_credit_transactions WHERE account_id = ?')
    .get(account.id).n;
  assert.equal(ledgerSum, expected);

  // And every row's balance_after agrees with the running total before it.
  const rows = db.get()
    .prepare('SELECT amount_centavos, balance_after_centavos FROM customer_credit_transactions WHERE account_id = ? ORDER BY occurred_at, id')
    .all(account.id);
  let running = 0;
  for (const row of rows) {
    running += row.amount_centavos;
    assert.equal(row.balance_after_centavos, running, 'balance_after_centavos is the running total');
  }

  assert.equal(customerService.get(customer.id).credit.balance_centavos, expected);
});

test('TC-INT-46: the check detects a break when one is introduced', () => {
  // A guard nobody has seen fail is a guard nobody knows works. The stored balance is
  // corrupted directly — which no application path can do — and put back afterwards.
  const { account } = makeCreditCustomer();
  creditService.postStandalone({
    accountId: account.id, type: 'CREDIT_SALE', amountCentavos: 100000,
    actor: sessions.CASHIER, documentNo: 'S-0003',
  });

  db.get().prepare('UPDATE customer_credit_accounts SET balance_centavos = 1 WHERE id = ?').run(account.id);
  const broken = creditService.reconcile();

  assert.equal(broken.ok, false);
  assert.equal(broken.breaks.length, 1);
  assert.equal(broken.breaks[0].account_id, account.id);
  assert.equal(broken.breaks[0].difference_centavos, 1 - 100000);

  db.get().prepare('UPDATE customer_credit_accounts SET balance_centavos = 100000 WHERE id = ?').run(account.id);
  assert.equal(creditService.reconcile().ok, true);
});

test('TC-INT-46: no repository method updates or deletes a credit transaction', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'repositories', 'creditRepository.js'), 'utf8'
  );

  // Only string literals, for the reason TC-UT-99 gives: prose about "never deleted"
  // is not a delete path. Verbs assembled from fragments so this file does not match
  // its own pattern.
  const literals = source.split('\n').flatMap((line) => [...line.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? ''));
  const templates = source.match(/`[\s\S]*?`/g) || [];

  for (const verb of ['UP' + 'DATE', 'DEL' + 'ETE', 'DR' + 'OP', 'TRUN' + 'CATE']) {
    const pattern = new RegExp(`${verb}[\\s\\S]{0,60}customer_credit_transactions`, 'i');
    const offender = [...literals, ...templates].find((text) => pattern.test(text));
    assert.equal(offender, undefined, `${verb} path on customer_credit_transactions`);
  }
});

test('CR-103: a credit transaction in a rolled-back transaction takes the balance with it', () => {
  const { account } = makeCreditCustomer();
  creditService.postStandalone({
    accountId: account.id, type: 'CREDIT_SALE', amountCentavos: 100000,
    actor: sessions.CASHIER, documentNo: 'S-0004',
  });

  assert.throws(() => db.transaction(() => {
    creditService.post({
      accountId: account.id, type: 'CREDIT_SALE', amountCentavos: 50000,
      actor: sessions.CASHIER, documentNo: 'S-0005',
    });
    throw new Error('the sale refused after its credit row was written');
  }), /sale refused/);

  assert.equal(creditRepository.findAccount(account.id).balance_centavos, 100000);
  assert.equal(creditRepository.countTransactionsFor(account.id), 1, 'no orphan row');
  assert.equal(creditService.reconcile().ok, true);
});

// ── CR-107 — ageing, derived, against real rows ─────────────────────────────

test('CR-107: ageing derives from open sales, and the worst one decides the account', () => {
  const { customer, account } = makeCreditCustomer();
  const actor = sessions.CASHIER;
  const now = '2026-09-20T02:00:00.000Z';        // 10am Manila on the 20th

  creditService.postStandalone({ accountId: account.id, type: 'CREDIT_SALE', amountCentavos: 100000, actor, documentNo: 'S-A', dueAt: '2026-10-30T00:00:00.000Z' });
  creditService.postStandalone({ accountId: account.id, type: 'CREDIT_SALE', amountCentavos: 200000, actor, documentNo: 'S-B', dueAt: '2026-09-22T00:00:00.000Z' });

  const soon = creditService.ageingFor(account.id, { now });
  assert.equal(soon.status, 'DUE_SOON', 'one sale is two days out');
  assert.equal(soon.outstanding_centavos, 300000);
  assert.equal(soon.open_sales.length, 2);
  assert.equal(soon.open_sales.find((s) => s.document_no === 'S-A').status, 'CURRENT');

  // One overdue sale makes the account overdue, whatever the others say.
  creditService.postStandalone({ accountId: account.id, type: 'CREDIT_SALE', amountCentavos: 50000, actor, documentNo: 'S-C', dueAt: '2026-09-01T00:00:00.000Z' });

  const overdue = creditService.ageingFor(account.id, { now });
  assert.equal(overdue.status, 'OVERDUE');
  assert.equal(overdue.days_overdue, 19, 'from the oldest unpaid due date');
  assert.equal(overdue.oldest_due_at, '2026-09-01T00:00:00.000Z');

  // And the same account, read on a later day, moves on its own.
  const later = creditService.ageingFor(account.id, { now: '2026-11-05T02:00:00.000Z' });
  assert.equal(later.open_sales.every((s) => s.status === 'OVERDUE'), true, 'CR-107: no job ran');

  assert.equal(customerService.get(customer.id).credit.ageing_status, 'OVERDUE');
});

test('CR-107: a settled sale drops out of the ageing, PAID when nothing is left', () => {
  const { account } = makeCreditCustomer();
  const actor = sessions.CASHIER;
  const at = '2026-09-01T02:00:00.000Z';

  const sale = creditService.postStandalone({
    accountId: account.id, type: 'CREDIT_SALE', amountCentavos: 100000, actor,
    documentNo: 'S-D', dueAt: '2026-09-05T00:00:00.000Z', occurredAt: at,
  });
  const collection = creditService.postStandalone({
    accountId: account.id, type: 'COLLECTION', amountCentavos: 60000, actor,
    documentNo: 'COLL-0002', method: 'CASH',
  });

  // TASK-012 owns the oldest-first allocation (CR-203); the ageing derivation only
  // needs the rows, so a partial allocation is written here directly.
  creditRepository.insertAllocation({
    id: require('../../config/ids').uuidv7(),
    collection_txn_id: collection.transaction.id,
    sale_txn_id: sale.transaction.id,
    amount_centavos: 60000,
    created_at: at,
  });

  const partial = creditService.ageingFor(account.id, { now: '2026-09-10T02:00:00.000Z' });
  assert.equal(partial.status, 'OVERDUE');
  assert.equal(partial.outstanding_centavos, 40000, 'what is left of the sale, not the whole of it');
  assert.equal(partial.open_sales[0].settled_centavos, 60000);

  creditRepository.insertAllocation({
    id: require('../../config/ids').uuidv7(),
    collection_txn_id: collection.transaction.id,
    sale_txn_id: sale.transaction.id,
    amount_centavos: 40000,
    created_at: at,
  });

  const settled = creditService.ageingFor(account.id, { now: '2026-09-10T02:00:00.000Z' });
  assert.equal(settled.status, 'PAID');
  assert.equal(settled.open_sales.length, 0);
});

test('CR-105: the due date on the transaction survives a later terms change', () => {
  const { customer, account } = makeCreditCustomer({ termsDays: 15 });
  const at = '2026-09-01T02:00:00.000Z';

  const dueAt = creditService.dueDateFor(account, { at });
  creditService.postStandalone({
    accountId: account.id, type: 'CREDIT_SALE', amountCentavos: 100000,
    actor: sessions.CASHIER, documentNo: 'S-E', dueAt, occurredAt: at,
  });
  assert.equal(dueAt, '2026-09-16T02:00:00.000Z');

  // The farm is moved to 30-day terms. The sale it already owes on does not move with
  // it — the transaction carries the date, the customer record does not.
  creditService.setLimit(customer.id, 5000000, sessions.OWNER, { termsDays: 30 });

  const [row] = creditRepository.transactionsFor(account.id, { type: 'CREDIT_SALE' });
  assert.equal(row.due_at, '2026-09-16T02:00:00.000Z', 'unmoved');
  assert.equal(creditService.accountFor(customer.id).terms_days, 30, 'the next sale gets 30 days');
});

// ── VR-304, VR-305 — removal ────────────────────────────────────────────────

test('VR-305: a customer with a balance cannot be deactivated', () => {
  const { customer, account } = makeCreditCustomer();
  creditService.postStandalone({
    accountId: account.id, type: 'CREDIT_SALE', amountCentavos: 250000,
    actor: sessions.CASHIER, documentNo: 'S-F',
  });

  let err;
  try {
    customerService.deactivate(customer.id, sessions.OWNER);
  } catch (caught) {
    err = caught;
  }

  assert.equal(err.status, 409);
  assert.equal(err.ruleId, 'VR-305');
  assert.match(err.message, /still owes ₱2,500\.00/, 'the message states the debt');
  assert.match(err.message, /Collect or write off/, 'and what to do about it');
  assert.equal(customerService.get(customer.id).is_active, true);

  // Settled, it deactivates.
  creditService.postStandalone({
    accountId: account.id, type: 'COLLECTION', amountCentavos: 250000,
    actor: sessions.CASHIER, documentNo: 'COLL-0003', method: 'CASH',
  });
  assert.equal(customerService.deactivate(customer.id, sessions.OWNER).is_active, false);
});

test('VR-305 applies to store credit too, in the other direction', () => {
  const { customer, account } = makeCreditCustomer();
  creditService.postStandalone({
    accountId: account.id, type: 'RETURN_CREDIT', amountCentavos: 30000,
    actor: sessions.CASHIER, documentNo: 'R-0002', reason: 'Returned unopened',
  });

  assert.throws(
    () => customerService.deactivate(customer.id, sessions.OWNER),
    (err) => err.ruleId === 'VR-305' && /holds ₱300\.00 in store credit/.test(err.message)
  );
});

test('withdrawing credit eligibility is refused while a balance stands', () => {
  const { customer, account } = makeCreditCustomer();
  creditService.postStandalone({
    accountId: account.id, type: 'CREDIT_SALE', amountCentavos: 1000,
    actor: sessions.CASHIER, documentNo: 'S-G',
  });

  assert.throws(
    () => customerService.update(customer.id, { isCreditEligible: false }, sessions.OWNER),
    (err) => err.ruleId === 'VR-305'
  );
});

test('VR-304: a transacted customer cannot be deleted, only deactivated', () => {
  const { customer, account } = makeCreditCustomer();
  creditService.postStandalone({
    accountId: account.id, type: 'OPENING', amountCentavos: 5000,
    actor: sessions.OWNER, documentNo: 'OPEN-002',
  });

  assert.throws(
    () => customerService.assertDeletable(customer.id),
    (err) => err.status === 409 && err.ruleId === 'VR-304'
  );

  const fresh = makeCustomer();
  assert.doesNotThrow(() => customerService.assertDeletable(fresh.id), 'a customer with no history');
});

// ── CR-106 / TC-API-01 — the limit change ───────────────────────────────────

test('TC-API-01: a credit limit change needs TX-414', async () => {
  const { customer } = makeCreditCustomer();

  for (const role of ['CASHIER', 'INVENTORY']) {
    const res = await call(`/customers/${customer.id}/credit-limit`, {
      token: tokens[role], method: 'PUT', body: { creditLimitCentavos: 99999999 },
    });
    assert.equal(res.status, 403, `${role} may not set a credit limit`);
    assert.equal((await res.json()).error.rule_id, 'TX-414');
  }

  // §10 grants TX-414 to owner and manager.
  const ok = await call(`/customers/${customer.id}/credit-limit`, {
    token: tokens.MANAGER, method: 'PUT',
    body: { creditLimitCentavos: 8000000, reason: 'Good payer, harvest season' },
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).credit.credit_limit_centavos, 8000000);
});

test('CR-106: a limit change is audited with both values', () => {
  const { customer } = makeCreditCustomer();
  creditService.setLimit(customer.id, 9000000, sessions.OWNER, { reason: 'Reviewed at year end' });

  const account = creditService.accountFor(customer.id);
  const [row] = auditService.browse({ action: 'CREDIT_LIMIT_CHANGED', entityId: account.id }).rows;

  assert.deepEqual(row.before, { credit_limit_centavos: 5000000, terms_days: 15 });
  assert.deepEqual(row.after, { credit_limit_centavos: 9000000, terms_days: 15 });
  assert.equal(row.actor.username, 'owner');
  assert.equal(row.reason, 'Reviewed at year end');
});

test('a limit change on a customer with no credit account is refused clearly', () => {
  const customer = makeCustomer();
  assert.throws(
    () => creditService.setLimit(customer.id, 100000, sessions.OWNER),
    (err) => err.status === 409 && err.ruleId === 'CR-101' && /credit-eligible first/.test(err.message)
  );
});

// ── Over HTTP ───────────────────────────────────────────────────────────────

test('TX-413 admits the counter to look a customer up; a clerk reads but does not edit', async () => {
  const { customer } = makeCreditCustomer();

  for (const role of ['OWNER', 'MANAGER', 'CASHIER', 'INVENTORY']) {
    assert.equal((await call(`/customers/${customer.id}`, { token: tokens[role] })).status, 200, role);
  }

  // §10's INVENTORY cell for TX-413 is VIEW, not a tick.
  const clerk = await call('/customers', {
    token: tokens.INVENTORY, method: 'POST', body: { name: 'Should Not Exist' },
  });
  assert.equal(clerk.status, 403);
  assert.equal((await clerk.json()).error.rule_id, 'TX-413');

  // A cashier registers a farm at the counter, which is the point of the FULL grant.
  const cashier = await call('/customers', {
    token: tokens.CASHIER, method: 'POST', body: { name: 'Reyes Poultry', customerType: 'FARM' },
  });
  assert.equal(cashier.status, 201);
});

test('GET /customers/:id/credit returns limit, balance, available and ageing (SCR-402)', async () => {
  const { customer, account } = makeCreditCustomer();
  creditService.postStandalone({
    accountId: account.id, type: 'CREDIT_SALE', amountCentavos: 1200000,
    actor: sessions.CASHIER, documentNo: 'S-H', dueAt: '2026-01-01T00:00:00.000Z',
  });

  const res = await call(`/customers/${customer.id}/credit`, { token: tokens.CASHIER });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.credit.credit_limit_centavos, 5000000);
  assert.equal(body.credit.balance_centavos, 1200000);
  assert.equal(body.credit.available_centavos, 3800000);
  assert.equal(body.credit.ageing_status, 'OVERDUE');
  assert.ok(body.credit.days_overdue > 0);
  assert.equal(body.open_sales.length, 1);
  assert.equal(body.transactions.rows[0].type_label, 'Credit sale');
});

test('a customer without credit says so rather than reporting zero', async () => {
  const customer = makeCustomer();
  const body = await (await call(`/customers/${customer.id}/credit`, { token: tokens.CASHIER })).json();

  assert.equal(body.credit, null);
  assert.match(body.message, /not set up for credit/);
});

test('a customer is deactivated, never deleted, over HTTP', async () => {
  const customer = makeCustomer();

  const deleted = await call(`/customers/${customer.id}`, { token: tokens.OWNER, method: 'DELETE' });
  assert.equal(deleted.status, 409);
  assert.equal((await deleted.json()).error.rule_id, 'VR-304');

  const off = await call(`/customers/${customer.id}/deactivate`, { token: tokens.OWNER, method: 'POST' });
  assert.equal(off.status, 200);
  assert.equal((await off.json()).customer.is_active, false);
});

test('search matches name, code and contact number, and can filter to credit customers', async () => {
  makeCreditCustomer({ name: 'Dela Cruz Piggery', code: 'DLC-01', contactNo: '09171234567' });

  for (const q of ['Dela Cruz', 'DLC-01', '09171234567']) {
    const body = await (await call(`/customers?q=${encodeURIComponent(q)}`, { token: tokens.CASHIER })).json();
    assert.ok(body.customers.some((c) => c.code === 'DLC-01'), q);
  }

  const creditOnly = await (await call('/customers?creditOnly=true', { token: tokens.CASHIER })).json();
  assert.ok(creditOnly.customers.every((c) => c.is_credit_eligible));
});

test('the outstanding worklist carries every account with a balance, aged', async () => {
  const res = await call('/customers/outstanding', { token: tokens.MANAGER });
  const body = await res.json();

  assert.ok(body.accounts.length > 0);
  assert.equal(
    body.total_balance_centavos,
    body.accounts.reduce((sum, a) => sum + a.balance_centavos, 0),
    'the total is the sum of its rows'
  );
  assert.ok(body.accounts.every((a) => creditService.AGEING.includes(a.ageing_status)));
});

test('the credit reconciliation endpoint is owner-only and reports clean', async () => {
  assert.equal((await call('/customers/credit-reconciliation', { token: tokens.MANAGER })).status, 403);

  const res = await call('/customers/credit-reconciliation', { token: tokens.OWNER });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, breaks: [] });
});

// ── The soft references (05_TECH_SPEC.md §3.4 deviation) ────────────────────

test('TC-INT-47: a credit transaction is writable before sales and cashier_shifts exist', () => {
  // The same trap 001 documented for audit_logs.shift_id. SQLite resolves a foreign
  // key's parent table at INSERT time, so declaring REFERENCES sales(id) here would
  // make every insert fail until migration 006 — a NULL sale_id included. An OPENING
  // balance from the notebook (TASK-026) carries neither a sale nor a shift and must
  // be writable the day this table exists.
  const schemaRepository = require('../../repositories/schemaRepository');
  assert.equal(schemaRepository.listTables().includes('sales'), false, 'sales arrive in 006');
  assert.equal(schemaRepository.listTables().includes('cashier_shifts'), false, 'shifts arrive in 005');

  const { account } = makeCreditCustomer();
  assert.doesNotThrow(() => creditService.postStandalone({
    accountId: account.id, type: 'OPENING', amountCentavos: 750000,
    actor: sessions.OWNER, documentNo: 'OPEN-003',
  }), 'no sale, no shift');

  assert.doesNotThrow(() => creditService.postStandalone({
    accountId: account.id, type: 'CREDIT_SALE', amountCentavos: 1000,
    actor: sessions.CASHIER, documentNo: 'S-I',
    saleId: 'a-sale-whose-table-does-not-exist-yet',
    shiftId: 'a-shift-whose-table-does-not-exist-yet',
  }), 'and with both ids set');

  assert.deepEqual(schemaRepository.foreignKeyCheck(), [], 'no foreign key violations introduced');
});
