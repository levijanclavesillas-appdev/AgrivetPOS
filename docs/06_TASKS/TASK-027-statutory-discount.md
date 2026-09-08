# TASK-027 — Senior citizen and PWD statutory discount

**Priority:** **P2** for v1.1, **P1 the day the store is asked for one** ·
**Blocks release:** yes (v1.1) · **Requirement:** feature `FT-309`,
rules `TAX-004`, `TAX-005`, `TAX-002`, `TAX-003`, `PR-204`, `AUD-601`

---

## Before starting — 1 answer is needed

**Is the store required to grant it?** RA 9994 and RA 10754 grant a 20% discount and VAT
exemption on goods *for the personal use of* a senior citizen or PWD. Whether an agrivet's
stock qualifies is a question for the store's accountant, not for this backlog — feed for a
farm is not personal use; a sack for a household's chickens might be argued either way.

`TAX-004` ships it **default OFF** for exactly that reason. This task builds it correctly and
leaves it off; turning it on is the store's decision with their accountant, and the setting
records who turned it on and when.

## Objective

Support the statutory discount correctly for the day the store needs it, and refuse to guess
about it until then.

## Context

The rule has been in `03_BUSINESS_RULES.md` since the specification and the schema has carried
`statutory_discount_centavos` on the sale and `statutory_discount_eligible` on the product
since `TASK-011` — unused, deliberately, so that turning this on is a configuration change and
not a migration.

**`TAX-005` is the rule that is most often implemented wrongly, and expensively:** a statutory
discount is computed **before** any voluntary discount, and the two **do not compound** — the
customer receives the better of the two, not both. A shop that gives 20% statutory on top of a
5% loyalty discount is giving 25% and cannot claim the difference back.

**In `VAT` mode the discount carries a VAT exemption**, which is not the same thing as a 20%
price cut: the line becomes VAT-exempt and the 20% applies to the VAT-exclusive amount. Getting
that backwards misstates both the discount and the output VAT.

## Requirements

1. `TAX-004`: off by default, enabled per store in the settings registry, owner-only, audited.
2. The sale records the statutory ID type, ID number and name (`sale_discounts` already carries
   the columns) — the law requires the record, and a discount without one is not claimable.
3. `TAX-005`: computed **before** voluntary discounts; the two do not compound; the customer
   receives the better.
4. Per-product eligibility via `products.statutory_discount_eligible`, which exists and is
   currently always false.
5. In `VAT` mode: the line becomes VAT-exempt and the 20% applies to the VAT-exclusive amount
   (`TAX-002`, `TAX-003`). In `NONE` and `NON_VAT` there is no VAT to exempt and the 20%
   applies to the selling price.
6. The receipt prints the statutory discount, the ID and the name, as the law requires.
7. Reports separate statutory from voluntary discounts — they are different claims and a total
   that merges them answers neither.
8. `PR-204`: recorded in `sale_discounts` with its type, as every other discount is.

## Business Rules

- `TAX-004` — supported, configurable, default off.
- `TAX-005` — before voluntary, never compounding, the better of the two.
- `TAX-002`, `TAX-003` — what VAT exemption means per mode.
- `PR-204` — every discount is recorded with its type and its actor.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/taxService.js`, `pricingService.js`, `saleService.js`, `printService.js`, the payment screen |
| Schema | None — `sale_discounts.statutory_id_type`, `statutory_id_no`, `statutory_name`, `sales.statutory_discount_centavos` and `products.statutory_discount_eligible` all exist and are unused |
| API | `POST /sales` accepts a statutory block; `GET /sales/pricing-policy` reports whether it is enabled |
| Constraints | Off by default · the arithmetic is a unit-tested pure function before it is wired anywhere near a sale |

## Acceptance Criteria

- [ ] Off by default, and a sale that claims it while off is refused
- [ ] A 20% statutory and a 5% voluntary yield 20%, not 25%
- [ ] In `VAT` mode the line is VAT-exempt and the 20% is on the VAT-exclusive amount
- [ ] The ID type, number and name are recorded and printed
- [ ] Reports separate statutory from voluntary
- [ ] Enabling it is owner-only and audited

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-UT-50` | `TAX-005`: statutory before voluntary, no compounding, the better applies |
| `TC-UT-51` | `VAT` mode: exemption and the 20% on the VAT-exclusive amount |
| `TC-INT-101` | Off by default; a claim while off is refused; enabling is audited |
| `TC-INT-102` | The ID and name reach the sale, the receipt and the report |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
