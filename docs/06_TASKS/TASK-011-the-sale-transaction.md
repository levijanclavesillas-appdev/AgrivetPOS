# TASK-011 — The sale transaction (`POST /sales`)

**Priority:** **P1** — the keystone of the product · **Blocks release:** yes ·
**Blocks:** `TASK-013`, `TASK-015`, `TASK-016` ·
**Requirement:** `FR_3.3`–`FR_3.6`, rules `POS-101`–`POS-108`, `POS-201`–`POS-207`, `CR-102`,
`CR-104`, `INV-107`, `MON-005`

---

## Objective

Implement the one endpoint where money, stock, credit and the till meet, as a single database
transaction that either commits all of it or none of it.

## Context

This is the task the previous ten exist to make possible, and the one every later task depends on.
`05_TECH_SPEC.md` §4.1 fixes the twelve steps and their order; **implement them in that order**,
because several of the checks are only correct where they sit — re-resolving prices before
checking stock, allocating the sale number after every validation so a rollback consumes none.

The single most important behaviour: **the client's computed totals are never persisted.** They
are recomputed server-side and compared, and a mismatch rejects the sale. A stale price list in a
renderer, or a tampered one, is caught rather than banked.

`INV-107` is why this is one task and not four: the sale, its lines, its tenders, its inventory
movements and its credit transaction commit together or not at all.

## Requirements

1. `POST /sales` executing the twelve steps of `05_TECH_SPEC.md` §4.1 in one `BEGIN IMMEDIATE`
   transaction, using the services from `TASK-002`, `TASK-007`, `TASK-008`, `TASK-009`, `TASK-010`.
2. Server-side re-resolution of every line price (`PR-101`) and recomputation of every total
   (`MON-003`, `MON-006`, `TAX-002`); the client's figures are compared, never stored.
3. Stock re-checked per line at commit time, not at cart time (`INV-104`).
4. Split tender across cash, GCash, QR Ph and credit, completing only when
   `SUM(tenders) ≥ total` (`POS-202`, `POS-204`); only cash may over-tender and produce change
   (`POS-203`, `MON-007`).
5. `GCASH` and `QRPH` tenders require a non-empty reference, never generated or defaulted
   (`POS-205`), are stored with status `RECORDED` only (`POS-206`), and a duplicate reference for
   the same method that day returns a warning the caller must explicitly accept (`POS-207`).
6. Credit tender requires a registered, active, credit-eligible customer (`CR-102`) and is blocked
   over limit unless approved, with requester and approver recorded distinctly (`CR-104`,
   `AUD-603`).
7. Every sale line snapshots price, cost, discount, tax class and tax amount (`MON-005`), and the
   product name.
8. `sale_no` allocated from a gapless per-day sequence **inside** the transaction, so a rollback
   consumes no number (`POS-108`), and derived from the database sequence rather than the clock
   (`VR-103`).
9. A completed sale is immutable — no update path exists (`POS-107`).

## Business Rules

- `POS-101`–`POS-108` — the sale's shape, immutability and numbering.
- `POS-201`–`POS-207` — tenders, split payment, references, `RECORDED` status, duplicates.
- `CR-102`, `CR-104` — credit eligibility and the limit check.
- `INV-104`, `INV-107` — stock check and the transaction boundary.
- `MON-003`, `MON-005`, `MON-006`, `MON-007` — totals, snapshots, apportionment, change.
- `TAX-002`, `TAX-003` — tax treatment by mode.
- `PR-105`, `PR-203` — below-cost and over-ceiling authorisations.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/saleService.js`, `src/repositories/saleRepository.js`, `src/routes/sales.js`, `src/services/sequenceService.js` |
| Schema | `006_sales.sql` — `sales`, `sale_items`, `sale_tenders`, `sale_discounts` |
| API | `POST /sales`, `POST /sales/price-check`, `GET /sales/:id` |
| Constraints | One `BEGIN IMMEDIATE` for the whole operation. Printing is **outside** it (`INT-1`) — a printer failure must never roll back a committed sale. `NFR_1.1` ≤ 2 s. |

## Acceptance Criteria

- [x] The twelve steps execute in the documented order
- [x] A tampered client total is rejected, not banked
- [x] Split tender ₱600 cash + ₱400 GCash completes a ₱1,000 sale; ₱600 alone does not
- [x] A GCash tender with an empty reference is rejected
- [x] A duplicate same-day reference warns and requires explicit acceptance
- [x] Over-limit credit is blocked, and an override records both actors
- [x] **An injected failure after the movements leaves no sale, no movement and no balance change**
- [x] Changing a product's cost afterwards does not change that sale's gross profit
- [x] Sale numbers are gapless per day, and a rolled-back sale consumes none
- [x] A completed sale has no update path in any repository

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-INT-34` | Atomicity under injected failure — permanent regression guard |
| `TC-INT-32` | Split tender |
| `TC-INT-35` | Cost snapshot independence |
| `TC-INT-37` | Client totals ignored |
| `TC-INT-38` | Duplicate reference warning |
| `TC-INT-41` | Over-limit override, two actors |
| `TC-INT-55` | Gapless numbering under rollback |
| `TC-E2E-01`, `TC-E2E-05` | Happy path and split tender end to end |
| `TC-PERF-01` | ≤ 2 s |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
