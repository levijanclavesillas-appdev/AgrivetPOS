# TASK-026 — Opening-data load from CSV

**Priority:** **P1** at cutover, whatever its release ·
**Blocks release:** yes (v1.1) · **Blocked by:** `TASK-025` (it reuses the validation) ·
**Requirement:** feature `FT-707`, rules `OPS-105`–`OPS-107`, `OPS-103`, `UOM-001`,
`MON-004`, `CR-103`

---

## Note on its release

**This is v1.1 by release and needed at cutover, before the store's first real day** — the one
planned exception in `06_TASKS/README.md`. It was assessed for v1.0 and left where it is:
`Q-4` came back as *a list small enough to key in by hand*, so `TASK-036`'s catalogue screens
cover the first cutover and this task covers the second store.

**If a later store's SKU count makes hand entry impractical, this comes into v1.0 for that
store and the backlog is re-ordered.** Decide it before the installer ships, not on cutover day.

## Objective

Load a store's existing products, stock and customer balances from CSV, so the first day starts
from what the notebook already says.

## Context

Hand entry works for one hundred and fifty products and does not work for eight hundred. More
to the point, it does not work for **opening credit balances**, which have to be reconciled
against a notebook customer by customer — and a typo there is money.

**`OPS-106` is the expensive one to get wrong.** Opening stock posts as `OPENING` movements
**carrying the opening unit cost**, so valuation and average cost start correct. Loaded without
a cost, average cost starts at zero and every gross-profit figure the store ever sees is wrong
by the entire cost of goods — and nobody notices, because the figure looks plausible.

**`OPS-107` is the one that has to reconcile.** Opening balances post as credit transactions
dated at cutover, referencing "opening balance", so a statement reads from the beginning rather
than starting mid-story with a number nobody can source.

## Requirements

1. `OPS-105`: CSV for products, opening stock and opening credit balances. **Every row
   validated before anything is written**, and a report of what would be rejected and why —
   reusing `TASK-025`'s validation pass rather than a second one.
2. A template CSV per file, downloadable, with the columns named as the store would name them.
3. `OPS-106`: opening stock as `OPENING` movements with the opening unit cost. A row without
   a cost is **rejected, not defaulted to zero.**
4. `OPS-107`: opening balances as credit transactions dated at cutover, referencing "opening
   balance".
5. `UOM-001`: the base unit is resolved by code and must exist. A row naming a unit the store
   has not defined is rejected with the row number and the unit named.
6. `OPS-103`: a verified backup before writing, and the whole load in one transaction.
7. The load is rehearsable: validate-only produces the same report without writing, so an owner
   can fix the spreadsheet and try again.
8. Afterwards, the reconciliations must hold — `INV-101` and `CR-103` — and the load reports
   that they do.

## Business Rules

- `OPS-105` — CSV for the three files, validated row by row before writing.
- `OPS-106` — opening stock carries its cost.
- `OPS-107` — opening balances dated at cutover, referencing "opening balance".
- `OPS-103` — backup first, one transaction.
- `UOM-001`, `MON-004`, `CR-103` — one base unit, average cost from the opening cost, and a
  balance derived from the transactions.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/openingDataService.js`, `src/routes/data.js` (extended), `public/js/admin/data.js` |
| Schema | None |
| API | `POST /data/opening/validate`, `POST /data/opening`, `GET /data/opening/template/:kind` |
| Constraints | RFC 4180 parsing, as the exports already write · validate-then-write, never as-you-go · one transaction |

## Acceptance Criteria

- [x] A 500-row product CSV loads, or reports every bad row with its line number and reason
- [x] Opening stock without a unit cost is rejected, not defaulted
- [x] Average cost after the load equals the opening cost
- [x] Opening balances appear on a statement as the first line, referencing "opening balance"
- [x] Validate-only writes nothing and reports the same thing the load would
- [x] A failed load leaves the database untouched and names the pre-load backup
- [x] Both reconciliations hold afterwards, and the load says so

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-INT-98` | `OPS-106`: a costless stock row is rejected; a loaded one sets average cost |
| `TC-INT-99` | `OPS-107`: an opening balance is the first line of the statement and reconciles |
| `TC-INT-100` | Validate-only writes nothing, and reports what the load would |
| `TC-E2E-21` | A whole cutover from three CSVs, then a sale, then both reconciliations |
| `TC-UT-100` | The CSV reader against the writer the exports use — and the line numbers `OPS-105` reports rejections with |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
