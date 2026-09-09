# TASK-027 — Senior citizen and PWD statutory discount

**Priority:** **P2** for v1.1, **P1 the day the store is asked for one** ·
**Blocks release:** yes (v1.1) · **Requirement:** feature `FT-309`,
rules `TAX-004`, `TAX-005`, `TAX-002`, `TAX-003`, `PR-204`, `AUD-601`

---

> **Closed.** Built, tested and off. The answer below was **not** given — and did not need to be
> for this task to land: the discount is implemented correctly, `statutory_discount_enabled` ships
> `false`, and turning it on is an owner's decision with their accountant, recorded with who did it
> and when. What ships is the machinery and the refusal, not a guess about the entitlement.

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
| Files | `src/services/taxService.js`, `pricingService.js`, `saleService.js`, `printService.js`, `reportService.js`, the POS screen (`F8`, where the claim is made) and the payment screen (where it is confirmed) |
| Schema | None — `sale_discounts.statutory_id_type`, `statutory_id_no`, `statutory_name`, `sales.statutory_discount_centavos` and `products.statutory_discount_eligible` all exist and are unused |
| API | `POST /sales` and `POST /sales/price-check` accept a statutory block; `GET /sales/pricing-policy` reports whether it is enabled, at what rate and on which ID types |
| Constraints | Off by default · the arithmetic is a unit-tested pure function before it is wired anywhere near a sale |

## Acceptance Criteria

- [x] Off by default, and a sale that claims it while off is refused — `409`, `TAX-004`, and no row written
- [x] A 20% statutory and a 5% voluntary yield 20%, not 25%
- [x] In `VAT` mode the line is VAT-exempt and the 20% is on the VAT-exclusive amount
- [x] The ID type, number and name are recorded and printed
- [x] Reports separate statutory from voluntary
- [x] Enabling it is owner-only and audited

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-UT-50` | `TAX-005`: statutory before voluntary, no compounding, the better applies |
| `TC-UT-51` | `VAT` mode: exemption and the 20% on the VAT-exclusive amount |
| `TC-INT-101` | Off by default; a claim while off is refused; enabling is audited |
| `TC-INT-102` | The ID and name reach the sale, the receipt and the report |

---

## What was decided here, that the rule did not settle

**Is the VAT exemption weighed against a voluntary discount?** `TAX-005` says the customer
receives the larger of the statutory and the voluntary discount. In `VAT` mode the entitlement is
two things at once — an exemption and a 20% — and reading them as one figure would let a 6%
clearance discount cancel a beneficiary's VAT exemption, which is not the store's to withhold. So
**the exemption stands whichever discount wins, and only the 20% is in the scale.** A line under
the entitlement is exempt; what varies is whether the 20% or the store's own discount comes off it.

**Does a basket discount reach a statutory line?** No, and this is where compounding would have
crept back in by the back door: `PR-106`'s tier is apportioned across lines (`MON-006`), and a
statutory line taking its share would have received 20% *and* a slice of the band — exactly the 25%
`TAX-005` forbids. A line under the entitlement therefore neither earns the tier nor takes a share
of it, and a transaction discount on a basket with nothing else in it is refused rather than
silently dropped.

**A statutory row is written even where the voluntary discount won.** The beneficiary presented an
ID, the line was sold as exempt on the strength of it, and a claim with no record of whose ID it was
made on is not a claim. The row carries the ID and a `discount_centavos` of zero, and its reason
says which way `TAX-005` went.

## What it found on the way — a defect nobody could have seen at 3 p.m.

`POS-207`'s duplicate-reference check built its window as the Manila date at **UTC** midnight,
which is the Manila day slid eight hours late. Between midnight and 08:00 Manila the window began
in the future, the check found nothing, and a double-keyed GCash reference went through unremarked
— on a store that opens at seven, the first hour of every day. `TC-INT-38` had been asserting it
all along and only fails when the suite is run in those hours, which is how it survived: this task
happened to be worked at 23:20 UTC.

`auditService` had done the same conversion correctly since `TASK-005`. The bug was a *second*
implementation of one idea, and the fix is to delete it: `saleService` now asks `auditService` for
the day's bounds. Nothing else shared the mistake — `returnService` and `stockCountService` use the
same expression on **both** sides of a subtraction, where the eight hours cancel.

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
