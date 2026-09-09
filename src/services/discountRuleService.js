'use strict';

// FT-306 — the discount rules the store *means* to give. PR-106, PR-202, PR-206.
//
// v1.0 had manual discounts with role ceilings and an override prompt. What it had not
// was any discount the owner had decided on in advance: a tier on a large basket, a
// lower ceiling on a category whose margin will not take one.
//
// Three rules, and two of them are easy to implement backwards.
//
//   **PR-202 inverts the usual direction.** A category maximum *overrides a higher
//   role ceiling*: the effective ceiling is the **lower** of the two. An owner with a
//   100% role ceiling still cannot give 20% on a category capped at 5%. Written the
//   obvious way round — "take the higher, the owner outranks the category" — it
//   produces a system in which the category cap does nothing for the only people who
//   could exceed it.
//
//   **PR-206 says the larger applies, not the sum.** A quantity break of 5% and a
//   cashier's 5% is 5%, not 10%. Compounding is how a line ends up below cost without
//   anybody choosing it, and PR-105 then refuses the sale with a queue behind it.
//
//   **PR-106's tiers are bands on the pre-discount subtotal, and at most one applies.**
//   The highest band the basket reaches, not every band it passes.
//
// ## What "on the same line" means, and the reading this file takes
//
// PR-206 names PR-104 (quantity breaks, per line) and PR-106 (tiers, per transaction)
// together, and says they do not compound with manual discounts "on the same line".
// PR-106 is not a line-level discount, so this file reads the rule as **comparing like
// with like at each level**:
//
//   • per line — the automatic line discount (a quantity break, TASK-024's) against
//     the manual line discount the cashier typed. The larger wins.
//   • per transaction — PR-106's tier against the manual transaction discount. The
//     larger wins.
//
// A line may therefore still carry both a line discount and a share of a transaction
// discount, as it could in v1.0. That is deliberate and the task's own acceptance
// criteria confirm it: "nothing compounds a line below cost **without PR-105 catching
// it**" is a sentence that only makes sense if cross-level compounding is still
// possible and PR-105 is the guard. The alternative reading — a tier silently
// suppressing a hand-given discount on one line of a large basket — surprises the
// counter in the other direction and nothing asks for it.

const errors = require('./errors');
const money = require('./money');
const settingsService = require('./settingsService');
const referenceRepository = require('../repositories/referenceRepository');

const BP_MAX = 10000;

// ── PR-106 — the tiers ──────────────────────────────────────────────────────

/**
 * Validate a tier list on its way into the registry.
 *
 * Ascending and non-overlapping is checked here rather than assumed at read time,
 * because a list that overlaps has no defined answer and the place to refuse it is
 * where somebody typed it — not on the third sale of the day.
 */
function validateTiers(list) {
  if (!Array.isArray(list) || list.length === 0) {
    throw errors.badRequest('Discount tiers are a list of bands', { ruleId: 'PR-106' });
  }

  const bands = list.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw errors.badRequest(
        `Tier ${index + 1} must be a band: a subtotal it starts at, and a discount.`,
        { ruleId: 'PR-106' }
      );
    }

    const min = Number.parseInt(entry.min_subtotal_centavos, 10);
    const bp = Number.parseInt(entry.discount_bp, 10);

    if (!Number.isInteger(min) || min < 0) {
      throw errors.badRequest(
        `Tier ${index + 1} needs the subtotal it starts at, in whole centavos (MON-001).`,
        { ruleId: 'PR-106' }
      );
    }
    if (!Number.isInteger(bp) || bp < 0 || bp > BP_MAX) {
      throw errors.badRequest(
        `Tier ${index + 1} needs a discount between 0% and 100%, in basis points.`,
        { ruleId: 'PR-106' }
      );
    }

    const label = typeof entry.label === 'string' ? entry.label.trim().slice(0, 60) : '';
    return {
      min_subtotal_centavos: min,
      discount_bp: bp,
      label: label || `${formatBp(bp)} over ${money.toDisplay(min)}`,
    };
  });

  // Ascending on both axes. A band that starts higher and gives less is not a tier,
  // it is a mistake — and it would be unreachable in the selection below, which is
  // the worst kind of configuration: present, plausible, and dead.
  const sorted = [...bands].sort((a, b) => a.min_subtotal_centavos - b.min_subtotal_centavos);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].min_subtotal_centavos === sorted[i - 1].min_subtotal_centavos) {
      throw errors.badRequest(
        `Two tiers start at ${money.toDisplay(sorted[i].min_subtotal_centavos)}. `
        + 'Bands may not overlap — only one tier ever applies (PR-106).',
        { ruleId: 'PR-106' }
      );
    }
    if (sorted[i].discount_bp < sorted[i - 1].discount_bp) {
      throw errors.badRequest(
        `The tier starting at ${money.toDisplay(sorted[i].min_subtotal_centavos)} gives less than `
        + `the one below it. A bigger basket may not earn a smaller discount.`,
        { ruleId: 'PR-106' }
      );
    }
  }

  return sorted;
}

