'use strict';

// FT-408 — store credit. CR-108, CR-103, CR-204, POS-305.
//
// `TC-INT-103` to `TC-INT-106`. The feature is one sentence — a customer's balance may
// be money the store owes *them*, and they may spend it — and three of the four cases
// are about the ways that sentence goes wrong in a ledger:
//
//   • a **second** ledger. `CR-103` derives one balance from one set of transactions;
//     a parallel store-credit table would be a second figure to disagree with it, and
//     the disagreement would be discovered by a customer being told they have nothing.
//     So spending it is an ordinary debit, and `TC-INT-105` reconciles the lot.
//   • a balance that moves **for no visible reason**. Earned on one line and spent on
//     another, or the statement is the notebook the store is leaving behind.
//   • a credit balance **aged as a debt**. `CR-107` derives ageing from unsettled
//     debits, so a credit that settles one and does not say so is a collection letter
//     addressed to somebody who owes nothing — `TC-INT-106`.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const customerService = require('../../services/customerService');
const inventoryService = require('../../services/inventoryService');
const creditService = require('../../services/creditService');
const collectionService = require('../../services/collectionService');
const returnService = require('../../services/returnService');
const shiftService = require('../../services/shiftService');
const saleService = require('../../services/saleService');
const clock = require('../../config/clock');
const creditRepository = require('../../repositories/creditRepository');
const saleRepository = require('../../repositories/saleRepository');
const temp = require('../helpers/tempdb');

let BASE = null;
const PASSWORD = 'correct-horse-battery';

let instance;
let ref;
let product;
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

/** A farm with a limit, so the account exists and the ledger has somewhere to live. */
function farm({ limitCentavos = 5000000, termsDays = 30 } = {}) {
  seq += 1;
  const customer = customerService.create({
    name: `Credit Farm ${seq}`, customerType: 'FARM', priceLevel: 'RETAIL',
    isCreditEligible: true, creditLimitCentavos: limitCentavos, termsDays,
  }, sessions.OWNER);
  return { customer, account: creditService.accountFor(customer.id) };
}

const balanceOf = (customerId) => creditRepository.findAccountByCustomer(customerId).balance_centavos;
const creditOf = (customerId) => creditService.summaryFor({ id: customerId });

test.before(async () => {
  temp.openEmpty('store-credit');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;
  temp.seedStore({ taxMode: 'NONE', withOwner: false });
  ref = temp.seedCatalog();

  for (const role of ['OWNER', 'MANAGER', 'CASHIER']) {
    const username = role.toLowerCase();
    temp.seedUser({ username, role, password: PASSWORD });
    const signedIn = authService.login({ username, password: PASSWORD });
    tokens[role] = signedIn.token;
    sessions[role] = authService.verifyToken(signedIn.token);
  }

  product = productService.create({
    sku: 'SCR-FEED', name: 'Hog Grower Pellets',
    categoryId: ref.category.id, baseUnitId: ref.kg.id, retailPriceCentavos: 6000,
  }, sessions.OWNER);
  inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli: 5000000, unitCostCentavos: 4000, actor: sessions.OWNER,
  });

  shiftService.open({ actor: sessions.CASHIER, openingFloatCentavos: 500000, confirmed: true });
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── TC-INT-103 — CR-108: both sources leave a spendable balance ─────────────

test('TC-INT-103: an overpayment leaves store credit, and it is not a debt', () => {
  const { customer } = farm();

  // CR-204: the excess is store credit, and it takes an explicit acknowledgement —
  // a cashier who mis-keys ₱5,000 for ₱500 is told before the ledger moves.
  assert.throws(
    () => collectionService.record({ customerId: customer.id, amountCentavos: 50000, method: 'CASH' }, sessions.CASHIER),
    (err) => err.status === 409 && err.ruleId === 'CR-204'
  );

  collectionService.record({
    customerId: customer.id, amountCentavos: 50000, method: 'CASH', acceptOverpayment: true,
  }, sessions.CASHIER);

  assert.equal(balanceOf(customer.id), -50000, 'CR-108: a negative outstanding balance');

  const credit = creditOf(customer.id);
  assert.equal(credit.store_credit_centavos, 50000, 'and it is served as a positive figure');
  assert.equal(credit.ageing_status, 'PAID', 'they owe nothing, so nothing is ageing');
  assert.equal(credit.outstanding_centavos, 0);
});

