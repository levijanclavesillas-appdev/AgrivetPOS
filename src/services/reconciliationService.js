'use strict';

// FT-606 — payment reconciliation (TASK-032, RPT-105).
//
// **`POS-206` is the honest limitation this exists to work around.** No payment API
// confirms a GCash or QRPh transfer for this store, so `sale_tenders.status` admits
// exactly one value — `RECORDED`, meaning *the cashier saw it* — and the schema is
// written so `VERIFIED` cannot be stored at all. A column that could say "confirmed" is
// one a report would eventually print.
//
// So the store reconciles instead: the wallet's statement arrives, somebody reads the
// period's total off it, and this compares the two.
//
// **`RPT-105`'s second sentence is a prohibition, and it is the whole design.** The
// temptation is obvious — the statement says ₱14,270, the POS says ₱14,320, and a
// "correct to actual" button would make the discrepancy go away. It would also destroy
// the only record of a ₱50 sale a cashier recorded and nobody ever paid. **Nothing here
// writes to a sale or a tender.** The variance is the output.
//
// The shape is the shift close's, one level up (`POS-510`): a human's figure against a
// derived one, a variance, and a reason required beyond tolerance. Cash is already
// reconciled that way at the drawer and is shown from there rather than counted twice.

const db = require('../config/database');
const clock = require('../config/clock');
const ids = require('../config/ids');
const errors = require('./errors');
const money = require('./money');
const permissions = require('./permissions');
const auditService = require('./auditService');
const settingsService = require('./settingsService');
const reportService = require('./reportService');
const reportRepository = require('../repositories/reportRepository');
const reconciliationRepository = require('../repositories/reconciliationRepository');

/**
 * The methods that settle somewhere else, and therefore the only ones this asks about.
 *
 * `CASH` is reconciled at the shift close (`POS-510`) and `CREDIT` and `STORE_CREDIT`
 * settle nowhere at all — a credit sale is money the store is owed, not money in
 * transit. Requirement 2 says the absence has to be *stated* rather than left
 * unexplained, which is what `EXCLUDED` below is for.
 */
const METHODS = Object.freeze(['GCASH', 'QRPH', 'OTHER']);

const EXCLUDED = Object.freeze({
  CASH: 'Reconciled at the shift close, against the drawer count (POS-510). Asking for a '
    + 'second count here would be asking the same question twice and inviting two answers.',
  CREDIT: 'Settles nowhere — a credit sale is money the store is owed, and it is chased on '
    + 'the ageing report rather than reconciled against a statement.',
  STORE_CREDIT: 'Settles nowhere — it is the customer spending money the store already holds '
    + 'for them (CR-108). No transfer happens.',
});

function assertMethod(method) {
  const upper = String(method || '').toUpperCase();
  if (!METHODS.includes(upper)) {
    throw errors.badRequest(
      EXCLUDED[upper]
        ? `${upper} is not reconciled here. ${EXCLUDED[upper]}`
        : `A reconciliation is for one of ${METHODS.join(', ')}`,
      { ruleId: 'RPT-105' }
    );
  }
  return upper;
}

function assertScope(actor) {
  if (!actor) return;
  if (permissions.grant(actor.role, 'TX-421') === permissions.FULL) return;
  throw errors.forbidden(
    'You can see the figures for your own shift, not the store’s settlements. Ask the owner '
    + 'or a manager.',
    { ruleId: 'TX-421', requiresRole: 'MANAGER' }
  );
}

/**
 * What the POS recorded for a range, per method — read, never written.
 *
 * The figures come from `reportService.payments`, which is `RPT-102`'s own query. Not a
 * similar query: **the same one**, so "the reconciliation disagrees with the payments
 * report" is a sentence that cannot be said about the same range.
 */
