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
const csv = require('../config/csv');
const printService = require('./printService');
const documentService = require('./documentService');
const storeProfileService = require('./storeProfileService');
const permissions = require('./permissions');
const authService = require('./authService');
const userRepository = require('../repositories/userRepository');
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

// ── CR-203 / CR-108 — allocation, in both directions ────────────────────────

/**
 * Apply a credit to the open debits, oldest first (`CR-203`).
 *
 * Lived in `collectionService` until `TASK-028` and belongs here, beside the ledger it
 * writes. The move is not tidying: **a return credit was never allocated**, so a farm
 * whose credit sale was returned in full kept an "open" ₱1,000 invoice on their
 * statement and aged towards `OVERDUE` on a balance of nothing. `CR-107` derives ageing
 * from unsettled debits, so a credit that settles one and does not say so is a
 * collection letter waiting to be sent to somebody who owes nothing.
 *
 * Anything left over allocates to nothing, because it settles nothing: it is store
 * credit (`CR-108`), and `allocateToDebit` below is what eventually spends it.
 */
function allocateToDebits({ accountId, creditTxnId, amountCentavos, at }) {
  let remaining = Math.abs(amountCentavos);
  const written = [];

  for (const debit of creditRepository.openDebits(accountId)) {
    if (remaining <= 0) break;

    const applied = Math.min(remaining, debit.outstanding_centavos);
    if (applied <= 0) continue;

    const row = creditRepository.insertAllocation({
      id: ids.uuidv7(),
      collection_txn_id: creditTxnId,
      sale_txn_id: debit.id,
      amount_centavos: applied,
      created_at: at,
    });

    written.push({
      ...row,
      sale_document_no: debit.document_no,
      sale_due_at: debit.due_at,
      settled_in_full: applied === debit.outstanding_centavos,
      remaining_on_sale_centavos: debit.outstanding_centavos - applied,
    });
    remaining -= applied;
  }

  return written;
}

/**
 * The other direction: settle a new debit from the credit already held (`CR-108`).
 *
 * A sale paid from store credit writes a debit like any other, and this is what stops
 * it looking like one the store must chase. The rows it writes are ordinary `CR-203`
 * allocations — the customer's own money, applied to their own purchase — which is why
 * `openDebits`, the statement and the ageing all need no special case for it.
 */
function allocateToDebit({ accountId, saleTxnId, amountCentavos, at }) {
  let remaining = amountCentavos;
  const written = [];

  for (const credit of creditRepository.openCredits(accountId)) {
    if (remaining <= 0) break;

    const applied = Math.min(remaining, credit.available_centavos);
    if (applied <= 0) continue;

    written.push(creditRepository.insertAllocation({
      id: ids.uuidv7(),
      collection_txn_id: credit.id,
      sale_txn_id: saleTxnId,
      amount_centavos: applied,
      created_at: at,
    }));
    remaining -= applied;
  }

  return written;
}

/**
 * `CR-108` — what a customer holds, as a positive figure.
 *
 * Derived from the one balance `CR-103` derives, never a second ledger. A store-credit
 * table would be a second figure to disagree with the first, and the disagreement would
 * be discovered by a customer being told they have nothing.
 */
function storeCreditFor(account) {
  return account && account.balance_centavos < 0 ? -account.balance_centavos : 0;
}

/**
 * Spend store credit on a sale (`CR-108`, requirement 2 and 3).
 *
 * Joins the caller's transaction, as `post` does: `TASK-011`'s sale, its movements and
 * this must commit together or not at all.
 *
 * The refusal quotes the figure, because "not enough store credit" is unanswerable at a
 * counter — the cashier has to know how much to take in cash instead. Over-spending is
 * refused rather than allowed to run the balance positive: a customer spending credit
 * they do not hold is a customer taking credit, which is `CR-102`'s question and needs
 * a limit, terms and eligibility rather than a silent slide into debt.
 */
