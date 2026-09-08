'use strict';

// FR_2.4–FR_2.6 / INV-101–INV-109 — the movement ledger, and the only writer of it.
//
// INV-101 is the whole design: `inventory.qty_on_hand_milli` is a materialised running
// balance, never an independently written figure. Every change to it goes through
// `post()`, inside the same transaction as the movement that justifies it, so that
// SUM(inventory_movements.qty_milli) equals it at any instant. That equality is
// TC-INT-20, a permanent regression guard, and it is what makes an inventory defect
// diagnosable at all: a discrepancy is visible in the ledger rather than hidden in a
// counter somebody incremented from the wrong place.
//
// There is deliberately **no** method here that sets on-hand without writing a
// movement. If one is ever needed, it is not needed — the answer is a movement with a
// type and a reason.

const db = require('../config/database');
const ids = require('../config/ids');
const clock = require('../config/clock');
const errors = require('./errors');
const money = require('./money');
const quantity = require('./quantity');
const costing = require('./costing');
const auditService = require('./auditService');
const settingsService = require('./settingsService');
const permissions = require('./permissions');
const inventoryRepository = require('../repositories/inventoryRepository');
const productRepository = require('../repositories/productRepository');

/**
 * INV-103 — the twelve types and their fixed signs.
 *
 * `+1` and `-1` mean the sign is fixed and a movement of the wrong sign is a
 * programming error; `0` means the type is genuinely two-directional. Fixing the sign
 * here rather than trusting the caller is what stops a `SALE` from ever *adding*
 * stock, which is the shape a mis-signed quantity takes when it reaches the ledger.
 *
 * legacy/PRD_v1.1.md §19's STOCK_TRANSFER is absent: no location entity exists before
 * v1.3 (02_PRD.md §7), so there is nowhere to transfer between.
 */
const TYPES = Object.freeze({
  OPENING: { sign: +1, what: 'Opening stock', costed: true, requiresReason: false },
  RECEIPT: { sign: +1, what: 'Goods received', costed: true, requiresReason: false },
  SALE: { sign: -1, what: 'Sold', costed: false, requiresReason: false },
  SALE_VOID: { sign: +1, what: 'Sale voided', costed: false, requiresReason: true },
  CUSTOMER_RETURN: { sign: +1, what: 'Customer return', costed: false, requiresReason: true },
  SUPPLIER_RETURN: { sign: -1, what: 'Returned to supplier', costed: false, requiresReason: true },
  ADJUSTMENT: { sign: 0, what: 'Adjustment', costed: true, requiresReason: true },
  DAMAGE: { sign: -1, what: 'Damaged', costed: false, requiresReason: true },
  EXPIRY: { sign: -1, what: 'Expired', costed: false, requiresReason: true },
  INTERNAL_USE: { sign: -1, what: 'Internal use', costed: false, requiresReason: true },
  COUNT_VARIANCE: { sign: 0, what: 'Stock count variance', costed: false, requiresReason: true },
  BREAK_BULK: { sign: 0, what: 'Break bulk', costed: false, requiresReason: false },
});

const TYPE_NAMES = Object.freeze(Object.keys(TYPES));

function assertType(type) {
  if (!Object.prototype.hasOwnProperty.call(TYPES, type)) {
    throw new RangeError(`unknown movement type: ${type} (INV-103)`);
  }
  return type;
}

function describe(type) {
  assertType(type);
  return TYPES[type].what;
}

// ── Posting a movement (INV-101, INV-103, INV-104, INV-106, INV-107) ────────

/**
 * Post one movement and move the balance with it.
 *
 * Called inside the caller's transaction where a document is involved: INV-107 makes
 * a sale, a receipt, a return, an adjustment and a count posting each one transaction
 * spanning the document, its lines, its movements, the on-hand update and any credit
 * or till effect. `post` therefore does **not** open its own — it joins the one the
 * document already opened, and `postStandalone` wraps it for the cases with no
 * document.
 *
 * Returns the movement, the new balance and whether the average cost moved, so a
 * caller can report a negative-stock warning (INV-104) and a test can assert the
 * "average did not move" case as loudly as the other one (INV-106).
 */
