'use strict';

// FR_3.2 / PR-101–PR-205 — price resolution, discount authority and the below-cost
// floor, as one server-authoritative computation.
//
// Pure in the sense requirement 8 means: no transaction, no session, no writes. It
// reads product_prices through the repository because that is where prices live, and
// every decision it makes is a function of what it read plus its arguments. TASK-011
// calls it inside a transaction it already owns.
//
// **The client's prices are never trusted** (05_TECH_SPEC.md §4.1 step 2). Everything
// here re-resolves server-side; a cart arrives as products and quantities, and what it
// claims anything costs is compared, not banked.

const clock = require('../config/clock');
const errors = require('./errors');
const money = require('./money');
const taxService = require('./taxService');
const settingsService = require('./settingsService');
const productRepository = require('../repositories/productRepository');

const PRICE_LEVELS = Object.freeze(['RETAIL', 'WHOLESALE', 'DEALER']);

/**
 * PR-101's precedence, as data rather than as an if-chain.
 *
 * All four levels exist now and the two v1.1 ones return null. That is deliberate and
 * is the task's own instruction: retrofitting a precedence order into a shipped
 * pricing engine is how the wrong price reaches a customer. When TASK-024 builds
 * customer-specific prices and quantity breaks, it fills in a resolver here and
 * changes nothing else.
 */
const PRECEDENCE = Object.freeze([
  { level: 'CUSTOMER_SPECIFIC', rule: 'PR-103', release: '1.1', resolve: () => null },
  { level: 'QUANTITY_BREAK', rule: 'PR-104', release: '1.1', resolve: () => null },
  { level: 'PRICE_LEVEL', rule: 'PR-101', release: '1.0', resolve: resolveCustomerLevel },
  { level: 'RETAIL', rule: 'PR-102', release: '1.0', resolve: resolveRetail },
]);

/** The role → settings key map for PR-201's ceilings. Ceilings are settings, not constants. */
const CEILING_KEYS = Object.freeze({
  CASHIER: 'discount_ceiling_cashier_bp',
  MANAGER: 'discount_ceiling_manager_bp',
  OWNER: 'discount_ceiling_owner_bp',
});

// ── PR-101 / PR-102 — resolution ────────────────────────────────────────────

function resolveCustomerLevel({ productId, customer, at }) {
  const wanted = (customer && customer.price_level) || 'RETAIL';
  if (!PRICE_LEVELS.includes(wanted)) {
    throw errors.badRequest(`Price level must be one of ${PRICE_LEVELS.join(', ')}`, { ruleId: 'PR-101' });
  }
  // Level 4 is the fall-through, so level 3 declines rather than answering RETAIL here.
  if (wanted === 'RETAIL') return null;
  const row = productRepository.priceAt(productId, wanted, at);
  return row ? { price_centavos: row.price_centavos, effective_from: row.effective_from } : null;
}

function resolveRetail({ productId, at }) {
  const row = productRepository.priceAt(productId, 'RETAIL', at);
  return row ? { price_centavos: row.price_centavos, effective_from: row.effective_from } : null;
}

/**
 * PR-101 — first match wins, and the level that matched is returned.
 *
 * The sale line records the resolved level (PR-101's last sentence), which is what
 * makes a price on a six-month-old receipt explicable: "wholesale" and "retail because
 * this product has no wholesale price" are different answers, and only one of them is
 * a pricing error worth chasing.
 *
 * PR-102: a missing wholesale or dealer price falls through to **retail, never to
 * zero**. Zero would give the product away, and it is the kind of defect that only
 * shows up in the day's takings.
 */