function spendStoreCredit({
  accountId, amountCentavos, actor, saleId = null, documentNo = null, shiftId = null,
  occurredAt = null, customerName = null,
}) {
  const account = creditRepository.findAccount(accountId);
  if (!account) throw errors.notFound('No such credit account');

  const held = storeCreditFor(account);
  const amount = normaliseAmount('CREDIT_SALE', amountCentavos);

  if (amount > held) {
    const who = customerName ? `${customerName} has` : 'This customer has';
    throw errors.badRequest(
      held === 0
        ? `${who} no store credit to spend. Take the ${money.toDisplay(amount)} another way.`
        : `${who} ${money.toDisplay(held)} in store credit and this payment is `
          + `${money.toDisplay(amount)}. Reduce it to ${money.toDisplay(held)} and take the rest `
          + 'another way.',
      { ruleId: 'CR-108' }
    );
  }

  const at = occurredAt || clock.nowUtc();

  // A debit, with the method saying where it came from — and **no due date**. A due
  // date is a promise to pay later, and this is paid now, out of money the store is
  // already holding.
  const posted = post({
    accountId,
    type: 'CREDIT_SALE',
    amountCentavos: amount,
    actor,
    documentNo,
    saleId,
    method: 'STORE_CREDIT',
    shiftId,
    occurredAt: at,
  });

  const allocations = allocateToDebit({
    accountId, saleTxnId: posted.transaction.id, amountCentavos: amount, at,
  });

  return { ...posted, allocations, store_credit_before_centavos: held, store_credit_after_centavos: storeCreditFor(posted.account) };
}

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
    // CR-108: money the store owes *them*, shown as a positive figure and never as a
    // debt. Spendable as a tender since TASK-028, which is what makes it a balance
    // rather than a line on a screen.
    store_credit_centavos: storeCreditFor(account),
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

// ── CR-303 — the bad-debt write-off (TASK-034) ──────────────────────────────

/**
 * Declare a debt uncollectable (`FT-409`, `CR-303`).
 *
 * **A write-off is not a correction.** `ADJUSTMENT` already means "this ledger row was
 * wrong"; `WRITE_OFF` means "this debt was real and the store is not going to get it",
 * which is an accounting event the store's accountant cares about and has tax
 * consequences a correction does not. The ledger is append-only, so using one for the
 * other loses the difference for ever — there is nothing left to re-derive it from.
 *
 * **It settles the debits it is written off against**, oldest first, through the same
 * allocator a collection uses. That is `TASK-028`'s lesson in the same place: a credit
 * that moved a balance without allocating left an account square by balance and overdue
 * by ageing, and it is the ageing that reaches the collections worklist. A written-off
 * invoice must stop being chased.
 *
 * **It may not manufacture store credit** (`CR-108`). Writing off more than is
 * outstanding is refused with the figure: the store does not owe money to somebody it
 * has just given up on.
 *
 * `TX-417` is owner-only and has been in the matrix since v1.0 with nothing behind it.
 * A refusal is audited, because "who tried to write off a debt" is a question worth
 * being able to answer.
 */