function post({
  productId, type, qtyMilli, unitCostCentavos = null,
  actor, reason = null, referenceType = null, referenceId = null, referenceNo = null,
  correctsMovementId = null, occurredAt = null, allowNegative = null,
}) {
  assertType(type);
  const declared = TYPES[type];

  const product = productRepository.findById(productId);
  if (!product) throw errors.notFound('No such product');
  if (!actor || !actor.id) {
    // created_by is NOT NULL and references users(id): a movement is always somebody's.
    throw new TypeError('a movement needs an acting user (INV-103)');
  }

  const qty = normaliseQuantity(type, qtyMilli);
  if (declared.requiresReason && !textOrNull(reason)) {
    throw errors.badRequest(`A ${declared.what.toLowerCase()} movement needs a reason`, { ruleId: 'INV-103' });
  }
  if (unitCostCentavos !== null && unitCostCentavos !== undefined) {
    money.assertCentavos(unitCostCentavos, 'movement unit cost');
  }

  const at = occurredAt || clock.nowUtc();
  const currentQty = inventoryRepository.qtyOnHand(productId);
  const nextQty = currentQty + qty;

  // INV-104 — stock may not go negative unless the setting allows it, in which case the
  // movement is flagged and the caller is warned. The setting is read here rather than
  // passed in, so every path gets the same answer; `allowNegative` is an override for
  // the one caller that has already asked and been authorised.
  const negativePermitted = allowNegative === null
    ? settingsService.get('allow_negative_stock')
    : Boolean(allowNegative);
  const goesNegative = nextQty < 0;

  if (goesNegative && !negativePermitted) {
    throw errors.conflict(
      `Not enough stock. ${product.name} has ${quantity.format(currentQty, product.base_unit_code)} on hand `
      + `and this would take it to ${quantity.format(nextQty, product.base_unit_code)}. `
      + 'Receive stock first, or file an adjustment.',
      { ruleId: 'INV-104' }
    );
  }

  // INV-106 / MON-004, computed by TASK-002's costing service. The average moves on the
  // way in and never on the way out: a sale, a damage write-off or a negative
  // adjustment consumes at the prevailing average. Anything else would let a store
  // change its historical margin by writing stock off.
  const costed = declared.costed ? unitCostCentavos ?? null : null;
  const applied = costing.applyMovement(
    { qtyOnHandMilli: currentQty, avgCostCentavos: product.avg_cost_centavos },
    { type, qtyMilli: qty, unitCostCentavos: costed }
  );

  const movement = inventoryRepository.insertMovement({
    id: ids.uuidv7(),
    product_id: productId,
    movement_type: type,
    qty_milli: qty,
    balance_after_milli: applied.qtyOnHandMilli,
    unit_cost_centavos: costed,
    reference_type: referenceType,
    reference_id: referenceId,
    reference_no: referenceNo,
    reason: textOrNull(reason),
    corrects_movement_id: correctsMovementId,
    is_negative_stock: goesNegative ? 1 : 0,
    occurred_at: at,
    created_by: actor.id,
  });

  inventoryRepository.upsertOnHand({
    productId, qtyOnHandMilli: applied.qtyOnHandMilli, updatedAt: at,
  });

  if (applied.averageChanged) {
    productRepository.updateFields(productId, {
      avg_cost_centavos: applied.avgCostCentavos,
      avg_cost_as_of: at,
    });
  }

  return {
    movement,
    balanceMilli: applied.qtyOnHandMilli,
    averageChanged: applied.averageChanged,
    avgCostCentavos: applied.avgCostCentavos,
    negativeStock: goesNegative,
    warning: goesNegative
      ? `${product.name} is now at ${quantity.format(applied.qtyOnHandMilli, product.base_unit_code)}, `
        + 'below zero. The movement is flagged for review.'
      : null,
  };
}

/** The same post, in its own transaction, for a movement with no source document. */
function postStandalone(input) {
  return db.transaction(() => post(input));
}

/**
 * INV-103's fixed signs, applied to whatever the caller passed.
 *
 * A caller may hand in 500 or −500 for a `SALE`; both mean five hundred out. A
 * two-directional type keeps the sign it was given, and zero is refused everywhere —
 * a movement of nothing is not a record of anything, and it would sit in the ledger
 * looking like a lost quantity.
 */
function normaliseQuantity(type, qtyMilli) {
  const n = typeof qtyMilli === 'number' ? qtyMilli : Number.parseInt(String(qtyMilli ?? '').trim(), 10);
  if (!Number.isInteger(n) || n === 0) {
    throw errors.badRequest(
      'A movement quantity is a whole number of thousandths and may not be zero',
      { ruleId: 'MON-002' }
    );
  }

  const { sign } = TYPES[type];
  if (sign === 0) return n;
  return sign * Math.abs(n);
}

