'use strict';

// MON-004: costing for v1.0–v1.1 is moving weighted average, recomputed on every stock
// increase and held as products.avg_cost_centavos. Batch/FEFO costing replaces it in
// v1.2 for batch-tracked products only (legacy/README.md contradiction 2).
//
// INV-106 is the half people get wrong: average cost moves on the way in and never on
// the way out. A sale, a damage write-off or a negative adjustment consumes at the
// prevailing average and leaves it alone. Anything else would let a store change its
// historical margin by writing off stock.

const money = require('./money');
const quantity = require('./quantity');

// INV-103 movement types. Only these three can move the average, and only when a cost
// is supplied with them (INV-106).
const COST_BEARING_TYPES = Object.freeze(['RECEIPT', 'OPENING', 'ADJUSTMENT']);

const ALL_TYPES = Object.freeze([
  'RECEIPT', 'SALE', 'SALE_VOID', 'CUSTOMER_RETURN', 'SUPPLIER_RETURN', 'ADJUSTMENT',
  'DAMAGE', 'EXPIRY', 'INTERNAL_USE', 'COUNT_VARIANCE', 'BREAK_BULK', 'OPENING',
]);

/**
 * MON-004: (existing_value + received_value) / (existing_qty + received_qty).
 *
 * Values are computed in BigInt as qty_milli × cost_centavos, so the thousandths
 * cancel against the quantity denominator and the result is centavos per base unit,
 * rounded half-up exactly once.
 */
function computeMovingAverage(existingQtyMilli, existingCostCentavos, receivedQtyMilli, receivedCostCentavos) {
  quantity.assertMilli(existingQtyMilli, 'existing quantity');
  quantity.assertMilli(receivedQtyMilli, 'received quantity');
  money.assertCentavos(existingCostCentavos, 'existing average cost');
  money.assertCentavos(receivedCostCentavos, 'received unit cost');

  if (receivedQtyMilli <= 0) {
    throw new RangeError('a moving average is recomputed on a stock increase (INV-106)');
  }

  const totalQty = BigInt(existingQtyMilli) + BigInt(receivedQtyMilli);
  if (totalQty <= 0n) {
    // Receiving into a short position that stays short. There is no meaningful average
    // over a non-positive quantity, so the prevailing one stands until stock is
    // positive again. Reachable only with allow_negative_stock on (INV-104).
    return existingCostCentavos;
  }

  const existingValue = BigInt(existingQtyMilli) * BigInt(existingCostCentavos);
  const receivedValue = BigInt(receivedQtyMilli) * BigInt(receivedCostCentavos);
  return money.toSafeNumber(
    money.divRoundHalfUp(existingValue + receivedValue, totalQty),
    'average cost'
  );
}

/**
 * INV-106 as a decision, applied to one movement.
 *
 * Returns the new { qtyOnHandMilli, avgCostCentavos } and says whether the average
 * moved, so a caller — and a test — can assert the "did not move" case as loudly as
 * the other one.
 *
 * This computes; it does not write. The ledger, the on-hand update and the transaction
 * that binds them belong to TASK-007 (INV-101, INV-107).
 */
function applyMovement(current, movement) {
  const { qtyOnHandMilli, avgCostCentavos } = current;
  const { type, qtyMilli, unitCostCentavos = null } = movement;

  quantity.assertMilli(qtyOnHandMilli, 'quantity on hand');
  quantity.assertMilli(qtyMilli, 'movement quantity');
  money.assertCentavos(avgCostCentavos, 'average cost');
  if (!ALL_TYPES.includes(type)) throw new RangeError(`unknown movement type: ${type} (INV-103)`);
  if (unitCostCentavos !== null) money.assertCentavos(unitCostCentavos, 'movement unit cost');

  const nextQty = qtyOnHandMilli + qtyMilli;

  // The average moves only on an increase, of a cost-bearing type, carrying a cost.
  const movesAverage =
    qtyMilli > 0 && COST_BEARING_TYPES.includes(type) && unitCostCentavos !== null;

  if (!movesAverage) {
    return { qtyOnHandMilli: nextQty, avgCostCentavos, averageChanged: false };
  }

  return {
    qtyOnHandMilli: nextQty,
    avgCostCentavos: computeMovingAverage(qtyOnHandMilli, avgCostCentavos, qtyMilli, unitCostCentavos),
    averageChanged: true,
  };
}

/**
 * RPT-103: valuation is qty_on_hand_milli × avg_cost_centavos in the base unit,
 * computed at read time.
 */
function valuation(qtyOnHandMilli, avgCostCentavos) {
  quantity.assertMilli(qtyOnHandMilli, 'quantity on hand');
  money.assertCentavos(avgCostCentavos, 'average cost');
  return money.toSafeNumber(
    money.divRoundHalfUp(BigInt(qtyOnHandMilli) * BigInt(avgCostCentavos), 1000n),
    'valuation'
  );
}

module.exports = { COST_BEARING_TYPES, ALL_TYPES, computeMovingAverage, applyMovement, valuation };
