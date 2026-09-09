'use strict';

// FT-306 — the discount rules engine. PR-106, PR-202, PR-206.
//
// Three unit cases, `TC-UT-45` to `TC-UT-47`, and each of them exists because the rule
// it covers is easy to implement backwards or additively:
//
//   `TC-UT-45` — PR-106's bands. At most **one** applies, and it is the highest the
//   basket reaches. An implementation that summed every band it passed would give a
//   ₱10,000 basket 2% + 5% + 8%, and would look right on a small one.
//
//   `TC-UT-46` — PR-202's direction. The **lower** of role and category binds. Written
//   the intuitive way round — "the owner outranks the category" — the cap does nothing
//   for the only people who could exceed it, which is the whole point of having one.
//
//   `TC-UT-47` — PR-206's arithmetic. The larger applies, **not the sum**. 5% and 5%
//   is 5%. This is the case that would pass against `a + b` for any input where one of
//   them is zero, which is most of them, so it is written with both non-zero.
//
// Unit rather than integration: none of the three touches a cart, a transaction or a
// price. They are arithmetic and policy, and testing them through `priceCart` would
// make a failure say "the total is wrong" rather than "the band selection is wrong".

const test = require('node:test');
const assert = require('node:assert/strict');
const discountRuleService = require('../../services/discountRuleService');
const pricingService = require('../../services/pricingService');
const settingsService = require('../../services/settingsService');
const temp = require('../helpers/tempdb');

let owner;

test.before(() => {
  temp.openMigrated('discount-rules');
  temp.seedStore({ taxMode: 'NONE', withOwner: false });
  temp.seedUser({ username: 'owner', role: 'OWNER', password: 'correct-horse-battery' });
  const authService = require('../../services/authService');
  owner = authService.verifyToken(
    authService.login({ username: 'owner', password: 'correct-horse-battery' }).token
  );
});

test.after(() => temp.cleanup());

/** Three ascending bands: 2% over ₱1,000, 5% over ₱5,000, 8% over ₱10,000. */
const BANDS = [
  { min_subtotal_centavos: 100000, discount_bp: 200, label: '2% over ₱1,000' },
  { min_subtotal_centavos: 500000, discount_bp: 500, label: '5% over ₱5,000' },
  { min_subtotal_centavos: 1000000, discount_bp: 800, label: '8% over ₱10,000' },
];

const withBands = (bands, run) => {
  const before = settingsService.get('transaction_discount_tiers');
  settingsService.set('transaction_discount_tiers', bands, owner);
  try { return run(); } finally { settingsService.set('transaction_discount_tiers', before, owner); }
};

// ── TC-UT-45 — PR-106 ───────────────────────────────────────────────────────

test('TC-UT-45: PR-106 — the highest band the basket reaches, and only one', () => {
  withBands(BANDS, () => {
    // Below every band.
    const none = discountRuleService.tierFor(99999);
    assert.equal(none.applies, false);
    assert.equal(none.discount_centavos, 0);
    assert.match(none.why, /below the first discount band/);

    // Exactly on a threshold is **in** the band. A band "over ₱1,000" that excluded
    // ₱1,000 would be a rule nobody could explain to a customer holding ₱1,000 of feed.
    const onBoundary = discountRuleService.tierFor(100000);
    assert.equal(onBoundary.applies, true);
    assert.equal(onBoundary.discount_bp, 200);
    assert.equal(onBoundary.discount_centavos, 2000, '2% of ₱1,000');

    // One centavo short of the next band is still the one below.
    const justUnder = discountRuleService.tierFor(499999);
    assert.equal(justUnder.discount_bp, 200);

    // And on it, the next.
    assert.equal(discountRuleService.tierFor(500000).discount_bp, 500);

    // **At most one.** A ₱10,000 basket passes all three bands and earns 8%, not
    // 2 + 5 + 8 = 15%. This is the assertion an additive implementation fails, and it
    // is the reason the function returns a band rather than a list.
    const big = discountRuleService.tierFor(1000000);
    assert.equal(big.discount_bp, 800);
    assert.equal(big.discount_centavos, 80000, '8% of ₱10,000, not 15%');
    assert.equal(big.band.label, '8% over ₱10,000');
  });
});

