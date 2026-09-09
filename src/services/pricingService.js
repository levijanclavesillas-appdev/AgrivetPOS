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
//
// TASK-023 added the rules an owner configures — PR-106's tiers, PR-202's category
// ceilings and PR-206's no-compounding — and put them in `discountRuleService` rather
// than here. The split is by kind: this file computes what a cart costs, that one
// answers what the store's policy says. `priceCart` below asks it three questions and
// makes no discount policy decision of its own.
//
// TASK-027 added the statutory discount the same way. The arithmetic — the 20%, the
// VAT exemption, and TAX-005's "the larger, never the sum" — is `taxService`'s and is a
// pure function tested on its own; what lives here is *which lines it reaches* and
// *what it does to the basket*, which is a pricing question and nothing else's.

const clock = require('../config/clock');
const errors = require('./errors');
const money = require('./money');
const taxService = require('./taxService');
const settingsService = require('./settingsService');
const discountRuleService = require('./discountRuleService');
const productRepository = require('../repositories/productRepository');

const PRICE_LEVELS = Object.freeze(['RETAIL', 'WHOLESALE', 'DEALER']);

/**
 * PR-101's precedence, as data rather than as an if-chain.
 *
 * All four levels resolve since TASK-024. The chain was built whole at TASK-009 with
 * the top two returning null, precisely so that filling them in would be four lines
 * here and nothing anywhere else — retrofitting a precedence order into a shipped
 * pricing engine is how the wrong price reaches a customer.
 */
const PRECEDENCE = Object.freeze([
  { level: 'CUSTOMER_SPECIFIC', rule: 'PR-103', release: '1.1', resolve: resolveCustomerPrice },
  { level: 'QUANTITY_BREAK', rule: 'PR-104', release: '1.1', resolve: resolveQuantityBreak },
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

/**
 * PR-103 — level 1. A customer-specific price overrides all others for that customer
 * and product, **including quantity breaks**.
 *
 * A farm that has negotiated ₱58 a kilo pays ₱58 a kilo, whether they buy one sack or
 * forty. The rule says "overrides all others" and it means it: no comparison with the
 * break, no cheaper-of. Which is why this sits first in the chain and the chain stops
 * at the first level that answers — the precedence *is* the implementation.
 *
 * What it is still subject to is PR-202's ceiling and PR-105's below-cost check, both
 * of which happen downstream of resolution. A negotiated price is not a licence to
 * sell below cost unnoticed.
 */
function resolveCustomerPrice({ productId, customer, at }) {
  if (!customer || !customer.id) return null;
  const row = productRepository.customerPriceAt(customer.id, productId, at);
  return row
    ? { price_centavos: row.price_centavos, effective_from: row.effective_from, note: row.note }
    : null;
}

/**
 * PR-104 — level 2. The band containing the line quantity applies **to the whole
 * line**, not marginally.
 *
 * Marginal would be the other obvious reading and is the wrong one: 40 sacks with a
 * band at 20 is 40 sacks at the band price, not 20 at one price and 20 at another.
 * PR-104 says "the whole line" in its own words, and a marginal implementation is
 * invisible until somebody adds up a large order by hand.
 *
 * The band set is stored ascending and validated as a set when written, so this takes
 * the last band whose threshold the quantity reaches and needs no tie-break — an
 * overlap is a definition-time refusal, never a counter-time coin toss.
 */
function resolveQuantityBreak({ productId, customer, qtyMilli, at }) {
  if (!qtyMilli || qtyMilli <= 0) return null;

  const level = (customer && customer.price_level) || 'RETAIL';
  const bands = productRepository.quantityBreaksAt(productId, level);
  if (bands.length === 0) return null;

  let chosen = null;
  for (const band of bands) {
    if (qtyMilli >= band.min_qty_milli) chosen = band;
  }
  if (!chosen) return null;

  return {
    price_centavos: chosen.price_centavos,
    effective_from: chosen.effective_from,
    band: { min_qty_milli: chosen.min_qty_milli, price_centavos: chosen.price_centavos },
  };
}

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
      // PR-104's band, so a line can say *which* break it got — "40 sacks or more" is
      // the sentence a customer queries, not "a discount".
      band: hit.band || null,
      // PR-103's note, which is the store's own account of what was agreed.
      note: hit.note || null,
    };
  }

  // PR-102: no retail price means the product is not sellable. Refused rather than
  // priced at zero — the refusal reaches the counter, a zero reaches the till.
  throw errors.conflict(
    'This product has no retail price yet, so it cannot be sold. Set one first.',
    { ruleId: 'PR-102' }
  );
}