const textOrNull = (value) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
};

// ── Corrections (INV-102) ───────────────────────────────────────────────────

/**
 * Correct a movement by writing its opposite, citing it.
 *
 * INV-102: the ledger is append-only, so a mistake is not edited away — it is left
 * standing with a compensating movement beside it. That is the whole difference
 * between a ledger and a spreadsheet: what actually happened, including the mistake,
 * remains legible afterwards.
 */
function correct(movementId, { actor, reason, occurredAt = null }) {
  const original = inventoryRepository.findMovement(movementId);
  if (!original) throw errors.notFound('No such movement');
  if (!textOrNull(reason)) {
    throw errors.badRequest('A correction needs a reason', { ruleId: 'INV-102' });
  }

  const existing = inventoryRepository.movementsFor(original.product_id, { limit: 1000 })
    .find((m) => m.corrects_movement_id === movementId);
  if (existing) {
    throw errors.conflict(
      'That movement has already been corrected. Correct the correction if it is still wrong.',
      { ruleId: 'INV-102' }
    );
  }

  return db.transaction(() => {
    const result = post({
      productId: original.product_id,
      // ADJUSTMENT is two-directional, so the compensating movement can carry either
      // sign without pretending to be a receipt or a sale that never happened.
      type: 'ADJUSTMENT',
      qtyMilli: -original.qty_milli,
      actor,
      reason,
      referenceType: 'movement_correction',
      referenceId: movementId,
      correctsMovementId: movementId,
      occurredAt,
      // A correction must be postable even where it takes stock negative: refusing to
      // undo a wrong receipt because the stock has since been sold would leave the
      // ledger permanently wrong, which is worse.
      allowNegative: true,
    });

    auditService.write({
      actor,
      action: 'INVENTORY_ADJUSTED',
      entityType: 'inventory_movements',
      entityId: result.movement.id,
      before: { corrected_movement: movementId, original_qty_milli: original.qty_milli },
      after: { qty_milli: result.movement.qty_milli, balance_after_milli: result.balanceMilli },
      reason,
    });

    return result;
  });
}

// ── Adjustments (INV-108) ───────────────────────────────────────────────────

function adjustmentReasons() {
  return settingsService.get('adjustment_reasons');
}

/**
 * INV-108: a reason **from the configured list**, and a blank or free-text-only reason
 * is rejected.
 *
 * The list is a setting (OPS-005), so a store can add its own. Free text is permitted
 * only as a note *alongside* a listed reason — an adjustment justified purely by
 * whatever the operator typed is exactly the audit hole the rule closes, because every
 * such row reads differently and none of them can be counted.
 */
function assertReasonListed(reason) {
  const listed = adjustmentReasons();
  const value = textOrNull(reason);

  if (!value) {
    throw errors.badRequest(
      `An adjustment needs a reason. Choose one of: ${listed.join(', ')}.`,
      { ruleId: 'INV-108' }
    );
  }
  if (!listed.some((entry) => entry.toLowerCase() === value.toLowerCase())) {
    throw errors.badRequest(
      `"${value}" is not one of the configured adjustment reasons. Choose one of: ${listed.join(', ')}.`,
      { ruleId: 'INV-108' }
    );
  }
  return listed.find((entry) => entry.toLowerCase() === value.toLowerCase());
}

/**
 * The value of an adjustment, for the INV-108 authorisation threshold.
 *
 * Measured at average cost and on the absolute quantity: writing off ten sacks and
 * finding ten sacks are the same size of claim about the stockroom, and only one of
 * them is the direction a threshold is usually thought about.
 */
function adjustmentValueCentavos(qtyMilli, avgCostCentavos) {
  return costing.valuation(Math.abs(qtyMilli), avgCostCentavos);
}

/**
 * File an adjustment (FR_2.5's sibling; INV-108, AUD-603).
 *
 * Above the configured value threshold an owner must authorise it, and the row records
 * **both** actors. AUD-603 names six overrides and an adjustment is not among them, so
 * this is not written as one of `auditService.OVERRIDE_ACTIONS` — it is an
 * `INVENTORY_ADJUSTED` row carrying an approver, which is the same two-actor shape
 * without pretending the rule lists a seventh override.
 */
