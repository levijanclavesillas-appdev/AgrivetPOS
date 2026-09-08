'use strict';

// FR_4.3, FR_4.4 / CR-201–CR-206 — recording a payment against a credit account.
//
// Collection is half the reason the store wants this system (01_PRODUCT_BRIEF.md
// §1.2), and CR-203's allocation is the half that makes a statement possible later:
// without recording *which* sales a payment settled, a statement can only show a
// running balance — which is exactly the notebook the store is trying to leave behind.
//
// One transaction (requirement 7): the credit transaction, the allocations and the
// balance update commit together. The acknowledgement is printed outside it (INT-1):
// a printer failure must never roll back a payment the customer has already handed
// over.

const db = require('../config/database');
const ids = require('../config/ids');
const clock = require('../config/clock');
const errors = require('./errors');
const money = require('./money');
const auditService = require('./auditService');
const creditService = require('./creditService');
const shiftService = require('./shiftService');
const drawerService = require('./drawerService');
const documentService = require('./documentService');
const sequenceService = require('./sequenceService');
const storeProfileService = require('./storeProfileService');
const creditRepository = require('../repositories/creditRepository');
const customerRepository = require('../repositories/customerRepository');

/** CR-201's methods. A collection is money coming in, so CREDIT is not among them. */
const METHODS = Object.freeze(['CASH', 'GCASH', 'QRPH']);

/** Which of them put money in the drawer (CR-205, POS-509). */
const CASH_METHODS = Object.freeze(['CASH']);

const textOrNull = (value) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
};

// ── Recording (CR-201, CR-202) ──────────────────────────────────────────────

/**
 * Take a collection.
 *
 * CR-202: partial collections are permitted, and **every collection is its own
 * transaction; collections are never merged**. So there is no "add to today's
 * payment" path here — two payments from one customer on one day are two rows, two
 * numbers and two acknowledgements, because that is what the customer was handed.
 */
