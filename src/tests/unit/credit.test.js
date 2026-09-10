'use strict';

// CR-107's ageing derivation and CR-105's due date, tested as pure functions.
//
// TC-UT-44 is the date-boundary case, and it is a unit case for a reason: the whole
// point of CR-107 is that nothing runs to make the status change. Asserting that with
// a database would prove a query works; asserting it here proves the *derivation*
// moves on its own when the calendar does.

const test = require('node:test');
const assert = require('node:assert/strict');
const creditService = require('../../services/creditService');

const DUE_SOON_DAYS = 3;   // CR-107's documented default

// ── TC-UT-44 — ageing across a date boundary ────────────────────────────────

test('TC-UT-44: ageing derives from the due date and today, with no job running', () => {
  const due = '2026-09-15T00:00:00.000Z';

  // Manila calendar days on both sides (VR-102). The store's "today" is what decides
  // this — an account must not tip into overdue at eight in the morning because UTC
  // rolled over first.
  assert.equal(creditService.statusFor(due, '2026-09-01', DUE_SOON_DAYS), 'CURRENT', 'two weeks out');
  assert.equal(creditService.statusFor(due, '2026-09-11', DUE_SOON_DAYS), 'CURRENT', 'four days out');
  assert.equal(creditService.statusFor(due, '2026-09-12', DUE_SOON_DAYS), 'DUE_SOON', 'three days out');
  assert.equal(creditService.statusFor(due, '2026-09-14', DUE_SOON_DAYS), 'DUE_SOON', 'tomorrow');
  assert.equal(creditService.statusFor(due, '2026-09-15', DUE_SOON_DAYS), 'DUE_SOON', 'due today is not yet late');
  assert.equal(creditService.statusFor(due, '2026-09-16', DUE_SOON_DAYS), 'OVERDUE', 'the day after');
  assert.equal(creditService.statusFor(due, '2026-10-01', DUE_SOON_DAYS), 'OVERDUE');
});

test('TC-UT-44: the boundary is one day wide, and crossing it changes nothing else', () => {
  // The same unchanged debit reads differently on two consecutive days. Nothing was
  // written between them, which is the property CR-107 is about.
  const due = '2026-09-15T12:00:00.000Z';        // 8pm Manila on the 15th
  assert.equal(creditService.statusFor(due, '2026-09-15', DUE_SOON_DAYS), 'DUE_SOON');
  assert.equal(creditService.statusFor(due, '2026-09-16', DUE_SOON_DAYS), 'OVERDUE');
});

test('TC-UT-44: the due date is the Manila day, not the UTC one', () => {
  // Manila is UTC+8, so the last eight hours of a UTC day already belong to the next
  // Manila day. A sale stamped 23:59 UTC on the 15th is due on the 16th in the store,
  // and treating the stored instant as a UTC date would make it overdue a day early —
  // the store chasing a farm that is not late yet.
  const lateUtc = '2026-09-15T23:59:59.999Z';    // 07:59 Manila on the 16th
  assert.equal(creditService.statusFor(lateUtc, '2026-09-16', DUE_SOON_DAYS), 'DUE_SOON', 'due today');
  assert.equal(creditService.statusFor(lateUtc, '2026-09-17', DUE_SOON_DAYS), 'OVERDUE');
});

test('the due-soon window is the configured one, not a literal', () => {
  const due = '2026-09-15T00:00:00.000Z';
  assert.equal(creditService.statusFor(due, '2026-09-08', 3), 'CURRENT', 'seven days out, window 3');
  assert.equal(creditService.statusFor(due, '2026-09-08', 7), 'DUE_SOON', 'seven days out, window 7');
  assert.equal(creditService.statusFor(due, '2026-09-08', 14), 'DUE_SOON');
});

test('a debit with no due date is not chaseable and reads CURRENT', () => {
  // Only an adjustment reaches this: a COD sale carries the day it was made.
  assert.equal(creditService.statusFor(null, '2026-09-16', DUE_SOON_DAYS), 'CURRENT');
});