function writeOff(customerId, {
  amountCentavos, reason = null, approver = null, occurredAt = null, actor,
}) {
  if (!actor || !actor.id) throw new TypeError('a write-off needs an acting user (CR-303)');

  if (!permissions.can(actor, 'TX-417')) {
    // Audited before the refusal is thrown: a manager reaching for this is not a
    // security incident, and it is a fact the owner is entitled to know.
    auditService.write({
      actor,
      action: 'PERMISSION_REFUSED',
      entityType: 'customer',
      entityId: customerId,
      after: { attempted: 'WRITE_OFF', amount_centavos: amountCentavos, role: actor.role },
      reason: 'CR-303: only the owner may write off a debt',
    });
    throw errors.forbidden(
      'Only the owner may write off a debt. A manager can take a payment or agree terms, '
      + 'and giving up on money owed is the owner’s decision.',
      { ruleId: 'TX-417', requiresRole: 'OWNER' }
    );
  }

  const customer = customerRepository.findById(customerId);
  if (!customer) throw errors.notFound('No such customer');
  const account = creditRepository.findAccountByCustomer(customerId);
  if (!account) {
    throw errors.conflict(
      `${customer.name} has no credit account, so there is nothing to write off.`,
      { ruleId: 'CR-101' }
    );
  }

  // CR-303: the reason is the field the accountant reads, so it is required and it is
  // not a dropdown — "why did this money never arrive" has no fixed list.
  const why = textOrNull(reason, { max: 300 });
  if (!why) {
    throw errors.badRequest(
      'A write-off needs a reason. It is what the store’s accountant will read, and what a '
      + 'later query about this account will be answered from.',
      { ruleId: 'CR-303' }
    );
  }

  const amount = normaliseAmount('WRITE_OFF', amountCentavos);
  const outstanding = Math.max(account.balance_centavos, 0);
  if (Math.abs(amount) > outstanding) {
    throw errors.conflict(
      `${customer.name} owes ${money.toDisplay(outstanding)} and this write-off is `
      + `${money.toDisplay(Math.abs(amount))}. A write-off cannot put an account into credit — `
      + 'the store does not owe money to somebody it has just given up on (CR-108).',
      { ruleId: 'CR-303' }
    );
  }

  // AUD-603 where there is a second pair of eyes to be had. Not waived silently: where
  // the store has one active user the trail records that nobody else was available,
  // which is INV-112's distinction applied to money instead of stock.
  const others = userRepository.list({ includeInactive: false })
    .filter((user) => user.id !== actor.id);
  const resolved = approver && approver.username
    ? authService.resolveApprover(approver, { roles: ['OWNER'], ruleId: 'CR-303' })
    : null;
  if (resolved && resolved.id === actor.id) {
    throw errors.forbidden(
      'A write-off is authorised by somebody other than the person recording it (AUD-603).',
      { ruleId: 'AUD-603', requiresRole: 'OWNER' }
    );
  }

  const at = occurredAt || clock.nowUtc();

  return db.transaction(() => {
    const posted = post({
      accountId: account.id,
      type: 'WRITE_OFF',
      amountCentavos: Math.abs(amount),
      actor,
      documentNo: `WOFF-${clock.manilaDate(at).replace(/-/g, '')}-${account.id.slice(-6)}`,
      reason: why,
      occurredAt: at,
    });

    // CR-203's allocator, third caller. The debits this settles stop ageing, which is
    // the difference between a debt forgiven and a debt still on the worklist.
    const allocations = allocateToDebits({
      accountId: account.id,
      creditTxnId: posted.transaction.id,
      amountCentavos: Math.abs(amount),
      at,
    });

    auditService.write({
      actor,
      approver: resolved,
      action: 'CREDIT_WRITTEN_OFF',
      entityType: 'customer_credit_accounts',
      entityId: account.id,
      after: {
        customer: customer.name,
        amount_centavos: Math.abs(amount),
        balance_after_centavos: posted.balanceCentavos,
        settled: allocations.map((row) => row.sale_document_no),
        // Stated rather than inferred from a user count that will have changed by the
        // time anybody reads this row: "nobody else was available" and "nobody bothered"
        // must not read alike a year later.
        authorisation: resolved ? 'approved' : (others.length === 0 ? 'no second user' : 'self'),
      },
      reason: why,
    });

    return {
      customer: { id: customer.id, name: customer.name },
      transaction: presentTransaction({ ...posted.transaction, created_by_username: actor.username }),
      balance_centavos: posted.balanceCentavos,
      settled: allocations,
      authorised_by: resolved ? resolved.username : null,
    };
  });
}

/**
 * `CR-303`'s other half: written-off debt, in its own report.
 *
 * **Never in a collections figure.** A write-off credits the account exactly as a
 * payment does, so a report that counted both would improve the store's collection
 * performance every time it gave up on a debt — a month where nobody paid and ₱40,000
 * was written off would read as the best month of the year.
 *
 * The separation is by transaction type, which is why the type had to be its own value
 * rather than an `ADJUSTMENT` with a note.
 */