test('TC-INT-103: a return with nothing owing leaves store credit rather than cash', () => {
  const { customer } = farm();

  // A credit sale, paid off in full. The farm owes nothing and has no credit.
  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 5000 }],
    customerId: customer.id,
    tenders: [{ method: 'CREDIT', amountCentavos: 30000 }],
  }, sessions.CASHIER);
  collectionService.record({
    customerId: customer.id, amountCentavos: 30000, method: 'CASH',
  }, sessions.CASHIER);
  assert.equal(balanceOf(customer.id), 0);

  // POS-305: the sale was on credit, so the refund goes to the ledger — and with
  // nothing owing it goes past zero rather than being paid out in notes.
  const returned = returnService.post({
    saleId: sale.sale.id,
    lines: [{ saleItemId: saleRepository.itemsFor(sale.sale.id)[0].id, qtyMilli: 5000, disposition: 'RESTOCK' }],
    reason: 'Wrong item sold',
  }, sessions.CASHIER);

  assert.equal(returned.sale_return.refund.cash_centavos, 0, 'no cash left the till');
  assert.equal(returned.sale_return.refund.store_credit_centavos, 30000);
  assert.equal(balanceOf(customer.id), -30000);
  assert.equal(creditOf(customer.id).store_credit_centavos, 30000);
});

// ── TC-INT-104 — the tender ────────────────────────────────────────────────

test('TC-INT-104: a sale is paid from store credit, and the balance falls by exactly that', () => {
  const { customer } = farm();
  collectionService.record({
    customerId: customer.id, amountCentavos: 50000, method: 'CASH', acceptOverpayment: true,
  }, sessions.CASHIER);

  // ₱300 of feed, ₱200 off the credit held and ₱100 in cash — the split the feature
  // exists for. Requirement 2: STORE_CREDIT was in the schema's CHECK from TASK-011
  // and nothing issued one until now.
  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 5000 }],
    customerId: customer.id,
    tenders: [
      { method: 'STORE_CREDIT', amountCentavos: 20000 },
      { method: 'CASH', amountCentavos: 10000 },
    ],
  }, sessions.CASHIER);

  assert.equal(sale.sale.total_centavos, 30000);
  assert.equal(sale.sale.change_centavos, 0);
  assert.deepEqual(sale.tenders.map((t) => t.method).sort(), ['CASH', 'STORE_CREDIT']);

  assert.equal(balanceOf(customer.id), -30000, '₱500 held less the ₱200 spent');
  assert.equal(creditOf(customer.id).store_credit_centavos, 30000);

  // Requirement 4: the statement reads continuously — earned on one line, spent on the
  // next — rather than a balance that changes for no visible reason.
  const view = creditService.creditFor(customer.id);
  const spent = view.transactions.rows.find((row) => row.method === 'STORE_CREDIT');
  assert.ok(spent, 'the spend is a transaction, not an adjustment to the account');
  assert.equal(spent.amount_centavos, 20000);
  assert.equal(spent.balance_after_centavos, -30000);
  assert.equal(spent.sale_id, sale.sale.id, 'and it names the sale it paid for');
  assert.equal(spent.due_at, null, 'no due date: it is paid now, out of money already held');
});

test('TC-INT-104: the sale endpoint takes the tender the payment screen sends', async () => {
  const { customer } = farm();
  collectionService.record({
    customerId: customer.id, amountCentavos: 50000, method: 'CASH', acceptOverpayment: true,
  }, sessions.CASHIER);

  // The request SCR-303 builds, field for field — including the null reference every
  // tender row carries and the client total §4.1 compares and discards. Driven over
  // HTTP because the service-level cases above cannot see a serialisation that throws
  // after the transaction has already committed.
  const res = await call('/sales', {
    token: tokens.CASHIER,
    method: 'POST',
    body: {
      customerId: customer.id,
      transactionDiscountCentavos: 0,
      statutory: null,
      lines: [{ productId: product.id, qtyMilli: 1000, packUnitId: null, discountCentavos: 0 }],
      tenders: [{ method: 'STORE_CREDIT', amountCentavos: 6000, referenceNo: null }],
      clientTotalCentavos: 6000,
      acceptDuplicateReference: false,
      approver: null,
    },
  });

  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.sale.total_centavos, 6000);
  assert.equal(balanceOf(customer.id), -44000);
});

