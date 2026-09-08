'use strict';

// POS-105, POS-106 — the in-progress cart and the parked ones.
//
// POS-105: an in-progress cart survives an idle logout and an application restart, and
// is recoverable by the **same user on the same shift**. Both halves of that ownership
// matter — a cart is a customer standing at a counter, and handing it to whoever logs
// in next is how the wrong person's sale gets completed.
//
// POS-106: a cart may be parked so a customer fetching another item does not block the
// counter, and parked carts expire at shift close. Expire, not carry over: a cart from
// yesterday priced at yesterday's prices, against a drawer that has been counted, is
// not something anyone should be able to complete this morning.
//
// Prices are never stored on a cart. The lines are products and quantities; every
// price is re-resolved on read and again at the sale (§4.1 step 2), so a cart parked
// before a price change resumes at the price in force when it is sold.

const db = require('../config/database');
const ids = require('../config/ids');
const clock = require('../config/clock');
const errors = require('./errors');
const shiftService = require('./shiftService');
const pricingService = require('./pricingService');
const storeProfileService = require('./storeProfileService');
const cartRepository = require('../repositories/cartRepository');
const customerRepository = require('../repositories/customerRepository');

const MAX_LINES = 200;

const textOrNull = (value) => {
  const trimmed = typeof value === 'string' ? value.trim().slice(0, 60) : '';
  return trimmed || null;
};

/**
 * A cart's lines, validated into the shape the sale endpoint takes.
 *
 * Deliberately the same shape as `POST /sales` expects: the cart is a draft of that
 * request and nothing else, so resuming one and completing it is one hand-off rather
 * than a translation that could drop a field.
 */
function normaliseLines(lines) {
  if (!Array.isArray(lines)) throw errors.badRequest('A cart is a list of lines', { ruleId: 'POS-101' });
  if (lines.length > MAX_LINES) {
    throw errors.badRequest(`A cart holds at most ${MAX_LINES} lines`, { ruleId: 'POS-101' });
  }

  return lines.map((line, index) => {
    const qty = typeof line.qtyMilli === 'number'
      ? line.qtyMilli
      : Number.parseInt(String(line.qtyMilli ?? '').trim(), 10);

    if (!line.productId) throw errors.badRequest(`Line ${index + 1} has no product`, { ruleId: 'POS-101' });
    if (!Number.isInteger(qty) || qty <= 0) {
      throw errors.badRequest(`Line ${index + 1} needs a positive quantity`, { ruleId: 'POS-101' });
    }

    return {
      productId: line.productId,
      qtyMilli: qty,
      packUnitId: line.packUnitId || null,
      discountCentavos: Number.isInteger(line.discountCentavos) ? line.discountCentavos : 0,
    };
  });
}

// ── The active cart (POS-105) ───────────────────────────────────────────────

/**
 * Save the cart in progress.
 *
 * Called by the renderer after every change, which is what makes an idle logout and a
 * power cut equivalent: neither loses anything the cashier had keyed. It replaces
 * rather than appends — the cart is one row, not a log of edits.
 */
function save({ lines = [], customerId = null, transactionDiscountCentavos = 0 }, actor) {
  const shift = shiftService.requireOpenShift(actor, { action: 'build a cart' });
  const normalised = normaliseLines(lines);
  const at = clock.nowUtc();

  if (customerId && !customerRepository.findById(customerId)) {
    throw errors.notFound('No such customer');
  }

  return db.transaction(() => {
    const existing = cartRepository.findActive(actor.id, shift.id);
    const payload = JSON.stringify({
      lines: normalised,
      transactionDiscountCentavos: Number.isInteger(transactionDiscountCentavos) ? transactionDiscountCentavos : 0,
    });

    // An empty cart is not saved — it is cleared. A row saying "this cashier has a
    // cart with nothing in it" would restore an empty screen and look like a bug.
    if (normalised.length === 0) {
      if (existing) cartRepository.remove(existing.id);
      return { cart: null, saved: false };
    }

    const row = existing
      ? cartRepository.update(existing.id, {
        customer_id: customerId, payload, line_count: normalised.length, updated_at: at,
      })
      : cartRepository.insert({
        id: ids.uuidv7(),
        user_id: actor.id,
        shift_id: shift.id,
        customer_id: customerId,
        status: 'ACTIVE',
        label: null,
        payload,
        line_count: normalised.length,
        parked_at: null,
        resumed_at: null,
        expired_at: null,
        created_at: at,
        updated_at: at,
      });

    return { cart: present(row), saved: true };
  });
}

/**
 * The cart to restore on load — POS-105's whole point.
 *
 * Returns null rather than an empty cart when there is nothing, so the screen can show
 * "Scan an item to begin" instead of an empty populated state (04_UX_SPEC.md §5).
 */
function active(actor) {
  const shift = shiftService.openShiftFor(actor.id);
  if (!shift) return null;
  const row = cartRepository.findActive(actor.id, shift.id);
  return row ? present(row) : null;
}