function writeOffReport({ from = null, to = null, now = clock.nowUtc(), actor = null } = {}) {
  assertReceivableScope(actor, 'the store’s write-offs');

  const fromDate = from || clock.manilaDate(now).slice(0, 8) + '01';
  const toDate = to || clock.manilaDate(now);
  const rows = creditRepository.writeOffsBetween(
    new Date(`${fromDate}T00:00:00.000+08:00`).toISOString(),
    new Date(`${toDate}T23:59:59.999+08:00`).toISOString()
  );

  const total = rows.reduce((sum, row) => sum + Math.abs(row.amount_centavos), 0);
  const byCustomer = new Map();
  for (const row of rows) {
    const entry = byCustomer.get(row.customer_id)
      || { customer_id: row.customer_id, customer_name: row.customer_name, total_centavos: 0, count: 0 };
    entry.total_centavos += Math.abs(row.amount_centavos);
    entry.count += 1;
    byCustomer.set(row.customer_id, entry);
  }

  return {
    from_date: fromDate,
    to_date: toDate,
    write_offs: rows.map((row) => ({
      id: row.id,
      customer_id: row.customer_id,
      customer_name: row.customer_name,
      occurred_at: row.occurred_at,
      occurred_at_manila: clock.toManila(row.occurred_at),
      amount_centavos: Math.abs(row.amount_centavos),
      document_no: row.document_no,
      // The field the accountant reads, on the row rather than behind a click.
      reason: row.reason,
      written_off_by: row.created_by_username,
    })),
    totals: { total_centavos: total, count: rows.length, customers: byCustomer.size },
    by_customer: [...byCustomer.values()].sort((a, b) => b.total_centavos - a.total_centavos),
    // RPT-106, and CR-303's own sentence.
    basis: 'Debt the owner has declared uncollectable in this period. A write-off is not a '
      + 'collection and is counted in no collections figure — a month where nobody paid and the '
      + 'store gave up on ₱40,000 would otherwise read as its best month.',
  };
}

// ── CR-301 / CR-302 — ageing buckets and the statement (TASK-031) ───────────

/**
 * `TX-421` at store scope, which is not the same as holding `TX-421`.
 *
 * The grant gives a cashier `OWN_SHIFT` — enough for the sales figures of the till they
 * stood at, and not a licence to read what every farm in the barangay owes. The
 * receivable has no shift to scope it to, so the only honest reading of `OWN_SHIFT`
 * here is "no", and the refusal says which figures they *can* see rather than stopping
 * at the word no.
 */
function assertReceivableScope(actor, what) {
  if (!actor) return;
  const level = permissions.grant(actor.role, 'TX-421');
  if (level === permissions.FULL) return;

  throw errors.forbidden(
    level === permissions.OWN_SHIFT
      ? `You can see the figures for your own shift, not ${what}. Ask the owner or a manager.`
      : `You do not have permission to read ${what}.`,
    { ruleId: 'TX-421', requiresRole: 'MANAGER' }
  );
}

/**
 * `CR-301`'s buckets, and the whole of the rule that decides them.
 *
 * **A bucket belongs to a debit, not to an account.** One farm can be ₱2,000 in the
 * 1–30 bucket and ₱5,000 in the 90+ at the same time; an implementation that bucketed
 * the account by its oldest debt would report ₱7,000 as 90+ and tell the owner their
 * problem is more than twice what it is.
 *
 * The boundaries are the ones the rule names — 1–30, 31–60, 61–90, 90+ — and each is
 * inclusive of its lower edge: a debit exactly 30 days past due is in 1–30, and 31 is
 * the first day of the next bucket. A debit not yet due is not in any of them, which is
 * why `NOT_DUE` is a bucket here and not a special case at the call site: the totals
 * have to add up to the whole receivable, and a debit with nowhere to go is how a
 * reconciliation quietly loses money.
 */
const BUCKETS = Object.freeze(['NOT_DUE', 'D1_30', 'D31_60', 'D61_90', 'D90_PLUS']);

const BUCKET_LABELS = Object.freeze({
  NOT_DUE: 'Not yet due',
  D1_30: '1–30 days',
  D31_60: '31–60 days',
  D61_90: '61–90 days',
  D90_PLUS: 'Over 90 days',
});

function bucketFor(daysPastDue) {
  if (daysPastDue <= 0) return 'NOT_DUE';
  if (daysPastDue <= 30) return 'D1_30';
  if (daysPastDue <= 60) return 'D31_60';
  if (daysPastDue <= 90) return 'D61_90';
  return 'D90_PLUS';
}

