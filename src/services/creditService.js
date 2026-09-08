'use strict';

// CR-101–CR-107 — the credit account, its ledger, and the two figures nobody stores.
//
// CR-103: the balance is derived from the transaction ledger and reconcilable to it at
// any time. `balance_centavos` on the account is a materialised running total, written
// only by `post()`, inside the transaction that writes the ledger row — the same shape
// as INV-101's on-hand figure, for the same reason.
//
// The reason is not symmetry. The store's credit is a notebook today
// (01_PRODUCT_BRIEF.md §1), and the cutover succeeds when the system's balances
// reconcile against it (§6.3). A stored balance with no ledger behind it cannot be
// reconciled against a notebook, or against anything else.
//
// CR-107: ageing is derived at read time. A stored status depends on a scheduled job,
// and a scheduled job on a store PC that is switched off overnight reports every
// overdue account as current — silently, and in the direction that loses money.

const db = require('../config/database');
const ids = require('../config/ids');
const clock = require('../config/clock');
const errors = require('./errors');
const money = require('./money');
const auditService = require('./auditService');
const settingsService = require('./settingsService');
const creditRepository = require('../repositories/creditRepository');
const customerRepository = require('../repositories/customerRepository');

/**
 * The six ledger types and their sign. Debit positive, credit negative — a credit sale
 * increases what is owed, everything else reduces it.
 *
 * `OPENING` is TASK-026's notebook migration: the balance a farm already owed at
 * cutover, entered once as a transaction so that even the opening figure has a row
 * behind it rather than being written straight onto the account.
 */
const TXN_TYPES = Object.freeze({
  CREDIT_SALE: { sign: +1, what: 'Credit sale', requiresReason: false },
  COLLECTION: { sign: -1, what: 'Collection', requiresReason: false },
  RETURN_CREDIT: { sign: -1, what: 'Return credit', requiresReason: true },
  WRITE_OFF: { sign: -1, what: 'Write-off', requiresReason: true },
  OPENING: { sign: +1, what: 'Opening balance', requiresReason: false },
  ADJUSTMENT: { sign: 0, what: 'Adjustment', requiresReason: true },
});

const TXN_TYPE_NAMES = Object.freeze(Object.keys(TXN_TYPES));
const METHODS = Object.freeze(['CASH', 'GCASH', 'QRPH', 'STORE_CREDIT']);

/** CR-105's terms. 0 is COD; an explicit date is passed per sale instead. */
const TERMS_DAYS = Object.freeze([0, 7, 15, 30]);

const AGEING = Object.freeze(['PAID', 'OVERDUE', 'DUE_SOON', 'CURRENT']);

function assertTxnType(type) {
  if (!Object.prototype.hasOwnProperty.call(TXN_TYPES, type)) {
    throw new RangeError(`unknown credit transaction type: ${type} (CR-103)`);
  }
  return type;
}

// ── Validation (VR-303, CR-105) ─────────────────────────────────────────────

function validateLimit(value) {
  const n = value === undefined || value === null || value === ''
    ? 0
    : (typeof value === 'number' ? value : Number.parseInt(String(value).trim(), 10));

  if (!Number.isInteger(n) || n < 0) {
    throw errors.badRequest('A credit limit is a whole number of centavos, zero or more', { ruleId: 'VR-303' });
  }
  return n;
}

function validateTerms(value) {
  const n = value === undefined || value === null || value === ''
    ? 0
    : (typeof value === 'number' ? value : Number.parseInt(String(value).trim(), 10));

  if (!Number.isInteger(n) || n < 0 || n > 365) {
    throw errors.badRequest('Payment terms are a whole number of days, 0 (COD) to 365', { ruleId: 'CR-105' });
  }
  return n;
}

// ── The account (CR-101) ────────────────────────────────────────────────────

