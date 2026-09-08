# TASK-021 — Sale voiding

**Priority:** **P1** for v1.1 — the correction a cashier needs in the first minute ·
**Blocks release:** yes (v1.1) · **Requirement:** feature `FT-308`,
rules `POS-401`–`POS-404`, `POS-107`, `AUD-601`, `AUD-603`, `TX-417`

---

## Objective

Reverse a sale that should not have happened — wholly, within the shift, with somebody's
authorisation on it.

## Context

The mis-scan noticed while the customer is still standing there. v1.0 has no answer: `POS-107`
makes a completed sale immutable and the only correction is a return, which is the wrong shape
— the goods never left.

**`POS-402` is the constraint that keeps this honest: a void is only permitted within the
shift in which the sale occurred, and while that shift is open.** After the close the drawer has
been counted against that sale, the day has been backed up and the figures have been reported;
unwinding one then is not a correction but a rewrite. The correction after a close is a return.

**`POS-404` is what stops it being a shrinkage tool.** A voided sale stays in the ledger, in
the audit trail and **in the sequence** — `POS-108`'s numbers do not close up. A gap in the
receipt numbers is what an auditor looks for, and a void that removed one would hide exactly the
thing the sequence exists to reveal.

## Requirements

1. `POS-401`: a void reverses **everything** — every inventory movement, every tender, any
   credit transaction — and marks the sale `VOIDED` with actor, timestamp and reason.
2. Reversal is by compensating movement, never by deletion (`INV-102`, `AUD-605`'s shape).
3. `POS-402`: only within the originating shift, and only while it is open. Refused otherwise,
   naming the return as the correction that does apply.
4. `POS-403`: manager or owner authorisation. **A cashier may never void unaided** — this is
   the rule the whole feature exists under, and the inline authorisation panel is how it is met.
   Both actors are recorded (`AUD-603`).
5. `POS-404`: the sale stays in the ledger, the trail and the sequence; it is excluded from net
   sales everywhere (`RPT-106`, already honoured by every report since `TASK-016`) and
   appears in a void report.
6. A cash void reverses the drawer figure, so `POS-509`'s expected cash is right at the close.
7. The void is one transaction.
8. A voided sale cannot be voided again, returned against, or reprinted as though live.

## Business Rules

- `POS-401`–`POS-404` — the reversal, the window, the authorisation, and what survives it.
- `POS-107` — the sale itself is still never edited; the void is new rows and a status.
- `POS-108` — the sequence keeps its number.
- `RPT-106` — voided sales out of net sales in every report.
- `AUD-601`, `AUD-603` — audited, with requester and approver as distinct actors.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/voidService.js`, `src/routes/sales.js` (the `POST /sales/:id/void` route the file currently refuses), `public/js/pos/*` |
| Schema | None. `sales.status`, `voided_at`, `voided_by` and `void_reason` exist and are unused |
| API | `POST /sales/:id/void` under `TX-417`. `routes/sales.js` currently answers `PUT`/`PATCH`/`DELETE` on a sale with a `POS-107` refusal naming the void — this task makes that name real |
| Constraints | One transaction · no deletion anywhere · the reports already exclude `VOIDED`; **`TC-INT-62` was written against a hand-forced status and should be re-pointed at the real void** |

## Acceptance Criteria

- [ ] A void reverses stock, tenders and credit, and the ledgers reconcile afterwards
- [ ] A cashier alone cannot void; with a manager's authorisation both actors are on the row
- [ ] A void after the shift closes is refused, and the message names the return instead
- [ ] The sale number is not reused and the sequence has no gap
- [ ] A voided cash sale leaves the drawer expecting the right figure at close
- [ ] Every report excludes it from net and shows it as voided
- [ ] It cannot be voided twice

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-INT-85` | `POS-401`: every movement, tender and credit transaction reverses; the ledgers reconcile |
| `TC-INT-86` | `POS-402`: refused after the close, naming the return |
| `TC-INT-87` | `POS-403`: a cashier alone is refused; both actors recorded |
| `TC-INT-62` | **Re-pointed** at a real void rather than a hand-forced status |
| `TC-E2E-18` | Ring a wrong sale, void it with authorisation, and close a drawer that balances |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
