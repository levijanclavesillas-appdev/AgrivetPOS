'use strict';

// FT-308 — the void. POS-401 to POS-404, POS-107, AUD-601, AUD-603.
//
// The mis-scan noticed while the customer is still standing there. v1.0 had no answer
// to it: POS-107 makes a completed sale immutable, and the only correction was a
// return, which is the wrong shape because the goods never left.
//
// A void and a return are different operations and the difference is the whole point.
// **A void says the sale never happened; a return says the goods came back.** That is
// why a void is bounded to the shift and a return is not, and why a void reverses the
// tenders while a return refunds them.
//
// Three rules do the work.
//
//   POS-402 — **only within the originating shift, and only while it is open.** After
//   the close the drawer has been counted against that sale, the day has been backed
//   up and the figures have been reported; unwinding one then is not a correction but
//   a rewrite. The refusal names the return, because the counter still needs an answer.
//
//   POS-403 — a manager or owner authorises, and **a cashier may never void unaided.**
//   The route is reachable at the counter under TX-401, and this file is what enforces
//   TX-405: the actor holds it, or a distinct approver who does is resolved and both
//   actors go on the row (AUD-603).
//
//   POS-404 — the sale stays in the ledger, the trail and **the sequence**. POS-108's
//   numbers do not close up. A gap in the receipt numbers is what an auditor looks for,
//   and a void that removed one would hide exactly the thing the sequence reveals.
//
// Nothing is deleted anywhere (INV-102). Stock comes back as a compensating SALE_VOID
// movement citing the sale; credit comes back as an ADJUSTMENT row against the same
// account. The tenders are reversed by the status alone, and deliberately so — see
// `drawerEffect` below, which is the one piece of arithmetic in this file worth
// reading twice.

const db = require('../config/database');
const clock = require('../config/clock');
const errors = require('./errors');
const money = require('./money');
const permissions = require('./permissions');
const authService = require('./authService');
const auditService = require('./auditService');
const inventoryService = require('./inventoryService');
const creditService = require('./creditService');
const drawerService = require('./drawerService');
const saleRepository = require('../repositories/saleRepository');
const returnRepository = require('../repositories/returnRepository');
const creditRepository = require('../repositories/creditRepository');
const shiftRepository = require('../repositories/shiftRepository');

/** POS-403's authority. §10 grants TX-405 to exactly these two. */
const AUTHORISING_ROLES = Object.freeze(['MANAGER', 'OWNER']);

const REASON_MIN = 4;
const REASON_MAX = 200;

const textOrNull = (value, { max = REASON_MAX } = {}) => {
  const trimmed = typeof value === 'string' ? value.trim().slice(0, max) : '';
  return trimmed || null;
};

// ── POS-403 — who may, and who may not alone ────────────────────────────────

/**
 * Whether this void is authorised, and by whom.
 *
 * Unlike the exceptions in `goodsReceiptService` and `returnService`, authorisation
 * here is **always** required — POS-403 has no ordinary case. What varies is only
 * whether the person at the keyboard already carries it.
 *
 * A manager or owner voiding their own mis-scan is the authority the rule asks for;
 * requiring a second person would make a void impossible in a store where the manager
 * works the till, which is most of them. The trail says `self_authorised` explicitly,
 * because "a manager did this himself" and "no authorisation was needed" read
 * identically otherwise — and here the second of those is never true.
 */
function authorisationFor({ actor, approver }) {
  if (permissions.can(actor, 'TX-405')) {
    return { required: true, selfAuthorised: true, approver: null };
  }

  const resolved = authService.resolveApprover(approver, { roles: null });
  if (!resolved) {
    throw errors.forbidden(
      'A void needs a manager or owner. A cashier may never void a sale unaided — call '
      + 'somebody over and have them authorise it here.',
      { ruleId: 'POS-403', requiresRole: AUTHORISING_ROLES.join(' or ') }
    );
  }
  if (!AUTHORISING_ROLES.includes(resolved.role)) {
    throw errors.forbidden(
      `${resolved.username} is a ${resolved.role.toLowerCase()} and cannot authorise a void.`,
      { ruleId: 'POS-403', requiresRole: AUTHORISING_ROLES.join(' or ') }
    );
  }
  if (resolved.id && actor.id && resolved.id === actor.id) {
    // Unreachable through the branch above — an actor who holds TX-405 self-authorises
    // and never gets here — but stated, because AUD-603's two actors must be two.
    throw errors.forbidden('A void must be authorised by a different user.', { ruleId: 'AUD-603' });
  }

  return { required: true, selfAuthorised: false, approver: resolved };
}

