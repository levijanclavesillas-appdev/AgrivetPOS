# TASK-033 — Sales analysis: category, cashier, movers and movement

**Priority:** **P2** for v1.2 — the owner has the day's total and not the reasons for it ·
**Blocks release:** yes (v1.2) ·
**Requirement:** feature `FT-602` (the v1.2 half), `FT-605`'s margin applied per grouping,
rules `RPT-101`, `RPT-104`, `RPT-106`, `MON-005`, `INV-102`, `TX-421`, `TX-422`

---

## Objective

Break the sales the store already reports into the groupings an owner buys and staffs by —
category, cashier, and what is and is not moving — and put the ledger's own movement history
beside them.

## Context

`FT-602` shipped its first word in v1.0: **daily** is built, reconciles (`RPT-101`), and
`reportRepository.dailyLines` already groups by product with revenue, cost and margin per row.
`FT-605`'s gross profit arrived early, in `TASK-016`, and reads the sale-line cost snapshot as
`RPT-104` requires. So this task is not new arithmetic. It is the same arithmetic grouped three
more ways, plus one report that is genuinely different.

**The one that is genuinely different is slow movers, and it cannot be built from `sale_items`.**
Every existing report starts at a sale line and groups. A product that sold nothing has no sale
line, so it is not in the result at all — and *products that sold nothing* is precisely what a
slow-mover report is for. It has to start from the catalogue and left-join the period's sales,
which is the opposite direction from every query in `reportRepository` today. `dailyLines` makes
the same point from the other end: it is `ORDER BY revenue DESC LIMIT 500`, so the slow half of
the catalogue is exactly what that `LIMIT` throws away.

**A mover is a quantity question, not a money one, and the report should answer both.** A sack of
feed at ₱1,400 and a sachet at ₱35 sort in opposite orders by revenue and by units. The store
uses the units figure to decide what to reorder and the revenue figure to decide what to stock
more of, so ranking by only one of them answers half the question — with the catch that
quantities across products are not comparable in the base unit (`UOM-001`), 40 KG against 40
sachets, which is why the ranking is per category or explicitly per unit.

**Movement analysis is `INV-102`'s ledger read as a report.** Every increase and decrease has
been append-only since `TASK-007`, typed by `INV-103` — `RECEIPT`, `SALE`, `DAMAGE`, `EXPIRY`,
`COUNT_VARIANCE`, `INTERNAL_USE` and the rest. Nothing has ever summarised them, so the store
cannot see that it wrote off ₱18,000 of damage this quarter. This is a `TX-422` inventory report,
not a `TX-421` sales one, and the split matters: the inventory clerk should read it.

**`RPT-106` binds all of them**, and `TX-421`'s `OWN_SHIFT` scope still applies — a cashier
asking for a store-wide breakdown is refused by `assertShiftScope`, which is already written.

## Requirements

1. Sales by **category**, for a range: revenue net of VAT, cost, gross profit and margin
   (`RPT-104`), reconciling to the daily report's totals for the same range.
2. Sales by **cashier**, same measures, plus transaction count and average transaction value.
   Scoped by `TX-421` — a cashier sees their own shifts and no one else's.
3. Sales by **product** — already served by `dailyLines`; lift it into its own report with the
   limit and the sort under the reader's control rather than fixed at 500 by revenue.
4. **Fast movers**: top N by units and by revenue, over a range, with the two rankings shown as
   two rankings and not merged into one.
5. **Slow movers**: products with sales below a threshold **including zero**, built from the
   catalogue outward. Inactive products are excluded, and products created inside the range are
   flagged rather than judged.
6. Every grouping carries days-of-stock or last-sold where it is the figure that makes the row
   actionable — a slow mover with 200 units on hand is a different problem from one with 2.
7. **Movement analysis**: quantity and value by `INV-103` movement type over a range, by product
   and in total, from `inventory_movements` alone. Behind `TX-422`.
8. Each report reconciles to something already trusted: category and cashier totals sum to the
   daily report's net; movement totals reconcile to the on-hand change over the range.
9. `RPT-106` header on all of them, CSV export on all of them.
10. `TC-PERF-05`'s budget is the bar: these run at `TC-PERF-06`'s seeded scale — 5,000 products,
    60,000 sales in a year — without a table scan per row.

## Business Rules