/**
 * PR-104's quantity break, seen as PR-206 sees it: an automatic discount.
 *
 * ## Two rules describe the same thing, and both are honoured
 *
 * `PR-101` calls a quantity break a **price level** — level 2 of the precedence chain,
 * resolved by `resolveQuantityBreak` above. `PR-206` calls it an **automatic discount**
 * that must not compound with a manual one. Both are true, and reconciling them is the
 * whole of this function.
 *
 * The break resolves a price. What it *saves* — the gap between the level price the
 * customer would otherwise have paid and the band price — is the automatic discount
 * PR-206 weighs against anything the cashier typed. So:
 *
 *   • the break saves more than the manual discount → the band price applies, and the
 *     manual discount does not. The line is charged at the break, and its resolved
 *     level says `QUANTITY_BREAK`.
 *   • the manual discount is larger → **the break does not apply**. The line is charged
 *     at the ordinary level price less the manual discount, and its resolved level says
 *     so. That is PR-206's "the larger applies" read strictly: exactly one of them.
 *
 * Charging the band price outright, rather than the level price less the saving, is
 * deliberate. The two differ by a centavo whenever `mulQty` rounds, and the figure a
 * customer was quoted is the band price — not an arithmetic reconstruction of it.
 *
 * Returns null where there is no break to consider, which is every line of a store
 * that defines none.
 */
function quantityBreakSaving({ productId, customer, qtyMilli, at }) {
  const brk = resolveQuantityBreak({ productId, customer, qtyMilli, at });
  if (!brk) return null;

  // What the line would have cost at the level below the break — PR-101 levels 3–4.
  // Resolved through the same chain, minus the two levels above it, so a fall-through
  // to retail is handled by the code that already handles it.
  const base = resolveCustomerLevel({ productId, customer, at })
    || resolveRetail({ productId, at });
  if (!base) return null;

  const saving = money.mulQty(base.price_centavos, qtyMilli) - money.mulQty(brk.price_centavos, qtyMilli);
  if (saving <= 0) {
    // A band priced at or above the level price saves nothing. It is not an error —
    // a store may set one while a level price moves under it — and it is not a
    // discount either, so PR-206 has nothing to weigh.
    return null;
  }

  return {
    centavos: saving,
    rule_id: 'PR-104',
    band: brk.band,
    base_price_centavos: base.price_centavos,
    break_price_centavos: brk.price_centavos,
    why: `${quantityLabel(brk.band.min_qty_milli)} or more at `
      + `${money.toDisplay(brk.price_centavos)} (PR-104).`,
  };
}

/** The seam TASK-023 left, now filled. Kept for callers that want the shape alone. */
function automaticLineDiscount(context = {}) {
  return quantityBreakSaving(context) || { centavos: 0, rule_id: 'PR-104', why: null };
}

const quantityLabel = (milli) => (milli % 1000 === 0
  ? String(milli / 1000)
  : (milli / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));

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
 * `categories.max_discount_bp` defaults to NULL, so a store that caps nothing is
 * unaffected. Where it is set, this is the one place the direction is decided, and
 * `discountRuleService.bindingCeiling` is where it is decided — including *which* of
 * the two bound, which the refusal has to say. "5% is above your limit" is unactionable
 * to an owner who knows their ceiling is 100%.
 */