function adjust({
  productId, qtyMilli, reason, notes = null, unitCostCentavos = null,
  actor, approver = null, occurredAt = null,
}, session = actor) {
  if (!permissions.can(session, 'TX-407')) {
    throw errors.forbidden(
      'You do not have permission to post an inventory adjustment.',
      { ruleId: 'TX-407', requiresRole: permissions.rolesHolding('TX-407').join(' or ') }
    );
  }

  const product = productRepository.findById(productId);
  if (!product) throw errors.notFound('No such product');

  const listedReason = assertReasonListed(reason);
  const qty = normaliseQuantity('ADJUSTMENT', qtyMilli);
  const value = adjustmentValueCentavos(qty, product.avg_cost_centavos);
  const threshold = settingsService.get('adjustment_authorisation_centavos');
  const needsOwner = value > threshold;

  // An owner filing it themselves already *is* the authorisation INV-108 asks for.
  // Demanding a second, distinct owner would make a large adjustment impossible in a
  // one-owner store, which is most of them — and the rule asks for owner authority,
  // not for two people. AUD-603's "distinct actors" governs an override one user
  // requests and another grants; it does not apply when there is only one user in it.
  const selfAuthorised = needsOwner && session && session.role === 'OWNER';

  if (needsOwner && !selfAuthorised) {
    if (!approver || !approver.username) {
      throw errors.forbidden(
        `This adjustment is worth ${money.toDisplay(value)}, above the ${money.toDisplay(threshold)} `
        + 'limit, so an owner must authorise it.',
        { ruleId: 'INV-108', requiresRole: 'OWNER' }
      );
    }
    if (approver.role !== 'OWNER') {
      throw errors.forbidden('Only an owner may authorise an adjustment of this value.', {
        ruleId: 'INV-108', requiresRole: 'OWNER',
      });
    }
    if (approver.id && actor.id && approver.id === actor.id) {
      // AUD-603's "distinct actors": an authorisation somebody gave themselves while
      // claiming to be a second party records nothing.
      throw errors.forbidden('An adjustment must be authorised by a different user.', { ruleId: 'AUD-603' });
    }
  }

  const recordedApprover = needsOwner && !selfAuthorised ? approver : null;

  const note = textOrNull(notes);
  const fullReason = note ? `${listedReason} — ${note}` : listedReason;

  return db.transaction(() => {
    const result = post({
      productId,
      type: 'ADJUSTMENT',
      qtyMilli: qty,
      unitCostCentavos,
      actor,
      reason: fullReason,
      referenceType: 'adjustment',
      occurredAt,
      // An adjustment is how a store corrects a wrong figure, including one that is
      // wrong in the direction that makes on-hand negative. It is flagged, not refused.
      allowNegative: true,
    });

    auditService.write({
      actor,
      approver: recordedApprover,
      action: 'INVENTORY_ADJUSTED',
      entityType: 'products',
      entityId: productId,
      before: { qty_on_hand_milli: result.balanceMilli - qty },
      after: {
        qty_on_hand_milli: result.balanceMilli,
        qty_milli: qty,
        value_centavos: value,
        movement_id: result.movement.id,
        authorisation_required: needsOwner,
        // Recorded explicitly so the trail distinguishes "an owner did this himself"
        // from "no authorisation was needed" — they read the same otherwise.
        self_authorised: selfAuthorised,
      },
      reason: fullReason,
    });

    return {
      ...result,
      valueCentavos: value,
      authorisationRequired: needsOwner,
      authorisedBy: needsOwner ? (selfAuthorised ? actor.username : approver.username) : null,
      selfAuthorised,
    };
  });
}

// ── Reading ─────────────────────────────────────────────────────────────────

function onHand(productId) {
  const product = productRepository.findById(productId);
  if (!product) throw errors.notFound('No such product');
  const row = inventoryRepository.findOnHand(productId);
  const qty = row ? row.qty_on_hand_milli : 0;

  return {
    product_id: productId,
    sku: product.sku,
    name: product.name,
    qty_on_hand_milli: qty,
    qty_on_hand_display: quantity.format(qty, product.base_unit_code),
    base_unit_code: product.base_unit_code,
    min_stock_milli: product.min_stock_milli,
    // INV-109 at read time, for one product.
    is_low_stock: Boolean(product.is_active) && product.min_stock_milli > 0 && qty <= product.min_stock_milli,
    has_moved: Boolean(row),
    updated_at: row ? row.updated_at : null,
  };
}

