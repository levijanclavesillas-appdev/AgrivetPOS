# TASK-019 — Suppliers, purchase orders and goods receipt

**Priority:** **P1** for v1.1 — the largest single gap left in the ledger ·
**Blocks release:** yes (v1.1) · **Blocks:** `TASK-020` (supplier returns) ·
**Requirement:** `FR_2` extension, features `FT-501`–`FT-504`,
rules `PO-101`–`PO-207`, `VR-401`, `INV-106`, `MON-004`, `AUD-601`

---

## Before starting — 1 answer is needed · **ANSWERED: yes, build the full lifecycle**

The store does raise orders, so `PO-101`–`PO-105` were built alongside the receipt rather than
deferred behind it. The question, as it was asked:

**Does the store issue purchase orders at all?** `D-4` shipped v1.0 as a "thin till-first MVP"
on the reasoning that the store *"can buy stock on paper for a few weeks"*. If it still does —
a phone call to the feed mill and a delivery note — then `PO-101`–`PO-105`'s whole lifecycle
is ceremony nobody will perform, and the store will use `PO-207`'s direct receipt for
everything.

That does not remove the PO from v1.1; it changes which half is built first. **Goods receipt is
the half that moves stock and sets cost, and it is worth having either way.** If the answer is
"no formal POs", build `FT-503`/`FT-504` first and let the lifecycle follow, rather than
making a shopkeeper open a purchase order before they can record a delivery.

## Objective

Record what the store buys: who from, what was ordered, what actually arrived, and what it
actually cost.

## Context

v1.0 has one way for stock to arrive — an `inventory_movements` row of type `RECEIPT`, posted
from the adjustment screen with a hand-typed unit cost. That was the right thin thing to ship,
and it leaves three questions unanswerable: what did we order and not receive, what did this
supplier charge us last time, and why is the average cost what it is.

**`PO-103` is the rule that shapes this task: a purchase order moves no stock.** Only a goods
receipt does. A system where raising an order changes on hand is a system whose stock figure
means "what we expect" rather than "what is on the shelf", and `INV-101` has meant the second
since `TASK-007`.

**`PO-202` is the second: only the sound received quantity increases stock.** Damaged quantity
is recorded and posts nothing. A delivery of fifty sacks with three split is forty-seven sacks
of stock and a number the store can take to the supplier.

## Requirements

1. Suppliers: name (required, unique — `VR-401`), code, contact, terms, address. Deactivated,
   never deleted, on the same reasoning as `VR-304` for customers.