test('daysBetween counts whole Manila days in both directions', () => {
  assert.equal(creditService.daysBetween('2026-09-01', '2026-09-15'), 14);
  assert.equal(creditService.daysBetween('2026-09-15', '2026-09-01'), -14);
  assert.equal(creditService.daysBetween('2026-09-15', '2026-09-15'), 0);
  // Across a month end and a leap-year February, where a naive 30-day arithmetic drifts.
  assert.equal(creditService.daysBetween('2026-01-31', '2026-03-01'), 29);
  assert.equal(creditService.daysBetween('2028-02-28', '2028-03-01'), 2, '2028 is a leap year');
});

// ── CR-105 — the due date, fixed at the moment of sale ──────────────────────

test('CR-105: the due date comes from the terms in force at the moment of sale', () => {
  const at = '2026-09-08T02:00:00.000Z';

  assert.equal(creditService.dueDateFor({ terms_days: 0 }, { at }), at, 'COD is due the day it is sold');
  assert.equal(creditService.dueDateFor({ terms_days: 7 }, { at }), '2026-09-15T02:00:00.000Z');
  assert.equal(creditService.dueDateFor({ terms_days: 15 }, { at }), '2026-09-23T02:00:00.000Z');
  assert.equal(creditService.dueDateFor({ terms_days: 30 }, { at }), '2026-10-08T02:00:00.000Z');

  // An explicit date on the sale overrides the terms (CR-105's "or an explicit date").
  assert.equal(
    creditService.dueDateFor({ terms_days: 30 }, { at, explicitDueAt: '2026-09-10T00:00:00.000Z' }),
    '2026-09-10T00:00:00.000Z'
  );
});

test('the documented terms are offered, and an absurd one is refused', () => {
  assert.deepEqual([...creditService.TERMS_DAYS], [0, 7, 15, 30]);
  assert.equal(creditService.validateTerms(undefined), 0, 'COD by default');
  assert.equal(creditService.validateTerms('15'), 15);

  assert.throws(() => creditService.validateTerms(-1), (e) => e.ruleId === 'CR-105');
  assert.throws(() => creditService.validateTerms(400), (e) => e.ruleId === 'CR-105');
  assert.throws(() => creditService.validateTerms('soon'), (e) => e.ruleId === 'CR-105');
});

// ── CR-101 / VR-303 ─────────────────────────────────────────────────────────

test('CR-101: available credit is limit minus balance, computed', () => {
  assert.equal(creditService.available({ credit_limit_centavos: 5000000, balance_centavos: 1200000 }), 3800000);
  assert.equal(creditService.available({ credit_limit_centavos: 5000000, balance_centavos: 0 }), 5000000);
  // Over the limit is a negative availability, not a clamped zero: the figure has to
  // be able to say how far over it is (CR-104).
  assert.equal(creditService.available({ credit_limit_centavos: 100000, balance_centavos: 150000 }), -50000);
  // Store credit (CR-108) is a negative balance, so availability exceeds the limit.
  assert.equal(creditService.available({ credit_limit_centavos: 100000, balance_centavos: -25000 }), 125000);
});

test('VR-303: a credit limit is a non-negative whole number of centavos', () => {
  assert.equal(creditService.validateLimit(undefined), 0);
  assert.equal(creditService.validateLimit('5000000'), 5000000);
  assert.throws(() => creditService.validateLimit(-1), (e) => e.ruleId === 'VR-303');
  assert.throws(() => creditService.validateLimit(12.5), (e) => e.ruleId === 'VR-303');
});

// ── CR-103 — the ledger's signs ─────────────────────────────────────────────