function resolvePrice({ product, productId = null, customer = null, qtyMilli = null, at = null } = {}) {
  const id = productId || (product && product.id);
  if (!id) throw new TypeError('resolvePrice needs a product');
  const when = at || clock.nowUtc();

  const requestedLevel = (customer && customer.price_level) || 'RETAIL';
  const context = { productId: id, product, customer, qtyMilli, at: when };

  for (const step of PRECEDENCE) {
    const hit = step.resolve(context);
    if (!hit) continue;

    return {
      price_centavos: hit.price_centavos,
      requested_level: requestedLevel,
      resolved_level: step.level === 'PRICE_LEVEL' ? requestedLevel : step.level,
      precedence: step.level,
      rule_id: step.rule,
      effective_from: hit.effective_from,
      fell_through: step.level === 'RETAIL' && requestedLevel !== 'RETAIL',
    };
  }

  // PR-102: no retail price means the product is not sellable. Refused rather than
  // priced at zero — the refusal reaches the counter, a zero reaches the till.
  throw errors.conflict(
    'This product has no retail price yet, so it cannot be sold. Set one first.',
    { ruleId: 'PR-102' }
  );
}

/** The v1.1 levels, named so a caller can see what is not yet resolving. */
function precedenceLevels() {
  return PRECEDENCE.map(({ level, rule, release }) => ({ level, rule_id: rule, release }));
}

// ── PR-201 / PR-202 / PR-203 — discount authority ───────────────────────────

/**
 * The ceiling a role may apply, in basis points. PR-201's figures are **settings, not
 * constants** — the rule says so in its own last sentence.
 *
 * A role with no grant has no ceiling at all rather than a ceiling of zero: an
 * inventory clerk cannot apply a discount because they hold no TX-402, which is a
 * different refusal from "your maximum is 0%".
 */
function roleCeilingBp(role) {
  const key = CEILING_KEYS[role];
  return key ? settingsService.get(key) : null;
}

/**
 * PR-202 — a category's maximum overrides a higher role ceiling; the effective ceiling
 * is the **lower** of the two.
 *
 * PR-202 is v1.1 (TASK-023 owns the rules engine), and `categories.max_discount_bp`
 * defaults to NULL, so in a v1.0 store this changes nothing. It is computed here
 * anyway because "the lower of role and category" is a property of the ceiling, and a
 * ceiling function that ignores half its inputs is one somebody has to remember to
 * replace.
 */
function effectiveCeilingBp(role, { categoryMaxDiscountBp = null } = {}) {
  const roleBp = roleCeilingBp(role);
  if (roleBp === null) return null;
  if (categoryMaxDiscountBp === null || categoryMaxDiscountBp === undefined) return roleBp;
  return Math.min(roleBp, categoryMaxDiscountBp);
}

/**
 * PR-203 — a discount above the acting user's ceiling is **not refused outright**. It
 * opens a manager override prompt, so this returns a decision rather than throwing:
 * `allowed`, the ceiling that applied, and who can approve it.
 *
 * The distinction matters at the counter. A refusal ends the sale; a decision that
 * names an approver is a prompt, and PR-203 asks for the second.
 */