function openAccount(customerId, { limitCentavos = 0, termsDays = 0, at = clock.nowUtc() } = {}) {
  const existing = creditRepository.findAccountByCustomer(customerId);
  if (existing) return existing;

  return creditRepository.insertAccount({
    id: ids.uuidv7(),
    customer_id: customerId,
    credit_limit_centavos: validateLimit(limitCentavos),
    balance_centavos: 0,
    terms_days: validateTerms(termsDays),
    updated_at: at,
  });
}

function accountFor(customerId) {
  return creditRepository.findAccountByCustomer(customerId);
}

/**
 * CR-102 — a credit tender requires a customer who is registered, active and
 * credit-eligible. A walk-in may not buy on credit.
 *
 * Returns the account. TASK-011 calls this before it will accept a CREDIT tender, and
 * TC-UT-40 asserts every one of the four refusals separately, because "no credit for
 * you" without saying which of the four applies is a refusal the counter cannot act on.
 */
function assertCreditEligible(customerId) {
  if (!customerId) {
    throw errors.badRequest(
      'A credit sale needs a registered customer. A walk-in cannot buy on credit.',
      { ruleId: 'CR-102' }
    );
  }

  const customer = customerRepository.findById(customerId);
  if (!customer) throw errors.notFound('No such customer', { ruleId: 'CR-102' });

  if (!customer.is_active) {
    throw errors.conflict(`${customer.name} is not an active customer.`, { ruleId: 'CR-102' });
  }
  if (!customer.is_credit_eligible) {
    throw errors.conflict(
      `${customer.name} is not set up for credit. Enable it on their profile first.`,
      { ruleId: 'CR-102' }
    );
  }

  const account = creditRepository.findAccountByCustomer(customerId);
  if (!account) {
    throw errors.conflict(
      `${customer.name} is marked credit-eligible but has no credit account.`,
      { ruleId: 'CR-101' }
    );
  }
  return { customer, account };
}

/**
 * CR-101 — available credit is `limit − balance`, computed.
 *
 * Never stored. Two figures that must agree, one of them derivable from the other, is
 * two figures that will one day disagree.
 */
function available(account) {
  return account.credit_limit_centavos - account.balance_centavos;
}

// ── CR-107 — ageing, derived at read time ───────────────────────────────────

/**
 * The ageing of one account, from its unsettled debits and today's date.
 *
 * `PAID` when nothing is outstanding, `OVERDUE` past a due date, `DUE_SOON` within the
 * configured window (default 3 days), else `CURRENT`. The worst status among the open
 * sales wins — an account with one overdue invoice is overdue, whatever the others say.
 *
 * Dates are compared as Manila calendar days (VR-102): "due today" must mean the
 * store's today, or an account tips into overdue at eight in the morning.
 */
function ageingFor(accountId, { now = clock.nowUtc() } = {}) {
  const open = creditRepository.openDebits(accountId);
  const outstanding = open.reduce((sum, row) => sum + row.outstanding_centavos, 0);

  if (open.length === 0 || outstanding <= 0) {
    return { status: 'PAID', outstanding_centavos: 0, oldest_due_at: null, days_overdue: 0, open_sales: [] };
  }

  const today = clock.manilaDate(now);
  const dueSoonDays = settingsService.get('credit_due_soon_days');

  let status = 'CURRENT';
  let daysOverdue = 0;
  let oldestDue = null;

  const sales = open.map((row) => {
    const rowStatus = statusFor(row.due_at, today, dueSoonDays);
    const overdueBy = row.due_at ? daysBetween(clock.manilaDate(row.due_at), today) : 0;

    if (rank(rowStatus) > rank(status)) status = rowStatus;
    if (overdueBy > daysOverdue) daysOverdue = overdueBy;
    if (row.due_at && (!oldestDue || row.due_at < oldestDue)) oldestDue = row.due_at;

    return {
      transaction_id: row.id,
      sale_id: row.sale_id,
      document_no: row.document_no,
      occurred_at: row.occurred_at,
      due_at: row.due_at,
      amount_centavos: row.amount_centavos,
      settled_centavos: row.settled_centavos,
      outstanding_centavos: row.outstanding_centavos,
      status: rowStatus,
      days_overdue: Math.max(0, overdueBy),
    };
  });

  return {
    status,
    outstanding_centavos: outstanding,
    oldest_due_at: oldestDue,
    days_overdue: Math.max(0, daysOverdue),
    open_sales: sales,
  };
}

