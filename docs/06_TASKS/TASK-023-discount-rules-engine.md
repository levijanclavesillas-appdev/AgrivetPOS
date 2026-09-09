# TASK-023 — Discount rules engine and category ceilings

**Priority:** **P2** for v1.1 · **Blocks release:** yes (v1.1) ·
**Requirement:** feature `FT-306`, rules `PR-106`, `PR-202`, `PR-206`, `PR-201`,
`PR-203`–`PR-205`, `OPS-005`, `AUD-601`

---

## Objective

Let the owner configure the discounts the store actually gives, and stop them compounding into
one nobody intended.

## Context

v1.0 has manual discounts with role ceilings (`PR-201`) and an authorisation panel above them.
What it has not is any discount the store *means* to give: a tier on a large basket, a lower
ceiling on a category whose margin will not take one.

**`PR-206` is the rule to build the engine around: automatic and manual discounts do not
compound on the same line — the larger applies.** A quantity break of 5% and a cashier's 5% is
5%, not 10%. Compounding is how a line ends up below cost without anybody choosing it, and
`PR-105` then refuses the sale at the counter with a queue behind it.

**`PR-202` inverts the usual direction and is easy to implement backwards.** A category
maximum **overrides a higher role ceiling**: the effective ceiling is the *lower* of role and
category. An owner with a 100% role ceiling still cannot give 20% on a category capped at 5%.

## Requirements

1. `PR-106`: transaction discount tiers — owner-configured ascending bands on the
   **pre-discount** subtotal, at most one applying. Configured in the settings registry
   (`OPS-005`), not in code.
2. `PR-202`: a per-category maximum discount, with the effective ceiling the **lower** of role
   and category. The refusal names which of the two bound it.
3. `PR-206`: automatic and manual do not compound on a line; the larger applies, and the screen
   says which was used and why the other was not.
4. Quantity breaks are `TASK-024`'s; this task defines the precedence they will slot into and
   must not need reworking when they arrive.
5. `PR-203`–`PR-205` continue to hold: authorisation above the ceiling, the audit trail with
   both actors, and the sum of discounts never exceeding the subtotal.
6. The pricing engine resolves all of it in one pass and reports every blocking decision per
   line, as it already does since `TASK-009` — a counter that has to fetch a manager twice for
   one sale is the defect that behaviour exists to prevent.
7. `GET /sales/pricing-policy` grows to serve the tiers and category ceilings, so no screen
   holds a copy (the rule `TC-UI-07` already enforces for settings).

## Business Rules

- `PR-106` — transaction tiers, ascending, at most one.
- `PR-202` — the category ceiling, and that it is the lower bound that wins.
- `PR-206` — no compounding; the larger applies.
- `PR-201`, `PR-203`–`PR-205` — role ceilings, authorisation, audit, and the total cap.
- `PR-105` — below-cost still opens the authorisation panel, whatever produced the price.
- `OPS-005` — the tiers are an operator-owned figure and live in the registry.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/pricingService.js` (extended), `discountRuleService.js`, settings registry entries |
| Schema | `categories.max_discount_bp`; tiers as a `JSON` setting — a short ordered list with no identity of its own, the same judgement as `till_reasons` |
| API | `GET /sales/pricing-policy` extended. **No new endpoint for pricing itself** — `POST /sales/price-check` already resolves a cart |
| Constraints | One resolver, as `TASK-009` established: two would drift, and the day they disagreed the counter and the report would each be sure they were right |

## Acceptance Criteria

- [x] A tier applies to a basket above its band, and only one tier ever applies
- [x] A category ceiling below the role ceiling binds, and the refusal says which did
- [x] An automatic 5% and a manual 5% yield 5%, not 10%
- [x] The larger of the two applies, and the screen says which and why
- [x] Nothing compounds a line below cost without `PR-105` catching it
- [x] No screen holds a copy of the tiers

## What it decided

**`PR-206` compares like with like at each level, and this is an interpretation.** The rule
names `PR-104` (per line) and `PR-106` (per transaction) together and says they do not compound
with manual discounts "on the same line" — but `PR-106` is not a line-level discount, so
"the same line" cannot be read literally for it. The engine therefore resolves the choice
**twice**: per line, a quantity break against the manual line discount; per transaction, the
tier against the manual transaction discount. The larger wins each time.

A line may still carry both a line discount and a share of a transaction discount, as it could
in v1.0. That is deliberate, and this task's own acceptance criteria confirm it — *"nothing
compounds a line below cost **without `PR-105` catching it**"* is a sentence that only makes
sense if cross-level compounding remains possible and `PR-105` is the guard. The alternative
reading, in which a basket tier silently suppresses a hand-given discount on one line, surprises
the counter in the other direction and nothing asks for it.

**A tier exercises nobody's discount authority.** `PR-201`'s ceilings are about who may *give*
a discount, and a tier is the owner's standing decision rather than anybody's act. So a cashier
whose limit is 2% may complete a basket that earns 5%, and the ceiling check applies only to the
figure a person typed. Reading it the other way round would make every large basket need a
manager, which is the opposite of what configuring a tier is for.

**A category cap offers no approver, and that is the point.** Where `PR-202` is the binding
ceiling, the refusal sets `requires_role` to **null**: no manager can release a cap the owner set
on the category, and naming one would send the cashier on an errand that ends in the same
refusal. Where the role is the binding ceiling the v1.0 behaviour is unchanged and an approver is
named.

**The tier is measured on the pre-discount subtotal**, as `PR-106` says in its own words —
`priceCart` now returns `pre_discount_subtotal_centavos` beside the net one. Measuring it against
a subtotal the tier has already moved is a fixed point nobody meant to compute, and measuring it
after line discounts would make a basket earn a *smaller* tier for having had a hand discount on
one line, which is not a rule anybody wrote.

**Requirement 4's seam is a function call, not a comment.** `pricingService.automaticLineDiscount`
returns zero today and is already fed through `PR-206`'s chooser by `priceCart`, so `TASK-024`
fills in one function and changes nothing else. A quantity break is modelled as a **discount off
the resolved price** rather than as a second price: `PR-101` resolves prices and `PR-206` governs
discounts, and a break arriving as a price would be an automatic discount that escaped the rule
saying automatic discounts do not compound with manual ones.

**One thing the registry needed.** The JSON coercion in `settingsService` cleaned every entry
with `String(item).trim()`, which is right for a list of words and gives `"[object Object]"` for
a band. A declaration whose entries are structured now supplies `validateList` — the same escape
hatch `validate` already provides for a `STRING` whose rule needs more than a type.

**What it did not do.** `PR-104`'s quantity breaks and `PR-103`'s customer-specific prices are
`TASK-024`'s and remain unresolved in `PRECEDENCE`, as `TASK-009` left them. The tiers have no
editor of their own on `SCR-702` beyond the registry's generic JSON list editor; a purpose-built
band editor is worth having and is not worth blocking this on.

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-UT-45` | `PR-106`: band selection, boundaries, and at most one tier |
| `TC-UT-46` | `PR-202`: the effective ceiling is the lower of role and category |
| `TC-UT-47` | `PR-206`: automatic and manual do not compound; the larger applies |
| `TC-INT-92` | The whole precedence, resolved in one pass, reporting every blocking decision |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