function recorded({ from, to = null, actor = null } = {}) {
  assertScope(actor);
  const report = reportService.payments({ from, to }, actor);
  const byMethod = new Map(report.methods.map((row) => [row.method, row]));

  return {
    header: report.header,
    // Every reconcilable method, including the ones with nothing in the range: a method
    // that vanished because the week was quiet is a method somebody forgets to check.
    methods: METHODS.map((method) => {
      const row = byMethod.get(method);
      const last = reconciliationRepository.lastReconciledTo(method);
      return {
        method,
        recorded_centavos: row ? row.amount_centavos : 0,
        recorded_display: money.toDisplay(row ? row.amount_centavos : 0),
        tender_count: row ? row.tender_count : 0,
        sale_count: row ? row.sale_count : 0,
        // POS-206, said out loud on the figure it qualifies: this is what the cashier
        // saw, and the store has no confirmation of it from anybody else.
        recorded_label: 'RECORDED',
        last_reconciled_to: last,
        // Requirement 7's other half: where the next range should start.
        already_reconciled: reconciliationRepository
          .overlapping({ method, fromDate: report.header.from_date, toDate: report.header.to_date })
          .map(present),
      };
    }),
    // Requirement 2: the absences, explained on the screen rather than left as a gap.
    excluded: Object.entries(EXCLUDED).map(([method, why]) => ({ method, why })),
    // The cash figure the store already has, so nobody counts the drawer twice.
    cash: byMethod.get('CASH')
      ? {
        recorded_centavos: byMethod.get('CASH').amount_centavos,
        recorded_display: money.toDisplay(byMethod.get('CASH').amount_centavos),
        why: EXCLUDED.CASH,
      }
      : { recorded_centavos: 0, recorded_display: money.toDisplay(0), why: EXCLUDED.CASH },
    tolerance_centavos: settingsService.get('settlement_variance_tolerance_centavos'),
    basis: 'What the POS recorded, from the same query the payments report uses (RPT-102). '
      + 'Nothing here is adjusted by a reconciliation — the recorded figure is what the sales '
      + 'say, and the sales are not edited (RPT-105, POS-107).',
  };
}

/**
 * The tenders behind a recorded total (requirement 8).
 *
 * A variance that can only be stated is one nobody can act on. "We are ₱50 short" is
 * answered by reading down this list until the ₱50 turns up — a sale with no reference,
 * a duplicate, a transfer that never arrived.
 */
function drill({ from, to = null, method, actor = null } = {}) {
  assertScope(actor);
  const upper = assertMethod(method);
  const scope = reportService.range({ from, to });
  const rows = reportRepository.tendersOfMethod({ ...scope, method: upper });

  return {
    from_date: scope.from_date,
    to_date: scope.to_date,
    method: upper,
    tenders: rows.map((row) => ({
      sale_id: row.sale_id,
      sale_no: row.sale_no,
      occurred_at: row.occurred_at,
      occurred_at_manila: clock.toManila(row.occurred_at),
      cashier: row.cashier,
      amount_centavos: row.amount_centavos,
      amount_display: money.toDisplay(row.amount_centavos),
      // POS-205's reference, which is the field somebody matches against a statement
      // line. Its absence is the first thing to look at when a total is short.
      reference_no: row.reference_no,
      status: row.status,
    })),
    total_centavos: rows.reduce((sum, row) => sum + row.amount_centavos, 0),
  };
}

/**
 * `RPT-105` — record what actually settled, and report the difference.
 *
 * Writes one row to `payment_reconciliations` and **nothing else**: no sale, no tender,
 * no annotation on either. The recorded figures are stored on the row as they were
 * shown, because they are what the operator judged and wrote a reason about — a void
 * afterwards moves the derived total, and a reconciliation whose recorded figure
 * silently changed under its own reason is a record of nothing (`MON-005`'s reasoning,
 * applied one level up).
 */