/** Requirement 8 — date, type, quantity, reference and running balance. */
function ledger(productId, { limit = 100, offset = 0, from = null, to = null, type = null } = {}) {
  const product = productRepository.findById(productId);
  if (!product) throw errors.notFound('No such product');
  if (type !== null && type !== undefined) assertType(type);

  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
  const skip = Math.max(Number.parseInt(offset, 10) || 0, 0);
  const filters = { from, to, type: type || null };

  return {
    product: {
      id: product.id, sku: product.sku, name: product.name, base_unit_code: product.base_unit_code,
    },
    on_hand: onHand(productId),
    total: inventoryRepository.countMovementsFor(productId, filters),
    limit: size,
    offset: skip,
    movements: inventoryRepository.movementsFor(productId, { ...filters, limit: size, offset: skip })
      .map((row) => presentMovement(row, product)),
  };
}

function presentMovement(row, product) {
  return {
    id: row.id,
    occurred_at: row.occurred_at,
    occurred_at_manila: clock.toManila(row.occurred_at),
    type: row.movement_type,
    type_label: describe(row.movement_type),
    qty_milli: row.qty_milli,
    qty_display: quantity.format(row.qty_milli, product.base_unit_code),
    balance_after_milli: row.balance_after_milli,
    balance_after_display: quantity.format(row.balance_after_milli, product.base_unit_code),
    unit_cost_centavos: row.unit_cost_centavos,
    reference: row.reference_type
      ? { type: row.reference_type, id: row.reference_id, no: row.reference_no }
      : null,
    reason: row.reason,
    corrects_movement_id: row.corrects_movement_id,
    corrected_by_id: row.corrected_by_id || null,
    is_negative_stock: Boolean(row.is_negative_stock),
    created_by: row.created_by_username || row.created_by,
  };
}

/** INV-109, the list (FR_2.6). Computed at read time, every time. */
function lowStock({ limit = 200, offset = 0 } = {}) {
  const rows = inventoryRepository.lowStock({ limit, offset });
  return {
    total: inventoryRepository.countLowStock(),
    products: rows.map((row) => ({
      product_id: row.product_id,
      sku: row.sku,
      name: row.name,
      category_name: row.category_name,
      qty_on_hand_milli: row.qty_on_hand_milli,
      qty_on_hand_display: quantity.format(row.qty_on_hand_milli, row.base_unit_code),
      min_stock_milli: row.min_stock_milli,
      min_stock_display: quantity.format(row.min_stock_milli, row.base_unit_code),
      shortfall_milli: row.min_stock_milli - row.qty_on_hand_milli,
      base_unit_code: row.base_unit_code,
      is_out_of_stock: row.qty_on_hand_milli <= 0,
    })),
  };
}

/** RPT-103, computed at read time with its as-of timestamp. */
function valuation() {
  const at = clock.nowUtc();
  const rows = inventoryRepository.valuationRows();
  let total = 0;

  const products = rows.map((row) => {
    const value = costing.valuation(row.qty_on_hand_milli, row.avg_cost_centavos);
    total += value;
    return {
      product_id: row.product_id,
      sku: row.sku,
      name: row.name,
      is_active: Boolean(row.is_active),
      qty_on_hand_milli: row.qty_on_hand_milli,
      qty_on_hand_display: quantity.format(row.qty_on_hand_milli, row.base_unit_code),
      avg_cost_centavos: row.avg_cost_centavos,
      value_centavos: value,
    };
  });

  return { as_of: at, total_value_centavos: total, products };
}

/**
 * The INV-101 invariant, as a callable check.
 *
 * TC-INT-20 runs this after the trading day, and OPS-006's health panel can too: an
 * inventory defect should be findable by asking, not by noticing.
 */
function reconcile() {
  const breaks = inventoryRepository.reconciliationBreaks();
  return { ok: breaks.length === 0, breaks };
}

module.exports = {
  TYPES, TYPE_NAMES, assertType, describe,
  post, postStandalone, correct, adjust,
  adjustmentReasons, assertReasonListed, adjustmentValueCentavos, normaliseQuantity,
  onHand, ledger, lowStock, valuation, reconcile, presentMovement,
};
