// TASK-070 — selling by amount at a sari-sari store's counter.
//
// Kept out of cart.js on purpose: the cart holds no price (§4.1 step 2), and this works from
// one — the unit price the server resolved for the line — to a quantity. What the quantity
// costs is still the server's answer, from the next price check.

/**
 * TASK-070 — "₱20 of rice": the quantity an amount buys, rounded **down** to the unit's
 * selling step (a thousandth where the unit has none), so the customer is never charged
 * more than they asked for. Null where the amount buys less than one step.
 *
 * Only the quantity is worked out here. What it costs is still the server's answer.
 */
export function quantityForAmount({ amountCentavos, unitPriceCentavos, stepMilli = null }) {
  if (!Number.isInteger(amountCentavos) || amountCentavos <= 0) return null;
  if (!Number.isInteger(unitPriceCentavos) || unitPriceCentavos <= 0) return null;
  const step = Number.isInteger(stepMilli) && stepMilli > 0 ? stepMilli : 1;
  const milli = Math.floor((amountCentavos * 1000) / unitPriceCentavos);
  const rounded = Math.floor(milli / step) * step;
  return rounded > 0 ? rounded : null;
}