test('TC-INT-104: beyond the balance is refused, with the figure', async () => {
  const { customer } = farm();
  collectionService.record({
    customerId: customer.id, amountCentavos: 20000, method: 'CASH', acceptOverpayment: true,
  }, sessions.CASHIER);

  const res = await call('/sales', {
    token: tokens.CASHIER,
    method: 'POST',
    body: {
      lines: [{ productId: product.id, qtyMilli: 5000 }],
      customerId: customer.id,
      tenders: [{ method: 'STORE_CREDIT', amountCentavos: 30000 }],
    },
  });

  assert.equal(res.status, 400);
  const { error } = await res.json();
  assert.equal(error.rule_id, 'CR-108');
  // The figure, because "not enough store credit" is unanswerable at a counter: the
  // cashier has to know how much to take another way.
  assert.match(error.message, /₱200\.00/);
  assert.equal(balanceOf(customer.id), -20000, 'and nothing moved');

  // A walk-in has no account to pay from.
  const walkIn = await call('/sales', {
    token: tokens.CASHIER,
    method: 'POST',
    body: {
      lines: [{ productId: product.id, qtyMilli: 1000 }],
      tenders: [{ method: 'STORE_CREDIT', amountCentavos: 6000 }],
    },
  });
  assert.equal(walkIn.status, 400);
  assert.equal((await walkIn.json()).error.rule_id, 'CR-108');
});

test('TC-INT-104: spending credit takes no cash and opens no drawer (CR-205, POS-509)', () => {
  const { customer } = farm();
  collectionService.record({
    customerId: customer.id, amountCentavos: 30000, method: 'CASH', acceptOverpayment: true,
  }, sessions.CASHIER);

  const shift = shiftService.openShiftFor(sessions.CASHIER.id);
  const before = shiftService.computeExpected(shift.id);

  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 5000 }],
    customerId: customer.id,
    tenders: [{ method: 'STORE_CREDIT', amountCentavos: 30000 }],
  }, sessions.CASHIER);

  assert.equal(sale.drawer, null, 'no cash, no pulse — POS-507');
  assert.equal(
    shiftService.computeExpected(shift.id).expected_cash_centavos,
    before.expected_cash_centavos,
    'the drawer is untouched: the money came in when the credit was created, not now'
  );
});

test('TC-INT-104: CR-104 is unaffected — a limit governs what they may owe, not what they hold', () => {
  const { customer } = farm({ limitCentavos: 10000 });
  collectionService.record({
    customerId: customer.id, amountCentavos: 50000, method: 'CASH', acceptOverpayment: true,
  }, sessions.CASHIER);

  // ₱500 held against a ₱100 limit. Spending it is not borrowing, so the limit has
  // nothing to say — and available credit is limit less balance, which a negative
  // balance makes larger rather than smaller.
  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 5000 }],
    customerId: customer.id,
    tenders: [{ method: 'STORE_CREDIT', amountCentavos: 30000 }],
  }, sessions.CASHIER);

  assert.equal(sale.sale.total_centavos, 30000);
  assert.equal(balanceOf(customer.id), -20000);
});

// ── TC-INT-105 — CR-103 with negative balances in the data ─────────────────

test('TC-INT-105: the reconciliation holds with store credit in the ledger', () => {
  const { customer } = farm();

  // A deliberately awkward account: overpay, buy on credit, return, spend credit, pay
  // some of it off. Every one of those moves the balance in a different direction.
  collectionService.record({
    customerId: customer.id, amountCentavos: 50000, method: 'CASH', acceptOverpayment: true,
  }, sessions.CASHIER);

  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 10000 }],
    customerId: customer.id,
    tenders: [
      { method: 'STORE_CREDIT', amountCentavos: 50000 },
      { method: 'CREDIT', amountCentavos: 10000 },
    ],
  }, sessions.CASHIER);

  returnService.post({
    saleId: sale.sale.id,
    lines: [{ saleItemId: saleRepository.itemsFor(sale.sale.id)[0].id, qtyMilli: 2000, disposition: 'RESTOCK' }],
    reason: 'Wrong item sold',
  }, sessions.CASHIER);

  // CR-103: the account's stored balance equals the sum of its ledger — the invariant
  // a store-credit *table* would have quietly broken.
  assert.deepEqual(creditService.reconcile().breaks, []);

  const rows = creditService.creditFor(customer.id).transactions.rows;
  const ledger = rows.reduce((sum, row) => sum + row.amount_centavos, 0);
  assert.equal(ledger, balanceOf(customer.id), 'the balance is the ledger, added up');

  // And every row carries the running balance it left behind, so a statement reads
  // down the page rather than being re-derived by whoever is reading it.
  const chronological = [...rows].reverse();
  let running = 0;
  for (const row of chronological) {
    running += row.amount_centavos;
    assert.equal(row.balance_after_centavos, running, `${row.type} at ${row.occurred_at_manila}`);
  }
});