function effectiveCeilingBp(role, { categoryMaxDiscountBp = null } = {}) {
  return discountRuleService.bindingCeiling({
    roleCeilingBp: roleCeilingBp(role), categoryMaxDiscountBp,
  }).ceiling_bp;
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
  role, lineTotalCentavos, discountCentavos, categoryMaxDiscountBp = null,
  categoryName = null, approverRole = null,
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

  // PR-202: which of the two bound, kept so the refusal can name it.
  const binding = discountRuleService.bindingCeiling({
    roleCeilingBp: roleCeilingBp(role), categoryMaxDiscountBp, categoryName,
  });
  const ceilingBp = binding.ceiling_bp;
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
      allowed: true, reason: null, rule_id: binding.rule_id,
      requested_bp: requestedBp, ceiling_bp: ceilingBp,
      bound_by: binding.bound_by, category_name: binding.category_name,
      requires_role: null,
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

  // PR-202: **the refusal names which of the two ceilings bound.** Where the category
  // is the lower one, no approver exists — a manager cannot release a cap the owner
  // put on the category, and telling the cashier to fetch one would send them on an
  // errand that ends in the same refusal.
  const boundByCategory = binding.bound_by === 'CATEGORY';

  return {
    allowed: false,
    reason: boundByCategory ? 'ABOVE_CATEGORY_CEILING' : 'ABOVE_CEILING',
    rule_id: boundByCategory ? 'PR-202' : 'PR-203',
    bound_by: binding.bound_by,
    category_name: binding.category_name,
    message: boundByCategory
      ? `${formatBp(requestedBp)} is above the ${formatBp(ceilingBp)} cap on `
        + `${binding.category_name || 'that category'}. That cap overrides any role ceiling, `
        + 'so nobody at the counter can release it — the owner sets it on the category.'
      : `${formatBp(requestedBp)} is above your ${formatBp(ceilingBp)} limit. `
        + (approvers.length
          ? `A ${approvers.join(' or ').toLowerCase()} can approve it.`
          : 'Nobody may approve a discount this large.'),
    requested_bp: requestedBp,
    ceiling_bp: ceilingBp,
    // Nobody to fetch where the category is the binding one.
    requires_role: boundByCategory ? null : (approvers.join(' or ') || null),
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

// ── TAX-004 / TAX-005 — the statutory discount ──────────────────────────────

/**
 * TAX-004 — the claim, checked before anything is priced with it.
 *
 * Three refusals, in the order a counter meets them:
 *
 *   • the store does not grant it. `statutory_discount_enabled` ships **off** and this
 *     is what off means — not a discount of zero, which would price the cart as though
 *     the claim had been honoured and quietly give nothing.
 *   • the ID type is not one of the two. A senior citizen's ID and a PWD's come from
 *     different registries under different statutes, and "ID number" with no type is a
 *     record nobody can check against either.
 *   • the ID number or the beneficiary's name is missing. TAX-004 requires both to be
 *     captured, and a discount without them is not claimable — the store would be
 *     giving away 20% and be unable to deduct it.
 *
 * Returns the claim in the shape `sale_discounts` stores, or null where none was made.
 */
function normaliseStatutoryClaim(statutory) {
  if (!statutory) return null;

  if (!settingsService.get('statutory_discount_enabled')) {
    throw errors.conflict(
      'This store does not grant the senior citizen and PWD discount. The owner turns it '
      + "on in Settings, after checking with the store's accountant which goods qualify.",
      { ruleId: 'TAX-004' }
    );
  }

  const idType = String(statutory.idType || statutory.id_type || '').trim().toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(taxService.STATUTORY_ID_TYPES, idType)) {
    throw errors.badRequest(
      `A statutory discount needs the ID type: ${Object.keys(taxService.STATUTORY_ID_TYPES).join(' or ')}.`,
      { ruleId: 'TAX-004' }
    );
  }

  const idNo = String(statutory.idNo || statutory.id_no || '').trim();
  const name = String(statutory.name || '').trim();
  if (!idNo || !name) {
    throw errors.badRequest(
      'A statutory discount needs the ID number and the name on the ID. The law requires '
      + 'the record, and a discount without one cannot be claimed back.',
      { ruleId: 'TAX-004' }
    );
  }

  return { id_type: idType, id_no: idNo, name };
}

/** Whether a claim reaches this product at all (TAX-004's per-product flag). */
const statutoryReaches = (claim, product) => Boolean(claim) && Boolean(product.statutory_discount_eligible);

/**
 * PR-205 on a statutory line, where `computeLineTotal` cannot do it.
 *
 * That function refuses a discount larger than `unit price × quantity`, which on an
 * exempt line is the wrong ceiling: the discount is taken on the VAT-exclusive amount,
 * and a discount between the two figures would drive the line negative while passing
 * a check made against the larger one.
 */
function assertWithinLine(discountCentavos, baseCentavos, productName) {
  if (discountCentavos <= baseCentavos) return discountCentavos;
  throw errors.badRequest(
    `A discount of ${money.toDisplay(discountCentavos)} is more than the `
    + `${money.toDisplay(baseCentavos)} ${productName} comes to once the VAT is lifted. `
    + 'A discount may not make a line negative.',
    { ruleId: 'PR-205' }
  );
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
  transactionDiscountCentavos = 0, statutory = null, at = null,
}) {
  taxService.assertMode(taxMode);
  if (!Array.isArray(lines) || lines.length === 0) {
    throw errors.badRequest('A cart needs at least one line', { ruleId: 'POS-101' });
  }
  const when = at || clock.nowUtc();

  // TAX-004, before a single price is resolved: a claim the store does not grant, or
  // one without the record the law requires, is refused rather than priced.
  const claim = normaliseStatutoryClaim(statutory);

  // 1–2. Resolve each line server-side and take its line discount.
  const resolved = lines.map((line, index) => {
    const product = productRepository.findById(line.productId);
    if (!product) throw errors.notFound(`No such product on line ${index + 1}`);
    if (!product.is_active) {
      // INV-105: an inactive product may not be added to a cart, though its stock and
      // history remain.
      throw errors.conflict(`${product.name} is withdrawn and cannot be sold.`, { ruleId: 'INV-105' });
    }

    const listed = resolvePrice({ product, customer, qtyMilli: line.qtyMilli, at: when });

    // PR-202's ceiling for this line, joined onto the product rather than looked up
    // per line: twenty cart lines would otherwise be twenty round trips.
    const categoryMaxDiscountBp = product.category_max_discount_bp ?? null;

    // ── PR-206, at the line level ──
    //
    // A quantity break is a price to PR-101 and an automatic discount to PR-206, and
    // `quantityBreakSaving` is where those two readings meet — see its own note. A
    // customer-specific price is neither: PR-103 overrode the break, so there is no
    // automatic discount left to weigh, and a manual one applies as it always did.
    const brokeOnQuantity = listed.precedence === 'QUANTITY_BREAK';
    const automatic = brokeOnQuantity
      ? quantityBreakSaving({ productId: product.id, customer, qtyMilli: line.qtyMilli, at: when })
      : null;

    const chosen = discountRuleService.chooseDiscount({
      automaticCentavos: automatic ? automatic.centavos : 0,
      manualCentavos: line.discountCentavos || 0,
      automaticReason: automatic ? automatic.why : null,
      manualReason: line.discountReason || null,
    });

    // **Exactly one of them applies.** Where the manual discount is larger, the break
    // does not apply at all: the line is charged at the level price the customer would
    // otherwise have paid, less what was typed. Where the break wins, it is charged at
    // the band price with no discount — not at the level price less the saving, which
    // differs by a centavo whenever mulQty rounds and is not the figure the customer
    // was quoted.
    const manualBeatTheBreak = automatic !== null && chosen.source === 'MANUAL';
    const price = manualBeatTheBreak
      ? {
        ...listed,
        price_centavos: automatic.base_price_centavos,
        resolved_level: listed.requested_level,
        precedence: 'PRICE_LEVEL',
        rule_id: 'PR-206',
        band: null,
      }
      : listed;

    const voluntary = brokeOnQuantity && !manualBeatTheBreak ? 0 : chosen.applied_centavos;

    // ── TAX-004 / TAX-005, at the line level ──
    //
    // Only where the claim reaches this product. TAX-004 flags eligibility per product
    // for the reason its own text gives: feed for a farm is not for the beneficiary's
    // own use, so an agrivet's ordinary lines fall outside the entitlement and only
    // the ones the owner has flagged are inside it.
    const underStatutory = statutoryReaches(claim, product);
    const statutory_ = underStatutory
      ? taxService.statutoryLine({
        amountCentavos: money.mulQty(price.price_centavos, line.qtyMilli),
        taxClass: product.tax_class,
        taxMode,
      })
      : null;

    // TAX-005's choice, made against the amount the discount is actually taken on: in
    // VAT mode the line is exempt first, so a hand-typed discount on a statutory line
    // may not exceed the VAT-exclusive amount either (PR-205).
    const pick = underStatutory
      ? taxService.chooseStatutory({
        statutoryCentavos: statutory_.discount_centavos,
        voluntaryCentavos: assertWithinLine(voluntary, statutory_.base_centavos, product.name),
        voluntaryReason: chosen.why,
      })
      : null;

    const discount = pick ? (pick.source === 'VOLUNTARY' ? voluntary : 0) : voluntary;
    const statutoryDiscount = pick && pick.source === 'STATUTORY' ? statutory_.discount_centavos : 0;

    const totals = underStatutory
      ? {
        // The gross is still what the shelf says: unit price × quantity. What the
        // exemption removes is VAT the store never charged, and it is not a discount —
        // it is carried separately so no report or receipt can call it one.
        gross: money.mulQty(price.price_centavos, line.qtyMilli),
        discount,
        net: statutory_.base_centavos - pick.applied_centavos,
      }
      : money.computeLineTotal({
        unitPrice: price.price_centavos, qtyMilli: line.qtyMilli, lineDiscount: discount,
      });

    // What a discount is measured against, and what PR-205 and PR-201 bound it by. On
    // a statutory line in VAT mode that is the VAT-exclusive amount, not the shelf
    // gross — a 5% ceiling checked against a figure 12% larger is not a 5% ceiling.
    const discountable = underStatutory ? statutory_.base_centavos : totals.gross;

    // An automatic discount is the store's own decision and needs no authority — it is
    // the ceiling's business only where a person chose the figure. PR-201 is about
    // discount *authority*, and nobody exercised any.
    const discountDecision = discount === 0 || chosen.source === 'AUTOMATIC'
      ? {
        allowed: true, requested_bp: basisPoints(discount, discountable),
        ceiling_bp: effectiveCeilingBp(actorRole, { categoryMaxDiscountBp }),
        rule_id: chosen.source === 'AUTOMATIC' ? 'PR-106' : 'PR-201',
      }
      : evaluateDiscount({
        role: actorRole,
        lineTotalCentavos: discountable,
        discountCentavos: discount,
        categoryMaxDiscountBp,
        categoryName: product.category_name,
        approverRole,
      });

    // PR-105 against **everything** that came off the line, statutory included. The
    // entitlement is not a licence to sell below cost unnoticed, which is the same
    // sentence PR-103's negotiated price already answers to — and an owner who is
    // losing money on every senior sale of a thin-margin line is the person the
    // authorisation prompt exists to tell.
    const costDecision = evaluateBelowCost({
      unitPriceCentavos: price.price_centavos,
      qtyMilli: line.qtyMilli,
      discountCentavos: totals.gross - totals.net,
      avgCostCentavos: product.avg_cost_centavos,
      actorRole,
      authorisedByRole: approverRole,
    });

    return {
      index,
      product_id: product.id,
      sku: product.sku,
      name: product.name,
      // TAX-003, after TAX-004 has had its say: a statutory line in VAT mode is exempt
      // from here on, and the summary block, the sale row and the receipt all read it
      // from this one field.
      tax_class: statutory_ ? statutory_.tax_class : product.tax_class,
      product_tax_class: product.tax_class,
      category_id: product.category_id,
      category_name: product.category_name,
      category_max_discount_bp: categoryMaxDiscountBp,
      qty_milli: line.qtyMilli,
      unit_price_centavos: price.price_centavos,
      price_level: price.resolved_level,
      price_fell_through: price.fell_through,
      // PR-101's last sentence, with the detail behind it: which band, or what was
      // agreed and noted. "40 or more at ₱58" is the sentence a customer queries.
      price_rule_id: price.rule_id,
      quantity_band: price.band || null,
      customer_price_note: price.precedence === 'CUSTOMER_SPECIFIC' ? price.note : null,
      gross_centavos: totals.gross,
      line_discount_centavos: totals.discount,
      net_centavos: totals.net,
      // TAX-004's three figures, kept apart because they answer three different
      // questions: what the store gave away, what VAT it never charged, and what it
      // took the 20% on.
      statutory_discount_centavos: statutoryDiscount,
      vat_exemption_centavos: statutory_ ? statutory_.vat_exemption_centavos : 0,
      statutory_base_centavos: statutory_ ? statutory_.base_centavos : null,
      statutory_eligible: Boolean(product.statutory_discount_eligible),
      under_statutory: underStatutory,
      // TAX-005: which of the two applied, and what it beat. The screen is asked to
      // say why the other did not, and cannot without it.
      statutory_choice: pick,
      // PR-206, in the payload: which discount was used, and what was suppressed. The
      // screen is asked to say why the other one did not apply, and cannot without it.
      // TAX-005 can override the answer: a statutory discount that beat both is the
      // one the customer received, and the field says so rather than naming the loser.
      discount_source: pick && pick.source === 'STATUTORY' ? 'STATUTORY' : chosen.source,
      discount_choice: chosen,
      discount_decision: discountDecision,
      below_cost: costDecision,
    };
  });

  // TAX-004: a claim that reaches nothing is refused, not silently priced at nothing.
  // The cashier has asked for the customer's ID and typed it in; being handed a total
  // with no discount and no explanation is how a beneficiary is turned away by
  // accident.
  const statutoryLines = resolved.filter((l) => l.under_statutory);
  if (claim && statutoryLines.length === 0) {
    throw errors.conflict(
      'None of these products is eligible for the senior citizen and PWD discount. '
      + 'The entitlement covers goods for the beneficiary\'s own use, and the owner flags '
      + 'which of the store\'s products those are.',
      { ruleId: 'TAX-004' }
    );
  }

  // 3. Sum, then apportion the transaction discount (MON-006).
  const subtotal = resolved.reduce((sum, l) => sum + l.net_centavos, 0);
  money.assertCentavos(transactionDiscountCentavos, 'transaction discount');

  // ── TAX-005 at the basket level: a statutory line takes no share ──
  //
  // The rule forbids compounding, and a transaction discount apportioned across every
  // line compounds onto the statutory ones by the back door — the customer would have
  // received 20% *and* a share of the basket band, which is exactly the 25% TAX-005
  // exists to stop. So a line under the entitlement neither earns the tier nor
  // receives a share of it: it is priced by statute, and the store's own generosity
  // applies to the rest of the basket.
  const voluntaryLines = resolved.filter((l) => !l.under_statutory);
  const voluntarySubtotal = voluntaryLines.reduce((sum, l) => sum + l.net_centavos, 0);

  if (transactionDiscountCentavos > 0 && voluntaryLines.length === 0) {
    throw errors.badRequest(
      'Every line in this basket is under the senior citizen and PWD discount, so a '
      + 'further discount would compound with it. The customer receives the larger of '
      + 'the two, never both.',
      { ruleId: 'TAX-005' }
    );
  }

  // ── PR-106 — the tier, on the **pre-discount** subtotal ──
  //
  // The rule says pre-discount in its own words, so the band is chosen against the
  // gross of the basket rather than against a subtotal that has already had line
  // discounts taken off it. Measuring the tier against a figure the tier has already
  // moved is a fixed point nobody meant to compute — and it would make a basket earn a
  // smaller tier for having had a hand discount on one line, which is not a rule
  // anybody wrote.
  const preDiscountSubtotal = resolved.reduce((sum, l) => sum + l.gross_centavos, 0);
  // The tier is earned by the part of the basket it can be applied to (see above), so
  // a band chosen against the whole of it could not be given without compounding.
  const tier = discountRuleService.tierFor(
    voluntaryLines.reduce((sum, l) => sum + l.gross_centavos, 0)
  );

  // ── PR-206, at the transaction level ──
  //
  // The configured tier against the figure somebody typed. The larger applies; they do
  // not add. See discountRuleService's header for why the comparison is like-with-like
  // at each level rather than the tier suppressing line discounts too.
  const txnChoice = discountRuleService.chooseDiscount({
    automaticCentavos: tier.discount_centavos,
    manualCentavos: transactionDiscountCentavos,
    automaticReason: tier.why,
  });
  const appliedTransactionDiscount = txnChoice.applied_centavos;

  if (appliedTransactionDiscount > voluntarySubtotal) {
    // PR-205's second half: the sum of discounts may never exceed the subtotal. The
    // tier can reach here on its own — a band on the pre-discount subtotal, applied to
    // a basket whose lines were then discounted by hand, can exceed what is left.
    throw errors.badRequest(
      txnChoice.source === 'AUTOMATIC'
        ? `The ${discountRuleService.formatBp(tier.discount_bp)} basket discount comes to `
          + `${money.toDisplay(appliedTransactionDiscount)}, which is more than the `
          + `${money.toDisplay(voluntarySubtotal)} left after the line discounts. Reduce those first.`
        : `A transaction discount of ${money.toDisplay(appliedTransactionDiscount)} is more than the `
          + `${money.toDisplay(voluntarySubtotal)} subtotal.`,
      { ruleId: 'PR-205' }
    );
  }

  // PR-201/PR-203 apply to the transaction discount too, and only where a person chose
  // it: a tier is the owner's standing decision, not an exercise of anybody's ceiling.
  const txnDecision = appliedTransactionDiscount === 0 || txnChoice.source === 'AUTOMATIC'
    ? { allowed: true, requested_bp: basisPoints(appliedTransactionDiscount, voluntarySubtotal), rule_id: 'PR-106' }
    : evaluateDiscount({
      role: actorRole,
      lineTotalCentavos: voluntarySubtotal,
      discountCentavos: appliedTransactionDiscount,
      approverRole,
    });

  // MON-006 across the lines that may take a share; a statutory line takes none, and
  // the remainder lands on the largest of the rest rather than on it.
  const voluntaryShares = appliedTransactionDiscount === 0
    ? voluntaryLines.map(() => 0)
    : money.apportionDiscount(voluntaryLines.map((l) => l.net_centavos), appliedTransactionDiscount);

  const shareByIndex = new Map(voluntaryLines.map((l, i) => [l.index, voluntaryShares[i]]));
  const shares = resolved.map((l) => shareByIndex.get(l.index) || 0);

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

  // The transaction discount's own decision, in the same list. It is not a line, and a
  // caller that only walked the lines would complete a sale whose transaction discount
  // was above the cashier's ceiling — the one gap in "every blocking decision" that
  // v1.0 left, because a transaction discount could not be refused before PR-202.
  if (!txnDecision.allowed) {
    authorisations.push({
      line: null,
      product: null,
      rule_id: txnDecision.rule_id,
      message: txnDecision.message,
      requires_role: txnDecision.requires_role,
    });
  }

  return {
    priced_at: when,
    tax_mode: taxMode,
    customer_price_level: (customer && customer.price_level) || 'RETAIL',
    lines: priced,
    subtotal_centavos: subtotal,
    pre_discount_subtotal_centavos: preDiscountSubtotal,
    line_discount_centavos: priced.reduce((sum, l) => sum + l.line_discount_centavos, 0),
    // TAX-004 / TAX-005, as the sale row and every report want them: the statutory
    // discount is never folded into the voluntary figures, because they are different
    // claims and a total that merges them answers neither.
    statutory_discount_centavos: priced.reduce((sum, l) => sum + l.statutory_discount_centavos, 0),
    vat_exemption_centavos: priced.reduce((sum, l) => sum + l.vat_exemption_centavos, 0),
    statutory: claim
      ? {
        rule_id: 'TAX-004',
        ...claim,
        id_type_label: taxService.STATUTORY_ID_TYPES[claim.id_type].label,
        discount_bp: taxService.STATUTORY_DISCOUNT_BP,
        line_count: statutoryLines.length,
        eligible_line_count: resolved.filter((l) => l.statutory_eligible).length,
      }
      : null,
    transaction_discount_centavos: appliedTransactionDiscount,
    // PR-106 and PR-206 at the transaction level: the band the basket earned, whether
    // it applied, and what it beat or lost to. A screen that showed only the amount
    // could not tell a customer why their large basket earned nothing.
    transaction_tier: tier,
    transaction_discount_source: txnChoice.source,
    transaction_discount_choice: txnChoice,
    transaction_discount_decision: txnDecision,
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
  resolvePrice, precedenceLevels, automaticLineDiscount, quantityBreakSaving,
  resolveCustomerPrice, resolveQuantityBreak,
  roleCeilingBp, effectiveCeilingBp, evaluateDiscount, assertDiscountAllowed,
  basisPoints, maxDiscountCentavos, rolesAbove,
  evaluateBelowCost, assertNotBelowCost,
  normaliseStatutoryClaim,
  priceCart,
};