function record({
  customerId, amountCentavos, method = 'CASH', referenceNo = null, notes = null,
  acceptOverpayment = false, occurredAt = null,
}, actor) {
  if (!actor || !actor.id) throw new TypeError('a collection needs an acting user (CR-201)');

  const customer = customerRepository.findById(customerId);
  if (!customer) throw errors.notFound('No such customer');

  const account = creditRepository.findAccountByCustomer(customerId);
  if (!account) {
    throw errors.conflict(
      `${customer.name} has no credit account, so there is nothing to collect against.`,
      { ruleId: 'CR-101' }
    );
  }

  const upper = String(method || '').toUpperCase();
  if (!METHODS.includes(upper)) {
    throw errors.badRequest(`A collection method is one of ${METHODS.join(', ')}`, { ruleId: 'CR-201' });
  }

  const amount = normaliseAmount(amountCentavos);
  const reference = textOrNull(referenceNo);

  // POS-205's reasoning applied to a collection: a non-cash payment the store cannot
  // trace is a payment it cannot prove it received.
  if (!CASH_METHODS.includes(upper) && !reference) {
    throw errors.badRequest(
      `A ${upper} collection needs its reference number. Read it from the customer's screen.`,
      { ruleId: 'CR-201' }
    );
  }

  // CR-204: a collection may not exceed the outstanding balance unless the store
  // accepts advances, in which case the excess becomes store credit and requires
  // explicit confirmation.
  const outstanding = account.balance_centavos;
  const overpayment = Math.max(0, amount - Math.max(outstanding, 0));

  if (overpayment > 0 && !acceptOverpayment) {
    throw errors.conflict(
      `${customer.name} owes ${money.toDisplay(Math.max(outstanding, 0))} and this payment is `
      + `${money.toDisplay(amount)}. The extra ${money.toDisplay(overpayment)} becomes store credit `
      + 'on their account. Confirm to continue.',
      { ruleId: 'CR-204' }
    );
  }

  const at = occurredAt || clock.nowUtc();

  const result = db.transaction(() => {
    // POS-501 — no shift, no money. Inside the transaction with everything else, so a
    // shift closed between the screen loading and the confirm cannot slip through.
    const shift = shiftService.requireOpenShift(actor, { action: 'take a collection' });

    // The number is allocated inside the transaction, so a rollback consumes none
    // (POS-108's reasoning, CR-206's format).
    const documentNo = sequenceService.next('COLLECTION', { at });

    const posted = creditService.post({
      accountId: account.id,
      type: 'COLLECTION',
      amountCentavos: amount,
      actor,
      documentNo,
      method: upper,
      referenceNo: reference,
      shiftId: shift.id,
      reason: textOrNull(notes),
      occurredAt: at,
    });

    // CR-203 — applied oldest credit sale first, recorded per sale.
    const allocations = allocate({
      accountId: account.id,
      collectionTxnId: posted.transaction.id,
      amountCentavos: amount,
      at,
    });

    auditService.write({
      actor,
      action: 'COLLECTION_RECORDED',
      entityType: 'customer_credit_transactions',
      entityId: posted.transaction.id,
      before: { balance_centavos: outstanding },
      after: {
        balance_centavos: posted.balanceCentavos,
        amount_centavos: amount,
        method: upper,
        reference_no: reference,
        document_no: documentNo,
        allocated_centavos: allocations.reduce((sum, a) => sum + a.amount_centavos, 0),
        store_credit_centavos: overpayment,
      },
      reason: `Collection from ${customer.name}`,
      shiftId: shift.id,
    });

    return { shift, documentNo, posted, allocations };
  });

  // ── Outside the transaction (INT-1, POS-507) ──────────────────────────────
  //
  // CR-205: a cash collection is till cash, so the drawer opens for it exactly as it
  // does for a cash tender. Hardware, and a pulse cannot be rolled back.
  const drawer = CASH_METHODS.includes(upper)
    ? drawerService.pulse({
      reason: 'CASH_COLLECTION', shiftId: result.shift.id, actor, amountCentavos: amount,
    })
    : null;

  // CR-206: every collection prints an acknowledgement. Outside the transaction — the
  // customer has handed over the money, and a printer fault must not undo that.
  const acknowledgement = buildAcknowledgement({
    customer,
    documentNo: result.documentNo,
    amountCentavos: amount,
    method: upper,
    referenceNo: reference,
    balanceAfterCentavos: result.posted.balanceCentavos,
    allocations: result.allocations,
    actor,
    at,
  });
  const printout = documentService.print(acknowledgement);

  return {
    collection: creditService.presentTransaction({
      ...result.posted.transaction, created_by_username: actor.username,
    }),
    balance_centavos: result.posted.balanceCentavos,
    store_credit_centavos: result.posted.balanceCentavos < 0 ? -result.posted.balanceCentavos : 0,
    overpayment_centavos: overpayment,
    allocations: result.allocations,
    acknowledgement,
    printed: printout,
    drawer,
    expected: shiftService.computeExpected(result.shift.id),
  };
}

function normaliseAmount(value) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw errors.badRequest('A collection is a positive whole number of centavos', { ruleId: 'CR-201' });
  }
  return n;
}

// ── CR-203 — oldest credit sale first ───────────────────────────────────────

/**
 * Apply the payment to the open debits, oldest first, and record what it settled.
 *
 * Oldest first is not an accounting nicety. It is what makes ageing mean anything: a
 * payment applied to the newest invoice would leave the oldest one standing and the
 * account permanently overdue while the customer pays every month.
 *
 * The last allocated sale takes whatever is left, which may be a part payment — that
 * is the row CR-203 exists to produce, and what a statement later shows as "₱3,000 of
 * SALE-20260901-000004".
 */
