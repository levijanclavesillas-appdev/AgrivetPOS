# TASK-021 — Sale voiding

**Priority:** **P1** for v1.1 — the correction a cashier needs in the first minute ·
**Blocks release:** yes (v1.1) · **Requirement:** feature `FT-308`,
rules `POS-401`–`POS-404`, `POS-107`, `AUD-601`, `AUD-603`, `TX-405`
> *This file originally named `TX-417`, which §10 defines as "write off a balance". The
> permission for a void is `TX-405`. See "What it decided".*

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
| API | `POST /sales/:id/void` and `GET /sales/:id/voidable`, both under `TX-401` with `TX-405` enforced inside (see "What it decided"), plus `GET /reports/voids` under `TX-421` for `POS-404`. `routes/sales.js` answered `PUT`/`PATCH`/`DELETE` on a sale with a `POS-107` refusal naming the void — this task makes that name real |
| Constraints | One transaction · no deletion anywhere · the reports already exclude `VOIDED`; **`TC-INT-62` was written against a hand-forced status and should be re-pointed at the real void** |

## Acceptance Criteria

- [x] A void reverses stock, tenders and credit, and the ledgers reconcile afterwards
- [x] A cashier alone cannot void; with a manager's authorisation both actors are on the row
- [x] A void after the shift closes is refused, and the message names the return instead
- [x] The sale number is not reused and the sequence has no gap
- [x] A voided cash sale leaves the drawer expecting the right figure at close
- [x] Every report excludes it from net and shows it as voided
- [x] It cannot be voided twice

## What it decided

**The route is `TX-401`'s, not `TX-417`'s — and not `TX-405`'s either.** This file's header
named `TX-417`, which §10 defines as "write off a balance": an owner-only credit operation with
nothing to do with a void. The permission the matrix actually has for this is `TX-405`, "void a
sale", granted to a manager and an owner. But putting the *route* behind `TX-405` would make it
a route a cashier cannot call, and `POS-403` says a cashier may never void **unaided** — a rule
about authorisation, not about who may ask. The cashier is the person who notices the mis-scan.
So the counter's own grant opens the door and `voidService` enforces `TX-405` inside, where the
refusal can name `POS-403` and open the inline panel rather than answering `403` at the edge
with nothing to do next. **`03_BUSINESS_RULES.md` §10 was not changed**; this is a reading of
the matrix as it stands.

**`POS-402`'s window is a property of the sale's shift, not the actor's.** A manager who has
opened no drawer of their own may still void a cashier's mis-scan, and a cashier on their second
shift of the day may not reach back into their first. `TX-419` — "close another user's shift" —
is reused for the second half rather than a new permission being invented: acting on a drawer
you did not count is the thing it already governs.

**A cash void writes no till movement, and that is the arithmetic worth reading twice.**
`tenderTotalsByMethod` and `changeGivenCentavos` have filtered `status <> 'VOIDED'` since
`TASK-010`, so the moment the status lands the tender leaves the expected figure and the change
comes back to it — both by exactly the right amount. A compensating till row as well would take
it off **twice**, so `drawerEffect` computes the figure, reports it, and deliberately writes
nothing. `TC-INT-85`'s sibling asserts both the figure and the absence of the row.

**Reversal is by compensating row everywhere.** Stock comes back as `SALE_VOID` citing the sale
(`INV-102`, `INV-103`); credit comes back as an `ADJUSTMENT` against the same account rather
than a new `txn_type`, because `CR-103`'s balance derives from the ledger, the type is
two-directional by declaration and requires a reason, and a `VOID` value in the schema's `CHECK`
would mean what one already there means.

**Two refusals the requirements did not name, both of them honest.** A sale with goods already
returned is not voided — a void says the sale never happened and part of it demonstrably did.
And a credit sale a collection has already been allocated against is not voided either, because
unpicking it would make money the customer actually paid disappear, which is the thing `POS-404`
exists to prevent. Both refusals name the return.

**`sales.approved_by` is not the void's approver.** It records who released a discount or an
over-limit credit *at the time of sale*, so the void report reads the authoriser from
`AUD-603`'s own audit row instead — found while writing `TC-E2E-18`, which asserted `rosa` and
got `null`.

**What it did not do.** `POS-402` is enforced but not configurable: `OPS-005` lists a "void
window" and `settingsService` already records it as `void_window_shift_only`, a setting whose
value is the rule rather than a number. Turning it off would need `POS-402` amended, and that is
not this task's to do.

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