test('TC-UT-45: PR-106 — the bands are validated where they are typed, not at the till', () => {
  // Two bands starting at the same subtotal have no defined answer.
  assert.throws(
    () => discountRuleService.validateTiers([
      { min_subtotal_centavos: 100000, discount_bp: 200 },
      { min_subtotal_centavos: 100000, discount_bp: 500 },
    ]),
    (err) => err.ruleId === 'PR-106' && /may not overlap/.test(err.message)
  );

  // A bigger basket earning a smaller discount is a mistake, and the band would be
  // unreachable — present, plausible and dead, which is the worst kind of setting.
  assert.throws(
    () => discountRuleService.validateTiers([
      { min_subtotal_centavos: 100000, discount_bp: 800 },
      { min_subtotal_centavos: 500000, discount_bp: 200 },
    ]),
    (err) => err.ruleId === 'PR-106' && /gives less than/.test(err.message)
  );

  for (const bad of [
    [{ min_subtotal_centavos: -1, discount_bp: 200 }],
    [{ min_subtotal_centavos: 100000, discount_bp: 10001 }],
    [{ min_subtotal_centavos: 100000, discount_bp: -1 }],
    ['not a band'],
  ]) {
    assert.throws(() => discountRuleService.validateTiers(bad), (err) => err.ruleId === 'PR-106');
  }

  // Out of order in, sorted out — so `tierFor` may walk it once.
  const sorted = discountRuleService.validateTiers([
    { min_subtotal_centavos: 500000, discount_bp: 500 },
    { min_subtotal_centavos: 100000, discount_bp: 200 },
  ]);
  assert.deepEqual(sorted.map((b) => b.min_subtotal_centavos), [100000, 500000]);

  // A band with no label gets one that reads, because SCR-702 lists them.
  assert.equal(sorted[0].label, '2% over ₱1,000.00');
});

test('TC-UT-45: PR-106 — the registry refuses a bad band on the way in', () => {
  assert.throws(
    () => settingsService.set('transaction_discount_tiers', [
      { min_subtotal_centavos: 100000, discount_bp: 500 },
      { min_subtotal_centavos: 50000, discount_bp: 800 },
    ], owner),
    (err) => err.ruleId === 'PR-106'
  );

  // OPS-005: and it is a registered, owner-only setting rather than a constant.
  const declared = settingsService.REGISTRY.transaction_discount_tiers;
  assert.equal(declared.type, 'JSON');
  assert.equal(declared.ruleId, 'PR-106');
  assert.equal(declared.ownerOnly, true);
});

// ── TC-UT-46 — PR-202 ───────────────────────────────────────────────────────

test('TC-UT-46: PR-202 — the effective ceiling is the LOWER of role and category', () => {
  const roleBp = 10000;      // an owner: 100%

  // The direction that is easy to get backwards. An owner with a 100% ceiling still
  // cannot give 20% on a category capped at 5% — if this returned 10000, the cap would
  // do nothing for the only people able to exceed it.
  const capped = discountRuleService.bindingCeiling({
    roleCeilingBp: roleBp, categoryMaxDiscountBp: 500, categoryName: 'Veterinary',
  });
  assert.equal(capped.ceiling_bp, 500);
  assert.equal(capped.bound_by, 'CATEGORY');
  assert.equal(capped.rule_id, 'PR-202');
  assert.equal(capped.category_name, 'Veterinary');

  // And the other way: a cashier's 2% under a category capped at 5% is still 2%.
  const byRole = discountRuleService.bindingCeiling({
    roleCeilingBp: 200, categoryMaxDiscountBp: 500, categoryName: 'Veterinary',
  });
  assert.equal(byRole.ceiling_bp, 200);
  assert.equal(byRole.bound_by, 'ROLE');
  assert.equal(byRole.rule_id, 'PR-201');

  // Equal: the role is named, because that is the one the cashier can do something
  // about by fetching somebody senior.
  assert.equal(
    discountRuleService.bindingCeiling({ roleCeilingBp: 500, categoryMaxDiscountBp: 500 }).bound_by,
    'ROLE'
  );

  // No cap on the category leaves the role's ceiling alone — the v1.0 store.
  assert.equal(
    discountRuleService.bindingCeiling({ roleCeilingBp: 200, categoryMaxDiscountBp: null }).ceiling_bp,
    200
  );

  // No authority at all is a different refusal from a ceiling of zero.
  const none = discountRuleService.bindingCeiling({ roleCeilingBp: null, categoryMaxDiscountBp: 500 });
  assert.equal(none.ceiling_bp, null);
  assert.equal(none.bound_by, 'NO_AUTHORITY');
});

