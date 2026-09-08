'use strict';

// FR_5.1, FR_5.2 / POS-501–POS-509 — the shift, the till and the expected figure.
//
// POS-501 — "no shift, no money" — is what makes the closing report possible at all.
// Every movement of money belongs to a shift, so that at close there is one expected
// figure per payment method to check the drawer against.
//
// POS-509 is the rule the whole closing report rests on:
//
//     expected cash = opening float
//                   + cash sales
//                   + cash collections
//                   + cash in
//                   − cash out
//                   − cash refunds
//
// It is implemented as a pure read (the task's own constraint), so the POS screen can
// call it on every change without a write ever happening as a side effect of looking.

const db = require('../config/database');
const ids = require('../config/ids');
const clock = require('../config/clock');
const errors = require('./errors');
const money = require('./money');
const auditService = require('./auditService');
const settingsService = require('./settingsService');
const drawerService = require('./drawerService');
const shiftRepository = require('../repositories/shiftRepository');

/** POS-201's tender types, which are also the methods a closing counts per (POS-510). */
const METHODS = Object.freeze(['CASH', 'GCASH', 'QRPH', 'CREDIT']);

/** The methods that put money in the drawer. CREDIT puts none — it creates a debt. */
const CASH_METHODS = Object.freeze(['CASH']);

const textOrNull = (value) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
};

// ── POS-502, POS-503 — opening ──────────────────────────────────────────────

/**
 * Open a shift, or resume the user's existing one.
 *
 * POS-502: one open shift per user, and **a second open attempt resumes the existing
 * shift**. Not an error — a cashier who reopens the app mid-morning is not making a
 * mistake, and refusing them would teach the counter that the shift screen is
 * something to work around.
 *
 * POS-503: the opening float is counted and confirmed by the opening user. The
 * confirmation is required on the server, not just by a checkbox, because an
 * unconfirmed float is a number nobody counted and the variance at close is measured
 * against it.
 */
function open({ actor, openingFloatCentavos, confirmed = false }) {
  if (!actor || !actor.id) throw new TypeError('a shift needs an acting user (POS-502)');

  const existing = shiftRepository.findOpenForUser(actor.id);
  if (existing) {
    return { shift: present(existing), resumed: true };
  }

  const float = normaliseAmount(openingFloatCentavos, 'The opening float');
  if (confirmed !== true) {
    throw errors.badRequest(
      'Count the opening float and confirm it. The variance at close is measured against '
      + 'this figure, so an unconfirmed one makes the close meaningless.',
      { ruleId: 'POS-503' }
    );
  }

  const at = clock.nowUtc();
  return db.transaction(() => {
    const shift = shiftRepository.insert({
      id: ids.uuidv7(),
      user_id: actor.id,
      opened_at: at,
      opening_float_centavos: float,
      status: 'OPEN',
    });

    auditService.write({
      actor,
      action: 'SHIFT_OPENED',
      entityType: 'cashier_shifts',
      entityId: shift.id,
      after: { opening_float_centavos: float },
      shiftId: shift.id,
    });

    return { shift: present(shift), resumed: false };
  });
}

function normaliseAmount(value, what) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isInteger(n) || n < 0) {
    throw errors.badRequest(`${what} is a whole number of centavos, zero or more`, { ruleId: 'MON-001' });
  }
  return n;
}

// ── POS-501 — the guard ─────────────────────────────────────────────────────

/**
 * "No shift, no money."
 *
 * A user may not complete a sale, take a collection, or move till cash without an open
 * shift **belonging to them**. Ownership is the half that is easy to drop: borrowing a
 * colleague's open shift is exactly how a drawer ends up short with nobody's name on it.
 *
 * Returns the shift, so a caller that needs it does not have to look it up twice.
 */
function requireOpenShift(actor, { action = 'do this' } = {}) {
  if (!actor || !actor.id) throw new TypeError('POS-501 needs an acting user');

  const shift = shiftRepository.findOpenForUser(actor.id);
  if (!shift) {
    throw errors.conflict(
      `Open your shift before you ${action}. Count the drawer and enter the opening float.`,
      { ruleId: 'POS-501' }
    );
  }
  return shift;
}

/** The same question without the refusal, for a screen deciding what to render. */
function openShiftFor(userId) {
  return shiftRepository.findOpenForUser(userId);
}

// ── POS-504–POS-507 — till movements ────────────────────────────────────────

function tillReasons() {
  return settingsService.get('till_reasons');
}

/**
 * POS-504 — a reason **from the configured list**, as INV-108 requires of adjustments
 * and for the same reason: a free-text-only justification produces rows that all read
 * differently and none of which can be counted.
 */