/**
 * How many Manila days past due a debit is (`CR-107`'s day arithmetic, reused).
 *
 * A debit with no due date is treated as due on the day it was raised: `CR-105` fixes
 * the due date at the sale, so a missing one is an opening balance from the notebook,
 * and a notebook debt is not "not yet due".
 */
function daysPastDue(row, today) {
  const due = row.due_at || row.occurred_at;
  return daysBetween(clock.manilaDate(due), today);
}

/**
 * `FT-406` — the debt, split into the buckets its age actually falls into.
 *
 * Per debit, then summed two ways — per account and per bucket — and the two agree
 * because they are the same rows added up along different axes rather than two queries.
 *
 * The reconciliation at the end is `RPT-101`'s demand applied to the receivable: the
 * buckets plus the not-yet-due have to equal what the store is owed. Where they do not,
 * the report says so rather than printing a total somebody would act on.
 */
function ageingReport({ now = clock.nowUtc(), includeZero = false, actor = null } = {}) {
  assertReceivableScope(actor, 'the store’s receivables');

  const today = clock.manilaDate(now);
  const debits = creditRepository.openDebitsForAll();
  const credits = creditRepository.openCreditsForAll();
  const balances = creditRepository.balancesForAll();

  const totals = Object.fromEntries(BUCKETS.map((bucket) => [bucket, 0]));
  const accounts = new Map();

  for (const row of debits) {
    const past = daysPastDue(row, today);
    const bucket = bucketFor(past);
    totals[bucket] += row.outstanding_centavos;

    const account = accounts.get(row.account_id) || {
      account_id: row.account_id,
      customer_id: row.customer_id,
      customer_name: row.customer_name,
      customer_code: row.customer_code,
      contact_no: row.customer_contact_no,
      buckets: Object.fromEntries(BUCKETS.map((b) => [b, 0])),
      outstanding_centavos: 0,
      oldest_days_past_due: 0,
      debits: [],
    };
    account.buckets[bucket] += row.outstanding_centavos;
    account.outstanding_centavos += row.outstanding_centavos;
    account.oldest_days_past_due = Math.max(account.oldest_days_past_due, Math.max(past, 0));
    account.debits.push({
      transaction_id: row.id,
      document_no: row.document_no,
      sale_id: row.sale_id,
      occurred_at: row.occurred_at,
      due_at: row.due_at,
      days_past_due: Math.max(past, 0),
      bucket,
      bucket_label: BUCKET_LABELS[bucket],
      amount_centavos: row.amount_centavos,
      settled_centavos: row.settled_centavos,
      outstanding_centavos: row.outstanding_centavos,
    });
    accounts.set(row.account_id, account);
  }

  // CR-108: an account in credit is money the store owes, not a receivable. It is
  // reported as its own figure rather than netted off the buckets, which would hide a
  // debt behind somebody else's credit.
  const inCredit = balances.filter((row) => row.balance_centavos < 0);
  const rows = [...accounts.values()];
  const receivable = balances
    .filter((row) => row.balance_centavos > 0)
    .reduce((sum, row) => sum + row.balance_centavos, 0);
  const bucketTotal = BUCKETS.reduce((sum, bucket) => sum + totals[bucket], 0);

  // **Ageing sums debts gross; a balance nets them.** An account's balance is its
  // unsettled debits *less* the credits nobody has spent yet — an overpayment, a return
  // credit, store credit the customer is holding (CR-108). So the buckets alone cannot
  // equal the ledger, and a report that claimed they did would be wrong the first time
  // a farm paid ₱100 too much.
  //
  // Stated as its own figure, and the reconciliation made against the arithmetic that
  // is actually true: aged debt, less unapplied credit, is what the ledger holds.
  const unapplied = credits.reduce((sum, row) => sum + row.available_centavos, 0);
  const ledgerTotal = balances.reduce((sum, row) => sum + row.balance_centavos, 0);
  const netOfCredits = bucketTotal - unapplied;

  // Per account too, so a store can see which farm's credit is standing against which
  // farm's debt rather than only that the totals move together.
  const creditsByAccount = new Map();
  for (const row of credits) {
    creditsByAccount.set(row.account_id, (creditsByAccount.get(row.account_id) || 0) + row.available_centavos);
  }
  for (const account of rows) {
    account.unapplied_credit_centavos = creditsByAccount.get(account.account_id) || 0;
  }

  return {
    as_of: now,
    as_of_manila: clock.toManila(now),
    buckets: BUCKETS.map((bucket) => ({
      bucket,
      label: BUCKET_LABELS[bucket],
      total_centavos: totals[bucket],
      accounts: rows.filter((row) => row.buckets[bucket] > 0).length,
    })),
    accounts: includeZero
      ? rows
      : rows.filter((row) => row.outstanding_centavos > 0),
    totals: {
      // What the store is owed by the accounts that owe it anything — the figure an
      // owner means by "receivable".
      receivable_centavos: receivable,
      // The aged debt, gross of any credit standing against it.
      bucketed_centavos: bucketTotal,
      // CR-108: money customers are holding with the store, not yet spent.
      unapplied_credit_centavos: unapplied,
      net_centavos: netOfCredits,
      in_credit_accounts: inCredit.length,
      in_credit_centavos: inCredit.reduce((sum, row) => sum + row.balance_centavos, 0),
      accounts_with_debt: rows.length,
    },
    // The check stated on the report rather than left to a test. Aged debt less
    // unapplied credit is what the ledger holds, exactly — the settled parts cancel on
    // both sides — so a difference here is a defect and not a rounding, and a store
    // told so can stop trusting the figure before it acts on it.
    reconciles: netOfCredits === ledgerTotal,
    reconciliation_note: netOfCredits === ledgerTotal
      ? `Aged debt of ${money.toDisplay(bucketTotal)} less ${money.toDisplay(unapplied)} of `
        + 'credit customers are holding is exactly what the ledger says the store is owed.'
      : `The buckets total ${money.toDisplay(bucketTotal)}, less ${money.toDisplay(unapplied)} `
        + `unapplied, against a ledger of ${money.toDisplay(ledgerTotal)}. They should agree — `
        + 'the difference is a defect, not a rounding.',
    // RPT-106.
    basis: 'Every unsettled debit, aged from its own due date on Manila days (CR-301). An '
      + 'account can appear in more than one bucket. Credit a customer is holding — an '
      + 'overpayment, a return credit — is shown as its own figure and never netted into a '
      + 'bucket, because a debt three months old does not become younger for being paid '
      + 'against later. Accounts wholly in credit are money the store owes and are counted '
      + 'apart from the debt.',
  };
}