2. Purchase orders per `PO-101`: supplier, dates, lines of quantity and unit cost, status.
3. `PO-102`'s status machine, and no other transitions: `DRAFT → PENDING →
   PARTIALLY_RECEIVED → RECEIVED`, with `CANCELLED` reachable from `DRAFT` and `PENDING`
   only. `PO-105`: not cancellable once anything has been received.
4. `PO-104`: editable while `DRAFT`; once `PENDING` it is amended by a new revision, not
   overwritten — the supplier has been told a number and the store needs to know which one.
5. `PO-103`: **raising or amending a PO writes no inventory movement.** Assert it.
6. Goods receipt per `PO-201`: per line, ordered, received, damaged, unit cost, and — for
   batch-tracked products, which arrive in v1.2 — the batch fields, nullable now.
7. `PO-202`: the sound quantity posts a `RECEIPT` movement; the damaged quantity posts none
   and is recorded on the receipt.
8. `PO-203`: average cost moves at the **actual** received unit cost, not the ordered one
   (`INV-106`, `MON-004`). This is the figure every gross-profit report will read for ever.
9. `PO-204`: over-receipt beyond the ordered quantity requires authorisation and is flagged.
10. `PO-205`: a unit cost differing from the PO by more than `cost_variance_tolerance_bp`
    requires manager authorisation — a supplier's price rise must be noticed, not absorbed.
11. `PO-206`: a posted receipt is immutable. The correction is an adjustment or a supplier
    return, never an edit.
12. `PO-207`: a direct receipt with no PO is permitted, requires a supplier, and obeys every
    other receipt rule. This is the counter purchase, and for many stores it is the normal case.
13. Every state change is audited with both values (`AUD-601`).

## Business Rules

- `VR-401` — supplier name required and unique.
- `PO-101`–`PO-105` — the order, its shape, its lifecycle and what may not be undone.
- `PO-201`–`PO-207` — the receipt: what it records, what moves stock, what needs authorising.
- `INV-106`, `MON-004` — weighted average cost, moved by a receipt at its actual cost.
- `INV-101`, `INV-102` — on hand stays derived; the receipt is an append-only movement.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/supplierService.js`, `purchaseOrderService.js`, `goodsReceiptService.js`, their repositories and routes, `public/js/purchasing/*.js` |
| Schema | `suppliers`, `purchase_orders`, `purchase_order_lines`, `goods_receipts`, `goods_receipt_lines` — a migration, and rows added to `05_TECH_SPEC.md` §3.4 |
| API | `GET|POST|PUT /suppliers`, `GET|POST /purchase-orders`, `POST /purchase-orders/:id/submit|cancel`, `POST /goods-receipts`. New screens need new `SCR-` ids in `04_UX_SPEC.md` — allocate them there first |
| Constraints | A receipt is one transaction: lines, movements and cost update commit together or not at all (`INV-107`'s shape) · no screen without a spec entry |

## Acceptance Criteria

- [x] A PO can be raised, submitted, partially received, and completed
- [x] Raising and amending a PO writes no inventory movement whatsoever
- [x] A damaged quantity is recorded and does not increase stock
- [x] Average cost after a receipt equals the actual received cost, not the ordered cost
- [x] Over-receipt and an out-of-tolerance cost each require authorisation and are flagged
- [x] A PO with any receipt against it cannot be cancelled
- [x] A posted receipt cannot be edited
- [x] A direct receipt with no PO works and obeys the same rules
- [x] The inventory ledger reconciles after a week of purchasing

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-INT-76` | `PO-103`: no PO operation writes an inventory movement |
| `TC-INT-77` | `PO-202`: damaged quantity records and moves no stock |
| `TC-INT-78` | `PO-203`: average cost moves at the received cost, not the ordered cost |
| `TC-INT-79` | `PO-102`, `PO-105`: the status machine, and the cancellation that is refused |
| `TC-INT-80` | `PO-204`, `PO-205`: over-receipt and cost variance each need authorisation |
| `TC-E2E-16` | Order 50 sacks, receive 47 sound and 3 damaged at a higher cost than ordered, authorise it, and find the stock, the cost and the ledger all right |

---

## Closed

Every acceptance criterion above is asserted by a test, not by inspection: `TC-INT-76` to
`TC-INT-80` and `TC-E2E-16`, plus the purchasing walk in `tools/browser-smoke/`, which drives
`SCR-801`–`SCR-804` in real Chromium and is where the authorisation panel and the sound-quantity
arithmetic are proved in front of a person rather than through the API.

**Four decisions worth carrying forward.**

1. **The tables are `purchase_order_items` and `goods_receipt_items`**, not the `_lines` this
   file asked for. `05_TECH_SPEC.md` §3.3 had already published the `_items` names in its entity
   overview and `sale_items` sets the house convention; the data model is that document's to own.

2. **`PO-205` applies to a direct receipt too, measured against the prevailing average cost.**
   The rule's own words are "differs from the PO", and `PO-207` has no PO to differ from — but
   `PO-207` also says a direct receipt follows every other receipt rule, and the reason `PO-205`
   gives is that a mis-keyed cost silently destroys every margin figure, which is exactly as true
   at the counter. Where a product has never been costed there is no baseline and the check does
   not apply. The refusal names which baseline it used.

3. **A manager or owner doing the receiving is the authorisation `PO-204` and `PO-205` ask for**,
   recorded as `self_authorised` in the trail. This is the carve-out `INV-108` already makes for
   a large adjustment, for the same reason: a second distinct person would make an over-receipt
   impossible in a store where the manager unloads the van. Where the receiver is an inventory
   clerk, `AUD-603`'s distinct actors apply in full.

4. **The approver is resolved against the `users` table, not taken from the request body.** The
   v1.0 pattern trusts a client-asserted `{ id, username, role }`; on a route that moves stock
   and rewrites average cost that is a claim, not an authorisation, and `SEC-6` says
   authorisation is server-side without exception. `TASK-011`'s override prompt should be brought
   to the same shape.

**One defect fixed outside the task's scope,** because the browser smoke found it while driving
these screens: switching screens with a fetch in flight left the new screen blank, the old view's
reply having cleared the shared root from under it. Each screen now owns its host element.

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
