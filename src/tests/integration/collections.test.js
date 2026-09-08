'use strict';

// CR-201–CR-206 — collections and the oldest-first allocation.
//
// TC-INT-42's allocation is the case that matters beyond the balance arithmetic:
// without recording *which* sales a payment settled, a statement can only ever show a
// running balance, which is the notebook the store is trying to leave behind.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const db = require('../../config/database');
const authService = require('../../services/authService');
const customerService = require('../../services/customerService');
const creditService = require('../../services/creditService');
const collectionService = require('../../services/collectionService');
const shiftService = require('../../services/shiftService');
const documentService = require('../../services/documentService');
const drawerService = require('../../services/drawerService');
const auditService = require('../../services/auditService');
const sequenceService = require('../../services/sequenceService');
const creditRepository = require('../../repositories/creditRepository');
const temp = require('../helpers/tempdb');

const PORT = 47886;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
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

/** A credit customer owing the given amounts, oldest first, each its own credit sale. */
function owing(amounts, { terms = 15 } = {}) {
  seq += 1;
  const customer = customerService.create({
    name: `Owing Farm ${seq}`, customerType: 'FARM',
    isCreditEligible: true, creditLimitCentavos: 100000000, termsDays: terms,
  }, sessions.OWNER);
  const account = creditService.accountFor(customer.id);

  amounts.forEach((amountCentavos, i) => {
    creditService.postStandalone({
      accountId: account.id,
      type: 'CREDIT_SALE',
      amountCentavos,
      actor: sessions.CASHIER,
      documentNo: `SALE-TEST-${seq}-${i + 1}`,
      // Distinct, ascending timestamps so "oldest" is unambiguous.
      occurredAt: new Date(Date.UTC(2026, 8, 1 + i, 2, 0, 0)).toISOString(),
      dueAt: new Date(Date.UTC(2026, 8, 16 + i, 2, 0, 0)).toISOString(),
    });
  });

  return { customer, account };
}