/** CURRENT < DUE_SOON < OVERDUE, so the worst open sale decides the account. */
const rank = (status) => ({ PAID: 0, CURRENT: 1, DUE_SOON: 2, OVERDUE: 3 }[status] ?? 0);

function statusFor(dueAt, todayManila, dueSoonDays) {
  // A debit with no due date is not yet chaseable — a COD sale carries today's date, so
  // in practice only an adjustment reaches this.
  if (!dueAt) return 'CURRENT';

  const due = clock.manilaDate(dueAt);
  if (due < todayManila) return 'OVERDUE';

  const daysUntil = daysBetween(todayManila, due);
  return daysUntil <= dueSoonDays ? 'DUE_SOON' : 'CURRENT';
}

/** Whole days between two YYYY-MM-DD Manila dates, `to − from`. */
function daysBetween(from, to) {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((end - start) / 86400000);
}

/**
 * CR-105 — the due date a credit sale carries, computed from the customer's terms at
 * the moment of sale.
 *
 * The *transaction* carries it, never the customer record: a farm moved from 15-day to
 * 30-day terms next month must not retroactively un-overdue the sale it already owes
 * on. That is why this returns a value to store rather than a rule to re-evaluate.
 */
function dueDateFor(account, { at = clock.nowUtc(), explicitDueAt = null } = {}) {
  if (explicitDueAt) return explicitDueAt;

  const days = account.terms_days || 0;
  if (days === 0) return at;                     // COD: due the day it is sold

  const due = new Date(Date.parse(at) + days * 86400000);
  return due.toISOString();
}

// ── The ledger (CR-103) ─────────────────────────────────────────────────────

/**
 * Post one credit transaction and move the balance with it.
 *
 * Like `inventoryService.post`, this does **not** open its own transaction: CR-103's
 * balance and INV-107's document must commit together, and TASK-011's sale writes a
 * credit transaction, inventory movements and the sale itself inside one. `postStandalone`
 * wraps it for the cases with no document.
 */
function post({
  accountId, type, amountCentavos, actor, documentNo = null, saleId = null,
  dueAt = null, method = null, referenceNo = null, shiftId = null, reason = null,
  occurredAt = null,
}) {
  assertTxnType(type);
  const declared = TXN_TYPES[type];

  const account = creditRepository.findAccount(accountId);
  if (!account) throw errors.notFound('No such credit account');
  if (!actor || !actor.id) {
    // created_by is NOT NULL and references users(id).
    throw new TypeError('a credit transaction needs an acting user (CR-201)');
  }

  const amount = normaliseAmount(type, amountCentavos);
  if (declared.requiresReason && !textOrNull(reason)) {
    throw errors.badRequest(`A ${declared.what.toLowerCase()} needs a reason`, { ruleId: 'CR-103' });
  }
  if (method !== null && method !== undefined && !METHODS.includes(method)) {
    throw errors.badRequest(`Method must be one of ${METHODS.join(', ')}`, { ruleId: 'CR-201' });
  }

  const at = occurredAt || clock.nowUtc();
  const balanceAfter = account.balance_centavos + amount;

  const row = creditRepository.insertTransaction({
    id: ids.uuidv7(),
    account_id: accountId,
    txn_type: type,
    amount_centavos: amount,
    balance_after_centavos: balanceAfter,
    sale_id: saleId,
    due_at: dueAt,
    document_no: documentNo || `${type}-${at.slice(0, 10).replace(/-/g, '')}-${ids.uuidv7().slice(0, 6)}`,
    method: method || null,
    reference_no: textOrNull(referenceNo),
    shift_id: shiftId,
    reason: textOrNull(reason),
    occurred_at: at,
    created_by: actor.id,
  });

  creditRepository.updateAccountFields(accountId, { balance_centavos: balanceAfter, updated_at: at });

  return { transaction: row, balanceCentavos: balanceAfter, account: creditRepository.findAccount(accountId) };
}

