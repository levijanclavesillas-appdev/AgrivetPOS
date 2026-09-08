// 04_UX_SPEC.md §4 — the component rules, as functions.
//
// Money is right-aligned, tabular, always two decimals, always ₱-prefixed, never a
// bare number. Quantity carries its unit. Both are here rather than in each view
// because a figure formatted two ways is a figure two screens disagree about.
//
// Pure: no DOM, so the arithmetic is testable without a browser.

/** MON-001: the server sends centavos. This is the only place they become a string. */
export function money(centavos, { symbol = true } = {}) {
  if (centavos === null || centavos === undefined) return symbol ? '₱—' : '—';
  const negative = centavos < 0;
  const digits = String(Math.abs(Math.trunc(centavos))).padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${symbol ? '₱' : ''}${whole}.${digits.slice(-2)}`;
}

/** MON-002: thousandths, up to three decimals, trailing zeros trimmed. */
export function quantity(milli, unit = null) {
  if (milli === null || milli === undefined) return '—';
  const negative = milli < 0;
  const digits = String(Math.abs(Math.trunc(milli))).padStart(4, '0');
  const whole = digits.slice(0, -3);
  const fraction = digits.slice(-3).replace(/0+$/, '');
  const value = `${negative ? '-' : ''}${Number(whole).toLocaleString('en-PH')}${fraction ? `.${fraction}` : ''}`;
  return unit ? `${value} ${unit}` : value;
}

/**
 * UOM-002 / POS-102 — a line quantity shown in **both** the pack the cashier entered
 * and the base unit the ledger stores.
 *
 * "2 SACK (100 KG)" rather than either alone: the first is what was asked for, the
 * second is what the stockroom will be short.
 */
export function packAndBase({ qtyMilli, baseUnit, packUnit = null, packFactorMilli = null }) {
  const base = quantity(qtyMilli, baseUnit);
  if (!packUnit || !packFactorMilli || packFactorMilli === 1000) return base;
  return `${quantity(Math.round((qtyMilli / packFactorMilli) * 1000), packUnit)} (${base})`;
}

/** Basis points as a percentage a person reads: 250 is "2.5%". */
export function percent(basisPoints) {
  if (basisPoints === null || basisPoints === undefined) return '—';
  return `${(basisPoints / 100).toFixed(basisPoints % 100 === 0 ? 0 : 2)}%`;
}

export function manila(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}