test('CR-103: a credit sale debits and everything else credits, whatever sign is passed', () => {
  // A collection of −50000 and a collection of 50000 both mean ₱500 came in. Trusting
  // the caller's sign is how a payment ends up increasing a debt.
  assert.equal(creditService.normaliseAmount('CREDIT_SALE', 50000), 50000);
  assert.equal(creditService.normaliseAmount('CREDIT_SALE', -50000), 50000);
  assert.equal(creditService.normaliseAmount('COLLECTION', 50000), -50000);
  assert.equal(creditService.normaliseAmount('COLLECTION', -50000), -50000);
  assert.equal(creditService.normaliseAmount('RETURN_CREDIT', 1000), -1000);
  assert.equal(creditService.normaliseAmount('WRITE_OFF', 1000), -1000);
  assert.equal(creditService.normaliseAmount('OPENING', 1000), 1000);

  // An adjustment is the one two-directional type and keeps what it was given.
  assert.equal(creditService.normaliseAmount('ADJUSTMENT', -1000), -1000);
  assert.equal(creditService.normaliseAmount('ADJUSTMENT', 1000), 1000);

  assert.throws(() => creditService.normaliseAmount('COLLECTION', 0), (e) => e.ruleId === 'MON-001');
  assert.throws(() => creditService.assertTxnType('PAYMENT'), RangeError);
});

test('the six ledger types are exactly the schema CHECK list', () => {
  assert.deepEqual([...creditService.TXN_TYPE_NAMES].sort(), [
    'ADJUSTMENT', 'COLLECTION', 'CREDIT_SALE', 'OPENING', 'RETURN_CREDIT', 'WRITE_OFF',
  ]);
  assert.deepEqual([...creditService.METHODS], ['CASH', 'GCASH', 'QRPH', 'STORE_CREDIT']);
  assert.deepEqual([...creditService.AGEING], ['PAID', 'OVERDUE', 'DUE_SOON', 'CURRENT']);
});

// ── TC-UT-55 — CR-301's buckets (TASK-031) ──────────────────────────────────

test('TC-UT-55: the bucket boundaries fall at 30, 60 and 90 days past due', () => {
  const bucket = creditService.bucketFor;

  // Not yet due is a bucket, not a special case at the call site: every unsettled debit
  // has to land somewhere or the totals stop adding up to the receivable, and a debt
  // with nowhere to go is how a reconciliation quietly loses money.
  assert.equal(bucket(-14), 'NOT_DUE');
  assert.equal(bucket(0), 'NOT_DUE', 'due today is not yet overdue');

  // Each bucket is inclusive of its upper edge, so the day after is the next one. Read
  // the other way round — 30 opening the 31–60 bucket — every figure on the report
  // shifts by a day's worth of debt, and the store chases the wrong farms first.
  assert.equal(bucket(1), 'D1_30', 'one day past due is the first day of the first bucket');
  assert.equal(bucket(30), 'D1_30');
  assert.equal(bucket(31), 'D31_60');
  assert.equal(bucket(60), 'D31_60');
  assert.equal(bucket(61), 'D61_90');
  assert.equal(bucket(90), 'D61_90');
  assert.equal(bucket(91), 'D90_PLUS');
  assert.equal(bucket(400), 'D90_PLUS');

  // Every bucket the report totals has a label somebody can read on a printed page.
  for (const name of creditService.BUCKETS) {
    assert.ok(creditService.BUCKET_LABELS[name], `${name} has no label`);
  }
});

test('TC-UT-55: the buckets are the whole of the range, with no gap and no overlap', () => {
  // A day cannot fall in two buckets and cannot fall in none. Asserted across the
  // boundaries rather than argued: the rule is four ranges and a "not yet", and an
  // off-by-one in either direction is invisible in any single example.
  const seen = new Map();
  for (let days = -5; days <= 200; days += 1) {
    const bucket = creditService.bucketFor(days);
    assert.ok(creditService.BUCKETS.includes(bucket), `${days} landed outside the buckets`);
    seen.set(bucket, (seen.get(bucket) || 0) + 1);
  }
  assert.equal(seen.size, 5, 'every bucket is reachable');
  assert.equal(seen.get('D1_30'), 30);
  assert.equal(seen.get('D31_60'), 30);
  assert.equal(seen.get('D61_90'), 30);
});