function allocate({ accountId, collectionTxnId, amountCentavos, at }) {
  let remaining = amountCentavos;
  const written = [];

  for (const debit of creditRepository.openDebits(accountId)) {
    if (remaining <= 0) break;

    const applied = Math.min(remaining, debit.outstanding_centavos);
    if (applied <= 0) continue;

    const row = creditRepository.insertAllocation({
      id: ids.uuidv7(),
      collection_txn_id: collectionTxnId,
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

  // Anything left is the overpayment, which is already on the account as a negative
  // balance (CR-108). It allocates to nothing because it settles nothing.
  return written;
}

// ── CR-206 — the acknowledgement ────────────────────────────────────────────

/**
 * The document the customer is handed.
 *
 * CR-206 fixes what it carries: customer, amount, method and reference, the new
 * running balance, the receiving user, and its `COLL-YYYYMMDD-NNNNNN` number.
 * TASK-014 owns the 58 mm and 80 mm layouts; the *content* is decided here so the
 * printed paper and the stored row cannot disagree.
 *
 * TAX-006 applies: this is an internal transaction record, and documentService refuses
 * to print it if the required notice is missing or a forbidden phrase has crept in.
 */
function buildAcknowledgement({
  customer, documentNo, amountCentavos, method, referenceNo,
  balanceAfterCentavos, allocations, actor, at,
}) {
  const profile = storeProfileService.profile();
  const owed = balanceAfterCentavos > 0;

  const lines = [
    profile.store_name,
    profile.address || null,
    '',
    'COLLECTION ACKNOWLEDGEMENT',
    documentNo,
    clock.toManila(at),
    '',
    `Customer: ${customer.name}${customer.code ? ` (${customer.code})` : ''}`,
    `Amount:   ${money.toDisplay(amountCentavos)}`,
    `Method:   ${method}${referenceNo ? ` — ${referenceNo}` : ''}`,
    '',
  ];

  if (allocations.length > 0) {
    lines.push('Applied to:');
    for (const allocation of allocations) {
      lines.push(
        `  ${allocation.sale_document_no}  ${money.toDisplay(allocation.amount_centavos)}`
        + (allocation.settled_in_full ? '  (settled)' : '  (part)')
      );
    }
    lines.push('');
  }

  lines.push(
    owed
      ? `Balance now: ${money.toDisplay(balanceAfterCentavos)}`
      : `Store credit: ${money.toDisplay(-balanceAfterCentavos)}`,
    `Received by: ${actor.username}`,
    '',
    // TAX-006, verbatim and unconditional. Not a setting, and not omitted in any mode.
    documentService.REQUIRED_NOTICE,
  );

  return {
    kind: 'COLLECTION_ACKNOWLEDGEMENT',
    document_no: documentNo,
    customer: { id: customer.id, name: customer.name, code: customer.code },
    amount_centavos: amountCentavos,
    method,
    reference_no: referenceNo,
    balance_after_centavos: balanceAfterCentavos,
    received_by: actor.username,
    occurred_at: at,
    occurred_at_manila: clock.toManila(at),
    allocations: allocations.map((a) => ({
      sale_document_no: a.sale_document_no,
      amount_centavos: a.amount_centavos,
      settled_in_full: a.settled_in_full,
    })),
    text: lines.filter((line) => line !== null).join('\n'),
  };
}

// ── Reading ─────────────────────────────────────────────────────────────────

function listFor(customerId, { limit = 50, offset = 0 } = {}) {
  const customer = customerRepository.findById(customerId);
  if (!customer) throw errors.notFound('No such customer');

  const account = creditRepository.findAccountByCustomer(customerId);
  if (!account) return { customer: { id: customer.id, name: customer.name }, total: 0, collections: [] };

  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const skip = Math.max(Number.parseInt(offset, 10) || 0, 0);

  const rows = creditRepository.transactionsFor(account.id, { type: 'COLLECTION', limit: size, offset: skip });

  return {
    customer: { id: customer.id, name: customer.name, code: customer.code },
    total: creditRepository.countTransactionsFor(account.id, { type: 'COLLECTION' }),
    limit: size,
    offset: skip,
    collections: rows.map((row) => ({
      ...creditService.presentTransaction(row),
      // What this payment settled — CR-203's whole point.
      allocations: creditRepository.allocationsForCollection(row.id).map((a) => ({
        sale_document_no: a.sale_document_no,
        amount_centavos: a.amount_centavos,
        due_at: a.due_at,
      })),
    })),
  };
}

module.exports = {
  METHODS, CASH_METHODS,
  record, allocate, buildAcknowledgement, listFor, normaliseAmount,
};