function clear(actor) {
  const shift = shiftService.openShiftFor(actor.id);
  if (!shift) return { cleared: false };
  const row = cartRepository.findActive(actor.id, shift.id);
  if (!row) return { cleared: false };

  cartRepository.remove(row.id);
  return { cleared: true };
}

/** The sale completed, so the draft is gone. Called by the POS after POST /sales. */
function complete(actor) {
  return clear(actor);
}

// ── Parking (POS-106) ───────────────────────────────────────────────────────

/**
 * Park the cart in progress and hand back an empty counter.
 *
 * F6 in the keyboard map, and F12 is this plus starting a new one — which is the same
 * operation, because the cart in progress is always cleared by parking it.
 */
function park({ label = null } = {}, actor) {
  const shift = shiftService.requireOpenShift(actor, { action: 'park a cart' });
  const at = clock.nowUtc();

  return db.transaction(() => {
    const row = cartRepository.findActive(actor.id, shift.id);
    if (!row) {
      throw errors.badRequest('There is nothing in the cart to park.', { ruleId: 'POS-106' });
    }

    const parked = cartRepository.update(row.id, {
      status: 'PARKED',
      label: textOrNull(label) || defaultLabel(row, at),
      parked_at: at,
      updated_at: at,
    });
    return { cart: present(parked) };
  });
}

/** Something a cashier can recognise across the counter, when they name nothing. */
function defaultLabel(row, at) {
  return `${row.line_count} line${row.line_count === 1 ? '' : 's'} · ${clock.toManila(at).split(', ')[1] || ''}`.trim();
}

function parked(actor) {
  const shift = shiftService.openShiftFor(actor.id);
  if (!shift) return { carts: [] };

  // Parked carts belong to the shift, not only to the user: a cashier going to lunch
  // mid-transaction is exactly why POS-106 exists, and the colleague taking over is on
  // the same shift's counter.
  return {
    carts: cartRepository.parkedForShift(shift.id).map(present),
  };
}

/**
 * Resume a parked cart, parking whatever is in progress first.
 *
 * F7. The swap is deliberate: a cashier who has half-built a second cart and then
 * retrieves the first should not lose the second, and losing it silently is worse
 * than any confusion the extra parked cart causes.
 */
function resume(cartId, actor) {
  const shift = shiftService.requireOpenShift(actor, { action: 'resume a cart' });
  const at = clock.nowUtc();

  return db.transaction(() => {
    const row = cartRepository.findById(cartId);
    if (!row || row.status !== 'PARKED') throw errors.notFound('No such parked cart');
    if (row.shift_id !== shift.id) {
      // POS-106: parked carts expire at shift close, so one from another shift is not
      // resumable — its prices, its stock and its drawer all belong to a closed day.
      throw errors.conflict(
        'That cart was parked on another shift and can no longer be resumed.',
        { ruleId: 'POS-106' }
      );
    }

    const inProgress = cartRepository.findActive(actor.id, shift.id);
    let displaced = null;
    if (inProgress) {
      displaced = present(cartRepository.update(inProgress.id, {
        status: 'PARKED',
        label: defaultLabel(inProgress, at),
        parked_at: at,
        updated_at: at,
      }));
    }

    const resumed = cartRepository.update(cartId, {
      status: 'ACTIVE', resumed_at: at, parked_at: null, updated_at: at,
    });
    return { cart: present(resumed), displaced };
  });
}

/**
 * POS-106 — parked carts expire at shift close.
 *
 * Called by the close, inside its transaction. Expired rather than deleted: a cashier
 * asking "where did my parked cart go" deserves an answer, and the row is the answer.
 */
function expireForShift(shiftId, { at = clock.nowUtc() } = {}) {
  return cartRepository.expireForShift(shiftId, at);
}

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * A cart with its prices resolved **now**.
 *
 * Never from what was stored: a cart parked yesterday shows this morning's prices,
 * because that is what it would sell at. The figures are the cashier's display copy
 * and are recomputed by the server at the sale regardless (§4.1).
 */
function present(row) {
  const payload = JSON.parse(row.payload);
  const customer = row.customer_id ? customerRepository.findById(row.customer_id) : null;

  let priced = null;
  try {
    priced = pricingService.priceCart({
      lines: payload.lines,
      customer,
      taxMode: storeProfileService.taxMode(),
      actorRole: null,
      transactionDiscountCentavos: payload.transactionDiscountCentavos || 0,
    });
  } catch {
    // A product withdrawn or de-priced since the cart was parked (INV-105, PR-102).
    // The cart is still returned so the cashier can see and fix it — dropping it would
    // be the silent no-op FR_3.1 forbids elsewhere for the same reason.
    priced = null;
  }

  return {
    id: row.id,
    status: row.status,
    label: row.label,
    line_count: row.line_count,
    customer: customer ? { id: customer.id, name: customer.name, price_level: customer.price_level } : null,
    lines: payload.lines,
    transaction_discount_centavos: payload.transactionDiscountCentavos || 0,
    priced,
    unpriceable: priced === null,
    parked_at: row.parked_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

module.exports = {
  MAX_LINES, normaliseLines,
  save, active, clear, complete, park, parked, resume, expireForShift, present,
};