- `RPT-101` — the daily identity these must reconcile against.
- `RPT-104`, `MON-005` — profit reads the line's cost snapshot, revenue is net of VAT.
- `RPT-106` — range, tax mode, voids excluded from net and not from sight.
- `INV-102`, `INV-103` — the append-only ledger and its declared types.
- `TX-421`, `TX-422` — sales reports and inventory reports are different permissions.
- `UOM-001` — quantities are in the base unit, which is why cross-product ranking by units needs
  a stated scope.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/reportService.js`, `src/repositories/reportRepository.js`, `public/js/reports/report.js` |
| Schema | **None**, but `008_report_indexes.sql` gains what the new groupings need — the catalogue-outward slow-mover query and the movement-type grouping are both new access paths |
| API | `GET /reports/by-category`, `/by-cashier`, `/by-product`, `/movers`, `/movements`. New screen ids in `04_UX_SPEC.md` if these are not folded into `SCR-602`/`603`/`604` |
| Constraints | One query per report · slow movers start at `products` and LEFT JOIN · `assertShiftScope` is reused, not re-implemented · budgets per `TC-PERF-05` at `TC-PERF-06`'s scale |

## Acceptance Criteria

- [x] Category and cashier totals sum to the daily report — **to two different anchors**, for the
      reason set out below, and each report prints which one it used
- [x] A product that sold nothing in the range appears in slow movers
- [x] Fast movers by units and by revenue give different orders, and both are shown
- [x] A cashier asking for a store-wide breakdown is refused; their own shift is served
- [x] Movement analysis totals reconcile to the on-hand change over the range
- [x] A voided sale is excluded from every net figure and still visible as a void
- [x] Every report states its range and tax mode, and exports to CSV
- [x] All of them meet the budget at `TC-PERF-06`'s seeded scale

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-INT-120` | Category and cashier breakdowns reconcile to `RPT-101`'s net |
| `TC-INT-121` | Slow movers include a product with no sales at all; fast movers rank both ways |
| `TC-INT-122` | Movement analysis by type reconciles to the on-hand change |
| `TC-E2E-27` | A quarter of trading across four cashiers and six categories, read four ways, reconciling to one net |
| `TC-PERF-07` | Every new report inside `TC-PERF-05`'s budget at `TC-PERF-06`'s scale |

**Requirement 1 asks for something that is only half true, and the report says which half.**
Category and cashier totals cannot both sum to net. A sale has one cashier, so summing
`total_centavos` by cashier *is* net sales — before returns, because a return is its own document
with its own operator and charging it back to the selling cashier would report a refund as their
mistake. A sale has as many categories as it has lines, and the transaction discount, the change
and the returns sit on the **sale**: there is no honest way to split ₱50 off a mixed basket between
feed and veterinary supplies. So the category breakdown reconciles to revenue net of VAT — the
figure `RPT-104` computes margin from, and the only one that is a sum of lines — and both reports
print the identity they used rather than a tick. A single assertion against net would have been
satisfied by a report that quietly prorated the discount, which is the defect this wording avoids.

**The grouping key is live, and nothing can make it a snapshot.** `MON-005` keeps money off the
product record and `sale_items` carries its own name, price and cost for that reason. A category is
not money, nothing snapshots it, and no column on a sale line could answer "what was this filed
under last March" — so recategorising a product moves its history with it. Stated in the report's
own basis line rather than left for somebody to discover the month they reorganise the shelves.

**Two value columns on the movement report, never one.** `INV-106` costs a movement on the way in
and never on the way out: a sale or a write-off consumes at the average prevailing at the time, and
`costing.applyMovement` uses that average without storing it. So the ledger knows exactly how many
kilos were damaged and does not know what they were worth. `costed_value_centavos` is summed from
the cost the movement carries and is a fact; `estimated_value_centavos` prices the rest at the
product's average cost today and is labelled as an estimate on every row. Adding a column now would
be honest only for movements posted after it, and a value column that is fact for some rows and
silence for others is worse than a report that names its estimate.

**The units ranking is partitioned by base unit rather than filtered to one.** `UOM-001` makes 40
KG and 40 sachets incomparable, and the obvious fix — a unit picker — hides the report behind a
control nobody presses. `moversOverview` returns every product's period figures once and the
service takes the top N within each unit, in the order of the unit the store sells most money of.

**`008_report_indexes.sql` could not gain the index the technical note asks it to.** It has been
applied, and §8.9 makes an applied migration immutable, so the one new access path landed in
`017_analysis_indexes.sql` — the same answer `TASK-032` reached about its own schema file. Four of
the five reports needed nothing; the fifth had no path at all, because every index on
`inventory_movements` since `003` leads with `product_id` or a reference and movement analysis
filters by **date across every product**. Measured over a year of movements: without it every range
costs the same, because every range reads the whole ledger.

**Three queries became one, on the evidence.** Fast-by-revenue, fast-by-units and slow movers were
written as three statements and measured at 2.4 s over a quarter — three full aggregates of the
same sums. They are three orderings of one set, so they are now one query ordered three times, at
1.1 s, which is what `by-product` costs on its own.

**`SCR-608` is a separate screen and not a fifth tab**, because `TX-422` is a different permission
from `TX-421` and the readerships genuinely differ: the inventory clerk needs to know what was
damaged this quarter and has no business reading the day's takings. `TC-E2E-27` asserts both halves
— the clerk is refused the daily report and served the ledger.

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
