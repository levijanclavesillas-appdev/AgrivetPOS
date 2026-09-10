'use strict';

// TAX-006 / INT-1 — the printed document.
//
// TASK-014 owns the ESC/POS printer, the 58 mm and 80 mm layouts and the reprint
// queue. This file is the interface the rest of the application calls, and the one
// rule that must hold before any of that exists:
//
//   **TAX-006 — the printed document is an internal transaction record.** It carries
//   the store name and the words "This is not an official receipt". It must not carry
//   "Official Receipt", "Sales Invoice", "OR No.", a BIR permit number, or an ATP
//   serial range. This holds in every tax mode and is not configurable.
//
// That is a statutory exposure, not a formatting preference: a document that looks
// like an Official Receipt without an Authority to Print behind it is a document the
// store can be penalised for issuing. So the check lives here, on every document,
// rather than in the layout that TASK-014 will write — a layout is edited, and the
// next person editing it should not be able to reintroduce the phrase.

const clock = require('../config/clock');

/** The sentence TAX-006 requires, verbatim. */
const REQUIRED_NOTICE = 'This is not an official receipt';

/**
 * The phrases TAX-006 forbids.
 *
 * "OR No." is matched with its punctuation optional, because "OR NO" and "OR#" are the
 * same claim to a reader. The BIR permit and ATP patterns match the shapes those
 * numbers take rather than any particular one.
 */
const FORBIDDEN = Object.freeze([
  { label: 'Official Receipt', pattern: /official\s+receipt/i },
  { label: 'Sales Invoice', pattern: /sales\s+invoice/i },
  { label: 'OR No.', pattern: /\bor\s*(?:no\.?|#|number)\b/i },
  { label: 'a BIR permit number', pattern: /\b(?:bir\s*)?permit\s*(?:no\.?|number|#)/i },
  { label: 'an ATP serial range', pattern: /\batp\b/i },
]);

const KINDS = Object.freeze({
  SALE_RECEIPT: 'Transaction record',
  COLLECTION_ACKNOWLEDGEMENT: 'Collection acknowledgement',
  RETURN_ACKNOWLEDGEMENT: 'Return acknowledgement',
  SHIFT_CLOSING: 'Shift closing summary',
  // CR-302 (TASK-031). A statement is a document handed to a customer, so it carries
  // TAX-006's notice like every other one — it states what is owed, and it is not a
  // receipt for anything.
  STATEMENT: 'Statement of account',
});

const printed = [];
const MAX_REMEMBERED = 200;
let driver = null;

/** TASK-014 installs the real one. */
function setDriver(fn) {
  driver = typeof fn === 'function' ? fn : null;
}

function reset() {
  printed.length = 0;
  driver = null;
}

/**
 * TAX-006, applied to a document's rendered text.
 *
 * The required notice is checked first because its absence is the more common
 * mistake: a forbidden phrase has to be typed, and a missing notice only has to be
 * forgotten.
 */
function assertTaxCompliant(text, { kind = null } = {}) {
  const body = String(text || '');
  const problems = [];

  if (!new RegExp(REQUIRED_NOTICE.replace(/\s+/g, '\\s+'), 'i').test(body)) {
    problems.push(`must carry the words "${REQUIRED_NOTICE}"`);
  }
  for (const { label, pattern } of FORBIDDEN) {
    // The required notice contains the words "official receipt", so it is removed
    // before the forbidden phrases are looked for — otherwise the sentence TAX-006
    // demands would trip the rule TAX-006 makes.
    const withoutNotice = body.replace(new RegExp(REQUIRED_NOTICE.replace(/\s+/g, '\\s+'), 'ig'), '');
    if (pattern.test(withoutNotice)) problems.push(`must not carry "${label}"`);
  }

  if (problems.length > 0) {
    // A programming error, not an operator refusal: no input a cashier can give
    // produces one, and a document that reaches the printer wrong is already issued.
    throw new Error(
      `TAX-006 violation on a ${kind || 'document'}: it ${problems.join('; it ')}. `
      + 'The printed document is an internal transaction record and this rule is not configurable.'
    );
  }
  return body;
}

/**
 * Queue a document for printing.
 *
 * Never throws for a printer problem (INT-1): printing is best-effort and asynchronous,
 * and **a printer failure never rolls back a committed sale** — it queues the document
 * for reprint and raises a toast. It *does* throw for a TAX-006 violation, because that
 * is a defect in the document rather than in the hardware, and issuing it is the harm.
 *
 * Called outside the caller's transaction, always. TASK-014 replaces the body.
 */
function print(document) {
  const at = clock.nowUtc();
  assertTaxCompliant(document.text, { kind: document.kind });

  const record = {
    at,
    kind: document.kind,
    document_no: document.document_no || null,
    text: document.text,
    delivered: false,
    error: null,
  };

  if (driver) {
    try {
      driver(record);
      record.delivered = true;
    } catch (err) {
      // Queued for reprint (POS-208) rather than failing the operation that produced it.
      record.error = err.message;
    }
  } else {
    record.error = 'No receipt printer is configured yet (TASK-014).';
  }

  printed.push(record);
  if (printed.length > MAX_REMEMBERED) printed.shift();
  return record;
}

function history() {
  return printed.slice();
}

module.exports = {
  REQUIRED_NOTICE, FORBIDDEN, KINDS,
  setDriver, reset, assertTaxCompliant, print, history,
};