/**
 * `CR-302` — a statement a customer can check by hand.
 *
 * Opening balance, every movement in the period in date order, closing balance. The
 * opening figure is **derived as the balance before the window**, never stored: there
 * is nowhere to keep it that would not be a second answer to a question `CR-103` has
 * already answered.
 *
 * **The closing balance is checked in the code path, not merely in a test.** A
 * statement that closes at ₱6,200 while the profile says ₱6,150 is worse than no
 * statement, because the customer will find the ₱50 and the store will not. So the
 * walked total and the ledger's own sum at that instant are compared here, and a
 * disagreement is raised as the defect it is rather than printed.
 */
function statement(customerId, { from = null, to = null, now = clock.nowUtc(), actor = null } = {}) {
  assertReceivableScope(actor, 'a customer’s statement');

  const customer = customerRepository.findById(customerId);
  if (!customer) throw errors.notFound('No such customer');
  const account = creditRepository.findAccountByCustomer(customerId);
  if (!account) {
    throw errors.badRequest(
      `${customer.name} has no credit account, so there is nothing to state.`,
      { ruleId: 'CR-102' }
    );
  }

  // Manila days in, UTC instants out: a statement "for September" means the store's
  // September, and a range compared in UTC would move its edges by eight hours.
  const fromDate = from || clock.manilaDate(now).slice(0, 8) + '01';
  const toDate = to || clock.manilaDate(now);
  const fromAt = `${fromDate}T00:00:00.000+08:00`;
  const toAt = `${toDate}T23:59:59.999+08:00`;

  const opening = creditRepository.balanceBefore(account.id, new Date(fromAt).toISOString());
  const rows = creditRepository.transactionsFor(account.id, {
    from: new Date(fromAt).toISOString(),
    to: new Date(toAt).toISOString(),
    limit: 5000,
  });

  let running = opening;
  const lines = rows.slice().reverse().map((row) => {
    running += row.amount_centavos;
    const line = {
      ...presentTransaction(row),
      // The running balance the customer follows down the page with a finger. Derived
      // here from the opening figure rather than read from balance_after_centavos,
      // which is the account's balance at the time and not this statement's.
      running_balance_centavos: running,
    };

    // CR-203: which invoices this payment settled — the sentence a customer is actually
    // asking for when they query a balance.
    if (row.txn_type === 'COLLECTION' || row.txn_type === 'RETURN_CREDIT') {
      line.settled = creditRepository.allocationsForCollection(row.id).map((alloc) => ({
        document_no: alloc.sale_document_no,
        amount_centavos: alloc.amount_centavos,
        due_at: alloc.due_at,
      }));
    }
    return line;
  });

  const closing = running;
  const ledgerClosing = creditRepository.balanceAsOf(account.id, new Date(toAt).toISOString());

  // CR-302's last clause, enforced rather than asserted about. Two derivations of one
  // number: the window walked from its opening figure, and the ledger summed to the
  // same instant. If they part company the statement is wrong and must not be handed
  // to anybody.
  if (closing !== ledgerClosing) {
    throw errors.conflict(
      `The statement does not agree with the account: it closes at ${money.toDisplay(closing)} `
      + `against a ledger balance of ${money.toDisplay(ledgerClosing)}. This is a defect in the `
      + 'statement, not a dispute with the customer — do not hand it over.',
      { ruleId: 'CR-302' }
    );
  }

  return {
    customer: {
      id: customer.id, name: customer.name, code: customer.code,
      contact_no: customer.contact_no, address: customer.address,
    },
    from_date: fromDate,
    to_date: toDate,
    opening_balance_centavos: opening,
    closing_balance_centavos: closing,
    // CR-108, in SCR-401's own words rather than as a minus sign: a customer who is in
    // credit is not in debt, and "−₱450" is a sentence somebody will read wrong.
    closing_label: closing < 0
      ? `${money.toDisplay(-closing)} in credit — the store owes this to ${customer.name}`
      : `${money.toDisplay(closing)} owed to the store`,
    is_in_credit: closing < 0,
    lines,
    // RPT-106: the range, and what a period with nothing in it means.
    basis: lines.length === 0
      ? 'Nothing was bought or paid in this period. The opening and closing balances are '
        + 'the same, and both are the account\'s own — CR-103 derives them from the ledger.'
      : 'Every movement on this account in the period, in date order, from the balance '
        + 'carried in. The closing balance is the account\'s balance on the last day.',
  };
}