// ── POS-402 — the window ────────────────────────────────────────────────────

/**
 * The sale's own shift, and whether it is still open.
 *
 * The shift that matters is the **sale's**, not the actor's. A manager who has not
 * opened a drawer of their own may still void a cashier's mis-scan, and a cashier on
 * their second shift of the day may not reach back into their first — which is the
 * same sentence read from either side, and why the check is on the sale.
 */
function windowFor(sale) {
  const shift = shiftRepository.findById(sale.shift_id);
  return {
    shift,
    shiftId: sale.shift_id,
    open: Boolean(shift) && shift.status === 'OPEN',
    closedAt: shift ? shift.closed_at : null,
  };
}

function assertWithinWindow(sale, state) {
  if (state.open) return;

  throw errors.conflict(
    `${sale.sale_no} was rung up in a shift that has since been closed`
    + `${state.closedAt ? ` (${clock.toManila(state.closedAt)})` : ''}, so it can no longer be `
    + 'voided: the drawer has been counted against it and the day has been reported. '
    + 'Take the goods back as a return instead — that is the correction that applies '
    + 'after a close.',
    { ruleId: 'POS-402' }
  );
}

/**
 * Whether this actor may operate inside that shift at all.
 *
 * `TX-419` is §10's "close another user's shift" — the grant that says a role may act
 * on a drawer it did not count. Reused rather than duplicated: a cashier reaching into
 * a colleague's shift is the same thing it already governs, and inventing a second
 * permission for it would put two answers in the matrix for one question.
 */
function assertOwnShift(sale, actor, state) {
  if (!state.shift || state.shift.user_id === actor.id) return;
  if (permissions.can(actor, 'TX-419')) return;

  throw errors.forbidden(
    `${sale.sale_no} belongs to another cashier's shift. A manager or owner may void it for them.`,
    { ruleId: 'TX-419', requiresRole: permissions.rolesHolding('TX-419').join(' or ') }
  );
}

// ── Requirement 6 — the drawer, and the arithmetic that is already right ────

/**
 * What a void does to POS-509's expected cash, and why this file writes no till row.
 *
 * `shiftRepository.tenderTotalsByMethod` and `changeGivenCentavos` both already filter
 * `status <> 'VOIDED'` — they have since TASK-010, because the column existed from
 * 006 even though nothing wrote it. So the moment the status lands, the cash tender
 * leaves the expected figure and the change given comes back to it, both by exactly the
 * right amount and both without a compensating row.
 *
 * **Writing a till movement as well would take it off twice.** That is the whole
 * reason this function exists rather than a `TILL_CASH_MOVED` call: it computes the
 * effect so a caller can report it and a test can assert it, and it deliberately
 * writes nothing. The same trap `returnService` avoided with POS-509's refund term.
 *
 * The physical drawer still opens — the cashier has notes to hand back — but a pulse
 * is hardware, not a ledger entry.
 */
function drawerEffect(sale, tenders) {
  const cashTendered = tenders
    .filter((t) => t.method === 'CASH')
    .reduce((sum, t) => sum + t.amount_centavos, 0);

  return {
    cash_tendered_centavos: cashTendered,
    change_given_centavos: sale.change_centavos,
    // What comes out of the drawer: what was taken, less what was already handed back.
    cash_out_centavos: Math.max(cashTendered - sale.change_centavos, 0),
    // Said explicitly so nobody adds one later.
    till_movement_written: false,
  };
}

// ── The endpoint ────────────────────────────────────────────────────────────

/**
 * Void a sale.
 *
 * One transaction (requirement 7): the reversing movements, the credit reversal, the
 * sale's status and its four stamped columns, and both audit rows commit together or
 * not at all. The drawer pulse is outside it (INT-1) — a stuck drawer must never undo
 * a void the ledger has already accepted.
 */
