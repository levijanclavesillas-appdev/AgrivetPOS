# TASK-028 — Store credit balances

**Priority:** **P2** for v1.1 · **Blocks release:** yes (v1.1) ·
**Blocked by:** `TASK-020` (returns are the other source) ·
**Requirement:** feature `FT-408`, rules `CR-108`, `CR-103`, `CR-204`, `POS-305`,
`AUD-601`

---

> **Closed.** Store credit is spendable: `STORE_CREDIT` is a tender, a customer in credit is never
> rendered or aged as a debtor, and the debt and the liability are reported apart. One ledger, as
> `CR-103` requires — the spend is an ordinary debit, settled by the credit it spends.

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

- [x] An overpayment leaves store credit, and the profile calls it money the store owes
- [x] A return with nothing owing leaves store credit rather than cash
- [x] A sale can be paid wholly or partly from it, and beyond it is refused with the figure
- [x] Spending it writes a transaction the statement shows
- [x] A credit balance is never rendered as a debt or aged as overdue
- [x] The credit reconciliation holds with negative balances present
- [x] Store credit is reported as a liability, separately from customer debt

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-INT-103` | `CR-108`: an overpayment and a return each leave a spendable balance |
| `TC-INT-104` | A `STORE_CREDIT` tender within the balance settles; beyond it is refused |
| `TC-INT-105` | `CR-103` reconciles with negative balances in the data |
| `TC-INT-106` | A credit balance is never aged as overdue |
| `TC-E2E-22` | Overpay, return, then buy a sack paid half from credit — and reconcile |

---

## What it found: a dunning letter for a debt the store had cancelled

`CR-107` derives ageing from **unsettled debits**, and `credit_allocations` is what marks a debit
settled. Collections have allocated since `TASK-012`. **Return credits never did.** So a farm whose
₱600 credit sale was returned in full carried a balance of nothing and an open ₱600 invoice at the
same time — `PAID` by the balance, `OVERDUE` by the ageing, and it is the ageing that reaches the
collections worklist and the dashboard's overdue count. The store would have chased a customer for
money it had itself given back.

Requirement 6 is what surfaced it — "the list's ageing column must not call a credit balance
overdue" — and the fix is not in the list. It is in the ledger: a credit settles the debits it
covers, whichever kind of credit it is. `allocate` moved out of `collectionService` into
`creditService`, `returnService` calls it, and `TC-INT-106` is the case that would have caught it
at `TASK-020` had anybody thought to ask.

## And a second thing it found, on the screen next door

The walk waited for `SCR-304`'s receipt preview and never saw it. §5's loading state clears the
element it is handed, and the receipt handed it the **sheet the paper lives in** — so the `<pre>`
was detached, the fetched document was written into a node no longer in the page, and the preview
stayed a skeleton. Since `TASK-015`. Every assertion on that screen read `.screen`, which carries
the sale number and the total whether or not the paper renders, so it passed a browser walk for six
tasks. A cashier's only way to see what had printed was Reprint — which stamps REPRINT on it
(`POS-208`), on a receipt nobody had yet been given.

## What was decided here, that `CR-108` did not settle

**Which transaction type spends it.** The schema's `CHECK` names six and the task forbids a
migration, so the spend is a `CREDIT_SALE` with `method = 'STORE_CREDIT'` — which turns out to be
the honest reading rather than a workaround: the customer's account *is* debited for the goods, and
the credit they hold *is* what covers it. The statement reads `RETURN_CREDIT −₱300` then
`CREDIT_SALE +₱300`, and the balance walks back to zero in front of the reader.

**And what stops that debit looking like a debt.** It is allocated against the credit it spends, in
the same transaction, by the same allocator running the other way round (`allocateToDebit`). So it
is settled the instant it is written: no due date, no open invoice, nothing to age. `TC-INT-106`
asserts it a year later, because "not yet overdue" and "never overdue" look identical on the day.

**`CR-104` has nothing to say about it.** A limit governs what a customer may *owe*. A farm at its
₱100 limit holding ₱500 of store credit may spend every peso of it, because spending it is not
borrowing — and `available = limit − balance` grows rather than shrinks against a negative balance,
which is the arithmetic already saying so.

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