function tiers() {
  const configured = settingsService.get('transaction_discount_tiers') || [];
  // Read through the same validator the writer used. A registry seeded before this
  // task existed, or edited straight in the database, is not a reason to price a cart
  // against a list nobody checked.
  return validateTiers(configured);
}

/**
 * PR-106 — the one tier this basket earns, or none.
 *
 * The **highest** band whose threshold the subtotal reaches. "At most one applies" is
 * the rule's own wording and the reason this returns a band rather than a list: a
 * function that returned every band the basket passed would put the choice — and the
 * chance of summing them — in every caller.
 *
 * The subtotal is the **pre-discount** one (PR-106's own words). Measuring the tier
 * against a subtotal that already had the tier taken off it is a fixed point nobody
 * meant to compute.
 */
function tierFor(preDiscountSubtotalCentavos) {
  money.assertCentavos(preDiscountSubtotalCentavos, 'subtotal');

  const bands = tiers();
  let chosen = null;
  for (const band of bands) {
    if (preDiscountSubtotalCentavos >= band.min_subtotal_centavos) chosen = band;
  }

  if (!chosen || chosen.discount_bp === 0) {
    return {
      applies: false,
      rule_id: 'PR-106',
      band: null,
      discount_bp: 0,
      discount_centavos: 0,
      // Why nothing applied, which is the question a counter asks when a customer
      // expected a discount: below every band, or the band gives nothing.
      why: bands.length === 0 || bands.every((b) => b.discount_bp === 0)
        ? 'This store has no basket discount configured.'
        : `${money.toDisplay(preDiscountSubtotalCentavos)} is below the first discount band.`,
    };
  }

  return {
    applies: true,
    rule_id: 'PR-106',
    band: chosen,
    discount_bp: chosen.discount_bp,
    discount_centavos: applyBp(preDiscountSubtotalCentavos, chosen.discount_bp),
    why: `${chosen.label} — the basket is over ${money.toDisplay(chosen.min_subtotal_centavos)}.`,
  };
}

// ── PR-202 — the category ceiling ───────────────────────────────────────────

/**
 * The maximum discount a category will take, in basis points, or null for no cap.
 *
 * Read from the category rather than cached: an owner who lowers a cap has lowered it,
 * and the next sale is the one that should feel it.
 */
function categoryCeilingBp(categoryId) {
  if (!categoryId) return null;
  const row = referenceRepository.findById('categories', categoryId);
  if (!row) return null;
  return row.max_discount_bp === null || row.max_discount_bp === undefined
    ? null
    : row.max_discount_bp;
}

/**
 * PR-202, stated so the direction cannot be got backwards: **the lower binds.**
 *
 * Returns which of the two it was, because the refusal has to say. "5% is above your
 * limit" is unactionable when the acting user is an owner who knows their ceiling is
 * 100% — what they need to be told is that Veterinary is capped at 5%, which is a
 * decision somebody made and can unmake.
 */