function assertReasonListed(reason) {
  const listed = tillReasons();
  const value = textOrNull(reason);

  if (!value) {
    throw errors.badRequest(
      `Till cash needs a reason. Choose one of: ${listed.join(', ')}.`,
      { ruleId: 'POS-504' }
    );
  }
  const match = listed.find((entry) => entry.toLowerCase() === value.toLowerCase());
  if (!match) {
    throw errors.badRequest(
      `"${value}" is not one of the configured till reasons. Choose one of: ${listed.join(', ')}.`,
      { ruleId: 'POS-504' }
    );
  }
  return match;
}

/**
 * Move cash in or out of the drawer.
 *
 * POS-506: a till movement is **never a sale**. It touches no inventory, no revenue and
 * no customer ledger — this function writes one row in one table and pulses the drawer,
 * and TC-INT-52's sibling asserts the absence rather than trusting it.
 *
 * POS-505: cash out may not exceed the expected cash currently in the drawer. Checked
 * against the computed figure rather than a running column, so it is the same
 * arithmetic the close will use.
 */
function moveTillCash({ shiftId, direction, amountCentavos, reason, notes = null, actor }) {
  if (!['IN', 'OUT'].includes(direction)) {
    throw errors.badRequest('A till movement is IN or OUT', { ruleId: 'POS-504' });
  }
  if (!actor || !actor.id) throw new TypeError('a till movement needs an acting user (POS-504)');

  const shift = shiftRepository.findById(shiftId);
  if (!shift) throw errors.notFound('No such shift');
  if (shift.status !== 'OPEN') {
    // POS-511: a closed shift is immutable. Nothing may be back-dated into it.
    throw errors.conflict('That shift is closed. Corrections belong to the next shift.', { ruleId: 'POS-511' });
  }
  if (shift.user_id !== actor.id) {
    throw errors.forbidden(
      "That is another user's shift. Move cash on your own.",
      { ruleId: 'POS-501' }
    );
  }

  const amount = normaliseAmount(amountCentavos, 'A till amount');
  if (amount === 0) {
    throw errors.badRequest('A till movement of nothing is not a movement', { ruleId: 'POS-504' });
  }
  const listedReason = assertReasonListed(reason);

  if (direction === 'OUT') {
    const expected = computeExpected(shiftId);
    if (amount > expected.expected_cash_centavos) {
      throw errors.conflict(
        `There is ${money.toDisplay(expected.expected_cash_centavos)} in the drawer and this would `
        + `take out ${money.toDisplay(amount)}. Cash out cannot exceed what is there.`,
        { ruleId: 'POS-505' }
      );
    }
  }

  const at = clock.nowUtc();
  const note = textOrNull(notes);

  const result = db.transaction(() => {
    const movement = shiftRepository.insertTillMovement({
      id: ids.uuidv7(),
      shift_id: shiftId,
      direction,
      amount_centavos: amount,
      reason: listedReason,
      notes: note,
      occurred_at: at,
      created_by: actor.id,
    });

    auditService.write({
      actor,
      action: 'TILL_CASH_MOVED',
      entityType: 'till_movements',
      entityId: movement.id,
      after: { direction, amount_centavos: amount, reason: listedReason, notes: note },
      reason: listedReason,
      shiftId,
    });

    return movement;
  });

  // POS-507 — the drawer is pulsed on any till movement. Outside the transaction: the
  // drawer is hardware, a pulse cannot be rolled back, and a stuck drawer must not
  // undo a recorded movement.
  const drawer = drawerService.pulse({
    reason: 'TILL_MOVEMENT', shiftId, actor, amountCentavos: amount,
  });

  return { movement: result, drawer, expected: computeExpected(shiftId) };
}

// ── POS-509 — expected cash ─────────────────────────────────────────────────

/**
 * The figure the close is measured against, computed from its parts every time.
 *
 * A pure read: it writes nothing, so the POS screen can call it after every till
 * movement without a side effect. That is the task's own constraint and it is also why
 * POS-505's ceiling above uses this rather than a stored running total — one
 * arithmetic, used by the guard and by the close, cannot disagree with itself.
 *
 * The non-cash methods are reported beside cash because POS-510 closes per method: a
 * shift's GCash total is as much a thing to check as its cash, even though no GCash
 * ever entered the drawer.
 */
