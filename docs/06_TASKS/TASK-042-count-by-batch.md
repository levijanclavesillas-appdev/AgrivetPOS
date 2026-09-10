# TASK-042 — Counting batch-tracked stock, by batch

**Priority:** **P1** for v1.2 — until it lands, the store's most valuable stock cannot be
counted at all · **Blocks release:** yes (v1.2) · **Depends on:** `TASK-029` ·
**Requirement:** rules `INV-110`–`INV-113`, `INV-201`, `INV-202`, `UOM-005`, `AUD-601`,
screen `SCR-205`

---

## Objective

Let a stocktake count a batch-tracked product the way the person holding the boxes counts it
— one line per batch — and post the variance against the batch it was found in.

## Context

**This task exists because of a decision `TASK-029` made and could not finish.** `INV-201`
makes a batch's quantity the ledger's own sum, and `inventoryService.post` therefore refuses a
movement of a batch-tracked product that does not name a batch. A stock count posts one
`COUNT_VARIANCE` movement per varying product, and a product-level count has nothing to name:
**which batch is short is not something one counted figure can say.** Three vials missing from
a shelf holding two batches is not a fact about the product, it is a fact about one of the two
boxes, and only the person at the shelf knows which.

Posting the variance against the earliest-expiring batch was considered and rejected. Shrinkage
is not FEFO — a box knocked behind the fridge is whichever box was knocked behind the fridge —
and a count that invented the answer would produce a batch balance that reconciles perfectly and
is wrong, which is worse than one that refuses. `INV-206`'s recall reads those balances.

**What `TASK-029` shipped instead, and what it cost.** Batch-tracked products were left off the
product-level sheet: `snapshotLines` excluded them, the session reported `batch_tracked_excluded`
so the sheet stated what it did not cover, and a scope containing nothing else refused at `open`
with `INV-201` rather than at `post` — after the shelf had been counted and the count approved,
which is the worst moment to discover it. That was honest and it was not enough: a store that
cannot count its vaccines does not know what it has, and `INV-113`'s staleness rule is measured
against counts that never happen. This task removed all of it.

**The counting unit is the batch, not the product.** A sheet line is `(product, batch)` with
the batch number, its expiry date and its frozen quantity, because that is what is printed on
the box in the counter's hand. `UOM-005` still applies: every quantity carries its unit.

## Requirements

1. `stock_count_lines` gains a nullable `batch_id`. Nullable, and it must stay nullable: a
   non-batch-tracked product is counted exactly as it was before this task, and every line
   written between `TASK-022` and now carries `NULL` correctly.
2. `INV-110`'s freeze snapshots one line per batch for a batch-tracked product — including
   batches holding zero, which is how a count discovers stock that the system thinks is gone —
   and one line per product for everything else, in the same statement and the same instant.
3. `INV-111` posts one `COUNT_VARIANCE` per varying **line**, naming the batch where the line
   has one. `INV-201` holds afterwards without a repair job, and the reconciliation says so.
4. A batch found on the shelf that the system has no record of is **not** creatable from the
   count sheet. It is a delivery nobody recorded, and `INV-202` says a batch carries a supplier
   and a cost that a count cannot supply. The refusal names the goods receipt as the path.
5. `SCR-205`'s sheet groups the batch lines under their product, shows each batch's expiry
   status (`INV-203`), and keeps the product's total visible — a counter needs to see that the
   four boxes add up to what the system expected before posting.
6. The exclusion `TASK-029` added is removed in the same commit that adds the lines, and the
   `batch_tracked_excluded` field with it. Two ways for a count to treat batch-tracked stock is
   one way too many.

## Business Rules

- `INV-110` — the freeze, now per batch as well as per product.
- `INV-111` — the variance movement, naming its batch.
- `INV-112`, `INV-113` — approval and staleness, unchanged.
- `INV-201` — the invariant this task exists to keep reachable.
- `INV-202` — a batch is born of a delivery or an opening load, never of a count sheet.
- `UOM-005` — every quantity on the sheet carries its unit.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/stockCountService.js`, `src/repositories/stockCountRepository.js`, `public/js/catalogue/count.js` |
| Schema | `015_count_by_batch.sql`: `stock_count_lines.batch_id`, nullable, referencing `product_batches(id)` |
| API | No new routes. The existing count routes carry batch lines because a line is a line |
| Constraints | The freeze stays **one statement** (`INV-110`) — a count whose first half was measured at 09:00 and second half at 09:04 is the defect the single `INSERT … SELECT` exists to prevent · a batch line is written for a batch holding zero, or a count cannot discover stock the system has already written off |

## Acceptance Criteria

- [x] A batch-tracked product appears on the sheet once per batch, with batch number and expiry
- [x] A non-batch product's sheet line is unchanged, and its `batch_id` is `NULL`
- [x] A variance on one batch posts against that batch and leaves the others alone
- [x] `INV-201` reconciles after posting a count that varied two batches of one product
- [x] A batch holding zero is on the sheet, so stock the system thinks is gone can be found
- [x] A batch on the shelf that the system does not know is refused, naming goods receipt
- [x] `batch_tracked_excluded` and the scope-time refusal `TASK-029` added are both gone

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-UT-55` | The sheet's line shape: one per batch for tracked, one per product for the rest |
| `TC-INT-114` | `INV-111`: a variance on one batch of two posts against that batch only |
| `TC-INT-115` | `INV-201`: batches reconcile to on-hand after a posted count |
| `TC-INT-116` | A batch at zero is counted, and counting it up is a variance like any other |
| `TC-E2E-25` | Count a fridge of three vaccine batches, find one box short, post it, and recall the batch afterwards to confirm the quantity it now reports |

`TC-E2E-25` stops short of the recall, which is `TASK-030` and does not exist yet; it asks the
batch list the same question instead — what the store now holds, batch by batch — which is the
figure the recall will read. The clause returns when `TASK-030` lands.

**Two things this task changed that were not in the plan.** The line addressing moved from
`productId` to the line's own id: a batch-tracked product has several lines, and a save keyed on
the product would have written one figure onto every batch of it. And the sheet's per-product
totals are computed on the **server** rather than in the screen — `TC-UT-55` and the count
screen's own guards assert that the sheet derives nothing of its own, which is the rule that
keeps one number from having two sources.

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