function evaluateDiscount({
  role, lineTotalCentavos, discountCentavos, categoryMaxDiscountBp = null, approverRole = null,
}) {
  money.assertCentavos(lineTotalCentavos, 'line total');
  money.assertCentavos(discountCentavos, 'discount');

  if (discountCentavos < 0) {
    throw errors.badRequest('A discount is never negative', { ruleId: 'PR-205' });
  }

  // PR-205 — a discount may never make a line total negative. Checked before the
  // ceiling: a 300% discount is not an authorisation question, it is nonsense.
  if (discountCentavos > lineTotalCentavos) {
    return {
      allowed: false,
      reason: 'FLOOR',
      rule_id: 'PR-205',
      message: `A discount of ${money.toDisplay(discountCentavos)} is more than the line total of `
        + `${money.toDisplay(lineTotalCentavos)}. A discount may not make a line negative.`,
      requested_bp: null,
      ceiling_bp: null,
      requires_role: null,
    };
  }

  const ceilingBp = effectiveCeilingBp(role, { categoryMaxDiscountBp });
  const requestedBp = lineTotalCentavos === 0
    ? 0
    : basisPoints(discountCentavos, lineTotalCentavos);

  if (ceilingBp === null) {
    return {
      allowed: false,
      reason: 'NO_AUTHORITY',
      rule_id: 'TX-402',
      message: 'You do not have permission to apply a discount.',
      requested_bp: requestedBp,
      ceiling_bp: null,
      requires_role: holdersOf().join(' or '),
    };
  }

  if (requestedBp <= ceilingBp) {
    return {
      allowed: true, reason: null, rule_id: 'PR-201',
      requested_bp: requestedBp, ceiling_bp: ceilingBp, requires_role: null,
    };
  }

  // PR-203: the approving user is recorded distinctly from the acting user, so an
  // approval already given is honoured here rather than re-prompted.
  if (approverRole) {
    const approverCeiling = effectiveCeilingBp(approverRole, { categoryMaxDiscountBp });
    if (approverCeiling !== null && requestedBp <= approverCeiling) {
      return {
        allowed: true, reason: null, rule_id: 'PR-203', authorised: true,
        requested_bp: requestedBp, ceiling_bp: approverCeiling,
        approved_by_role: approverRole, requires_role: null,
      };
    }
  }

  const approvers = rolesAbove(requestedBp, { categoryMaxDiscountBp });
  return {
    allowed: false,
    reason: 'ABOVE_CEILING',
    rule_id: 'PR-203',
    message: `${formatBp(requestedBp)} is above your ${formatBp(ceilingBp)} limit. `
      + (approvers.length
        ? `A ${approvers.join(' or ').toLowerCase()} can approve it.`
        : 'Nobody may approve a discount this large.'),
    requested_bp: requestedBp,
    ceiling_bp: ceilingBp,
    requires_role: approvers.join(' or ') || null,
  };
}

/** The same decision as a refusal, for a caller that wants the error shape. */
function assertDiscountAllowed(input) {
  const decision = evaluateDiscount(input);
  if (decision.allowed) return decision;

  const build = decision.reason === 'FLOOR' ? errors.badRequest : errors.forbidden;
  throw build(decision.message, { ruleId: decision.rule_id, requiresRole: decision.requires_role });
}

/** Which roles could approve a discount of this size (PR-203's "requires role"). */
function rolesAbove(requestedBp, { categoryMaxDiscountBp = null } = {}) {
  return Object.keys(CEILING_KEYS).filter((role) => {
    const ceiling = effectiveCeilingBp(role, { categoryMaxDiscountBp });
    return ceiling !== null && requestedBp <= ceiling;
  });
}

const holdersOf = () => Object.keys(CEILING_KEYS);

/**
 * A discount as basis points of the line, rounded half-up.
 *
 * Basis points rather than a percentage float, for MON-001's reason one indirection
 * out: 2% is 200, and there is no representation in which "2%" becomes 1.9999999.
 */
function basisPoints(partCentavos, wholeCentavos) {
  if (wholeCentavos === 0) return 0;
  return money.toSafeNumber(
    money.divRoundHalfUp(BigInt(partCentavos) * 10000n, BigInt(wholeCentavos)),
    'basis points'
  );
}

/** The largest discount a role may give on a line, in centavos. */
function maxDiscountCentavos(role, lineTotalCentavos, { categoryMaxDiscountBp = null } = {}) {
  const ceilingBp = effectiveCeilingBp(role, { categoryMaxDiscountBp });
  if (ceilingBp === null) return 0;
  return money.toSafeNumber(
    money.divRoundHalfUp(BigInt(lineTotalCentavos) * BigInt(ceilingBp), 10000n),
    'maximum discount'
  );
}

