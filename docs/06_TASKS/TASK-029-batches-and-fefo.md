# TASK-029 — Batches, expiry status and FEFO allocation

**Priority:** **P1** for v1.2 — every other batch feature stands on this one ·
**Blocks release:** yes (v1.2) · **Blocks:** `TASK-030` (recall by batch) ·
**Requirement:** feature `FT-205`, rules `INV-201`–`INV-205`, `MON-004`, `INV-101`–`INV-103`,
`INV-106`, `OPS-007`, `AUD-603`

---

## Before starting — 2 answers are needed

**1. Which of the store's goods are batch-tracked, and does the store hold anything cold-chain?**
This is `Q-1`'s sibling `Q-2`, open since the brief and deferred to here because until now nothing
read the answer. It is not a preference: `is_batch_tracked` decides whether a product costs at a
batch cost or at a moving average (`MON-004`), whether a sale has to choose stock, and whether a
return defaults to write-off. Guessing it *on* burdens a cashier selling a sack of feed with an
expiry choice that means nothing; guessing it *off* lets the store sell an expired vaccine. The
answer is per category, and the store already categorises its own stock — the same handle
`return_writeoff_categories` uses.

**2. Does the store's own policy allow selling expired stock at all?** `INV-205` permits an owner
override "only where the store's own policy allows it", which is a rule that declines to decide.
If the answer is no, the override is not built — a switch nobody may use is a switch somebody
will. If yes, it is `AUD-603`'s two-actor form with a reason, and it needs a report.

## Objective

Hold a batch-tracked product's stock as identified batches with expiry dates, consume the
earliest-expiring first, and refuse to sell what has expired.

## Context

**Every seam this task fills was left open on purpose, and they have been sitting there since
v1.0.** `products.is_batch_tracked` was added by `TASK-006` and is read today by exactly one
thing — `returnService`, for `POS-304`'s write-off default. `goods_receipt_lines.batch_no` and
`expiry_date` were added by `TASK-019` with the comment saying why they are nullable: so that
batch-tracked receiving would be a service change rather than a migration against a table with
live rows in it. `goodsReceiptService` already captures both and attaches them to nothing.
`sale_items.batch_id` has existed since `TASK-011` and `saleService` writes `null` into it on
every line ever sold. `near_expiry_days` (90, `INV-203`) is already in the settings registry.

**`INV-201` and `INV-101` are two derivations of the same number, and they must not be allowed to
disagree.** `INV-101` says on-hand is derived from the movement ledger and never stored;
`INV-201` says the batch quantities sum to it. The safe reading is that there is still exactly one
ledger: `inventory_movements` gains a `batch_id`, batch on-hand is the same query grouped one
column finer, and the two figures cannot drift because they are the same sum. A stored
`batches.qty_milli` counter maintained beside the ledger is the other reading, and it is the one
that produces a store whose batches total 47 while its on-hand says 50.