function bindingCeiling({ roleCeilingBp, categoryMaxDiscountBp = null, categoryName = null }) {
  if (roleCeilingBp === null || roleCeilingBp === undefined) {
    return { ceiling_bp: null, bound_by: 'NO_AUTHORITY', rule_id: 'TX-402', category_name: null };
  }
  if (categoryMaxDiscountBp === null || categoryMaxDiscountBp === undefined) {
    return { ceiling_bp: roleCeilingBp, bound_by: 'ROLE', rule_id: 'PR-201', category_name: null };
  }

  // The lower of the two. Where they are equal the role is named, because that is the
  // one the acting user can do something about by fetching somebody senior.
  if (categoryMaxDiscountBp < roleCeilingBp) {
    return {
      ceiling_bp: categoryMaxDiscountBp,
      bound_by: 'CATEGORY',
      rule_id: 'PR-202',
      category_name: categoryName,
    };
  }
  return { ceiling_bp: roleCeilingBp, bound_by: 'ROLE', rule_id: 'PR-201', category_name: null };
}

// ── PR-206 — the larger applies ─────────────────────────────────────────────

/**
 * Choose between an automatic discount and a manual one. They do not compound.
 *
 * Returns the chosen amount **and the one that was not used, with the reason** —
 * requirement 3 asks the screen to say which was used and why the other was not, and a
 * function that returned only a number would leave every caller to reconstruct that.
 *
 * Equal amounts resolve to the automatic one. It is the discount the store decided on
 * in advance, so a cashier keying the same figure by hand has added nothing, and
 * recording it as manual would put a name and a reason against a decision nobody made.
 */
function chooseDiscount({
  automaticCentavos = 0, manualCentavos = 0, automaticReason = null, manualReason = null,
}) {
  const auto = Math.max(automaticCentavos || 0, 0);
  const manual = Math.max(manualCentavos || 0, 0);

  if (auto === 0 && manual === 0) {
    return {
      applied_centavos: 0, source: 'NONE', rule_id: 'PR-206',
      automatic_centavos: 0, manual_centavos: 0, suppressed: null, why: null,
    };
  }

  const automaticWins = auto >= manual;

  return {
    applied_centavos: automaticWins ? auto : manual,
    source: automaticWins ? 'AUTOMATIC' : 'MANUAL',
    rule_id: 'PR-206',
    automatic_centavos: auto,
    manual_centavos: manual,
    // Named only where there was actually something to suppress. A manual discount of
    // nothing is not a discount that lost.
    suppressed: automaticWins && manual > 0
      ? { source: 'MANUAL', centavos: manual, reason: manualReason }
      : (!automaticWins && auto > 0 ? { source: 'AUTOMATIC', centavos: auto, reason: automaticReason } : null),
    why: automaticWins
      ? (manual > 0
        ? `${money.toDisplay(auto)} automatic beats ${money.toDisplay(manual)} entered by hand; `
          + 'they do not add together (PR-206).'
        : automaticReason)
      : `${money.toDisplay(manual)} entered by hand beats ${money.toDisplay(auto)} automatic; `
        + 'they do not add together (PR-206).',
  };
}

// ── What a screen needs, so it holds no copy ────────────────────────────────

/**
 * The policy `GET /sales/pricing-policy` serves.
 *
 * Every figure here is an operator-owned one, and a screen with its own copy is a
 * screen that is wrong the day an owner changes it — the rule `TC-UI-07` already
 * enforces for the settings screen, applied to the counter.
 */
function policy() {
  return {
    transaction_tiers: {
      rule_id: 'PR-106',
      bands: tiers(),
      note: 'Bands are on the subtotal before any discount, and at most one applies.',
    },
    category_ceilings: {
      rule_id: 'PR-202',
      note: 'A category maximum overrides a higher role ceiling: the lower of the two binds.',
      categories: referenceRepository.list('categories', { includeInactive: false })
        .filter((row) => row.max_discount_bp !== null && row.max_discount_bp !== undefined)
        .map((row) => ({ id: row.id, name: row.name, max_discount_bp: row.max_discount_bp })),
    },
    compounding: {
      rule_id: 'PR-206',
      compounds: false,
      note: 'An automatic discount and a manual one do not add together on a line. '
        + 'The larger applies, and the sale records which.',
    },
  };
}

const applyBp = (centavos, bp) => money.toSafeNumber(
  money.divRoundHalfUp(BigInt(centavos) * BigInt(bp), BigInt(BP_MAX)),
  'tier discount'
);

const formatBp = (bp) => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 2)}%`;

module.exports = {
  BP_MAX,
  validateTiers, tiers, tierFor,
  categoryCeilingBp, bindingCeiling,
  chooseDiscount,
  policy, applyBp, formatBp,
};