function post({ saleId, reason, approver = null }, actor) {
  // The route is TX-401's — this is the counter, and the cashier who rang the sale is
  // the person who notices the mistake. POS-403's authority is checked below, where it
  // can name the rule and open the panel rather than refusing at the door.
  if (!permissions.can(actor, 'TX-401')) {
    throw errors.forbidden(
      'You do not have permission to work the counter.',
      { ruleId: 'TX-401', requiresRole: permissions.rolesHolding('TX-401').join(' or ') }
    );
  }

  const sale = saleRepository.findById(saleId);
  if (!sale) throw errors.notFound('No such sale');

  // Requirement 8, first half. Refused before anything else, because "already voided"
  // is a different sentence from "the shift is closed" and the second would otherwise
  // be shown for a sale that was voided while its shift was still open.
  if (sale.status === 'VOIDED') {
    throw errors.conflict(
      `${sale.sale_no} was already voided${sale.voided_at ? ` on ${clock.toManila(sale.voided_at)}` : ''}. `
      + 'It stays in the ledger and in the sequence, and voiding it again would say nothing new.',
      { ruleId: 'POS-404' }
    );
  }

  // A sale with goods already back cannot also never have happened. The two
  // corrections are alternatives, and this is where that is said out loud.
  // `countSearch`, not `search`: the repository's search returns rows and the service's
  // returns a page, and reading `.total` off the wrong one is a check that silently
  // never fires. It did, until TC-INT-85's sibling below caught it.
  if (returnRepository.countSearch({ saleId: sale.id }) > 0) {
    throw errors.conflict(
      `${sale.sale_no} has already had goods returned against it, so it cannot be voided — `
      + 'a void says the sale never happened, and part of it demonstrably did. Correct the '
      + 'rest with a return.',
      { ruleId: 'POS-401' }
    );
  }

  const why = textOrNull(reason);
  if (!why || why.length < REASON_MIN) {
    // POS-401 names the reason alongside the actor and the timestamp. "Voided" with no
    // reason is the row an auditor cannot use, and the column is the one place the
    // cashier's account of the mistake survives.
    throw errors.badRequest(
      'A void needs a reason. Say what went wrong — a mis-scan, a wrong customer, a '
      + 'change of mind at the counter.',
      { ruleId: 'POS-401' }
    );
  }

  const state = windowFor(sale);
  assertWithinWindow(sale, state);
  assertOwnShift(sale, actor, state);

  const authorisation = authorisationFor({ actor, approver });

  const items = saleRepository.itemsFor(sale.id);
  const tenders = saleRepository.tendersFor(sale.id);
  const drawer = drawerEffect(sale, tenders);
  const at = clock.nowUtc();

  const result = db.transaction(() => {
    // ── POS-401, first: every inventory movement reversed ──
    //
    // By compensating movement, never by deletion (INV-102). SALE_VOID is INV-103's
    // declared type for it and its sign is fixed at +, so a reversal cannot itself be
    // mis-signed into a second sale.
    const reversed = [];
    for (const item of items) {
      const movement = inventoryService.post({
        productId: item.product_id,
        type: 'SALE_VOID',
        qtyMilli: item.qty_milli,
        actor,
        reason: `${why} — ${sale.sale_no} voided (POS-401)`,
        referenceType: 'sale_void',
        referenceId: sale.id,
        referenceNo: sale.sale_no,
        occurredAt: at,
      });
      reversed.push({
        product: item.product_name_snapshot,
        qty_milli: item.qty_milli,
        movement_id: movement.movement.id,
        balance_after_milli: movement.movement.balance_after_milli,
      });
    }

    // ── POS-401, second: any credit transaction reversed ──
    //
    // ADJUSTMENT rather than a new type: CR-103's balance derives from this ledger,
    // the type is two-directional by declaration and requires a reason, and inventing
    // a `VOID` type would put a value in the schema's CHECK that means the same as one
    // already there. The row cites the sale, so the pair reads as a pair.
    const creditReversals = [];
    for (const txn of creditRepository.transactionsForSale(sale.id)) {
      if (txn.amount_centavos === 0) continue;

      // CR-203: a collection that has already settled part of this credit sale cannot
      // be unpicked from here. Refusing is the honest answer — the money came in, and
      // making it disappear is exactly what POS-404 exists to prevent.
      if (creditRepository.allocationsForSale(txn.id).length > 0) {
        throw errors.conflict(
          `${sale.sale_no} has already had a payment applied to it, so voiding it would `
          + 'unpick a collection the customer made. Take the goods back as a return instead.',
          { ruleId: 'CR-203' }
        );
      }

      const posted = creditService.post({
        accountId: txn.account_id,
        type: 'ADJUSTMENT',
        amountCentavos: -txn.amount_centavos,
        actor,
        saleId: sale.id,
        shiftId: sale.shift_id,
        reason: `${why} — ${sale.sale_no} voided (POS-401)`,
        occurredAt: at,
      });
      creditReversals.push({
        reversed_txn_id: txn.id,
        txn_id: posted.transaction.id,
        amount_centavos: -txn.amount_centavos,
        balance_after_centavos: posted.balanceCentavos,
      });
    }

    // ── POS-401, third: the status, the actor, the time and the reason ──
    //
    // POS-107 still holds. The sale is not edited; four columns 006_sales.sql put here
    // for this are stamped, in one statement, and nothing else on the row moves.
    const voided = saleRepository.setVoided(sale.id, {
      voidedAt: at, voidedBy: actor.id, reason: why,
    });

    auditService.write({
      actor,
      approver: authorisation.approver,
      action: 'SALE_VOIDED',
      entityType: 'sales',
      entityId: sale.id,
      before: {
        sale_no: sale.sale_no,
        status: sale.status,
        total_centavos: sale.total_centavos,
        tenders: tenders.map((t) => ({ method: t.method, amount_centavos: t.amount_centavos })),
      },
      after: {
        sale_no: sale.sale_no,
        status: 'VOIDED',
        // POS-404, recorded rather than implied: the number is kept, and a reader of
        // this row a year from now should not have to infer that from its absence.
        sale_no_retained: true,
        movements: reversed,
        credit_reversals: creditReversals,
        cash_out_centavos: drawer.cash_out_centavos,
        self_authorised: authorisation.selfAuthorised,
      },
      reason: why,
      shiftId: sale.shift_id,
    });

    // AUD-603's own row, and only where a second person actually authorised it.
    if (authorisation.approver) {
      auditService.recordOverride({
        action: 'OVERRIDE_SALE_VOID',
        actor,
        approver: authorisation.approver,
        reason: why,
        entityType: 'sales',
        entityId: sale.id,
        before: { sale_no: sale.sale_no, total_centavos: sale.total_centavos },
        after: { rule_id: 'POS-403', voided_at: at },
        shiftId: sale.shift_id,
      });
    }

    return { voided, reversed, creditReversals };
  }, { immediate: true });

  // ── Outside the transaction (INT-1, POS-507) ──────────────────────────────
  //
  // The cashier has notes to hand back. A pulse cannot be rolled back, and a stuck
  // drawer must never undo a void the ledger has already accepted.
  const pulse = drawer.cash_out_centavos > 0
    ? drawerService.pulse({
      reason: 'CASH_VOID', shiftId: sale.shift_id, actor, amountCentavos: drawer.cash_out_centavos,
    })
    : null;

  const shiftService = require('./shiftService');

  return {
    ...present(result.voided),
    authorisation: {
      required: authorisation.required,
      self_authorised: authorisation.selfAuthorised,
      authorised_by: authorisation.approver ? authorisation.approver.username : null,
      rule_id: 'POS-403',
    },
    reversal: {
      movements: result.reversed,
      credit: result.creditReversals,
      // Requirement 6, said in the payload: the drawer figure corrected itself the
      // moment the status landed, and no till row was written to do it.
      drawer,
    },
    drawer: pulse,
    expected: shiftRepository.findById(sale.shift_id)
      ? shiftService.computeExpected(sale.shift_id)
      : null,
  };
}

