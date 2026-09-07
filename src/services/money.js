'use strict';

// MON-001: all money is a signed integer number of centavos. No floating-point type
// appears in any money column, API field, or calculation. Division by 100 happens at
// the display edge and nowhere else.
//
// A credit ledger built on floating-point money accumulates balances that never reach
// zero (03_BUSINESS_RULES.md §1 preamble). Everything here exists to make that
// impossible rather than unlikely.
//
// Products are computed in BigInt. A price in centavos times a quantity in thousandths
// exceeds Number.MAX_SAFE_INTEGER at figures this store will never see, but "never
// see" is not a guarantee, and a silent precision loss in money is the one failure
// this module exists to prevent.

const CENTAVOS_PLACES = 2;   // MON-001
const MILLI = 1000n;         // MON-002: quantities are thousandths

// ── The rounding primitive ──────────────────────────────────────────────────
//
// MON-003 fixes rounding as half-up, applied once per line at the line total. It does
// not say what "half-up" means for a negative value, and the two readings differ:
//
//   half away from zero   -7843.75 -> -7844      (implemented here)
//   half toward +infinity -7843.75 -> -7843
//
// Away from zero is the only one under which a reversal exactly cancels what it
// reverses. Under the other, voiding a ₱78.4375 line (POS-401, v1.1) leaves a centavo
// behind, and a ledger that cannot return to zero is the defect MON-001 exists to
// prevent. Recorded here because the rule is silent, not because it is ambiguous in
// effect.

/** Divide two integers, rounding halves away from zero. The single rounding policy. */
function divRoundHalfUp(numerator, denominator) {
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  if (d === 0n) throw new RangeError('division by zero');

  const negative = (n < 0n) !== (d < 0n);
  const absN = n < 0n ? -n : n;
  const absD = d < 0n ? -d : d;

  // (2|n| + |d|) / (2|d|) is |n|/|d| rounded half-up, in integer arithmetic only.
  const quotient = (2n * absN + absD) / (2n * absD);
  return negative ? -quotient : quotient;
}

/** An integer scaled by 10^places, rendered as an exact decimal string. */
function formatScaled(units, places) {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const fraction = places === 0 ? '' : digits.slice(digits.length - places);
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * Round a decimal value to `places`, half away from zero — the decimal-facing form of
 * divRoundHalfUp, and the one rounding function callers outside this module use
 * (TASK-002 requirement 3).
 *
 * It returns an exact decimal **string**, not a number. 78.44 is not representable as
 * a float, so returning one would hand the caller a value that is already wrong and
 * invite it back into a money path in violation of MON-001. A string cannot be
 * silently added to anything; converting it is a visible act.
 */
function roundHalfUp(value, places = 0) {
  assertPlaces(places);
  const { units, scaledBy } = parseDecimal(value);
  const scaled = scaledBy >= places
    ? divRoundHalfUp(units, 10n ** BigInt(scaledBy - places))
    : units * 10n ** BigInt(places - scaledBy);
  return formatScaled(scaled, places);
}

// ── Exact decimal parsing ───────────────────────────────────────────────────

const DECIMAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;

function assertPlaces(places) {
  if (!Number.isInteger(places) || places < 0 || places > 9) {
    throw new RangeError(`places must be an integer 0..9, got ${places}`);
  }
}

/** A decimal literal as { units: BigInt, scaledBy: number }, without ever using a float. */
function parseDecimal(input) {
  let text;
  if (typeof input === 'bigint') return { units: input, scaledBy: 0 };
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new RangeError(`not a finite number: ${input}`);
    text = String(input);
  } else if (typeof input === 'string') {
    text = input.trim();
  } else {
    throw new TypeError(`expected a number or decimal string, got ${typeof input}`);
  }

  // Scientific notation is rejected rather than interpreted: it is never how a price
  // or a quantity is entered, and accepting it hides a bug in the caller.
  if (!DECIMAL.test(text)) throw new RangeError(`not a decimal value: ${JSON.stringify(input)}`);

  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  const units = BigInt((whole || '0') + fraction);
  return { units: negative ? -units : units, scaledBy: fraction.length };
}

/**
 * A decimal value as an integer scaled to exactly `places`, rejecting anything with
 * more precision than that. Rejection, never truncation — MON-002's rule for
 * quantities, applied to money for the same reason: a silently dropped digit is a
 * figure nobody can reconcile.
 */
function parseScaled(input, places) {
  assertPlaces(places);
  const { units, scaledBy } = parseDecimal(input);
  if (scaledBy > places) {
    throw new RangeError(
      `${JSON.stringify(input)} has ${scaledBy} decimal places; at most ${places} is representable. ` +
      'It is rejected rather than rounded, so the figure that was meant is the figure that is used.'
    );
  }
  return units * 10n ** BigInt(places - scaledBy);
}

function toSafeNumber(big, what = 'value') {
  if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${what} ${big} is beyond exact integer range`);
  }
  return Number(big);
}

function assertCentavos(value, what = 'amount') {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${what} must be an integer number of centavos (MON-001), got ${value}`);
  }
  return value;
}

// ── Money ───────────────────────────────────────────────────────────────────

/** '62.50' | 62.5 -> 6250. The entry edge: pesos in, centavos everywhere after. */
function fromPesos(pesos) {
  return toSafeNumber(parseScaled(pesos, CENTAVOS_PLACES), 'amount');
}

/**
 * 7844 -> '₱78.44'. The display edge.
 *
 * MON-001 says display divides by 100. It is done here by moving the decimal point in
 * the digit string rather than by dividing, because a float division is exactly what
 * this module forbids everywhere else and there is no reason to make an exception at
 * the one place a reader will copy from.
 */
