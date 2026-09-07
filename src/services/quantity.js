'use strict';

// MON-002: all quantities are a signed integer number of thousandths of the product's
// base unit. 1.255 KG is 1255. Three decimal places is the limit, and a fourth is
// rejected, not truncated.
//
// UOM-001: there is one base unit per product and no second inventory figure. Packs
// (UOM-002) are a sell-time and display-time convenience over the same base number;
// the ledger never holds sacks.
//
// Exact decimal handling lives in money.js, so that rounding and parsing are decided
// once for the whole product rather than twice with a drift between them.

const money = require('./money');

const MILLI_PLACES = 3;      // MON-002
const MILLI_PER_UNIT = 1000;

function assertMilli(value, what = 'quantity') {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${what} must be integer thousandths of the base unit (MON-002), got ${value}`);
  }
  return value;
}

/**
 * '1.255' | 1.255 -> 1255.
 *
 * A fourth decimal place is refused. Truncating it would post a movement for a
 * quantity nobody entered, and the ledger is the thing every stock figure reconciles
 * to (INV-101).
 */
function parse(input) {
  return money.toSafeNumber(money.parseScaled(input, MILLI_PLACES), 'quantity');
}

/** 1255 -> '1.255'. Trailing zeros are trimmed unless `decimals` forces a width. */
function toDecimalString(qtyMilli, { decimals = null } = {}) {
  assertMilli(qtyMilli);
  const negative = qtyMilli < 0;
  const abs = Math.abs(qtyMilli);
  const whole = Math.trunc(abs / MILLI_PER_UNIT);
  let fraction = String(abs % MILLI_PER_UNIT).padStart(MILLI_PLACES, '0');

  if (decimals === null) {
    fraction = fraction.replace(/0+$/, '');
  } else {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > MILLI_PLACES) {
      throw new RangeError(`decimals must be 0..${MILLI_PLACES}, got ${decimals}`);
    }
    fraction = decimals === 0 ? '' : fraction.slice(0, decimals);
  }
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * 1255, 'KG' -> '1.255 KG'.
 *
 * 04_UX_SPEC.md §4: the unit label is always attached. A bare quantity on a screen
 * that sells the same product by sack and by kilo is the ambiguity this product exists
 * to remove (legacy/README.md contradiction 3).
 */
function format(qtyMilli, unit, opts = {}) {
  if (typeof unit !== 'string' || unit.trim() === '') {
    throw new TypeError('a quantity is never displayed without its unit (UOM-005)');
  }
  return `${toDecimalString(qtyMilli, opts)} ${unit}`;
}

/**
 * UOM-002: selling `packQtyMilli` of a pack posts `factor_milli × qty` base thousandths.
 *
 * A sack on a KG-based product has factor_milli 50000, so one sack — 1000 thousandths
 * of a pack — is 50000 base thousandths, which is 50.000 KG.
 */
function toBaseUnits(packQtyMilli, packFactorMilli) {
  assertMilli(packQtyMilli, 'pack quantity');
  assertMilli(packFactorMilli, 'pack factor');
  if (packFactorMilli <= 0) throw new RangeError('a pack factor is a positive quantity of base units');
  return money.toSafeNumber(
    money.divRoundHalfUp(BigInt(packQtyMilli) * BigInt(packFactorMilli), BigInt(MILLI_PER_UNIT)),
    'base quantity'
  );
}

/**
 * The inverse, for showing a base quantity in packs.
 *
 * Display only. The conversion back is not always exact — 1 KG is a third of a 3 KG
 * pack — so the ledger figure remains the base one (UOM-001) and this result is never
 * stored or posted.
 */
function fromBaseUnits(baseQtyMilli, packFactorMilli) {
  assertMilli(baseQtyMilli, 'base quantity');
  assertMilli(packFactorMilli, 'pack factor');
  if (packFactorMilli <= 0) throw new RangeError('a pack factor is a positive quantity of base units');
  return money.toSafeNumber(
    money.divRoundHalfUp(BigInt(baseQtyMilli) * BigInt(MILLI_PER_UNIT), BigInt(packFactorMilli)),
    'pack quantity'
  );
}

/** True where a base quantity is a whole number of packs — no break-bulk implied (UOM-004). */
function isWholePacks(baseQtyMilli, packFactorMilli) {
  assertMilli(baseQtyMilli, 'base quantity');
  assertMilli(packFactorMilli, 'pack factor');
  return packFactorMilli > 0 && baseQtyMilli % packFactorMilli === 0;
}

module.exports = {
  MILLI_PLACES, MILLI_PER_UNIT,
  assertMilli, parse, toDecimalString, format,
  toBaseUnits, fromBaseUnits, isWholePacks,
};