/**
 * `CR-302` on paper — the statement, printed (requirement 9).
 *
 * `CR-206`'s precedent: a document a customer takes away goes out on the receipt
 * printer, through `documentService` so that `TAX-006`'s notice is on it like every
 * other document this shop prints. A statement states what is owed; it is not a receipt
 * for anything, and the notice says so.
 *
 * The rendering is `printService`'s, and the figures are `statement`'s — the same call
 * the screen made, so the paper and the screen cannot say different things.
 */
function printStatement(customerId, { from = null, to = null, actor = null, reprint = false } = {}) {
  const report = statement(customerId, { from, to, actor });
  const document = printService.renderStatement({
    profile: storeProfileService.profile(),
    statement: report,
    preparedBy: actor ? actor.username : 'the store',
    reprint,
  });

  return { statement: report, document, printed: documentService.print(document) };
}

/**
 * The statement as a file, and the ageing report as another.
 *
 * Both are the same call the screen makes, so the figures cannot drift — the lesson
 * `TC-INT-63` already draws for the sales reports, applied to the receivable.
 *
 * They are built here rather than in `reportService.exportCsv` because that machinery
 * writes a sales header — tax modes, voided sales excluded — onto everything it
 * touches, and a receivables file that said "Voided sales excluded: 0" would be
 * answering a question nobody asked of it.
 */
