// POS-201 to POS-207 — the tender list, as a model.
//
// Pure. The screen renders it and the server re-checks all of it (§4.1 steps 5 to 7):
// nothing decided here is trusted, and the point of deciding it here is that the
// cashier sees "remaining ₱400.00" while they are counting, not after they press
// Complete.

export const METHODS = Object.freeze(['CASH', 'GCASH', 'QRPH', 'CREDIT', 'STORE_CREDIT']);

/**
 * CR-108: these two belong to a customer rather than to the counter, so a walk-in is
 * offered neither. `CREDIT` is money the customer will owe; `STORE_CREDIT` is money the
 * store already owes them — opposite directions on one account.
 */
export const NEEDS_CUSTOMER = Object.freeze(['CREDIT', 'STORE_CREDIT']);

/** POS-205: these carry a reference that is neither defaulted nor generated. */
export const NEEDS_REFERENCE = Object.freeze(['GCASH', 'QRPH']);

/** POS-203: only cash may over-tender, and change is cash only (MON-007). */
export const MAY_OVER_TENDER = Object.freeze(['CASH']);

export function createTenders(totalCentavos, { storeCreditCentavos = 0 } = {}) {
  let rows = [];
  // CR-108: what the customer holds. Settable rather than fixed at construction, because
  // the screen draws before `GET /customers/:id/credit` answers — and rebuilding the
  // model when it does would throw away whatever the cashier had already keyed.
  let held = storeCreditCentavos;

  function add(method, amountCentavos = 0, referenceNo = '') {
    const row = {
      key: `${method}:${rows.length}:${Date.now()}`,
      method,
      amountCentavos,
      referenceNo,
      // POS-206: "the cashier saw it". Never VERIFIED — no payment API confirms these,
      // and the word appears on the screen, the receipt and the report alike.
      status: 'RECORDED',
      duplicateAccepted: false,
    };
    rows.push(row);
    return row;
  }

  const remove = (key) => { rows = rows.filter((row) => row.key !== key); };
  const find = (key) => rows.find((row) => row.key === key) ?? null;

  const tenderedCentavos = () => rows.reduce((sum, row) => sum + (row.amountCentavos || 0), 0);
  const cashCentavos = () => rows
    .filter((row) => MAY_OVER_TENDER.includes(row.method))
    .reduce((sum, row) => sum + (row.amountCentavos || 0), 0);

  /** What is still owed, never negative — the over-tender is change, not a shortfall. */
  const remainingCentavos = () => Math.max(0, totalCentavos - tenderedCentavos());

  /** CR-108: how much of the balance this payment is spending. */
  const storeCreditTendered = () => rows
    .filter((row) => row.method === 'STORE_CREDIT')
    .reduce((sum, row) => sum + (row.amountCentavos || 0), 0);

  // The screen's own formatter is in format.js; this model is imported by tests that
  // load no DOM, so it carries the one line of it that a refusal needs.
  const peso = (centavos) => `₱${(centavos / 100).toFixed(2)}`;

  /** MON-007: change is what cash exceeds the bill by, and it is cash only. */
  const changeCentavos = () => Math.min(
    Math.max(0, tenderedCentavos() - totalCentavos),
    cashCentavos()
  );

  /**
   * Why Complete is disabled, or null when it is not.
   *
   * A reason rather than a boolean: 04_UX_SPEC.md §6 puts rule validation at the point
   * of action, and a greyed-out button with no explanation is the thing cashiers ring
   * the owner about.
   */
  function blockedReason() {
    if (rows.length === 0) return 'Add a payment to continue.';

    for (const row of rows) {
      if (!Number.isInteger(row.amountCentavos) || row.amountCentavos <= 0) {
        return `Enter the ${row.method} amount.`;
      }
      if (NEEDS_REFERENCE.includes(row.method) && !String(row.referenceNo || '').trim()) {
        // POS-205, and it is never filled in for them: an auto-generated reference is a
        // receipt claiming a payment was traced when nobody traced it.
        return `A ${row.method} payment needs its reference number.`;
      }
      if (row.duplicate && !row.duplicateAccepted) {
        // POS-207: double-keying the same GCash reference is the common till error, so
        // it is accepted explicitly rather than waved through.
        return `${row.method} reference ${row.referenceNo} was already used today. Confirm it to continue.`;
      }
    }

    // CR-108: more store credit than the customer holds. Checked before POS-204's
    // shortfall, because "this does not cover it yet" is what the cashier sees while
    // they are still counting and this is a figure that will never be accepted.
    if (storeCreditTendered() > held) {
      return held === 0
        ? 'This customer has no store credit to spend.'
        : `Only ${peso(held)} of store credit is held. Reduce it and take the rest another way.`;
    }

    // POS-204.
    if (tenderedCentavos() < totalCentavos) return 'The payment does not cover the total yet.';

    // POS-203: an over-tender larger than the cash in it cannot produce change.
    const over = tenderedCentavos() - totalCentavos;
    if (over > cashCentavos()) return 'Only cash may be over-tendered. Reduce the other payments.';

    return null;
  }

  return {
    add,
    remove,
    find,
    blockedReason,
    tenderedCentavos,
    remainingCentavos,
    changeCentavos,
    cashCentavos,
    storeCreditTendered,
    setStoreCreditHeld: (centavos) => { held = Math.max(0, centavos || 0); },
    get storeCreditCentavos() { return held; },
    get rows() { return rows.slice(); },
    get isComplete() { return blockedReason() === null; },
    toRequest: () => rows.map((row) => ({
      method: row.method,
      amountCentavos: row.amountCentavos,
      referenceNo: NEEDS_REFERENCE.includes(row.method) ? String(row.referenceNo).trim() : null,
    })),
    anyDuplicateAccepted: () => rows.some((row) => row.duplicate && row.duplicateAccepted),
  };
}
