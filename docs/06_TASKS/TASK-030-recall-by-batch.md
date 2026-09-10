# TASK-030 — Recall by batch

**Priority:** **P1** for v1.2 — it is the reason batch identity is on the sale line ·
**Blocks release:** yes (v1.2) · **Depends on:** `TASK-029` ·
**Requirement:** feature `FT-205`, rules `INV-206`, `RPT-106`, `TX-422`, `AUD-601`

---

## Objective

Given a batch, name every sale, customer and quantity that consumed it — so the store can phone
the farms that bought it.

## Context

This is the smallest task in v1.2 and the one that justifies the largest decision in `TASK-029`.
`INV-206` says the batch is carried **onto the sale line, not merely onto the movement**, and
gives its own reason: a movement says stock left, a sale line says who took it. A recall run from
the movement ledger alone produces quantities and dates and no telephone numbers.

**A recall is not a report about stock, it is a list of people.** The output is a customer, a
sale, a date and a quantity — and for a walk-in there is no customer, which is the answer the
store needs to hear plainly rather than as an empty column. A batch sold to eleven farms and four
walk-ins is *eleven calls and four you cannot make*, and the screen should say the second half
out loud.

**What is already in place after `TASK-029`.** Batch identity on the consuming sale lines, and
`sales.customer_id` where the sale was to a named customer. `saleRepository` and `reportRepository`
already join sales to customers for the daily report. There is no new schema here; if there is,
`TASK-029` got the sale-line decision wrong and this task is where that surfaces.

## Requirements

1. `INV-206`: given a batch, list every sale that consumed it — sale number, date, cashier,
   customer where there was one, and **the quantity taken from this batch**, not the line
   quantity.
2. The remaining on-hand of the batch, so the store knows what to pull off the shelf as well as
   what to chase.
3. Sales that were later voided (`POS-401`) or returned (`POS-301`) are shown with that stated,
   not silently dropped — a returned unit may still be in the customer's shed.
4. Walk-in sales are counted and shown as unreachable rather than omitted, with the count stated.
5. Reachable in one step from the batch wherever a batch is displayed — `SCR-206` and the
   near-expiry alert both land on a batch, and a recall is what the reader wants next.
6. Exportable to CSV, like every other report (`04_UX_SPEC.md` §3), because the list gets worked
   through by somebody with a phone and not by somebody at the machine.
7. Running a recall is audited (`AUD-601`'s spirit: a recall names customers). Behind `TX-422`.

## Business Rules

- `INV-206` — the recall itself, and why batch identity sits on the line.
- `INV-202` — TASK-029 owns it; this task only reads the identity it defines.
- `RPT-106` — the report states its range and whether voided sales are included.
- `TX-422` — who may read inventory reports.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/batchService.js` (recall), `src/repositories/batchRepository.js`, `public/js/catalogue/recall.js` |
| Schema | **None.** If this task needs a column, `TASK-029`'s sale-line decision was wrong |
| API | `GET /batches/:id/recall` |
| Constraints | One query per recall, not one per sale · the quantity reported is per batch per line · runs against `TC-PERF-06`'s seeded year without a table scan |

## Acceptance Criteria

- [ ] A batch consumed by a line that spanned two batches reports only its own share
- [ ] Named customers and walk-ins are both accounted for, and the walk-in count is stated
- [ ] A voided sale appears, marked voided
- [ ] A fully returned line appears, marked returned
- [ ] The batch's remaining on-hand is shown beside the list
- [ ] Reachable in one step from the batch list and from a near-expiry alert
- [ ] Exports to CSV with the same figures as the screen

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-INT-112` | `INV-206`: every consuming sale is found, with per-batch quantities |
| `TC-INT-113` | Voided, returned and walk-in sales are all represented as themselves |
| `TC-E2E-24` | Sell one batch across six sales — two on credit, three walk-in, one later voided — then recall it and reconcile the quantities against the batch |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