const formatBp = (bp) => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 2)}%`;

// ── PR-105 — the below-cost floor ───────────────────────────────────────────

/**
 * PR-105 — a resolved or discounted unit price below `avg_cost_centavos` requires
 * authorisation, and the authorisation is audited (AUD-603).
 *
 * A decision rather than a throw, for PR-203's reason: at the counter this is a prompt,
 * not the end of the sale. `authorisedBy` is a role that holds TX-404; a session that
 * holds it itself needs no second party.
 *
 * The comparison is on the **effective unit price** — after the line discount — because
 * a 50% discount on a product priced at cost sells it below cost just as surely as a
 * mis-keyed price does.
 */
function evaluateBelowCost({
  unitPriceCentavos, qtyMilli, discountCentavos = 0, avgCostCentavos, authorisedByRole = null, actorRole = null,
}) {
  money.assertCentavos(avgCostCentavos, 'average cost');

  const gross = money.mulQty(unitPriceCentavos, qtyMilli);
  const net = gross - discountCentavos;
  // Back to a per-base-unit figure so it compares against avg_cost, which is per base
  // unit (MON-004).
  const effectiveUnit = qtyMilli === 0
    ? unitPriceCentavos
    : money.toSafeNumber(money.divRoundHalfUp(BigInt(net) * 1000n, BigInt(qtyMilli)), 'effective unit price');

  if (avgCostCentavos === 0 || effectiveUnit >= avgCostCentavos) {
    return { belowCost: false, allowed: true, effective_unit_centavos: effectiveUnit, avg_cost_centavos: avgCostCentavos };
  }

  const holders = ['OWNER', 'MANAGER'];        // §10's TX-404 cells
  const authorised = holders.includes(actorRole) || holders.includes(authorisedByRole);

  return {
    belowCost: true,
    allowed: authorised,
    effective_unit_centavos: effectiveUnit,
    avg_cost_centavos: avgCostCentavos,
    shortfall_centavos: avgCostCentavos - effectiveUnit,
    rule_id: 'PR-105',
    requires_role: authorised ? null : holders.join(' or '),
    message: authorised
      ? null
      : `${money.toDisplay(effectiveUnit)} is below the ${money.toDisplay(avgCostCentavos)} average cost. `
        + 'A manager or owner must authorise selling below cost.',
  };
}

function assertNotBelowCost(input) {
  const decision = evaluateBelowCost(input);
  if (decision.allowed) return decision;
  throw errors.forbidden(decision.message, { ruleId: 'PR-105', requiresRole: decision.requires_role });
}

// ── The whole cart (POST /sales/price-check) ────────────────────────────────

/**
 * Resolve, discount and tax a whole cart without committing anything.
 *
 * This is the computation TASK-011 performs inside its transaction, and the endpoint
 * the POS screen calls on every change — the same code both times, so what the screen
 * previews and what the till charges cannot drift.
 *
 * MON-003 fixes the order and it is followed literally: unit price × qty → round →
 * line discount → round → sum → transaction discount apportioned (MON-006) → tax
 * treatment per line (TAX-002).
 */
function priceCart({
  lines, customer = null, taxMode, actorRole = null, approverRole = null,
  transactionDiscountCentavos = 0, at = null,
}) {
  taxService.assertMode(taxMode);
  if (!Array.isArray(lines) || lines.length === 0) {
    throw errors.badRequest('A cart needs at least one line', { ruleId: 'POS-101' });
  }
  const when = at || clock.nowUtc();

  // 1–2. Resolve each line server-side and take its line discount.
  const resolved = lines.map((line, index) => {
    const product = productRepository.findById(line.productId);
    if (!product) throw errors.notFound(`No such product on line ${index + 1}`);
    if (!product.is_active) {
      // INV-105: an inactive product may not be added to a cart, though its stock and
      // history remain.
      throw errors.conflict(`${product.name} is withdrawn and cannot be sold.`, { ruleId: 'INV-105' });
    }

    const price = resolvePrice({ product, customer, qtyMilli: line.qtyMilli, at: when });
    const discount = line.discountCentavos || 0;
    const totals = money.computeLineTotal({
      unitPrice: price.price_centavos, qtyMilli: line.qtyMilli, lineDiscount: discount,
    });

    const discountDecision = discount === 0
      ? { allowed: true, requested_bp: 0, ceiling_bp: effectiveCeilingBp(actorRole), rule_id: 'PR-201' }
      : evaluateDiscount({
        role: actorRole,
        lineTotalCentavos: totals.gross,
        discountCentavos: discount,
        approverRole,
      });

    const costDecision = evaluateBelowCost({
      unitPriceCentavos: price.price_centavos,
      qtyMilli: line.qtyMilli,
      discountCentavos: discount,
      avgCostCentavos: product.avg_cost_centavos,
      actorRole,
      authorisedByRole: approverRole,
    });

    return {
      index,
      product_id: product.id,
      sku: product.sku,
      name: product.name,
      tax_class: product.tax_class,
      qty_milli: line.qtyMilli,
      unit_price_centavos: price.price_centavos,
      price_level: price.resolved_level,
      price_fell_through: price.fell_through,
      gross_centavos: totals.gross,
      line_discount_centavos: totals.discount,
      net_centavos: totals.net,
      discount_decision: discountDecision,
      below_cost: costDecision,
    };
  });

  // 3. Sum, then apportion the transaction discount (MON-006).
  const subtotal = resolved.reduce((sum, l) => sum + l.net_centavos, 0);
  money.assertCentavos(transactionDiscountCentavos, 'transaction discount');

  if (transactionDiscountCentavos > subtotal) {
    // PR-205's second half: the sum of discounts may never exceed the subtotal.
    throw errors.badRequest(
      `A transaction discount of ${money.toDisplay(transactionDiscountCentavos)} is more than the `
      + `${money.toDisplay(subtotal)} subtotal.`,
      { ruleId: 'PR-205' }
    );
  }

  const shares = transactionDiscountCentavos === 0
    ? resolved.map(() => 0)
    : money.apportionDiscount(resolved.map((l) => l.net_centavos), transactionDiscountCentavos);

  const withShares = resolved.map((line, i) => ({
    ...line,
    transaction_discount_centavos: shares[i],
    // 4. The amount the tax treatment applies to: after every discount (TAX-003).
    amount_centavos: line.net_centavos - shares[i],
  }));

  // 5. Tax treatment, per line (TAX-002, TAX-003).
  const tax = taxService.computeTax({
    taxMode,
    lines: withShares.map((l) => ({ taxClass: l.tax_class, amountCentavos: l.amount_centavos })),
  });

  const priced = withShares.map((line, i) => ({
    ...line,
    tax_amount_centavos: tax.lines[i].vat_centavos,
    net_of_tax_centavos: tax.lines[i].net_centavos,
  }));

  // Every blocking decision on every line, not the first one per line. A screen that
  // is told about the discount, has it approved, resubmits and only then hears about
  // the below-cost price has made the counter ask the manager over twice for one sale.
  const authorisations = priced.flatMap((line) => [line.discount_decision, line.below_cost]
    .filter((decision) => !decision.allowed)
    .map((decision) => ({
      line: line.index,
      product: line.name,
      rule_id: decision.rule_id,
      message: decision.message,
      requires_role: decision.requires_role,
    })));

  return {
    priced_at: when,
    tax_mode: taxMode,
    customer_price_level: (customer && customer.price_level) || 'RETAIL',
    lines: priced,
    subtotal_centavos: subtotal,
    line_discount_centavos: priced.reduce((sum, l) => sum + l.line_discount_centavos, 0),
    transaction_discount_centavos: transactionDiscountCentavos,
    total_centavos: priced.reduce((sum, l) => sum + l.amount_centavos, 0),
    tax_amount_centavos: tax.total_vat_centavos,
    tax_summary: tax.summary,
    // What the POS screen needs to decide between completing, prompting for an
    // override, or refusing — without re-deriving any of it.
    requires_authorisation: authorisations.length > 0,
    authorisations,
  };
}

module.exports = {
  PRICE_LEVELS, PRECEDENCE, CEILING_KEYS,
  resolvePrice, precedenceLevels,
  roleCeilingBp, effectiveCeilingBp, evaluateDiscount, assertDiscountAllowed,
  basisPoints, maxDiscountCentavos, rolesAbove,
  evaluateBelowCost, assertNotBelowCost,
  priceCart,
};
