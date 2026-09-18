'use strict';

// POS-108 / VR-103 — document numbers.
//
// `SALE-YYYYMMDD-NNNNNN`, sequential per day, **gapless**, and allocated inside the
// transaction that writes the document so that a rollback consumes no number.
//
// Two decisions are load-bearing:
//
//   There is no counter table. The next number is derived from the documents
//   themselves — MAX of today's rows, inside the caller's transaction. A counter table
//   is a second figure that must agree with the first, and it drifts on exactly the
//   rollback this rule exists to survive: the counter increments, the row does not
//   land, and the day has a gap nobody can explain.
//
//   VR-103 — the device clock is not trusted for **sequencing**. The counter comes
//   from the database. The clock still supplies the date the number is filed under,
//   because a document has to be dated something and the store's calendar day is the
//   only meaningful answer; a clock moved backwards past the last transaction raises
//   OPS-009's anomaly alert rather than being silently trusted.

const clock = require('../config/clock');
const errors = require('./errors');
const sequenceRepository = require('../repositories/sequenceRepository');

const SEQUENCES = Object.freeze({
  SALE: { prefix: 'SALE', table: 'sales', column: 'sale_no', rule: 'POS-108' },
  COLLECTION: { prefix: 'COLL', table: 'customer_credit_transactions', column: 'document_no', rule: 'CR-206' },
  PURCHASE_ORDER: { prefix: 'PO', table: 'purchase_orders', column: 'po_no', rule: 'PO-101' },
  GOODS_RECEIPT: { prefix: 'GR', table: 'goods_receipts', column: 'gr_no', rule: 'PO-201' },
  RETURN: { prefix: 'RET', table: 'sale_returns', column: 'return_no', rule: 'POS-301' },
  STOCK_COUNT: { prefix: 'SC', table: 'stock_count_sessions', column: 'count_no', rule: 'INV-110' },
  RESTOCK_REQUEST: { prefix: 'RR', table: 'restock_requests', column: 'rr_no', rule: 'PO-107' },
});

const WIDTH = 6;
const PATTERN = /^([A-Z]+(?:-[A-Z])?)-(\d{8})-(\d{6})$/;   // TASK-063: SALE-A-… on a device

function assertKind(kind) {
  if (!Object.prototype.hasOwnProperty.call(SEQUENCES, kind)) {
    throw new RangeError(`unknown document sequence: ${kind}`);
  }
  return kind;
}

/** The Manila calendar day a document is filed under (VR-102). */
function dateKey(at) {
  return clock.manilaDate(at).replace(/-/g, '');
}

function format(kind, at, counter, series = deviceSeries()) {
  assertKind(kind);
  if (!Number.isInteger(counter) || counter < 1) {
    throw new RangeError(`a document counter is a positive integer, got ${counter}`);
  }
  if (counter > 10 ** WIDTH - 1) {
    // A store doing a million documents in one day has a different problem, but the
    // number must not silently wrap into a duplicate.
    throw errors.conflict(
      `The ${SEQUENCES[kind].prefix} sequence for today is full. This should not happen; `
      + 'contact support before continuing.',
      { ruleId: SEQUENCES[kind].rule }
    );
  }
  return `${prefixFor(kind, series)}-${dateKey(at)}-${String(counter).padStart(WIDTH, '0')}`;
}

/**
 * TASK-063: a store's devices sell offline at the same time, so each numbers its own
 * documents — SALE-A-20260915-000012 on device A — and every series stays gapless on
 * its own (POS-108). The web copy and a store with one device keep SALE-20260915-…
 */
function deviceSeries() {
  try {
    const identity = require('../repositories/syncRepository').identity();
    return identity && identity.role === 'DEVICE' && identity.series ? identity.series : null;
  } catch {
    return null;
  }
}

const prefixFor = (kind, series = deviceSeries()) => (series ? `${SEQUENCES[kind].prefix}-${series}` : SEQUENCES[kind].prefix);

function parse(documentNo) {
  const match = PATTERN.exec(String(documentNo || ''));
  if (!match) return null;
  return { prefix: match[1], date: match[2], counter: Number.parseInt(match[3], 10) };
}

/**
 * The next number for today.
 *
 * **Must be called inside the caller's transaction.** Between reading the maximum and
 * inserting the row there is a window; the transaction is what closes it, and
 * §4.1's BEGIN IMMEDIATE is what makes that true under a second writer. Called outside
 * one it is still correct on a single-writer machine, and TASK-011 does not rely on
 * that.
 */
function next(kind, { at = clock.nowUtc() } = {}) {
  assertKind(kind);
  const { table, column } = SEQUENCES[kind];
  const series = deviceSeries();
  const highest = sequenceRepository.highestForDay({ table, column, prefix: prefixFor(kind, series), dateKey: dateKey(at) });
  const counter = highest === null ? 1 : highest + 1;
  return format(kind, at, counter, series);
}

/**
 * Every number issued today, and whether the run is gapless.
 *
 * TC-INT-55 asserts this after a rolled-back sale. Exposed rather than computed in the
 * test so the same check can run on a real store's day: "are there gaps in today's
 * sale numbers" is a question an owner is entitled to ask.
 */
function auditDay(kind, { at = clock.nowUtc(), series = deviceSeries() } = {}) {
  assertKind(kind);
  const { table, column } = SEQUENCES[kind];
  // One series at a time: this installation's own, or the one asked for (TASK-063).
  const numbers = sequenceRepository.numbersForDay({ table, column, prefix: prefixFor(kind, series), dateKey: dateKey(at) });

  const counters = numbers.map((n) => parse(n)).filter(Boolean).map((p) => p.counter).sort((a, b) => a - b);
  const gaps = [];
  for (let expected = 1; expected <= counters.length; expected += 1) {
    if (counters[expected - 1] !== expected) gaps.push(expected);
  }

  return { kind, date: dateKey(at), issued: counters.length, gapless: gaps.length === 0, gaps, numbers };
}

module.exports = { SEQUENCES, WIDTH, assertKind, dateKey, format, parse, next, auditDay };