test('TC-INT-105: the worklist reports the debt and the liability apart, never netted', () => {
  const owed = farm();
  saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 5000 }],
    customerId: owed.customer.id,
    tenders: [{ method: 'CREDIT', amountCentavos: 30000 }],
  }, sessions.CASHIER);

  const held = farm();
  collectionService.record({
    customerId: held.customer.id, amountCentavos: 40000, method: 'CASH', acceptOverpayment: true,
  }, sessions.CASHIER);

  const list = creditService.outstanding();

  // Requirement 7: a store owed ₱40,000 by farms while holding ₱3,000 of other
  // people's money is not "owed ₱37,000". It is both, at once.
  assert.ok(list.total_receivable_centavos > 0);
  assert.ok(list.total_store_credit_centavos > 0);
  assert.equal(
    list.total_balance_centavos,
    list.total_receivable_centavos - list.total_store_credit_centavos,
    'the netted figure is still served, and is visibly the difference of the two'
  );

  const heldRow = list.accounts.find((a) => a.customer_id === held.customer.id);
  assert.equal(heldRow.store_credit_centavos, 40000);
  assert.notEqual(heldRow.ageing_status, 'OVERDUE');
});

// ── TC-INT-106 — a credit balance is never aged as a debt ──────────────────

test('TC-INT-106: a fully returned credit sale leaves no invoice to chase', () => {
  const { customer } = farm({ termsDays: 0 });     // COD: due the day it is sold

  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 5000 }],
    customerId: customer.id,
    tenders: [{ method: 'CREDIT', amountCentavos: 30000 }],
  }, sessions.CASHIER);

  const owing = creditOf(customer.id);
  assert.equal(owing.outstanding_centavos, 30000, 'before the return, it is a real debt');

  returnService.post({
    saleId: sale.sale.id,
    lines: [{ saleItemId: saleRepository.itemsFor(sale.sale.id)[0].id, qtyMilli: 5000, disposition: 'RESTOCK' }],
    reason: 'Wrong item sold',
  }, sessions.CASHIER);

  // CR-107 derives ageing from unsettled debits. The return credit settles this one —
  // and until TASK-028 it did not say so, which left a paid-off farm ageing towards
  // OVERDUE on a balance of nothing. A dunning letter for a debt the store itself
  // cancelled is the worst thing this ledger can produce.
  const after = creditOf(customer.id);
  assert.equal(after.balance_centavos, 0);
  assert.equal(after.outstanding_centavos, 0);
  assert.equal(after.ageing_status, 'PAID');
  assert.deepEqual(creditService.creditFor(customer.id).open_sales, []);
});

test('TC-INT-106: a customer in credit is PAID, whatever the calendar does', () => {
  const { customer } = farm({ termsDays: 0 });
  collectionService.record({
    customerId: customer.id, amountCentavos: 50000, method: 'CASH', acceptOverpayment: true,
  }, sessions.CASHIER);

  // A year on, to the day. A negative balance has no due date to pass, so there is
  // nothing for time to do to it — CR-108's balance is not a debt that ripens.
  const nextYear = new Date(Date.parse(clock.nowUtc()) + 365 * 86400000).toISOString();
  const aged = creditService.summaryFor({ id: customer.id }, { now: nextYear });

  assert.equal(aged.store_credit_centavos, 50000);
  assert.equal(aged.ageing_status, 'PAID');
  assert.equal(aged.days_overdue, 0);

  // And spending it does not create one either: the debit it writes is settled the
  // moment it is written, out of the credit it spends.
  saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 5000 }],
    customerId: customer.id,
    tenders: [{ method: 'STORE_CREDIT', amountCentavos: 30000 }],
  }, sessions.CASHIER);

  const spentAged = creditService.summaryFor({ id: customer.id }, { now: nextYear });
  assert.equal(spentAged.ageing_status, 'PAID', 'a sale paid from credit is not an invoice');
  assert.equal(spentAged.outstanding_centavos, 0);
  assert.equal(spentAged.store_credit_centavos, 20000);
});
