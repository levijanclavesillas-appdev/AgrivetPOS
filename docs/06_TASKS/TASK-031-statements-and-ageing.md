# TASK-031 — Customer statements and ageing buckets

**Priority:** **P1** for v1.2 — the store chases debt on a screen it cannot hand to a customer ·
**Blocks release:** yes (v1.2) · **Blocks:** `TASK-034` (a write-off must land on a statement) ·
**Requirement:** features `FT-406`, `FT-407`, rules `CR-301`, `CR-302`, `CR-103`, `CR-107`,
`CR-203`, `RPT-106`, `TX-421`

---

## Objective

Print a customer a statement they can check, and give the owner the debt split into the four
buckets the age of it actually falls into.

## Context

**`FT-407` is a document handed to one customer; `FT-406` is a report read by the owner about all
of them.** They are one task because they are one arithmetic read two ways, and building them
apart is how the total on the report stops matching the sum of the statements.

v1.0 derives an account balance from the ledger (`CR-103`) and an ageing *status* per account
(`CR-107` — `CURRENT`, `DUE_SOON`, `OVERDUE`, `PAID`). Both are on `SCR-401`/`402` and the
overdue count is a dashboard tile. What the store cannot do is answer *how* overdue, or show a
customer the working.

**`CR-302`'s last clause is the whole task: the closing balance must equal the account balance at
that date.** A statement that opens at ₱4,000, lists the period's movements and closes at ₱6,200
while the profile says ₱6,150 is worse than no statement, because the customer will find the
₱50 and the store will not. So the statement is not assembled from a separate query — it is the
same ledger `CR-103` derives from, walked in date order, with the opening balance derived as the
balance *before* the period rather than stored anywhere.

**`CR-301` ages from due dates, not from invoice dates, and buckets an unsettled debit — not an
account.** One farm can be ₱2,000 in the 1–30 bucket and ₱5,000 in the 90+ at the same time, and
an implementation that buckets the account by its oldest debt reports ₱7,000 as 90+ and
overstates the store's problem. What settles a debit is `credit_allocations`, which
`collectionService` has written since `TASK-012` and which `TASK-028` extended to return credits
after finding a farm chased for money the store had itself given back.

**`CR-203` is what makes a statement worth printing.** A collection is allocated oldest-first and
recorded per sale, so the statement can say *which invoices this ₱3,000 settled* — the sentence
the customer is actually asking for when they query a balance.

## Requirements

1. `CR-302`: a statement for a customer over a date range — opening balance, every debit and
   credit in the period in date order, closing balance.
2. The closing balance equals the account balance at that date, asserted in the code path and not
   merely in a test.
3. Every row names what it was: `CREDIT_SALE` with its sale number, `COLLECTION` with its
   reference and the invoices it settled (`CR-203`), `RETURN_CREDIT`, `WRITE_OFF` (`TASK-034`),
   `OPENING`, `ADJUSTMENT`.
4. A customer in credit (`CR-108`) closes negative and is described as the store owing them, in
   `SCR-401`'s established words rather than a minus sign.
5. `CR-301`: ageing buckets 1–30, 31–60, 61–90, 90+ days past due, computed **per unsettled
   debit** from its due date, on Manila days as `CR-107` already computes.
6. The ageing report totals per bucket across all accounts, and per account, and the two agree.
7. The bucket totals plus the not-yet-due balance equal total receivable — the same
   reconciliation `RPT-101` demands of the daily report, applied to the debt.
8. Statutory: `RPT-106` — the range is stated, and the report says whether it includes accounts
   with a zero balance.
9. Printable: a statement goes out on the receipt printer or as a document, in `documentService`'s
   existing shape (`CR-206`'s acknowledgement is the precedent).
10. Both behind `TX-421`; a cashier does not read the store's receivables.

## Business Rules

- `CR-301` — the four buckets, per unsettled debit, from the due date.
- `CR-302` — the statement's shape, and the closing balance that must agree.
- `CR-103` — one ledger, one derived balance; the statement reads it, it does not shadow it.
- `CR-107` — the status words, and Manila days.
- `CR-203` — which invoices a collection settled.
- `CR-108` — an account in credit is not a debt.
- `RPT-106` — range, and what is included.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/creditService.js` (statement, ageing), `src/repositories/creditRepository.js`, `src/services/reportService.js`, `src/services/documentService.js`, `public/js/customers/statement.js`, `public/js/reports/report.js` |
| Schema | **None.** `customer_credit_transactions` and `credit_allocations` already carry everything; if a column is needed, the ledger is being shadowed |
| API | `GET /customers/:id/statement`, `GET /reports/ageing`. New screens need new `SCR-` ids in `04_UX_SPEC.md` — `SCR-404` (statement) and `SCR-605` (ageing) are next free |
| Constraints | Opening balance is derived, never stored · buckets are per debit · one query for the ageing report across all accounts, not one per customer |

## Acceptance Criteria

- [x] A statement's closing balance equals the profile balance at that date, to the centavo —
      and the service **refuses to build** one that disagrees, rather than leaving it to a test
- [x] A collection row names the invoices it settled, oldest first
- [x] A customer with two debts of different ages appears in two buckets
- [x] Bucket totals plus not-yet-due equal total receivable — **less the credit customers
      hold**, which the rule did not name and the arithmetic requires; see below
- [x] An account in credit closes negative and is described, not signed
- [x] A statement over a range with no activity still states the opening and closing balance
- [x] A cashier is refused both, and the refusal is the documented error code
- [x] Both export to CSV; the statement also prints

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-UT-55` | `CR-301`: bucket boundaries at 30, 60 and 90 days past due, on Manila days |
| `TC-INT-114` | `CR-302`: closing balance equals the account balance, across sales, collections, a return credit and a partial allocation |
| `TC-INT-115` | `CR-301`: one account, two debits, two buckets; totals reconcile to receivable |
| `TC-INT-116` | `CR-203`: the statement names the invoices each collection settled |
| `TC-E2E-25` | A year of trading on one account — sales, partial collections, a return — then a statement for one month that the customer could check by hand |

**What requirement 7 turned out to mean.** "Bucket totals plus the not-yet-due balance equal
total receivable" is *not* true as written, and the first version of this report claimed it was.
Ageing sums debts **gross**; a balance nets them. An account's balance is its unsettled debits
less the credits nobody has spent yet — an overpayment, a return credit, store credit the
customer is holding (`CR-108`). So the buckets alone cannot equal the ledger, and a report that
said they did would be wrong the first time a farm paid ₱100 too much.

The report states the credit as its own figure and reconciles against the arithmetic that is
actually true: **aged debt, less unapplied credit, is exactly what the ledger holds** — the
settled parts cancel on both sides, so it is an equality and not an approximation. The credit is
never netted into a bucket, because a debt three months old does not become younger for a payment
landing against it later.

The defect surfaced in a five-line probe before any test existed, because the report was written
to check itself. That is the same reasoning `CR-302` applies to the statement, one level up.

**Two other things worth recording.** `TX-421` is not enough on its own: it grants a cashier
`OWN_SHIFT`, and the receivable has no shift to scope it to, so both screens check for store
scope and the refusal says which figures a cashier *can* see. And the printed statement's
"Balance brought forward" truncated to "Balance brought forwar" at 32 columns — it is "Brought
forward" on paper now, because a typo on a page a customer is asked to check is a page they stop
trusting.

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