test.before(async () => {
  temp.openEmpty('collections');
  instance = await server.start({ listenPort: PORT });
  temp.seedStore({ withOwner: false });

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

// ── TC-INT-42 — the arithmetic and the allocation ───────────────────────────

test('TC-INT-42: ₱3,000 against ₱10,000 leaves ₱7,000', () => {
  const { customer, account } = owing([1000000]);

  const result = collectionService.record({
    customerId: customer.id, amountCentavos: 300000, method: 'CASH',
  }, sessions.CASHIER);

  assert.equal(result.balance_centavos, 700000);
  assert.equal(creditRepository.findAccount(account.id).balance_centavos, 700000);
  assert.equal(creditService.reconcile().ok, true, 'CR-103 still holds');
});

test('TC-INT-42: the payment is applied oldest credit sale first, and recorded per sale', () => {
  // Three invoices, oldest ₱1,000, then ₱2,000, then ₱5,000. A ₱2,500 payment settles
  // the first and part-pays the second.
  const { customer, account } = owing([100000, 200000, 500000]);

  const result = collectionService.record({
    customerId: customer.id, amountCentavos: 250000, method: 'CASH',
  }, sessions.CASHIER);

  assert.equal(result.allocations.length, 2, 'two invoices touched, not three');
  assert.equal(result.allocations[0].amount_centavos, 100000);
  assert.equal(result.allocations[0].settled_in_full, true);
  assert.equal(result.allocations[1].amount_centavos, 150000);
  assert.equal(result.allocations[1].settled_in_full, false, 'part-paid');
  assert.equal(result.allocations[1].remaining_on_sale_centavos, 50000);

  // Oldest first is what makes ageing mean anything: applying to the newest would leave
  // the oldest standing and the account permanently overdue while the customer pays.
  assert.equal(result.allocations[0].sale_document_no.endsWith('-1'), true);
  assert.equal(result.allocations[1].sale_document_no.endsWith('-2'), true);

  const open = creditService.ageingFor(account.id, { now: '2026-09-10T02:00:00.000Z' });
  assert.equal(open.open_sales.length, 2, 'the settled one has dropped out');
  assert.equal(open.outstanding_centavos, 50000 + 500000);
  assert.equal(open.open_sales[0].settled_centavos, 150000);
});

test('CR-202: two payments in a day are two collections, never merged', () => {
  const { customer, account } = owing([1000000]);

  const first = collectionService.record({
    customerId: customer.id, amountCentavos: 300000, method: 'CASH',
  }, sessions.CASHIER);
  const second = collectionService.record({
    customerId: customer.id, amountCentavos: 200000, method: 'CASH',
  }, sessions.CASHIER);

  // Two rows, two numbers, two acknowledgements — because that is what the customer
  // was handed, twice.
  assert.notEqual(first.collection.document_no, second.collection.document_no);
  assert.equal(creditRepository.countTransactionsFor(account.id, { type: 'COLLECTION' }), 2);
  assert.equal(second.balance_centavos, 500000);

  // And both allocate against the same invoice, in order.
  const allocations = creditRepository.allocationsForSale(
    creditRepository.transactionsFor(account.id, { type: 'CREDIT_SALE' })[0].id
  );
  assert.equal(allocations.length, 2);
  assert.equal(allocations.reduce((sum, a) => sum + a.amount_centavos, 0), 500000);
});

test('a collection allocates across as many invoices as it reaches', () => {
  const { customer } = owing([100000, 100000, 100000]);

  const result = collectionService.record({
    customerId: customer.id, amountCentavos: 300000, method: 'CASH',
  }, sessions.CASHIER);

  assert.equal(result.allocations.length, 3);
  assert.ok(result.allocations.every((a) => a.settled_in_full));
  assert.equal(result.balance_centavos, 0);
});

// ── TC-INT-45 / CR-204 — overpayment ────────────────────────────────────────

test('TC-INT-45: an overpayment requires explicit confirmation', () => {
  const { customer } = owing([100000]);

  let err;
  try {
    collectionService.record({
      customerId: customer.id, amountCentavos: 150000, method: 'CASH',
    }, sessions.CASHIER);
  } catch (caught) {
    err = caught;
  }

  assert.equal(err.status, 409);
  assert.equal(err.ruleId, 'CR-204');
  assert.match(err.message, /owes ₱1,000\.00 and this payment is ₱1,500\.00/);
  assert.match(err.message, /extra ₱500\.00 becomes store credit/);
});

test('TC-INT-45: confirmed, the excess becomes store credit as a negative balance', () => {
  const { customer, account } = owing([100000]);

  const result = collectionService.record({
    customerId: customer.id, amountCentavos: 150000, method: 'CASH', acceptOverpayment: true,
  }, sessions.CASHIER);

  // CR-108: store credit is a negative outstanding balance.
  assert.equal(result.balance_centavos, -50000);
  assert.equal(result.store_credit_centavos, 50000);
  assert.equal(result.overpayment_centavos, 50000);

  // The allocation covers only what there was to settle. The excess settles nothing,
  // so it allocates to nothing.
  assert.equal(result.allocations.length, 1);
  assert.equal(result.allocations[0].amount_centavos, 100000);

  const summary = creditService.summaryFor(customer);
  assert.equal(summary.store_credit_centavos, 50000);
  assert.equal(summary.ageing_status, 'PAID');
  assert.equal(creditService.reconcile().ok, true);

  // And the acknowledgement says store credit rather than a negative balance.
  assert.match(result.acknowledgement.text, /Store credit\s+500\.00/);
  assert.equal(creditRepository.findAccount(account.id).balance_centavos, -50000);
});

test('a payment against an account with nothing outstanding is all store credit', () => {
  seq += 1;
  const customer = customerService.create({
    name: `Prepaying Farm ${seq}`, customerType: 'FARM',
    isCreditEligible: true, creditLimitCentavos: 1000000, termsDays: 15,
  }, sessions.OWNER);

  const result = collectionService.record({
    customerId: customer.id, amountCentavos: 100000, method: 'CASH', acceptOverpayment: true,
  }, sessions.CASHIER);

  assert.equal(result.allocations.length, 0, 'there was nothing to settle');
  assert.equal(result.balance_centavos, -100000);
});

// ── CR-201 — the shape of a collection ──────────────────────────────────────

test('CR-201: a non-cash collection needs a reference', () => {
  const { customer } = owing([100000]);

  for (const method of ['GCASH', 'QRPH']) {
    assert.throws(
      () => collectionService.record({
        customerId: customer.id, amountCentavos: 10000, method,
      }, sessions.CASHIER),
      (err) => err.status === 400 && err.ruleId === 'CR-201',
      method
    );
  }

  assert.doesNotThrow(() => collectionService.record({
    customerId: customer.id, amountCentavos: 10000, method: 'GCASH', referenceNo: 'GC-1001',
  }, sessions.CASHIER));

  // Cash needs none — there is nothing to trace.
  assert.doesNotThrow(() => collectionService.record({
    customerId: customer.id, amountCentavos: 10000, method: 'CASH',
  }, sessions.CASHIER));
});

test('CR-201: credit is not a collection method', () => {
  const { customer } = owing([100000]);
  // A collection is money coming in. Paying a debt with the same debt is not a payment.
  assert.throws(
    () => collectionService.record({
      customerId: customer.id, amountCentavos: 10000, method: 'CREDIT',
    }, sessions.CASHIER),
    (err) => err.ruleId === 'CR-201'
  );
});

test('a collection amount is positive, and the customer must have an account', () => {
  const { customer } = owing([100000]);

  for (const amount of [0, -1, 'lots', undefined]) {
    assert.throws(
      () => collectionService.record({
        customerId: customer.id, amountCentavos: amount, method: 'CASH',
      }, sessions.CASHIER),
      (err) => err.ruleId === 'CR-201',
      JSON.stringify(amount)
    );
  }

  const plain = customerService.create({ name: 'Cash Only Shop' }, sessions.OWNER);
  assert.throws(
    () => collectionService.record({
      customerId: plain.id, amountCentavos: 10000, method: 'CASH',
    }, sessions.CASHIER),
    (err) => err.status === 409 && err.ruleId === 'CR-101'
  );
});

// ── POS-501 — no shift, no money ────────────────────────────────────────────

test('a collection with no open shift is refused', () => {
  const { customer } = owing([100000]);
  temp.seedUser({ username: 'noshiftcoll', role: 'CASHIER', password: PASSWORD });
  const session = authService.verifyToken(
    authService.login({ username: 'noshiftcoll', password: PASSWORD }).token
  );

  let err;
  try {
    collectionService.record({
      customerId: customer.id, amountCentavos: 10000, method: 'CASH',
    }, session);
  } catch (caught) {
    err = caught;
  }

  assert.equal(err.status, 409);
  assert.equal(err.ruleId, 'POS-501');
  assert.match(err.message, /Open your shift before you take a collection/);
  assert.equal(creditService.reconcile().ok, true, 'and nothing was written');
});

// ── CR-205 / POS-507 — the till and the drawer ──────────────────────────────

test('CR-205: a cash collection raises the shift expected cash by exactly the amount', () => {
  const { customer } = owing([1000000]);
  const before = shiftService.computeExpected(cashierShift.id);

  collectionService.record({
    customerId: customer.id, amountCentavos: 250000, method: 'CASH',
  }, sessions.CASHIER);

  const after = shiftService.computeExpected(cashierShift.id);
  assert.equal(after.cash_collections_centavos, before.cash_collections_centavos + 250000);
  assert.equal(after.expected_cash_centavos, before.expected_cash_centavos + 250000);
});

test('CR-205: a non-cash collection is expected at close but never in the drawer', () => {
  const { customer } = owing([1000000]);
  const before = shiftService.computeExpected(cashierShift.id);

  collectionService.record({
    customerId: customer.id, amountCentavos: 250000, method: 'GCASH', referenceNo: 'GC-2002',
  }, sessions.CASHIER);

  const after = shiftService.computeExpected(cashierShift.id);
  assert.equal(after.expected_cash_centavos, before.expected_cash_centavos, 'the drawer is unchanged');
  assert.equal(
    after.by_method.GCASH.collections_centavos,
    before.by_method.GCASH.collections_centavos + 250000,
    'but the method is expected at close (POS-510)'
  );
  assert.equal(after.by_method.GCASH.in_drawer, false);
});

test('POS-507: the drawer is pulsed on a cash collection and not on a GCash one', () => {
  const { customer } = owing([1000000]);
  const pulses = [];
  drawerService.setDriver((record) => pulses.push(record));

  try {
    collectionService.record({
      customerId: customer.id, amountCentavos: 10000, method: 'GCASH', referenceNo: 'GC-3003',
    }, sessions.CASHIER);
    assert.equal(pulses.length, 0, 'no cash, no drawer');

    collectionService.record({
      customerId: customer.id, amountCentavos: 10000, method: 'CASH',
    }, sessions.CASHIER);
    assert.equal(pulses.length, 1);
    assert.equal(pulses[0].reason, 'CASH_COLLECTION');
    assert.equal(pulses[0].amount_centavos, 10000);
  } finally {
    drawerService.setDriver(null);
  }
});

// ── TC-INT-43 / CR-206 — the acknowledgement ────────────────────────────────

test('TC-INT-43: the acknowledgement carries everything CR-206 lists, with a COLL- number', () => {
  const { customer } = owing([100000, 200000]);

  const result = collectionService.record({
    customerId: customer.id, amountCentavos: 150000, method: 'GCASH', referenceNo: 'GC-4004',
  }, sessions.CASHIER);

  const ack = result.acknowledgement;
  assert.match(ack.document_no, /^COLL-\d{8}-\d{6}$/, 'CR-206’s format');
  assert.equal(ack.customer.name, customer.name);
  assert.equal(ack.amount_centavos, 150000);
  assert.equal(ack.method, 'GCASH');
  assert.equal(ack.reference_no, 'GC-4004');
  assert.equal(ack.balance_after_centavos, 150000);
  assert.equal(ack.received_by, 'cashier');

  // And the printed text says each of them in words the customer can read.
  assert.match(ack.text, /COLLECTION ACKNOWLEDGEMENT/);
  assert.match(ack.text, new RegExp(ack.document_no));
  // Rendered by printService at the store's paper width (TASK-014). Figures are
  // right-aligned without the peso sign, which a CP437 thermal head cannot print.
  assert.match(ack.text, /Amount\s+1,500\.00/);
  assert.match(ack.text, /Method\s+GCASH/);
  assert.match(ack.text, /Ref GC-4004/);
  assert.match(ack.text, /Balance now\s+1,500\.00/);
  assert.match(ack.text, /Received by\s+cashier/);
  assert.equal(ack.columns, 32, '58 mm by default');

  // CR-203: it shows which invoices the payment settled.
  assert.match(ack.text, /Applied to:/);
  assert.match(ack.text, /settled/);
  assert.match(ack.text, /part payment/);
});

test('TC-INT-43: the acknowledgement is subject to TAX-006', () => {
  const { customer } = owing([100000]);
  const result = collectionService.record({
    customerId: customer.id, amountCentavos: 50000, method: 'CASH',
  }, sessions.CASHIER);

  // The document carries the store name and the required sentence...
  assert.match(result.acknowledgement.text, /Test Agrivet Supply/);
  assert.match(result.acknowledgement.text, /This is not an official receipt/);

  // ...and none of the phrases TAX-006 forbids. A document that looks like an Official
  // Receipt without an Authority to Print behind it is one the store can be penalised
  // for issuing.
  const withoutNotice = result.acknowledgement.text.replace(/This is not an official receipt/ig, '');
  for (const pattern of [/official\s+receipt/i, /sales\s+invoice/i, /\bor\s*no\.?\b/i, /\batp\b/i]) {
    assert.equal(pattern.test(withoutNotice), false, String(pattern));
  }
});

test('TC-INT-43: a document missing the notice, or carrying a forbidden phrase, is refused', () => {
  // The check lives in documentService rather than in TASK-014's layout, because a
  // layout is edited and the next person editing it should not be able to put the
  // phrase back.
  assert.throws(
    () => documentService.assertTaxCompliant('Chachi Agrivet Supply\nTotal ₱100.00'),
    /must carry the words/
  );
  for (const bad of ['OFFICIAL RECEIPT', 'Sales Invoice No. 1', 'OR No. 0012', 'ATP 1-2-3', 'Permit No. 118']) {
    assert.throws(
      () => documentService.assertTaxCompliant(`Store\n${bad}\nThis is not an official receipt`),
      /must not carry/,
      bad
    );
  }
  assert.doesNotThrow(
    () => documentService.assertTaxCompliant('Store\nTotal ₱100.00\nThis is not an official receipt')
  );
});

test('TC-INT-43: numbers are gapless per day, allocated inside the transaction', () => {
  const audit = sequenceService.auditDay('COLLECTION');
  assert.ok(audit.issued > 0);
  assert.equal(audit.gapless, true);
  assert.equal(audit.numbers.every((n) => /^COLL-\d{8}-\d{6}$/.test(n)), true);
});

test('INT-1: a printer failure never rolls back a collection', () => {
  const { customer, account } = owing([100000]);
  documentService.setDriver(() => { throw new Error('printer offline'); });

  try {
    const result = collectionService.record({
      customerId: customer.id, amountCentavos: 50000, method: 'CASH',
    }, sessions.CASHIER);

    // The customer has handed over the money. A printer fault must not undo that; the
    // document is queued for reprint instead (POS-208).
    assert.equal(result.printed.delivered, false);
    assert.equal(result.printed.error, 'printer offline');
    assert.equal(creditRepository.findAccount(account.id).balance_centavos, 50000);
    assert.equal(creditService.reconcile().ok, true);
  } finally {
    documentService.setDriver(null);
  }
});

// ── Requirement 7 — one transaction ─────────────────────────────────────────

test('the credit row, its allocations and the balance commit together', (t) => {
  const { customer, account } = owing([100000]);
  const before = {
    balance: creditRepository.findAccount(account.id).balance_centavos,
    transactions: creditRepository.countTransactionsFor(account.id),
    numbers: sequenceService.auditDay('COLLECTION').issued,
    allocations: db.get().prepare('SELECT COUNT(*) AS n FROM credit_allocations').get().n,
  };

  // The audit row is the last write inside the transaction.
  t.mock.method(auditService, 'write', () => { throw new Error('disk gave out'); });

  assert.throws(() => collectionService.record({
    customerId: customer.id, amountCentavos: 50000, method: 'CASH',
  }, sessions.CASHIER), /disk gave out/);

  t.mock.restoreAll();

  assert.equal(creditRepository.findAccount(account.id).balance_centavos, before.balance, 'no balance change');
  assert.equal(creditRepository.countTransactionsFor(account.id), before.transactions, 'no credit row');
  assert.equal(db.get().prepare('SELECT COUNT(*) AS n FROM credit_allocations').get().n, before.allocations, 'no allocation');
  assert.equal(sequenceService.auditDay('COLLECTION').issued, before.numbers, 'no number consumed');
  assert.equal(creditService.reconcile().ok, true);
});

// ── TC-INT-46 — the invariant holds after collections ───────────────────────

test('TC-INT-46: the balance still reconciles to its ledger after every collection', () => {
  const reconciliation = creditService.reconcile();
  assert.equal(reconciliation.ok, true, JSON.stringify(reconciliation.breaks));

  // And each account's allocations never exceed the debit they are against.
  const overAllocated = db.get().prepare(`
    SELECT t.id, t.amount_centavos, SUM(a.amount_centavos) AS allocated
      FROM customer_credit_transactions t
      JOIN credit_allocations a ON a.sale_txn_id = t.id
     GROUP BY t.id
    HAVING SUM(a.amount_centavos) > t.amount_centavos
  `).all();
  assert.deepEqual(overAllocated, [], 'no invoice is settled more than once');
});

// ── Over HTTP ───────────────────────────────────────────────────────────────

test('POST /customers/:id/collections needs TX-416', async () => {
  const { customer } = owing([100000]);

  const refused = await call(`/customers/${customer.id}/collections`, {
    token: tokens.INVENTORY, method: 'POST', body: { amountCentavos: 10000, method: 'CASH' },
  });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.rule_id, 'TX-416');

  // §10 grants TX-416 to owner, manager and cashier — the counter takes payments.
  const res = await call(`/customers/${customer.id}/collections`, {
    token: tokens.CASHIER, method: 'POST', body: { amountCentavos: 30000, method: 'CASH' },
  });
  assert.equal(res.status, 201);
  const body = await res.json();

  assert.equal(body.balance_centavos, 70000);
  assert.equal(body.allocations.length, 1);
  assert.match(body.acknowledgement.document_no, /^COLL-/);
  assert.equal(body.drawer.reason, 'CASH_COLLECTION');
  assert.ok(body.expected.expected_cash_centavos > 0, 'the screen gets the new till figure');
});

test('an overpayment over HTTP asks before it makes store credit', async () => {
  const { customer } = owing([100000]);

  const refused = await call(`/customers/${customer.id}/collections`, {
    token: tokens.CASHIER, method: 'POST', body: { amountCentavos: 200000, method: 'CASH' },
  });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error.rule_id, 'CR-204');

  const accepted = await call(`/customers/${customer.id}/collections`, {
    token: tokens.CASHIER, method: 'POST',
    body: { amountCentavos: 200000, method: 'CASH', acceptOverpayment: true },
  });
  assert.equal(accepted.status, 201);
  assert.equal((await accepted.json()).store_credit_centavos, 100000);
});

test('GET /customers/:id/collections shows each payment and what it settled', async () => {
  const { customer } = owing([100000, 100000]);
  collectionService.record({
    customerId: customer.id, amountCentavos: 150000, method: 'CASH',
  }, sessions.CASHIER);

  const body = await (await call(`/customers/${customer.id}/collections`, { token: tokens.MANAGER })).json();

  assert.equal(body.total, 1);
  assert.equal(body.collections[0].amount_centavos, -150000, 'a credit on the ledger');
  assert.equal(body.collections[0].type_label, 'Collection');
  assert.equal(body.collections[0].allocations.length, 2, 'CR-203: which invoices it settled');
  assert.equal(
    body.collections[0].allocations.reduce((sum, a) => sum + a.amount_centavos, 0),
    150000
  );
});
