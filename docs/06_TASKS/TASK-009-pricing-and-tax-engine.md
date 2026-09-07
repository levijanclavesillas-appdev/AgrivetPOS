# TASK-009 — Price resolution and the three-mode tax engine

**Priority:** **P1** · **Blocks release:** yes · **Blocks:** `TASK-011` ·
**Requirement:** `FR_3.2`, rules `PR-101`, `PR-102`, `PR-105`, `PR-201`–`PR-205`, `TAX-001`–`TAX-003`, `TAX-006`

---

## Objective

Resolve a line's price and its tax treatment as one pure, server-authoritative computation, so
that the sale transaction in `TASK-011` has nothing left to decide about money.

## Context

The client's tax answer was "cater both non-VAT, VAT, and not registered", so the engine takes the
store's `tax_mode` as an input rather than assuming one at build time (`01_PRODUCT_BRIEF.md` D-3).
Every product carries a `tax_class` in all three modes (`TAX-003`), which is why switching a store
from non-VAT to VAT later is a settings change and not a migration.

Levels 1 and 2 of the `PR-101` precedence — customer-specific price and quantity break — are v1.1
(`TASK-024`). **Build the precedence chain with all four levels now** and let the two unbuilt ones
return null; retrofitting a precedence order into a shipped pricing engine is how the wrong price
reaches a customer.

## Requirements

1. `resolvePrice({ product, customer, qtyMilli })` implementing `PR-101`'s four-level precedence,
   returning the price **and the level applied**, which the sale line records.
2. Missing wholesale or dealer price falls through to retail, never to zero (`PR-102`).
3. `computeTax({ lines, taxMode })` implementing `TAX-002`: `NONE` and `NON_VAT` produce zero tax
   and no VAT block; `VAT` decomposes each line **after discount** by its `tax_class` (`TAX-003`).
4. VAT decomposition per line, never in aggregate: `net = round(P / 1.12)`, `vat = P − net`, using
   the single rounding function from `TASK-002`.
5. Discount ceilings per role (`PR-201`), with a below-ceiling application returning success and an
   above-ceiling application returning a refusal naming the approving role (`PR-203`).
6. A resolved or discounted unit price below `avg_cost_centavos` returns a refusal requiring
   `TX-404` authorisation (`PR-105`).
7. A discount may not drive a line negative, nor may the sum exceed the subtotal (`PR-205`).
8. Everything in this task is a **pure function of its inputs**. It opens no transaction, reads no
   session, and writes nothing.

## Business Rules

- `PR-101`, `PR-102` — precedence and fall-through.
- `PR-105` — below-cost authorisation.
- `PR-201`, `PR-203`, `PR-204`, `PR-205` — discount ceilings, overrides, audit fields, floors.
- `TAX-001`, `TAX-002`, `TAX-003` — the three modes and the decomposition.
- `MON-003`, `MON-006` — the order of operations and apportionment, from `TASK-002`.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/pricingService.js`, `src/services/taxService.js` |
| Schema | None new — reads `product_prices`, `products.tax_class`, `store_profile.tax_mode` |
| API | `POST /sales/price-check` — resolves a whole cart without committing |
| Constraints | Pure; no transaction, no session, no writes. The client's prices are never trusted (`05_TECH_SPEC.md` §4.1 step 2). |

## Acceptance Criteria

- [ ] Precedence resolves customer → quantity break → level → retail, with the two v1.1 levels stubbed
- [ ] The resolved level is returned and is what the sale line records
- [ ] A wholesale customer with no wholesale price is charged retail, not zero
- [ ] `NONE` and `NON_VAT` produce zero tax and no VAT block
- [ ] `VAT` mode: inclusive ₱1,120 VATable → net ₱1,000, VAT ₱120
- [ ] A basket of VATable and exempt lines decomposes per line, not in aggregate
- [ ] A cashier discount above 2% is refused, naming the role that can approve it
- [ ] A below-cost price is refused without `TX-404`
- [ ] No discount can make a line negative

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-UT-31` | Precedence order |
| `TC-UT-32` | Fall-through to retail |
| `TC-UT-17`, `TC-UT-18`, `TC-UT-19` | The three tax modes and per-line decomposition |
| `TC-UT-34` | Discount ceiling refusal |
| `TC-UT-35` | Discount floor |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
