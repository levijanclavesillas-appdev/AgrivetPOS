# TASK-034 — Bad-debt write-off

**Priority:** **P3** for v1.2 — rare, owner-only, and wrong in a way that hides itself ·
**Blocks release:** yes (v1.2) · **Depends on:** `TASK-031` (a write-off must land on a statement) ·
**Requirement:** feature `FT-409`, rules `CR-303`, `CR-103`, `CR-107`, `CR-203`, `TX-417`,
`AUD-601`, `AUD-603`

---

## Objective

Let an owner declare a debt uncollectable, credit the account for it, and keep that credit out of
every figure that measures how well the store collects.

## Context

**Three-quarters of this task already exists and has never been reachable.** `WRITE_OFF` has been
one of the six values in `customer_credit_transactions.txn_type`'s `CHECK` since `TASK-008`, and
nothing in the application has ever written one. `CR-103` names it in the list of things the
balance derives from — "credit sales debit, collections credit, returns credit, write-offs
credit" — so the ledger arithmetic is already correct for a transaction type that has never
occurred. `TX-417` has sat in the permission matrix as the only owner-exclusive credit
transaction since v1.0. What is missing is the path, the authority check on it, and the reporting
rule below.

**`CR-303`'s last clause is the whole reason this is a task and not a button.** A write-off
credits the account, so a naive implementation makes the balance go down — which is exactly what
a collection does. Put both in the collections report and the store's collection performance
improves every time it gives up on a debt. A month where nobody paid anything and ₱40,000 was
written off would read as the best collections month of the year. **So the write-off is reported
separately, and every collections figure — the report, the dashboard tile, any future
collector-performance measure — excludes it.**

**A write-off is not a correction, and the distinction has to hold in the schema.** `ADJUSTMENT`
already exists for "this ledger row was wrong". `WRITE_OFF` means "this debt was real and the
store is not going to get it", which is an accounting event with tax consequences the store's
accountant cares about. Using one for the other loses the difference permanently, because the
ledger is append-only and there is nothing to re-derive it from.

**It settles debits, and that has to happen or `CR-107` will chase the customer for ever.** This
is `TASK-028`'s lesson, in the same place. A return credit reduced a balance without allocating
against the invoice it related to, so an account could be square by balance and overdue by
ageing — and it is the ageing that reaches the collections worklist. `creditService.allocate`
moved out of `collectionService` for exactly this reason and now has two callers; a write-off is
the third. A written-off debit is settled, so it ages no further and leaves the worklist.

## Requirements

1. `TX-417`: owner only, enforced server-side. A manager is refused, and the refusal is audited.
2. A write-off names the **amount, the account and a reason**, and the reason is required —
   `CR-303` says so and it is the field the accountant will read.
3. It writes one `WRITE_OFF` credit transaction, and `CR-103`'s derived balance moves by exactly
   that much and by no other path.
4. It **allocates against the unsettled debits it is written off against**, oldest first
   (`CR-203`'s allocator, the third caller), so `CR-107` stops ageing them.
5. Writing off more than the outstanding balance is refused with the figure. A write-off never
   puts an account into credit — that is `CR-108`'s money, and the store does not owe somebody it
   just gave up on.
6. `CR-303`: reported separately. A write-offs report by period, customer and reason; **and every
   collections figure excludes write-offs**, which includes the existing collections report and
   the dashboard.
7. It appears on the statement (`TASK-031`, `CR-302`) as its own row type, described in words a
   customer would understand if they were ever shown it.
8. `AUD-601` and `AUD-603`: audited with the actor, the account, the amount, the reason and the
   debits it settled. Where the store has a second active user, the two-actor form applies.
9. A written-off account is not closed. The customer may still trade, still pay, and a later
   payment on a written-off debt is an ordinary `COLLECTION` — the write-off is not reversed, and
   both rows stand on the ledger.
10. Total written off is a figure the owner can find in one place, over any range.

## Business Rules

- `CR-303` — owner authority, the reason, and the separation from collections.
- `CR-103` — the ledger the balance derives from, which already names write-offs.
- `CR-107`, `CR-203` — ageing from unsettled debits, and the oldest-first allocator.
- `CR-108` — a write-off may not manufacture store credit.
- `TX-417` — owner only.
- `AUD-601`, `AUD-603` — audited, with two actors where there are two people.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/creditService.js` (`writeOff`), `src/repositories/creditRepository.js`, `src/routes/credit.js`, `src/services/reportService.js`, `public/js/customers/*.js` |
| Schema | **None.** `WRITE_OFF` is already in the `txn_type` `CHECK`; `credit_allocations` already exists |
| API | `POST /customers/:id/write-off`, `GET /reports/write-offs`. New screen id in `04_UX_SPEC.md` if it does not sit on `SCR-402` |
| Constraints | One transaction: the credit row, the allocations and the audit row commit together · reuses `creditService.allocate` rather than growing a second allocator · the collections report's query gains an exclusion, and that exclusion is what `TC-INT-125` guards |

## Acceptance Criteria

- [ ] A manager is refused and the refusal is audited; an owner succeeds
- [ ] A write-off without a reason is refused
- [ ] The balance falls by exactly the amount, derived and not stored
- [ ] The written-off invoices leave the ageing and the collections worklist
- [ ] Writing off more than the balance is refused with the figure
- [ ] The collections report and the dashboard are unchanged by a write-off
- [ ] The write-offs report shows it, by customer and reason
- [ ] It appears on the customer's statement as a `WRITE_OFF` row
- [ ] A later payment against a written-off account is an ordinary collection, and both rows stand

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-INT-123` | `TX-417`: owner only, refusal audited; the reason is required |
| `TC-INT-124` | `CR-103`, `CR-107`: the balance moves, and the settled debits stop ageing |
| `TC-INT-125` | `CR-303`: collections figures are identical before and after a write-off, and the write-off appears in its own report |
| `TC-E2E-28` | A farm three months overdue, written off, then paying six months later — the ledger, the statement and the collections report all telling the truth |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