function record({
  from, to = null, method, actualCentavos, reference = null, reason = null,
}, actor) {
  if (!actor || !actor.id) throw new TypeError('a reconciliation needs an acting user');
  assertScope(actor);
  const upper = assertMethod(method);

  const scope = reportService.range({ from, to });
  const actual = Number.isInteger(actualCentavos)
    ? actualCentavos
    : Number.parseInt(String(actualCentavos ?? '').trim(), 10);
  if (!Number.isInteger(actual) || actual < 0) {
    throw errors.badRequest(
      'The settled amount is a figure from the statement, in centavos, and it is not negative.',
      { ruleId: 'RPT-105' }
    );
  }

  // Requirement 7: a range cannot be quietly reconciled twice with different answers.
  // Refused rather than flagged — the second answer is the one that would be believed,
  // and the first is already on the trail with a reason attached to it.
  const clashes = reconciliationRepository.overlapping({
    method: upper, fromDate: scope.from_date, toDate: scope.to_date,
  });
  if (clashes.length > 0) {
    const first = clashes[0];
    throw errors.conflict(
      `${upper} is already reconciled for ${first.from_date} to ${first.to_date}`
      + `${first.reason ? ` — "${first.reason}"` : ''}. Reconcile a range that does not overlap `
      + 'it, or read that one back first: two answers for one week is worse than none.',
      { ruleId: 'RPT-105' }
    );
  }

  const figures = reportService.payments({ from: scope.from_date, to: scope.to_date }, actor);
  const row = figures.methods.find((entry) => entry.method === upper);
  const recordedCentavos = row ? row.amount_centavos : 0;
  const variance = actual - recordedCentavos;

  // POS-510's shape: a reason beyond the tolerance, and none demanded within it. A
  // store that had to explain every ₱2 of wallet fee would stop reading the question.
  const tolerance = settingsService.get('settlement_variance_tolerance_centavos');
  const why = typeof reason === 'string' ? reason.trim().slice(0, 300) : null;
  if (Math.abs(variance) > tolerance && !why) {
    throw errors.badRequest(
      `${upper} settled ${money.toDisplay(actual)} against ${money.toDisplay(recordedCentavos)} `
      + `recorded — a difference of ${money.toDisplay(variance)}, beyond the `
      + `${money.toDisplay(tolerance)} tolerance. Say what it is: a fee, a transfer that landed `
      + 'late, or a sale nobody paid for. The figures are not changed either way.',
      { ruleId: 'RPT-105' }
    );
  }

  const at = clock.nowUtc();

  return db.transaction(() => {
    const saved = reconciliationRepository.insert({
      id: ids.uuidv7(),
      from_date: scope.from_date,
      to_date: scope.to_date,
      method: upper,
      recorded_centavos: recordedCentavos,
      recorded_count: row ? row.tender_count : 0,
      actual_centavos: actual,
      variance_centavos: variance,
      reference: typeof reference === 'string' ? reference.trim().slice(0, 60) || null : null,
      reason: why || null,
      created_at: at,
      created_by: actor.id,
    });

    auditService.write({
      actor,
      action: 'PAYMENT_RECONCILED',
      entityType: 'payment_reconciliations',
      entityId: saved.id,
      after: {
        method: upper,
        from_date: scope.from_date,
        to_date: scope.to_date,
        recorded_centavos: recordedCentavos,
        actual_centavos: actual,
        variance_centavos: variance,
        reference: saved.reference,
      },
      reason: why || null,
    });

    return present(saved);
  }, { immediate: true });
}

function present(row) {
  if (!row) return null;
  const within = Math.abs(row.variance_centavos)
    <= settingsService.get('settlement_variance_tolerance_centavos');

  return {
    id: row.id,
    from_date: row.from_date,
    to_date: row.to_date,
    method: row.method,
    recorded_centavos: row.recorded_centavos,
    recorded_display: money.toDisplay(row.recorded_centavos),
    recorded_count: row.recorded_count,
    actual_centavos: row.actual_centavos,
    actual_display: money.toDisplay(row.actual_centavos),
    variance_centavos: row.variance_centavos,
    variance_display: money.toDisplay(row.variance_centavos),
    // The two words a reader wants before the numbers: which way, and whether it
    // matters. "Short" and "over" are what a shopkeeper says about a till.
    variance_label: row.variance_centavos === 0
      ? 'Exactly as recorded'
      : `${money.toDisplay(Math.abs(row.variance_centavos))} ${row.variance_centavos < 0 ? 'short' : 'over'}`,
    within_tolerance: within,
    reference: row.reference,
    reason: row.reason,
    reconciled_at: row.created_at,
    reconciled_at_manila: clock.toManila(row.created_at),
    reconciled_by: row.created_by_username || row.created_by,
  };
}

/** What has been reconciled already — where the next one starts (requirement 7). */
function history({ method = null, limit = 50, actor = null } = {}) {
  assertScope(actor);
  const upper = method ? assertMethod(method) : null;
  return {
    reconciliations: reconciliationRepository.list({ method: upper, limit }).map(present),
    methods: METHODS,
    excluded: Object.entries(EXCLUDED).map(([name, why]) => ({ method: name, why })),
  };
}

module.exports = { METHODS, EXCLUDED, recorded, drill, record, history, present };