function postStandalone(input) {
  return db.transaction(() => post(input));
}

/**
 * Signs are fixed per type, as INV-103's are.
 *
 * A collection of 50000 and a collection of −50000 both mean ₱500 came in. Trusting
 * the caller's sign is how a payment ends up increasing a debt.
 */
function normaliseAmount(type, amountCentavos) {
  const n = typeof amountCentavos === 'number'
    ? amountCentavos
    : Number.parseInt(String(amountCentavos ?? '').trim(), 10);

  if (!Number.isInteger(n) || n === 0) {
    throw errors.badRequest(
      'A credit transaction amount is a whole number of centavos and may not be zero',
      { ruleId: 'MON-001' }
    );
  }

  const { sign } = TXN_TYPES[type];
  if (sign === 0) return n;
  return sign * Math.abs(n);
}

const textOrNull = (value) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
};

// ── CR-106 — the limit change ───────────────────────────────────────────────

/**
 * Change a credit limit. TX-414, audited with both values.
 *
 * A limit is the store's exposure to one farm. Changing it silently is how a ₱20,000
 * limit becomes ₱200,000 with nobody able to say when or who — which is precisely what
 * CR-106 and AUD-601 exist to prevent.
 */
function setLimit(customerId, limitCentavos, actor, { reason = null, termsDays = undefined } = {}) {
  const customer = customerRepository.findById(customerId);
  if (!customer) throw errors.notFound('No such customer');

  const account = creditRepository.findAccountByCustomer(customerId);
  if (!account) {
    throw errors.conflict(
      `${customer.name} has no credit account. Make them credit-eligible first.`,
      { ruleId: 'CR-101' }
    );
  }

  const limit = validateLimit(limitCentavos);
  const terms = termsDays === undefined ? account.terms_days : validateTerms(termsDays);

  if (limit === account.credit_limit_centavos && terms === account.terms_days) {
    return summaryFor(customer);
  }

  const at = clock.nowUtc();
  return db.transaction(() => {
    creditRepository.updateAccountFields(account.id, {
      credit_limit_centavos: limit, terms_days: terms, updated_at: at,
    });

    auditService.write({
      actor,
      action: 'CREDIT_LIMIT_CHANGED',
      entityType: 'customer_credit_accounts',
      entityId: account.id,
      before: { credit_limit_centavos: account.credit_limit_centavos, terms_days: account.terms_days },
      after: { credit_limit_centavos: limit, terms_days: terms },
      reason: reason || `Credit limit for ${customer.name}`,
    });

    return summaryFor(customer);
  });
}

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * The credit block SCR-402 shows first: limit, balance, available and ageing.
 *
 * Returns null for a customer with no account rather than a zeroed one — "no credit
 * account" and "a credit account at zero" are different facts, and a screen that shows
 * ₱0.00 available for both cannot distinguish them.
 */
function summaryFor(customer, { now = clock.nowUtc() } = {}) {
  const account = creditRepository.findAccountByCustomer(customer.id);
  if (!account) return null;

  const ageing = ageingFor(account.id, { now });
  return {
    account_id: account.id,
    credit_limit_centavos: account.credit_limit_centavos,
    balance_centavos: account.balance_centavos,
    available_centavos: available(account),
    terms_days: account.terms_days,
    terms_label: account.terms_days === 0 ? 'COD' : `${account.terms_days} days`,
    ageing_status: ageing.status,
    days_overdue: ageing.days_overdue,
    oldest_due_at: ageing.oldest_due_at,
    outstanding_centavos: ageing.outstanding_centavos,
    // CR-108 is v1.1, but a negative balance is representable today and the screen
    // must not render it as a debt.
    store_credit_centavos: account.balance_centavos < 0 ? -account.balance_centavos : 0,
    updated_at: account.updated_at,
  };
}

