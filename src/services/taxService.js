'use strict';

// TAX-001–TAX-003 — the three-mode tax engine.
//
// Pure. It opens no transaction, reads no session, touches no database and writes
// nothing: every input arrives as an argument, which is what lets TASK-011 compute a
// sale's tax inside its own transaction without this file knowing a transaction exists.
//
// The store's `tax_mode` is an **input**, never a build-time assumption. The client
// asked for all three (01_PRODUCT_BRIEF.md D-3), and TAX-003 populates `tax_class` on
// every product in every mode — which is what makes moving a store from non-VAT to VAT
// a settings change rather than a migration that has to invent a class per product.

const money = require('./money');

const MODES = Object.freeze(['NONE', 'NON_VAT', 'VAT']);
const CLASSES = Object.freeze(['VATABLE', 'VAT_EXEMPT', 'ZERO_RATED']);

/**
 * 12%, expressed as the inclusive divisor TAX-003 states: `net = round(P / 1.12)`.
 *
 * Held as a numerator and denominator rather than a float, so the division is the
 * exact integer one MON-001 requires. It is deliberately **not** an OPS-005 setting:
 * the VAT rate is statute, not an operator preference, and a store that could type a
 * different one would be filing wrong figures with a straight face.
 */
const VAT_INCLUSIVE_NUMERATOR = 100n;
const VAT_INCLUSIVE_DENOMINATOR = 112n;
const VAT_RATE_LABEL = '12%';

function assertMode(taxMode) {
  if (!MODES.includes(taxMode)) {
    throw new RangeError(`unknown tax mode: ${taxMode} (TAX-001)`);
  }
  return taxMode;
}

function assertClass(taxClass) {
  if (!CLASSES.includes(taxClass)) {
    throw new RangeError(`unknown tax class: ${taxClass} (TAX-003)`);
  }
  return taxClass;
}

/**
 * TAX-002 — whether the mode computes tax at all.
 *
 * `NONE` and `NON_VAT` do not: the selling price is the final price, nothing is split
 * out, and every sale line records `tax_amount_centavos = 0`.
 */
function computesTax(taxMode) {
  assertMode(taxMode);
  return taxMode === 'VAT';
}

/**
 * TAX-003 — decompose one VAT-inclusive amount.
 *
 * `net = round(P / 1.12)`, `vat = P − net`. The subtraction rather than a second
 * rounded division is the point: two independently rounded halves do not always sum
 * back to the whole, and a receipt whose net and VAT miss the total by a centavo is a
 * defect the customer can see.
 *
 * Exempt and zero-rated lines yield no VAT — they are not the same thing to the BIR,
 * but they decompose identically, so the difference is carried in the summary block
 * rather than in the arithmetic.
 */
function decomposeLine(amountCentavos, taxClass) {
  money.assertCentavos(amountCentavos, 'line amount');
  assertClass(taxClass);

  if (taxClass !== 'VATABLE') {
    return { net_centavos: amountCentavos, vat_centavos: 0, tax_class: taxClass };
  }

  const net = money.toSafeNumber(
    money.divRoundHalfUp(BigInt(amountCentavos) * VAT_INCLUSIVE_NUMERATOR, VAT_INCLUSIVE_DENOMINATOR),
    'VAT-exclusive amount'
  );
  return { net_centavos: net, vat_centavos: amountCentavos - net, tax_class: taxClass };
}

/**
 * TAX-002 / TAX-003 — the whole basket.
 *
 * `lines` are `{ taxClass, amountCentavos }`, where the amount is the line total
 * **after every discount**: MON-003 fixes the order as line discount, then transaction
 * discount, then tax treatment, and TAX-003 says the decomposition is "computed per
 * line after discount".
 *
 * Per line, never in aggregate. Decomposing the basket total would be wrong the moment
 * one line is exempt, and it would also round once instead of once per line — TC-UT-19
 * asserts both halves of that.
 */
function computeTax({ lines, taxMode }) {
  assertMode(taxMode);
  if (!Array.isArray(lines)) throw new TypeError('computeTax needs an array of lines');

  const priced = lines.map((line, i) => {
    const amount = line.amountCentavos;
    money.assertCentavos(amount, `line ${i} amount`);
    const taxClass = assertClass(line.taxClass);

    if (!computesTax(taxMode)) {
      // TAX-002: no tax is computed, split or printed, and the line records zero.
      return {
        index: i,
        amount_centavos: amount,
        net_centavos: amount,
        vat_centavos: 0,
        tax_class: taxClass,
      };
    }

    const { net_centavos: net, vat_centavos: vat } = decomposeLine(amount, taxClass);
    return { index: i, amount_centavos: amount, net_centavos: net, vat_centavos: vat, tax_class: taxClass };
  });

  return {
    tax_mode: taxMode,
    computes_tax: computesTax(taxMode),
    lines: priced,
    total_centavos: priced.reduce((sum, l) => sum + l.amount_centavos, 0),
    total_vat_centavos: priced.reduce((sum, l) => sum + l.vat_centavos, 0),
    total_net_centavos: priced.reduce((sum, l) => sum + l.net_centavos, 0),
    // TAX-007's printed block, or null where there is none to print. TASK-014 renders
    // it; the figures are decided here so the receipt and the report cannot disagree.
    summary: computesTax(taxMode) ? summaryBlock(priced) : null,
  };
}

/**
 * TAX-007 — the VATable / VAT-exempt / zero-rated / VAT-amount block.
 *
 * Needed for the store's own bookkeeping, and printed subject to TAX-006: the document
 * is an internal transaction record, so the block appears on it without any of the
 * phrases TAX-006 forbids. That wording is TASK-014's; the figures are these.
 */
function summaryBlock(lines) {
  const bucket = (taxClass) => lines
    .filter((l) => l.tax_class === taxClass)
    .reduce((sum, l) => sum + l.net_centavos, 0);

  return {
    vat_rate: VAT_RATE_LABEL,
    vatable_sales_centavos: bucket('VATABLE'),
    vat_exempt_sales_centavos: bucket('VAT_EXEMPT'),
    zero_rated_sales_centavos: bucket('ZERO_RATED'),
    vat_amount_centavos: lines.reduce((sum, l) => sum + l.vat_centavos, 0),
  };
}

module.exports = {
  MODES, CLASSES, VAT_RATE_LABEL,
  assertMode, assertClass, computesTax, decomposeLine, computeTax, summaryBlock,
};