// ── Reading ─────────────────────────────────────────────────────────────────

function present(sale) {
  return {
    sale: {
      id: sale.id,
      sale_no: sale.sale_no,
      status: sale.status,
      shift_id: sale.shift_id,
      total_centavos: sale.total_centavos,
      change_centavos: sale.change_centavos,
      occurred_at: sale.occurred_at,
      occurred_at_manila: clock.toManila(sale.occurred_at),
      voided_at: sale.voided_at,
      voided_at_manila: sale.voided_at ? clock.toManila(sale.voided_at) : null,
      voided_by: sale.voided_by,
      void_reason: sale.void_reason,
      // POS-404, in the payload so a screen states it rather than a reader inferring
      // it from a receipt number that happens not to be missing.
      excluded_from_net: true,
      retained_in_sequence: true,
    },
  };
}

/**
 * Whether this sale could be voided right now, and if not, why not — SCR-304's
 * question before it shows the button.
 *
 * Every reason is the server's. A screen that decided for itself whether a shift was
 * still open would offer the button after a close and explain the refusal afterwards,
 * which is the interface POS-402 is least well served by: the cashier has already told
 * the customer it can be undone.
 */
function eligibility(saleId, actor) {
  const sale = saleRepository.findById(saleId);
  if (!sale) throw errors.notFound('No such sale');

  const state = windowFor(sale);
  const returnedCount = returnRepository.countSearch({ saleId: sale.id });
  const selfAuthorised = permissions.can(actor, 'TX-405');

  let refusal = null;
  if (sale.status === 'VOIDED') {
    refusal = { rule_id: 'POS-404', message: `${sale.sale_no} has already been voided.` };
  } else if (returnedCount > 0) {
    refusal = {
      rule_id: 'POS-401',
      message: `${sale.sale_no} has had goods returned against it. Correct the rest with a return.`,
    };
  } else if (!state.open) {
    refusal = {
      rule_id: 'POS-402',
      message: 'That shift has been closed, so the correction is a return, not a void.',
    };
  } else if (state.shift && state.shift.user_id !== actor.id && !permissions.can(actor, 'TX-419')) {
    refusal = {
      rule_id: 'TX-419',
      message: "That sale belongs to another cashier's shift.",
    };
  }

  return {
    sale_id: sale.id,
    sale_no: sale.sale_no,
    can_void: refusal === null,
    refusal,
    // POS-403: whether the panel will be needed, so it can be shown up front rather
    // than after a refusal the cashier has to read to understand.
    requires_authorisation: true,
    self_authorised: selfAuthorised,
    requires_role: selfAuthorised ? null : AUTHORISING_ROLES.join(' or '),
    shift: {
      id: state.shiftId,
      open: state.open,
      closed_at: state.closedAt,
      window_rule: 'POS-402',
    },
  };
}