/** The full credit view: summary, open sales, and the statement (SCR-402). */
function creditFor(customerId, { limit = 50, offset = 0, now = clock.nowUtc() } = {}) {
  const customer = customerRepository.findById(customerId);
  if (!customer) throw errors.notFound('No such customer');

  const account = creditRepository.findAccountByCustomer(customerId);
  if (!account) {
    return {
      customer: { id: customer.id, name: customer.name, code: customer.code },
      credit: null,
      message: 'This customer is not set up for credit.',
    };
  }

  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const skip = Math.max(Number.parseInt(offset, 10) || 0, 0);
  const ageing = ageingFor(account.id, { now });

  return {
    customer: { id: customer.id, name: customer.name, code: customer.code, is_active: Boolean(customer.is_active) },
    credit: summaryFor(customer, { now }),
    open_sales: ageing.open_sales,
    transactions: {
      total: creditRepository.countTransactionsFor(account.id),
      limit: size,
      offset: skip,
      rows: creditRepository.transactionsFor(account.id, { limit: size, offset: skip })
        .map(presentTransaction),
    },
  };
}

function presentTransaction(row) {
  return {
    id: row.id,
    occurred_at: row.occurred_at,
    occurred_at_manila: clock.toManila(row.occurred_at),
    type: row.txn_type,
    type_label: TXN_TYPES[row.txn_type] ? TXN_TYPES[row.txn_type].what : row.txn_type,
    amount_centavos: row.amount_centavos,
    balance_after_centavos: row.balance_after_centavos,
    document_no: row.document_no,
    sale_id: row.sale_id,
    due_at: row.due_at,
    method: row.method,
    reference_no: row.reference_no,
    reason: row.reason,
    created_by: row.created_by_username || row.created_by,
  };
}

/**
 * The CR-103 invariant, as a callable check — TC-INT-46, and the health panel.
 *
 * An inventory defect is found by INV-101's reconciliation; a credit defect is found
 * by this one. Both are questions the system can be asked rather than things somebody
 * has to notice.
 */
function reconcile() {
  const breaks = creditRepository.reconciliationBreaks();
  return { ok: breaks.length === 0, breaks };
}

/** Every account carrying a balance, with its ageing — the collections worklist. */
function outstanding({ now = clock.nowUtc() } = {}) {
  const rows = creditRepository.accountsWithBalance();
  let total = 0;

  const accounts = rows.map((row) => {
    total += row.balance_centavos;
    const ageing = ageingFor(row.account_id, { now });
    return {
      account_id: row.account_id,
      customer_id: row.customer_id,
      customer_name: row.customer_name,
      customer_code: row.customer_code,
      is_active: Boolean(row.is_active),
      credit_limit_centavos: row.credit_limit_centavos,
      balance_centavos: row.balance_centavos,
      available_centavos: row.credit_limit_centavos - row.balance_centavos,
      ageing_status: ageing.status,
      days_overdue: ageing.days_overdue,
      oldest_due_at: ageing.oldest_due_at,
    };
  });

  return { as_of: now, total_balance_centavos: total, accounts };
}

module.exports = {
  TXN_TYPES, TXN_TYPE_NAMES, METHODS, TERMS_DAYS, AGEING,
  assertTxnType, validateLimit, validateTerms, normaliseAmount,
  openAccount, accountFor, assertCreditEligible, available,
  ageingFor, statusFor, daysBetween, dueDateFor,
  post, postStandalone, setLimit,
  summaryFor, creditFor, presentTransaction, reconcile, outstanding,
};
