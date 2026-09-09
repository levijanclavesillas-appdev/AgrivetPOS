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

/**
 * TAX-004 / TAX-005 — the statutory discount, as a rate and a label.
 *
 * 20%, and — like the VAT rate above — deliberately **not** an `OPS-005` setting. RA
 * 9994 and RA 10754 fix the figure; a store that could type a different one would be
 * either short-changing a senior citizen or claiming a deduction it is not owed, and
 * both are the kind of mistake nobody notices until an assessment. What *is*
 * configurable is whether the store grants it at all (`statutory_discount_enabled`),
 * because whether an agrivet's stock qualifies is a question for the store's
 * accountant — see TASK-027's opening section.
 */
const STATUTORY_DISCOUNT_NUMERATOR = 20n;
const STATUTORY_DISCOUNT_DENOMINATOR = 100n;
const STATUTORY_DISCOUNT_BP = 2000;
const STATUTORY_RATE_LABEL = '20%';

/**
 * The two entitlements, and the words a receipt prints for them.
 *
 * TAX-004 requires the ID *type* alongside the number, because they are different
 * statutes with different registries: a senior citizen's ID is issued by the OSCA, a
 * PWD's by the local government or the NCDA. A single "ID number" column with no type
 * is a record that cannot be checked against either.
 */
const STATUTORY_ID_TYPES = Object.freeze({
  SENIOR_CITIZEN: { label: 'Senior citizen', receipt: 'SC ID', statute: 'RA 9994' },
  PWD: { label: 'PWD', receipt: 'PWD ID', statute: 'RA 10754' },
});

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
 * TAX-004 / TAX-002 / TAX-003 — one statutory line, as pure arithmetic.
 *
 * The rule that is most often implemented wrongly, and expensively: in `VAT` mode the
 * entitlement is **an exemption and a discount**, not a 20% price cut. The line stops
 * being VATable, the 20% applies to what is left, and the customer pays
 * `P / 1.12 × 0.8` — not `P × 0.8`. Getting it backwards overstates the discount the
 * store may claim and understates the output VAT it declares.
 *
 * In `NONE` and `NON_VAT` there is no VAT to lift (TAX-002: the selling price is the
 * final price), so the 20% applies to the selling price and the tax class is untouched.
 *
 * Pure, and takes the mode as an argument for the reason the rest of this file does:
 * all three modes are testable without a store profile.
 *
 * `amountCentavos` is the line **before any discount** — the gross. TAX-005 puts the
 * statutory computation before the voluntary one, and `chooseStatutory` below decides
 * which of the two the customer actually receives.
 */
function statutoryLine({ amountCentavos, taxClass, taxMode }) {
  money.assertCentavos(amountCentavos, 'line amount');
  assertClass(taxClass);
  assertMode(taxMode);

  // The exemption, where there is one to give. Only a VATable line in VAT mode carries
  // VAT to lift; an already-exempt line is exempt for its own reason and stays so.
  const exempt = computesTax(taxMode) && taxClass === 'VATABLE';
  const base = exempt ? decomposeLine(amountCentavos, taxClass).net_centavos : amountCentavos;

  const discount = money.toSafeNumber(
    money.divRoundHalfUp(BigInt(base) * STATUTORY_DISCOUNT_NUMERATOR, STATUTORY_DISCOUNT_DENOMINATOR),
    'statutory discount'
  );

  return {
    rule_id: 'TAX-004',
    // What the 20% was taken on: the VAT-exclusive amount in VAT mode, the selling
    // price otherwise. Returned rather than left implicit because it is the figure a
    // receipt and an assessment both want to see.
    base_centavos: base,
    vat_exemption_centavos: amountCentavos - base,
    discount_centavos: discount,
    net_centavos: base - discount,
    discount_bp: STATUTORY_DISCOUNT_BP,
    // TAX-003: the line's class for the rest of the computation. An exempt line yields
    // no VAT, which is the whole of what the exemption means downstream.
    tax_class: exempt ? 'VAT_EXEMPT' : taxClass,
    exempted: exempt,
  };
}

/**
 * TAX-005 — statutory first, and never both.
 *
 * "Computed **before** any voluntary discount and the two do not compound: the customer
 * receives the larger, not the sum." A shop that gives 20% statutory on top of a 5%
 * loyalty discount is giving 25% and cannot claim the difference back.
 *
 * The comparison is between the two **discounts**, not between two final prices, and
 * that distinction is this function's one judgement call. Where the statutory line is
 * also VAT-exempt, the exemption is a tax treatment the beneficiary is entitled to
 * either way (TAX-002) — it is not a discount, it is not the store's to give, and
 * weighing it against a voluntary discount would let a 6% loyalty discount cancel a
 * customer's VAT exemption. So the exemption stands whichever discount wins, and only
 * the 20% is in the scale.
 *
 * Shaped like `discountRuleService.chooseDiscount` on purpose: PR-206 already answers
 * "two discounts, one line, which applies" and a second answer with a different shape
 * is how the two drift.
 */
function chooseStatutory({ statutoryCentavos, voluntaryCentavos, voluntaryReason = null }) {
  money.assertCentavos(statutoryCentavos, 'statutory discount');
  money.assertCentavos(voluntaryCentavos, 'voluntary discount');

  const statutoryWins = statutoryCentavos >= voluntaryCentavos;

  return {
    applied_centavos: statutoryWins ? statutoryCentavos : voluntaryCentavos,
    source: statutoryWins ? 'STATUTORY' : 'VOLUNTARY',
    rule_id: 'TAX-005',
    statutory_centavos: statutoryCentavos,
    voluntary_centavos: voluntaryCentavos,
    suppressed: statutoryWins
      ? (voluntaryCentavos > 0
        ? { source: 'VOLUNTARY', centavos: voluntaryCentavos, reason: voluntaryReason }
        : null)
      : { source: 'STATUTORY', centavos: statutoryCentavos, reason: null },
    why: statutoryWins
      ? (voluntaryCentavos > 0
        ? `${money.toDisplay(statutoryCentavos)} statutory beats `
          + `${money.toDisplay(voluntaryCentavos)} given by the store; they do not add together (TAX-005).`
        : `${STATUTORY_RATE_LABEL} statutory discount (TAX-004).`)
      : `${money.toDisplay(voluntaryCentavos)} given by the store beats the `
        + `${money.toDisplay(statutoryCentavos)} statutory discount; they do not add together (TAX-005).`,
  };
}

/** TAX-004's ID type, refused by name rather than written as whatever arrived. */
function assertStatutoryIdType(idType) {
  if (!Object.prototype.hasOwnProperty.call(STATUTORY_ID_TYPES, idType)) {
    throw new RangeError(`unknown statutory ID type: ${idType} (TAX-004)`);
  }
  return idType;
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
  STATUTORY_DISCOUNT_BP, STATUTORY_RATE_LABEL, STATUTORY_ID_TYPES,
  assertMode, assertClass, computesTax, decomposeLine, computeTax, summaryBlock,
  statutoryLine, chooseStatutory, assertStatutoryIdType,
};
