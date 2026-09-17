// What a bulk price change does to one price — the arithmetic, on its own.
//
// Pure, and out of the screen, for the reason the cart's own arithmetic is: a rounding rule
// nobody can test is a rounding rule that surprises a store at the counter. Centavos in,
// centavos out (MON-001); nothing here reaches a server, and the server re-checks every
// figure it is sent regardless.

/** The ways a store says "put the prices up". */
export const RULES = Object.freeze([
  { id: 'PERCENT_UP', label: 'Raise by %', needs: 'percent' },
  { id: 'PERCENT_DOWN', label: 'Lower by %', needs: 'percent' },
  { id: 'AMOUNT_UP', label: 'Raise by ₱', needs: 'amount' },
  { id: 'AMOUNT_DOWN', label: 'Lower by ₱', needs: 'amount' },
  { id: 'SET', label: 'Set to ₱', needs: 'amount' },
  { id: 'MARGIN', label: 'Set from cost, margin %', needs: 'percent' },
]);

/** Where a store likes its prices to land: ₱0.25, ₱1, ₱5, or wherever the arithmetic says. */
export const ROUNDINGS = Object.freeze([
  { id: 'NONE', label: 'No rounding', centavos: 0 },
  { id: 'C25', label: 'Nearest ₱0.25', centavos: 25 },
  { id: 'P1', label: 'Nearest ₱1', centavos: 100 },
  { id: 'P5', label: 'Nearest ₱5', centavos: 500 },
]);

const roundTo = (centavos, step) => (step > 0 ? Math.round(centavos / step) * step : centavos);

/**
 * The new price for one product, or null where the rule cannot say:
 * a product with no price to move, or a margin rule on a product with no cost.
 *
 * `value` is a percentage (5 means 5%) or an amount in centavos, as the rule needs.
 * A rule never returns a negative price: the floor is zero, which is a price a store may
 * genuinely set (a giveaway), and `PR-105` still asks for authority to *sell* below cost.
 */
export function newPrice({ rule, value, current = null, costCentavos = null, rounding = 'NONE' }) {
  const step = (ROUNDINGS.find((r) => r.id === rounding) || ROUNDINGS[0]).centavos;
  const percent = Number(value);
  if (!Number.isFinite(percent)) return null;

  let next = null;
  switch (rule) {
    case 'PERCENT_UP':
    case 'PERCENT_DOWN': {
      if (current === null) return null;
      const factor = rule === 'PERCENT_UP' ? 1 + percent / 100 : 1 - percent / 100;
      next = Math.round(current * factor);
      break;
    }
    case 'AMOUNT_UP':
    case 'AMOUNT_DOWN': {
      if (current === null) return null;
      next = rule === 'AMOUNT_UP' ? current + Math.round(percent) : current - Math.round(percent);
      break;
    }
    case 'SET':
      next = Math.round(percent);
      break;
    case 'MARGIN': {
      // The price at which this margin is made **on the selling price**, which is how a
      // store says "I work on 20%": ₱80 of cost at 20% is ₱100, not ₱96.
      if (costCentavos === null || costCentavos <= 0) return null;
      if (percent >= 100) return null;
      next = Math.round(costCentavos / (1 - percent / 100));
      break;
    }
    default:
      return null;
  }

  return Math.max(0, roundTo(next, step));
}

/** What a price and a cost make, in basis points of the price (MON-001's reason for bp). */
export function marginBp(priceCentavos, costCentavos) {
  if (!Number.isInteger(priceCentavos) || priceCentavos <= 0) return null;
  if (!Number.isInteger(costCentavos) || costCentavos <= 0) return null;
  return Math.round(((priceCentavos - costCentavos) / priceCentavos) * 10000);
}