function statementCsv(customerId, options = {}) {
  const report = statement(customerId, options);
  const rows = [
    ['Statement', report.customer.name],
    ['Range', `${report.from_date} to ${report.to_date}`],
    ['Brought forward', money.toDisplay(report.opening_balance_centavos, { symbol: false })],
    [],
    ['date', 'type', 'document', 'settled', 'amount', 'balance'],
    ...report.lines.map((line) => [
      line.occurred_at_manila,
      line.type_label,
      line.document_no || '',
      (line.settled || []).map((s) => s.document_no).join(' '),
      money.toDisplay(line.amount_centavos, { symbol: false }),
      money.toDisplay(line.running_balance_centavos, { symbol: false }),
    ]),
    [],
    [report.is_in_credit ? 'In credit' : 'Balance owing',
      money.toDisplay(Math.abs(report.closing_balance_centavos), { symbol: false })],
    ['Basis', report.basis],
  ];

  return {
    csv: csv.stringify(rows),
    filename: `statement_${report.customer.code || report.customer.name}_${report.from_date}.csv`
      .replace(/[^\w.\-]/g, '_'),
    report,
  };
}

function ageingCsv(options = {}) {
  const report = ageingReport(options);
  const rows = [
    ['Ageing', report.as_of_manila],
    ['Basis', report.basis],
    [],
    ['customer', 'contact', ...BUCKETS.map((b) => BUCKET_LABELS[b]), 'unapplied credit', 'total'],
    ...report.accounts.map((account) => [
      account.customer_name,
      account.contact_no || '',
      ...BUCKETS.map((b) => money.toDisplay(account.buckets[b], { symbol: false })),
      money.toDisplay(account.unapplied_credit_centavos, { symbol: false }),
      money.toDisplay(account.outstanding_centavos, { symbol: false }),
    ]),
    [],
    ['Totals', '', ...report.buckets.map((b) => money.toDisplay(b.total_centavos, { symbol: false })),
      money.toDisplay(report.totals.unapplied_credit_centavos, { symbol: false }),
      money.toDisplay(report.totals.bucketed_centavos, { symbol: false })],
    ['Reconciles', report.reconciles ? 'YES' : 'NO'],
    ['Reconciliation', report.reconciliation_note],
  ];

  return { csv: csv.stringify(rows), filename: `ageing_${clock.manilaDate(report.as_of)}.csv`, report };
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

  let receivable = 0;
  let storeCredit = 0;

  const accounts = rows.map((row) => {
    total += row.balance_centavos;
    // CR-108, requirement 7: a debt and a liability are two different questions, and
    // one netted figure answers neither. A store owed ₱40,000 by farms while holding
    // ₱3,000 of other people's money is not "owed ₱37,000" — it is both, at once.
    if (row.balance_centavos > 0) receivable += row.balance_centavos;
    else storeCredit += -row.balance_centavos;
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
      // CR-108: money the store holds for them, said in the row rather than left as a
      // minus sign for a screen to interpret.
      store_credit_centavos: storeCreditFor(row),
    };
  });

  return {
    as_of: now,
    total_balance_centavos: total,
    // The two halves the netted figure hides.
    total_receivable_centavos: receivable,
    total_store_credit_centavos: storeCredit,
    accounts,
  };
}

module.exports = {
  TXN_TYPES, TXN_TYPE_NAMES, METHODS, TERMS_DAYS, AGEING,
  assertTxnType, validateLimit, validateTerms, normaliseAmount,
  openAccount, accountFor, assertCreditEligible, available,
  ageingFor, statusFor, daysBetween, dueDateFor,
  post, postStandalone, setLimit,
  allocateToDebits, allocateToDebit, storeCreditFor, spendStoreCredit,
  summaryFor, creditFor, presentTransaction, reconcile, outstanding,
  BUCKETS, BUCKET_LABELS, bucketFor, ageingReport, statement, statementCsv, ageingCsv,
  writeOff, writeOffReport,
  printStatement,
};