function computeExpected(shiftId) {
  const shift = shiftRepository.findById(shiftId);
  if (!shift) throw errors.notFound('No such shift');

  const till = shiftRepository.tillTotals(shiftId);
  const tenders = shiftRepository.tenderTotalsByMethod(shiftId);
  const collections = shiftRepository.collectionTotalsByMethod(shiftId);
  const refunds = shiftRepository.refundTotalCentavos(shiftId);
  const change = shiftRepository.changeGivenCentavos(shiftId);

  const cashSales = tenders.CASH || 0;
  const cashCollections = collections.CASH || 0;

  // POS-509, term by term and in its own order.
  const expected = shift.opening_float_centavos
    + cashSales
    + cashCollections
    + till.cashInCentavos
    - till.cashOutCentavos
    - refunds
    // MON-007: change is cash out of the drawer. POS-509 does not list it because
    // "cash sales" there means the cash actually taken; tenders record what was
    // handed over, so the change handed back is subtracted here to reach the same
    // figure. Reported as its own line so the arithmetic stays checkable.
    - change;

  const byMethod = {};
  for (const method of METHODS) {
    const fromSales = tenders[method] || 0;
    const fromCollections = collections[method] || 0;
    byMethod[method] = {
      method,
      sales_centavos: fromSales,
      collections_centavos: fromCollections,
      expected_centavos: fromSales + fromCollections,
      // CREDIT is a tender that takes no money: it creates a debt, and a closing that
      // expected cash for it would be short by the day's credit sales.
      in_drawer: CASH_METHODS.includes(method),
    };
  }

  return {
    shift_id: shiftId,
    user_id: shift.user_id,
    status: shift.status,
    opened_at: shift.opened_at,
    opening_float_centavos: shift.opening_float_centavos,
    cash_sales_centavos: cashSales,
    cash_collections_centavos: cashCollections,
    cash_in_centavos: till.cashInCentavos,
    cash_out_centavos: till.cashOutCentavos,
    cash_refunds_centavos: refunds,
    change_given_centavos: change,
    expected_cash_centavos: expected,
    by_method: byMethod,
    computed_at: clock.nowUtc(),
  };
}

// ── POS-508 — the long-open shift ───────────────────────────────────────────

/**
 * A shift left open past the configured maximum raises an alert (OPS-007).
 *
 * It is **not** auto-closed, and that is the decision legacy/PRD_v1.1.md §62 never
 * made. Auto-closing invents a count nobody made: the variance would be measured
 * against a drawer no person ever counted, and the resulting figure would look exactly
 * like a real one.
 */
function staleShifts({ now = clock.nowUtc() } = {}) {
  const maxHours = settingsService.get('shift_max_open_hours');
  const cutoff = Date.parse(now) - maxHours * 3600000;

  return shiftRepository.openShifts()
    .filter((shift) => Date.parse(shift.opened_at) < cutoff)
    .map((shift) => ({
      shift_id: shift.id,
      user_id: shift.user_id,
      username: shift.username,
      opened_at: shift.opened_at,
      open_for_hours: Math.floor((Date.parse(now) - Date.parse(shift.opened_at)) / 3600000),
      max_hours: maxHours,
      rule_id: 'POS-508',
      message: `${shift.full_name || shift.username} has had a shift open since `
        + `${clock.toManila(shift.opened_at)}, longer than the ${maxHours}-hour maximum. `
        + 'Close it with a count; it is not closed automatically.',
    }));
}

/** OPS-007's alert list, as far as this task owns it. */
function alerts({ now = clock.nowUtc() } = {}) {
  return staleShifts({ now }).map((stale) => ({
    kind: 'SHIFT_OPEN_TOO_LONG',
    severity: 'WARNING',
    rule_id: 'POS-508',
    message: stale.message,
    shift_id: stale.shift_id,
  }));
}

// ── Reading ─────────────────────────────────────────────────────────────────

function present(shift) {
  return {
    id: shift.id,
    user_id: shift.user_id,
    opened_at: shift.opened_at,
    opened_at_manila: clock.toManila(shift.opened_at),
    opening_float_centavos: shift.opening_float_centavos,
    closed_at: shift.closed_at,
    status: shift.status,
  };
}

function get(shiftId) {
  const shift = shiftRepository.findById(shiftId);
  if (!shift) throw errors.notFound('No such shift');

  return {
    shift: present(shift),
    expected: computeExpected(shiftId),
    till_movements: shiftRepository.tillMovementsFor(shiftId).map((row) => ({
      id: row.id,
      direction: row.direction,
      amount_centavos: row.amount_centavos,
      reason: row.reason,
      notes: row.notes,
      occurred_at: row.occurred_at,
      occurred_at_manila: clock.toManila(row.occurred_at),
      created_by: row.created_by_username || row.created_by,
    })),
  };
}

module.exports = {
  METHODS, CASH_METHODS,
  open, requireOpenShift, openShiftFor,
  tillReasons, assertReasonListed, moveTillCash,
  computeExpected, staleShifts, alerts,
  present, get,
};
