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

- [ ] A customer price beats a quantity break for that customer and product
- [ ] The band containing the quantity applies, and boundaries land in exactly one band
- [ ] Overlapping or descending bands are refused at definition, naming the pair
- [ ] A negotiated price below cost still opens the authorisation panel
- [ ] The resolved level is named on the cart line and on the sale line
- [ ] `TC-UT-31` asserts four live levels, not two stubs

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-UT-31` | **Updated** — all four levels resolve |
| `TC-UT-48` | `PR-104`: band boundaries, and that exactly one band contains a quantity |
| `TC-UT-49` | `PR-103`: the customer price beats the break, and is still ceiling-bound |
| `TC-INT-93` | Overlapping bands refused at definition |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
