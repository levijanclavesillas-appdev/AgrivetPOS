# TASK-028 — Store credit balances

**Priority:** **P2** for v1.1 · **Blocks release:** yes (v1.1) ·
**Blocked by:** `TASK-020` (returns are the other source) ·
**Requirement:** feature `FT-408`, rules `CR-108`, `CR-103`, `CR-204`, `POS-305`,
`AUD-601`

---

## Objective

Let a customer's credit balance be money the store owes *them*, and let them spend it.

## Context

Half of this already exists and is untested where it matters. `CR-204` lets an overpayment
through with the cashier's explicit acknowledgement, and `creditService.summaryFor` already
reports `store_credit_centavos` when the balance goes negative — with a comment saying
**"CR-108 is v1.1, but a negative balance is representable today and the screen must not render
it as a debt"**. `TASK-037`'s screens honour that.

What is missing is the other direction: **nothing spends it.** A customer ₱500 in credit gets a
line on their profile and must still pay cash for their next sack, which is the shape of a
complaint rather than a feature.

`TASK-020` adds the second source — a refund with nothing owing leaves the customer in credit
— so this task waits for it and then makes both spendable.

## Requirements

1. `CR-108`: a store credit balance is a negative outstanding balance, from a return or an
   overpayment. Not a second ledger — `CR-103` derives one balance from one set of
   transactions, and a parallel store-credit table would be a second figure to disagree with it.
2. **`STORE_CREDIT` becomes a usable tender.** It is already in `sale_tenders.method`'s
   `CHECK` and nothing issues it.
3. A sale may be paid wholly or partly from store credit, up to the balance held. Over it is
   refused with the figure quoted.
4. Spending it writes a credit transaction, so the statement reads continuously — earned on one
   line, spent on another — rather than a balance that changes for no visible reason.
5. `POS-305`'s refund precedence already puts credit first; a return that overpays leaves store
   credit rather than cash, which is what makes this task the other half of `TASK-020`.
6. The customer profile shows it as money the store owes, in the store's favour language, never
   as a debt. The list's ageing column must not call a credit balance overdue.
7. Reports: store credit outstanding is a liability and is reported separately from customer
   debt. Netting the two answers neither question.
8. It never expires without an owner writing it off, and a write-off is `TASK-034`'s bad-debt
   path in reverse — out of scope here, and named so nobody assumes expiry.

## Business Rules

- `CR-108` — store credit as a negative balance, from a return or an overpayment.
- `CR-103` — one balance, derived from the transactions. No second ledger.
- `CR-204` — the overpayment that creates it, explicitly acknowledged.
- `POS-305` — the refund precedence that feeds it.
- `CR-104` — available credit is unaffected: a limit governs what they may owe, not what they hold.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/creditService.js`, `saleService.js` (the `STORE_CREDIT` tender), the payment and customer screens |
| Schema | None. The negative balance and the tender method both already exist |
| API | `POST /sales` accepts a `STORE_CREDIT` tender; `GET /customers/:id/credit` already reports the figure |
| Constraints | One balance, one set of transactions · a store-credit tender takes no cash and opens no drawer · the reconciliation `CR-103` asserts must still hold with negative balances in the data |

## Acceptance Criteria

- [ ] An overpayment leaves store credit, and the profile calls it money the store owes
- [ ] A return with nothing owing leaves store credit rather than cash
- [ ] A sale can be paid wholly or partly from it, and beyond it is refused with the figure
- [ ] Spending it writes a transaction the statement shows
- [ ] A credit balance is never rendered as a debt or aged as overdue
- [ ] The credit reconciliation holds with negative balances present
- [ ] Store credit is reported as a liability, separately from customer debt

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-INT-103` | `CR-108`: an overpayment and a return each leave a spendable balance |
| `TC-INT-104` | A `STORE_CREDIT` tender within the balance settles; beyond it is refused |
| `TC-INT-105` | `CR-103` reconciles with negative balances in the data |
| `TC-INT-106` | A credit balance is never aged as overdue |
| `TC-E2E-22` | Overpay, return, then buy a sack paid half from credit — and reconcile |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