function toDisplay(centavos, { symbol = true, grouping = true } = {}) {
  assertCentavos(centavos);
  const digits = String(Math.abs(centavos)).padStart(CENTAVOS_PLACES + 1, '0');
  let whole = digits.slice(0, digits.length - CENTAVOS_PLACES);
  const cents = digits.slice(digits.length - CENTAVOS_PLACES);
  if (grouping) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${centavos < 0 ? '-' : ''}${symbol ? '₱' : ''}${whole}.${cents}`;
}

function add(...amounts) {
  return amounts.reduce((sum, a) => sum + assertCentavos(a), 0);
}

function sub(a, b) {
  return assertCentavos(a) - assertCentavos(b);
}

/**
 * MON-003 step 1: unit price × quantity, rounded to the centavo, half-up.
 *
 * unitPriceCentavos is per one base unit; qtyMilli is thousandths of that unit. The
 * product is exact in BigInt and rounded exactly once.
 */
function mulQty(unitPriceCentavos, qtyMilli) {
  assertCentavos(unitPriceCentavos, 'unit price');
  if (!Number.isInteger(qtyMilli)) {
    throw new TypeError(`quantity must be integer thousandths (MON-002), got ${qtyMilli}`);
  }
  return toSafeNumber(divRoundHalfUp(BigInt(unitPriceCentavos) * BigInt(qtyMilli), MILLI), 'line total');
}

/** A percentage of an amount, rounded half-up. `pct` may be fractional: 12.5 is 12.5%. */
function percent(centavos, pct) {
  assertCentavos(centavos);
  const { units, scaledBy } = parseDecimal(pct);
  const denominator = 100n * 10n ** BigInt(scaledBy);
  return toSafeNumber(divRoundHalfUp(BigInt(centavos) * units, denominator), 'percentage');
}

/**
 * MON-006: apportion a transaction-level discount across lines in proportion to line
 * total, with the rounding remainder assigned to the largest line, so the parts sum to
 * the whole exactly.
 *
 * Each share is rounded half-up, then the largest line absorbs the difference — which
 * may be positive or negative. Ties for "largest" go to the earliest line, so the
 * result is deterministic and a reprint matches the original.
 *
 * This is requirement 1's `apportion` under requirement 5's name and signature.
 */
function apportionDiscount(lineTotals, txnDiscount) {
  if (!Array.isArray(lineTotals) || lineTotals.length === 0) {
    throw new TypeError('apportionDiscount needs at least one line total');
  }
  lineTotals.forEach((t, i) => assertCentavos(t, `line ${i} total`));
  assertCentavos(txnDiscount, 'transaction discount');

  const total = add(...lineTotals);
  if (total === 0) {
    if (txnDiscount !== 0) {
      throw new RangeError('cannot apportion a discount across lines totalling zero');
    }
    return lineTotals.map(() => 0);
  }

  const shares = lineTotals.map((lineTotal) =>
    toSafeNumber(divRoundHalfUp(BigInt(txnDiscount) * BigInt(lineTotal), BigInt(total)), 'share'));

  // The remainder lands on the largest line; earliest wins a tie.
  let largest = 0;
  for (let i = 1; i < lineTotals.length; i += 1) {
    if (lineTotals[i] > lineTotals[largest]) largest = i;
  }
  shares[largest] += txnDiscount - add(...shares);

  // The invariant this function exists for. Asserted, not assumed.
  if (add(...shares) !== txnDiscount) {
    throw new Error(`apportionment lost ${txnDiscount - add(...shares)} centavos (MON-006)`);
  }
  return shares;
}

/**
 * MON-003 steps 1–2 for one line, returning every intermediate so a test can assert
 * the order of operations rather than only the answer.
 */
function computeLineTotal({ unitPrice, qtyMilli, lineDiscount = 0 }) {
  const gross = mulQty(unitPrice, qtyMilli);
  assertCentavos(lineDiscount, 'line discount');
  if (lineDiscount < 0) throw new RangeError('a line discount is never negative');
  if (lineDiscount > gross) {
    // PR-205 forbids a discount driving a line negative. Enforced here too, because
    // this is the function that would otherwise produce the negative figure.
    throw new RangeError(
      `line discount ${lineDiscount} exceeds the line total ${gross}; a discount may not ` +
      'drive a line negative (PR-205)'
    );
  }
  return { gross, discount: lineDiscount, net: gross - lineDiscount };
}

/**
 * MON-008: the system does not round the payable to the nearest 5 or 25 centavos.
 * Cash rounding is a setting defaulting to 1 — off. A store that wants it sets the
 * increment; anything else leaves the figure alone.
 */
function applyCashRounding(centavos, roundingCentavos = 1) {
  assertCentavos(centavos);
  if (!Number.isInteger(roundingCentavos) || roundingCentavos < 1) {
    throw new RangeError(`cash_rounding_centavos must be a positive integer, got ${roundingCentavos}`);
  }
  if (roundingCentavos === 1) return centavos;
  return toSafeNumber(
    divRoundHalfUp(BigInt(centavos), BigInt(roundingCentavos)) * BigInt(roundingCentavos),
    'rounded amount'
  );
}

module.exports = {
  CENTAVOS_PLACES,
  divRoundHalfUp, roundHalfUp, formatScaled, parseDecimal, parseScaled, toSafeNumber, assertCentavos,
  fromPesos, toDisplay, add, sub, mulQty, percent,
  apportionDiscount, computeLineTotal, applyCashRounding,
};
