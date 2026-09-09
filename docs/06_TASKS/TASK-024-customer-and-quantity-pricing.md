# TASK-024 — Customer-specific and quantity-break pricing

**Priority:** **P2** for v1.1 · **Blocks release:** yes (v1.1) ·
**Blocked by:** `TASK-023` (the precedence it slots into) ·
**Requirement:** features `FT-211`, `FT-212`, rules `PR-103`, `PR-104`, `PR-101`,
`PR-202`, `AUD-601`

---

## Objective

Fill the two levels of `PR-101`'s precedence chain that have been stubbed since `TASK-009`.

## Context

`PR-101` names four levels and `TASK-009` built the chain with the top two stubbed, which is
why `TC-UT-31` asserts *"the precedence chain has all four levels, with the two v1.1 ones
stubbed"*. This task fills them, and the resolver was written expecting it.

**`PR-103` is absolute: a customer-specific price overrides all others for that customer and
product, including quantity breaks.** A farm that has negotiated ₱58 a kilo pays ₱58 a kilo,
whether they buy one sack or forty. It is still subject to `PR-202`'s ceiling and `PR-105`'s
below-cost check — a negotiated price is not a licence to sell below cost unnoticed.

**`PR-104` is where the arithmetic goes wrong quietly.** Bands are ascending and
non-overlapping on `min_qty_milli`, and the band containing the line's quantity applies —
*the* band, singular. Overlapping bands are a validation failure at definition, not a
tie-break at the counter.

## Requirements

1. `PR-103`: customer-specific prices per (customer, product), overriding every other level.
2. `PR-104`: quantity breaks per (product, price level) as ascending, non-overlapping
   `min_qty_milli` bands. Overlap or descent is refused when defined, with the offending pair
   named.
3. The full `PR-101` chain resolves in one pass, and the resolved level is **named on the
   line** — the POS screen already renders it, and has since `TASK-015`.
4. Both are subject to `PR-202`'s category ceiling and `PR-105`'s below-cost authorisation.
5. `PR-206`: a quantity break is an automatic discount and does not compound with a manual one.
6. `MON-005`: the resolved price is snapshotted on the sale line, so a negotiated price
   changing next month does not restate last month's margin.
7. Changing a customer price or a break is audited with both values (`AUD-601`).
8. `TC-UT-31` is **updated, not replaced**: it currently asserts two levels are stubbed and must
   assert all four resolve.

## Business Rules

- `PR-103` — customer-specific overrides everything for that pair.
- `PR-104` — ascending, non-overlapping bands; the containing band applies.
- `PR-101`, `PR-102` — the precedence chain and its fall-through.
- `PR-202`, `PR-105` — the ceiling and the below-cost floor still bind.
- `MON-005` — the resolved price is snapshotted at the sale.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/pricingService.js` (the two stubs), `productService.js`, `customerService.js`, the catalogue and customer screens |
| Schema | `customer_prices`, `product_quantity_breaks` |
| API | `PUT /customers/:id/prices`, `PUT /products/:id/quantity-breaks` |
| Constraints | One resolver · a band set is validated as a set, not row by row · no screen computes a price |

## Acceptance Criteria

- [x] A customer price beats a quantity break for that customer and product
- [x] The band containing the quantity applies, and boundaries land in exactly one band
- [x] Overlapping or descending bands are refused at definition, naming the pair
- [x] A negotiated price below cost still opens the authorisation panel
- [x] The resolved level is named on the cart line and on the sale line
- [x] `TC-UT-31` asserts four live levels, not two stubs

## What it decided

**A quantity break is a price to `PR-101` and an automatic discount to `PR-206`, and both
readings are honoured.** The break resolves a price — level 2 of the chain. What it *saves*,
against the level price the customer would otherwise have paid, is the automatic discount
`PR-206` weighs against anything the cashier typed. Exactly one of them applies:

* the break saves more → the line is charged **at the band price** with no discount, and its
  resolved level says `QUANTITY_BREAK`;
* the manual discount is larger → **the break does not apply at all**. The line is charged at the
  ordinary level price less the manual discount, and its resolved level says so.

Charging the band price outright rather than the level price less the saving is deliberate: the
two differ by a centavo whenever `mulQty` rounds, and the figure the customer was quoted is the
band price, not an arithmetic reconstruction of it. `TASK-023` had guessed the break would arrive
as a discount rather than a price; it arrives as both, and the seam it left took the reconciling
function without changing shape.

**`PR-103` needs no code to be absolute.** A customer price is level 1, the chain stops at the
first level that answers, and the precedence *is* the implementation — no comparison with the
break, no cheaper-of. A farm that negotiated ₱58 pays ₱58 at forty sacks even where the break
would have been ₱50. `TC-UT-49` asserts exactly that, with a break deliberately cheaper than the
deal, because the plausible-looking mistake is to take the lower of the two.

**A band set is written whole, and validated as a set.** Ascending, non-overlapping and each band
cheaper than the one below are properties of the set: a single band always satisfies all three,
so no `CHECK` can express any of them. The refusal names the offending pair, because "these bands
overlap" against a list of six is a message somebody has to work through by hand.

**And the band table holds the current set rather than a history, which the first design got
wrong.** `customer_prices` is append-only like `product_prices`, and the bands started out the
same way — a revision writing a new generation under a fresh `effective_from`. That cannot
express the one state a band set genuinely reaches and a price never does: **no bands at all**.
An empty generation writes no rows, so "remove the breaks" left the previous set in force, and
the editor's own sentence — *"leave the table empty to remove them"* — was a lie. Driving the
editor in a real browser found it in one click. A revision now clears the level and writes the
new set in one transaction, and the history lives on `AUD-601`'s trail, which already carried the
whole set both ways.

**A band that could never lower a price is refused too**, though no rule asks for it. A set whose
cheapest band is at or above the level price is not an error the schema can see and not a break
either; it would sit in the table looking like a discount and never give one, which is the same
"present, plausible and dead" failure `TASK-023` refused for a descending tier.

**Both write paths are `TX-411`, not `TX-410` or `TX-413`.** A quantity break and a customer
price are selling prices; §10's "create or edit a customer" reaches a cashier, and a cashier
should not be agreeing prices. The read paths stay where the reader already is — `TX-422` for the
product's bands, `TX-413` for the customer's list.

**`PR-105` is checked at the sale, not at the agreement**, and the agreement says so. A
negotiated price below cost is a decision an owner may take; the authorisation belongs where the
cost of the day applies. What `PUT /customers/:id/prices` does is warn in its response, so nobody
agrees one by accident and discovers it at the counter with a queue behind them.

**`TC-UT-31` is updated, not replaced**, as requirement 8 asked — and it needed more than
inverting the assertion. It used to check `step.resolve({}) === null`, which a real resolver also
satisfies when handed an empty context, so the case would have gone on passing against stubs.
It now walks the chain with real data at each level.

**What it did not do.** There is no bulk editor for customer prices — one product at a time
through the profile, which is how the store agrees them. And a customer price cannot yet be
*removed* through the API: superseding it with a new figure works, but "we no longer have a deal"
has no representation, because a row cannot say "no price" and a price of zero would give the
product away. That wants a soft-delete column and a rule to justify it.

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-UT-31` | **Updated** — all four levels resolve |
| `TC-UT-48` | `PR-104`: band boundaries, and that exactly one band contains a quantity |
| `TC-UT-49` | `PR-103`: the customer price beats the break, and is still ceiling-bound |
| `TC-INT-93` | Overlapping bands refused at definition |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