test('TC-UT-46: PR-202 — the refusal says which ceiling bound, and whether anybody can release it', () => {
  // An owner, above a category cap. Nobody can approve it: a manager cannot release a
  // cap the owner put on the category, and sending the cashier to fetch one would be
  // an errand that ends in the same refusal.
  const byCategory = pricingService.evaluateDiscount({
    role: 'OWNER',
    lineTotalCentavos: 100000,
    discountCentavos: 20000,           // 20%
    categoryMaxDiscountBp: 500,        // capped at 5%
    categoryName: 'Veterinary',
  });
  assert.equal(byCategory.allowed, false);
  assert.equal(byCategory.rule_id, 'PR-202');
  assert.equal(byCategory.bound_by, 'CATEGORY');
  assert.match(byCategory.message, /above the 5% cap on Veterinary/);
  assert.match(byCategory.message, /overrides any role ceiling/);
  assert.equal(byCategory.requires_role, null, 'there is nobody to fetch');

  // A cashier above their own ceiling on an uncapped category is the v1.0 refusal, and
  // it still names an approver.
  const byRole = pricingService.evaluateDiscount({
    role: 'CASHIER', lineTotalCentavos: 100000, discountCentavos: 3000,
  });
  assert.equal(byRole.rule_id, 'PR-203');
  assert.equal(byRole.bound_by, 'ROLE');
  assert.match(byRole.message, /above your 2% limit/);
  assert.ok(byRole.requires_role);

  // Within the category cap, an owner is fine and the decision names PR-202 as the
  // ceiling that applied — not PR-201, which would misattribute the limit.
  const within = pricingService.evaluateDiscount({
    role: 'OWNER', lineTotalCentavos: 100000, discountCentavos: 400,
    categoryMaxDiscountBp: 500, categoryName: 'Veterinary',
  });
  assert.equal(within.allowed, true);
  assert.equal(within.ceiling_bp, 500);
  assert.equal(within.bound_by, 'CATEGORY');
});

// ── TC-UT-47 — PR-206 ───────────────────────────────────────────────────────

test('TC-UT-47: PR-206 — automatic and manual do not compound; the larger applies', () => {
  // The case the rule is written for, and the one an additive implementation passes on
  // every other input: both non-zero, and equal.
  const equal = discountRuleService.chooseDiscount({
    automaticCentavos: 500, manualCentavos: 500,
  });
  assert.equal(equal.applied_centavos, 500, '5% and 5% is 5%, not 10%');
  assert.equal(equal.source, 'AUTOMATIC', 'a tie goes to the store’s own decision');
  assert.equal(equal.suppressed.source, 'MANUAL');
  assert.match(equal.why, /do not add together/);

  // The larger applies, either way round.
  const manualWins = discountRuleService.chooseDiscount({
    automaticCentavos: 300, manualCentavos: 900, manualReason: 'Damaged sack',
  });
  assert.equal(manualWins.applied_centavos, 900);
  assert.equal(manualWins.source, 'MANUAL');
  assert.equal(manualWins.suppressed.source, 'AUTOMATIC');
  assert.equal(manualWins.suppressed.centavos, 300);

  const autoWins = discountRuleService.chooseDiscount({
    automaticCentavos: 900, manualCentavos: 300, automaticReason: '5% over ₱5,000',
  });
  assert.equal(autoWins.applied_centavos, 900);
  assert.equal(autoWins.source, 'AUTOMATIC');
  assert.equal(autoWins.suppressed.centavos, 300);

  // Nothing suppressed where there was nothing to suppress: a manual discount of zero
  // is not a discount that lost, and reporting it as one would put a sentence on the
  // screen about a decision nobody made.
  const onlyAuto = discountRuleService.chooseDiscount({
    automaticCentavos: 500, manualCentavos: 0, automaticReason: '5% over ₱5,000',
  });
  assert.equal(onlyAuto.suppressed, null);
  assert.equal(onlyAuto.why, '5% over ₱5,000');

  const neither = discountRuleService.chooseDiscount({});
  assert.equal(neither.applied_centavos, 0);
  assert.equal(neither.source, 'NONE');
  assert.equal(neither.suppressed, null);
});

test('TC-UT-47: PR-206 — the sum is never the answer, at any pair of figures', () => {
  // Property-style, because "the larger applies" is one line and getting it wrong is
  // one character. Every pair must yield one of the two inputs and never their sum.
  for (const auto of [0, 1, 250, 999, 100000]) {
    for (const manual of [0, 1, 250, 999, 100000]) {
      const chosen = discountRuleService.chooseDiscount({
        automaticCentavos: auto, manualCentavos: manual,
      });
      assert.equal(chosen.applied_centavos, Math.max(auto, manual),
        `auto ${auto} against manual ${manual}`);
      if (auto > 0 && manual > 0 && auto !== manual) {
        assert.notEqual(chosen.applied_centavos, auto + manual, 'never the sum');
      }
    }
  }
});

// ── The policy a screen renders and does not copy ───────────────────────────

test('requirement 7: the policy is served whole, so no screen holds a copy', () => {
  withBands(BANDS, () => {
    const policy = discountRuleService.policy();

    assert.equal(policy.transaction_tiers.rule_id, 'PR-106');
    assert.equal(policy.transaction_tiers.bands.length, 3);
    assert.match(policy.transaction_tiers.note, /at most one applies/);

    assert.equal(policy.category_ceilings.rule_id, 'PR-202');
    assert.match(policy.category_ceilings.note, /the lower of the two binds/);

    // PR-206, said in the payload rather than left for a screen to know.
    assert.equal(policy.compounding.compounds, false);
    assert.match(policy.compounding.note, /do not add together/);
  });
});