/** POS-404's void report, over a range. */
function listFor({ fromAt, toAt, shiftId = null, limit = 500 }) {
  return require('../repositories/reportRepository')
    .voidsInRange({ fromAt, toAt, shiftId, limit })
    .map((row) => ({
      id: row.id,
      sale_no: row.sale_no,
      occurred_at: row.occurred_at,
      occurred_at_manila: clock.toManila(row.occurred_at),
      voided_at: row.voided_at,
      voided_at_manila: row.voided_at ? clock.toManila(row.voided_at) : null,
      shift_id: row.shift_id,
      customer_name: row.customer_name,
      cashier_username: row.cashier_username,
      voided_by: row.voided_by_username,
      approved_by: row.approved_by_username,
      line_count: row.line_count,
      total_centavos: row.total_centavos,
      change_centavos: row.change_centavos,
      reason: row.void_reason,
      // The figure a reader of this report is actually checking: what left the drawer
      // again. The cash tendered, less the change already handed over — never the sale
      // total, which would overstate every void of a mixed-tender sale.
      cash_returned_centavos: Math.max(row.cash_tendered_centavos - row.change_centavos, 0),
    }));
}

module.exports = {
  AUTHORISING_ROLES, REASON_MIN, REASON_MAX,
  authorisationFor, windowFor, assertWithinWindow, assertOwnShift, drawerEffect,
  post, present, eligibility, listFor,
};
