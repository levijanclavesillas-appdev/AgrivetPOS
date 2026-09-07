# TASK-016 — Dashboard and the v1.0 reports

**Priority:** **P2** — the store can trade without it for a week; the owner cannot manage without
it · **Blocks release:** yes · **Blocks:** `TASK-018` ·
**Requirement:** `FR_6.1`, `FR_6.2`, screens `SCR-601`–`SCR-604`, `NFR_1.5`,
rules `RPT-101`–`RPT-103`, `RPT-106`, `OPS-007`, `TX-421`, `TX-422`, `TX-426`

---

## Before starting — 1 answer is needed

**1. Does the v1.0 dashboard show gross profit?** `01_PRODUCT_BRIEF.md` §6 metric 5 says the owner
can state *yesterday's gross profit* from the dashboard in **week 1** of v1.0. But `FR_6.1` lists
six tiles and profit is not among them, and `RPT-104` — gross profit reads the sale-line cost
snapshot — is marked **R 1.1**. One of the three is wrong.

It cannot be guessed, because the answer changes what ships. If the metric stands, a seventh tile
and a profit column arrive here, `RPT-104` moves to 1.0, and `TC-INT-35` becomes a v1.0 gate test.
If the metric was aspirational, `01_PRODUCT_BRIEF.md` §6 metric 5 must be re-dated to v1.1 rather
than left as a success criterion the release cannot meet. The data is already there either way —
`MON-005` snapshots cost on every sale line from `TASK-011` — so this is a scope decision, not a
technical one.

## Objective

Give the owner the six numbers that describe the day, and three reports that reconcile — so that
the answer to "how did we do" comes off a screen instead of out of a notebook.

## Context

Every figure here is a **read** over data `TASK-011`, `TASK-012` and `TASK-013` already wrote.
This task adds no business rule; it adds the obligation that the reads agree with each other.

That obligation is the whole point. `RPT-101` says a daily sales report that does not reconcile is
a **defect, not a rounding artefact**, and `TC-INT-61` is a permanent regression guard
(`07_TEST_PLAN.md` §7). `TC-INT-60` extends the same discipline to the dashboard: a tile that
disagrees with the report it links to is worse than no tile, because it gets believed.

`legacy/PRD_v1.1.md` §3.6 promised fast/slow-mover visibility that no report in §57–60 produced —
recorded as contradiction 6 and resolved as `FT-602`, **v1.2**. Do not quietly build it here.

## Requirements

1. `SCR-601` dashboard: six tiles — today's gross sales, transaction count, payment mix, total
   credit outstanding, overdue account count, low-stock count — refreshed on navigation, **each
   tile a link to the report behind it** (`FR_6.1`).
2. Every tile figure is produced by the **same query** as the report it links to. A tile with its
   own arithmetic is the defect `TC-INT-60` exists to catch.
3. The alert list sits above the tiles as a dismissible-per-session list, carrying the `OPS-007`
   alerts that exist in v1.0: low stock, overdue credit, credit limit reached, backup overdue,
   unverified backup, shift open too long, cash variance beyond tolerance, clock anomaly.
   **Backup overdue and clock anomaly are not dismissible.** Near-expiry is v1.2 and absent.
4. `SCR-602` daily sales: shows the reconciliation `gross − discounts − returns = net`
   **explicitly on the report**, and `net = SUM(tenders) − change` (`RPT-101`, `FR_6.2`).
5. `SCR-603` payments: tenders grouped by method with recorded total and count per method,
   non-cash rows labelled `RECORDED` (`RPT-102`, `POS-206`).
6. `SCR-604` inventory valuation: `SUM(qty_on_hand_milli × avg_cost_centavos)` in the base unit,
   computed **at read time** and stated with its as-of timestamp (`RPT-103`).
7. Every report header states its date range, the tax mode in force, and whether voided sales are
   included. Voided sales are **excluded from net** in every report (`RPT-106`).
8. Every report exports to CSV, and the export matches the screen figure for figure (`TX-426`).
9. `TX-421` gates sales and profit reports; a `CASHIER` sees **their own shift only**, enforced
   server-side, not by hiding a control (`SEC-6`). `TX-422` gates inventory reports.
10. Reports read the **sale-line snapshot** for price, cost, discount and tax, never the current
    product record (`MON-005`) — so a price change today does not restate last week.
11. Dashboard loads in ≤ 3 s against 100,000 sale lines (`NFR_1.5`). Where that needs an index,
    the index is a migration in this task, not an ad-hoc statement.

## Business Rules

- `RPT-101` — the reconciliation that must hold, and the defect status of one that does not.
- `RPT-102` — payment grouping and the `RECORDED` label.
- `RPT-103` — valuation in the base unit at read time, with an as-of timestamp.
- `RPT-106` — the header disclosure, and voided sales out of net everywhere.
- `MON-005` — reports read the snapshot.
- `OPS-007` — the alert list, and the two that cannot be dismissed.
- `TX-421`, `TX-422`, `TX-426` — who may read and who may export.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/reportService.js`, `src/repositories/reportRepository.js`, `src/routes/reports.js`, `public/js/reports/*.js` |
| Schema | No new table. Reporting **indexes** on `sales(sold_at)`, `sale_items(sale_id)`, `sale_tenders(sale_id, method)` and `inventory_movements(product_id, occurred_at)` as a migration, sized against `NFR_2.1` |
| API | `GET /reports/daily?date=`, `GET /reports/payments?from=&to=`, `GET /reports/inventory/valuation`, plus **`GET /reports/dashboard`** — add this row to `05_TECH_SPEC.md` §4, `TX-421` |
| Constraints | Read-only: no endpoint in this task writes anything but an audit row for an export (`AUD-601`) · all money arithmetic in integer centavos (`MON-001`) · `NFR_1.5` ≤ 3 s at 100,000 lines |

## Acceptance Criteria

- [ ] Every dashboard tile equals the report it links to, for the same day, to the centavo
- [ ] The daily sales report prints its reconciliation line, and it balances after the E2E day
- [ ] `net` equals `SUM(tenders) − change` on a day containing split tenders and change
- [ ] A voided sale is absent from net in all three reports and present in the ledger
- [ ] Every report header states range, tax mode and void inclusion
- [ ] Payment report labels every GCash and QR Ph row `RECORDED`
- [ ] Valuation matches a hand-computed figure from the movement ledger, with an as-of timestamp
- [ ] CSV export matches the screen figure for figure
- [ ] A `CASHIER` calling `GET /reports/daily` for another shift is refused 403 and audited
- [ ] Dashboard loads in ≤ 3 s against a seeded 100,000-line database

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-INT-60` | Dashboard tiles equal the report queries for the same day |
| `TC-INT-61` | `gross − discounts − returns = net`, and `net = tenders − change` — regression guard |
| `TC-INT-62` | Voided sales excluded from net in every report |
| `TC-INT-63` | CSV export matches the on-screen report figure for figure |
| `TC-INT-35` | Changing a product cost after a sale does not change that sale's profit |
| `TC-API-01` | A `CASHIER` is refused another shift's report, with 403, audited |
| `TC-PERF-05` | Dashboard ≤ 3 s at 100,000 sale lines |

> `TC-INT-63` is in `07_TEST_PLAN.md` §4 and `TC-PERF-05` in §6.1. `TC-PERF-05` is measured
> against a database seeded to `NFR_2.1` scale, not against a day's trading.

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