**One sale line can consume two batches, and `sale_items.batch_id` is one column.** Ten sacks
where the oldest batch holds six is the ordinary case, not the corner: `INV-204` consumes six from
one and four from the next. `INV-206` then wants *quantity per batch per sale line* — which sale,
which customer, how much of *this* batch. So either a line splits into two lines (and the receipt,
the return quantities and `POS-301`'s ceiling all change shape), or the line grows a child table
and `sale_items.batch_id` becomes a convenience for the single-batch case or is withdrawn in
place. **Decide this before writing anything**, because `TASK-030` is built on whichever it is.

## Requirements

1. `INV-202`: a batch carries batch number, supplier, receipt date, expiry date, quantity and
   unit cost, with batch number unique per product.
2. Batches are created by goods receipt, from the `batch_no` and `expiry_date`
   `goodsReceiptService` already captures — and by the opening load, which is how a store's
   existing shelf gets batches at all.
3. A batch-tracked product may not take stock in without a batch (`VR-*` shape: refused, with
   the product named); a non-batch product may not be given one.
4. `INV-201`: batch quantities are derived from the same ledger as on-hand, and reconcile to it
   by construction rather than by a repair job.
5. `INV-203`: expiry status is derived at read time — `EXPIRED`, `NEAR_EXPIRY` within
   `near_expiry_days`, else `NORMAL`. Never a stored column, for `CR-107`'s reason.
6. `INV-204`: **FEFO** — allocation for a batch-tracked product consumes the earliest
   non-expired expiry date first, spanning batches where one does not cover the line.
7. `INV-205`: an expired batch is not allocated and may not be sold. Where answer 2 above permits
   an override, it is `AUD-603`'s requesting-and-approving pair with a reason, and it is reported.
8. `EXPIRY` is already a declared movement type (`INV-103`) and is how expired stock is expected
   to leave. Writing one off consumes from the named batch.
9. `MON-004`: a batch-tracked product's sale line takes its cost snapshot from **the batch it
   consumed**, not from `avg_cost_centavos`. Non-batch products keep the moving average
   permanently — this is not a migration of costing, it is a second path beside it.
10. `OPS-007`'s near-expiry alert, which the rule has listed as "(v1.2)" since v1.0.
11. A return that restocks a batch-tracked line returns it to the batch it came from
    (`POS-303`) — where `POS-304`'s default was overridden to allow it at all.

## What this task decided, and what it handed on

**`Q-2` — which goods are batch-tracked.** Per category, set per product, and settable from the
opening load's product file (`batch_tracked`) so a cutover does not have to be corrected
afterwards.

**`INV-205`'s override — not built.** The store's policy does not permit selling expired stock,
so there is no authorising column, no parameter and no route: `TC-INT-110` asserts that no path
exists, in every shape one would arrive in. If the policy changes it arrives as `AUD-603`'s
two-actor form in its own migration — adding it later costs less than removing it.

**The sale line — a child table, not a column.** `sale_item_batches` carries the per-batch
detail `INV-206` needs; `sale_items.batch_id` is **withdrawn in place**, left `NULL` for ever
rather than dropped, because a line recording its batch in two places is a line whose two
records can disagree.

**Stock counts — handed to `TASK-042`.** `INV-201` refuses an unbatched movement of a
batch-tracked product, and a product-level count sheet has no batch to name. Batch-tracked
products are left off the sheet, the session says how many it left off, and a scope containing
nothing else refuses at `open` rather than at `post`. Counting them by batch is `TASK-042`.

## Business Rules

- `INV-201`, `INV-202` — what a batch is, and that it sums to on-hand.
- `INV-203` — expiry status, derived, on the configured threshold.
- `INV-204` — FEFO, and that it skips the expired rather than consuming them.
- `INV-205` — the refusal, the override the store's policy may not allow, and `EXPIRY`.
- `MON-004`, `INV-106` — batch cost for batch-tracked, moving average for the rest, and that
  cost still moves only on the way in.
- `INV-101`, `INV-102` — one derived on-hand, one append-only ledger.
- `AUD-603` — the override records two actors, not one.
- `OPS-007` — near-expiry joins the alert list.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/batchService.js`, `src/repositories/batchRepository.js`, and cuts into `inventoryService`, `goodsReceiptService`, `saleService`, `returnService`, `stockCountService`, `costing.js`, `alertService`, `openingDataService` |
| Schema | `014_batches.sql`: `product_batches`; `inventory_movements.batch_id`; the sale-line decision from §Context. `products.is_batch_tracked`, `goods_receipt_lines.batch_no`/`expiry_date` and `sale_items.batch_id` already exist |
| API | `GET /products/:id/batches`, `POST /batches/:id/expire`; batch fields on the existing receipt and sale routes. New screen needs a new `SCR-` id in `04_UX_SPEC.md` — `SCR-206` is next free in the catalogue range |
| Constraints | FEFO allocation runs **inside `TASK-011`'s single sale transaction** · batch on-hand is one query against the ledger, not a counter · `TC-PERF-01` and `TC-PERF-02` still hold with batches in the path |

## Acceptance Criteria

- [x] A batch-tracked receipt without a batch number is refused, naming the product
- [x] Batch quantities sum to the product's on-hand figure after a receipt, a sale and a return
- [x] A line of ten where the oldest batch holds six consumes six and four, oldest first
- [x] An expired batch is skipped by FEFO, and selling one is refused with the expiry date
- [x] Where the override exists, it records a requesting and an approving user and a reason —
      **it does not exist**: the store's policy permits none, so `TC-INT-110` asserts the absence
      of the path rather than the behaviour of one
- [x] A batch-tracked sale line's cost snapshot is the batch cost; a non-batch line's is unchanged
- [x] Expiry status changes with the clock alone, with no job having run
- [x] The near-expiry alert appears on `SCR-601` at the configured threshold
- [x] An `EXPIRY` write-off names the batch and leaves the ledger reconciling

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-UT-52` | `INV-203`: the three statuses at the threshold boundary, on Manila days |
| `TC-UT-53` | `INV-204`: FEFO ordering, including a line spanning two batches |
| `TC-UT-54` | `MON-004`: batch cost for a batch-tracked line, moving average for the rest |
| `TC-INT-107` | `INV-201`: batches reconcile to on-hand across receipt, sale, return and expiry |
| `TC-INT-108` | `INV-202`: batch number unique per product; receipt without one refused |
| `TC-INT-109` | `INV-205`: an expired batch is not sold, and is not allocated to |
| `TC-INT-110` | `AUD-603`: the override, if built, records both actors and the reason |
| `TC-INT-111` | `OPS-007`: the near-expiry alert fires on the configured threshold |
| `TC-E2E-23` | Receive three batches of a vaccine, sell across two of them, expire the third, and find the ledger, the costs and the recall trail all right |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
