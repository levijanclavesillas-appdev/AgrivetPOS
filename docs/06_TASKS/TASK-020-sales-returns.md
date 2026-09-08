# TASK-020 — Sales returns

**Priority:** **P1** for v1.1 — a counter with no way to take something back ·
**Blocks release:** yes (v1.1) · **Blocks:** `TASK-028` (store credit) ·
**Requirement:** feature `FT-307`, rules `POS-301`–`POS-307`, `INV-103`, `CR-108`,
`AUD-601`

---

## Objective

Take goods back against the sale they came from, decide whether they can be sold again, and
refund by the means the customer paid.

## Context

v1.0 sells and cannot unsell. The two corrections it lacks are a **void** (`TASK-021`, the
same shift, the whole sale) and a **return** — this task, any time within the window, per line.
They are different operations and the difference is the point: a void says the sale never
happened, a return says the goods came back.

**`POS-304` is the rule that matters most here and the easiest to get wrong.** Veterinary
medicines, vaccines and any batch-tracked product **default to write-off, not restock**. A
customer who has had a bottle of antibiotic in their motorcycle box for two days in Sultan
Kudarat has not returned a saleable bottle, and a system that quietly puts it back on the shelf
will sell it to the next farm. Restocking one is possible and requires manager authorisation.

**`POS-305`'s refund precedence is the second.** A return refunds by the same means as the
original tender, and credit comes first: reduce the customer's outstanding balance where they
have one. `POS-306` says a return against a credit sale never pays out cash while a balance
stands — otherwise the store hands over money to somebody who still owes it.

## Requirements

1. `POS-301`: a return requires an original sale, and may not exceed the quantity sold on that
   line less what has already been returned. Partial returns, repeatedly, up to the total.
2. `POS-302`: a reason from the configured list (`OPS-005`, as `INV-108` does for
   adjustments). Free text alongside, never instead.
3. `POS-303`: **restock or write-off, decided per line.** Restock posts a `CUSTOMER_RETURN`
   in; write-off posts the same movement followed by a write-off out, so the ledger records both
   that it came back and that it is not saleable.
4. `POS-304`: batch-tracked and medicine products default to write-off. The screen defaults
   that way and says why; restocking one needs manager authorisation and is audited.
5. `POS-305`: refund by the original means, in precedence — reduce outstanding credit first,
   then the original non-cash tender, then cash.
6. `POS-306`: a return against a credit sale writes a credit transaction reducing the balance,
   and pays no cash while a balance stands.
7. `POS-307`: within `return_window_days` (default 7) freely; beyond it, manager
   authorisation.
8. A return is one transaction: the return rows, the inventory movements, any credit transaction
   and any till movement commit together or not at all.
9. The refund prints an acknowledgement carrying `TAX-006`, as a collection does (`CR-206`'s
   shape).
10. Returns appear in the daily report as the `returns` term `RPT-101` already reserves — it
    is rendered at zero today precisely so this task has somewhere to put a figure.

## Business Rules

- `POS-301`, `POS-302` — against an original sale, within what was sold, with a listed reason.
- `POS-303`, `POS-304` — the restock decision, and what defaults to write-off.
- `POS-305`, `POS-306` — the refund precedence, and the cash that is not paid out.
- `POS-307` — the window, and who authorises beyond it.
- `INV-102`, `INV-103` — append-only movements, of the declared types.
- `CR-108` — a refund may leave the customer in credit (`TASK-028`).
- `RPT-101` — returns are a term of the daily reconciliation.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/returnService.js`, `src/repositories/returnRepository.js`, `src/routes/returns.js`, `public/js/returns/*.js` |
| Schema | `sale_returns`, `sale_return_lines`; `sale_items.returned_qty_milli` already exists and is maintained by this task |
| API | `POST /sales/:id/returns`, `GET /sales/:id/returns`, `GET /returns`. New screen needs a new `SCR-` id in `04_UX_SPEC.md` |
| Constraints | One transaction · `POS-107` still holds: the original sale is never edited, its `returned_qty_milli` is maintained and its status moves to `PARTIALLY_RETURNED` or `RETURNED` |

## Acceptance Criteria

- [ ] A line can be returned partially, repeatedly, and never beyond what was sold
- [ ] A medicine defaults to write-off, and restocking it requires a manager and is audited
- [ ] A restock increases stock; a write-off nets to zero and both movements are on the ledger
- [ ] A credit customer's return reduces their balance and pays no cash while they owe
- [ ] A return beyond the window is refused without authorisation
- [ ] The daily report's `returns` term is no longer always zero, and the reconciliation holds
- [ ] The refund acknowledgement carries the `TAX-006` line

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-INT-81` | `POS-301`: cumulative returns never exceed the quantity sold |
| `TC-INT-82` | `POS-304`: a batch-tracked product defaults to write-off; restock needs a manager |
| `TC-INT-83` | `POS-305`, `POS-306`: refund precedence, and no cash out while a balance stands |
| `TC-INT-84` | `POS-303`: a write-off posts both movements and nets to zero |
| `TC-E2E-17` | Sell three lines, return two — one restocked, one written off, one on credit — and find the ledger, the balance and the daily reconciliation all right |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
