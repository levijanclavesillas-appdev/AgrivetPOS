# TASK-008 — Customers and credit accounts

**Priority:** **P1** · **Blocks release:** yes · **Blocks:** `TASK-011`, `TASK-012` ·
**Requirement:** `FR_4.1`, rules `VR-301`–`VR-305`, `CR-101`, `CR-103`, `CR-105`–`CR-107`

---

## Objective

Build the customer record and the credit account whose balance is derived from a transaction
ledger, so that "what does this farm owe us" has one answer that can be proven from its parts.

## Context

The store's credit is currently a notebook (`01_PRODUCT_BRIEF.md` §1). The migration of those
balances is `TASK-026`, but the ledger they land in is built here, and `CR-103` is the rule that
makes the migration checkable: **the balance is derived from the transaction ledger and is
reconcilable to it at any time.** A stored balance with no ledger behind it cannot be reconciled
against a notebook, and reconciling against the notebook is the cutover's success criterion
(`01_PRODUCT_BRIEF.md` §6.3).

Ageing is derived at read time (`CR-107`) rather than stored, because a stored status depends on a
scheduled job, and a scheduled job on a store PC that is off overnight silently reports every
overdue account as current.

## Requirements

1. Customer CRUD per the schema, with types, price level, credit eligibility, and soft delete.
2. A credit account per credit-eligible customer, carrying limit, balance and terms.
3. The balance is maintained **only** by writing a `customer_credit_transactions` row, in the same
   transaction, with `balance_after_centavos` computed by the service (`CR-103`).
4. A reconciliation method proving `balance_centavos = SUM(amount_centavos)` for the account,
   exposed on the health panel and asserted by `TC-INT-46`.
5. Ageing status derived at read time from each unsettled sale's `due_at` and the current date:
   `PAID` / `OVERDUE` / `DUE_SOON` / `CURRENT` (`CR-107`).
6. Due date computed from the customer's terms at the moment of sale (`CR-105`) — the transaction
   carries it, the customer record does not.
7. A credit limit change requires `TX-414` and audits both values (`CR-106`).
8. A customer with a non-zero balance cannot be deactivated (`VR-305`); a transacted customer
   cannot be deleted (`VR-304`).

## Business Rules

- `VR-301`–`VR-305` — customer validation.
- `CR-101` — limit, balance, available credit.
- `CR-103` — the balance derives from the ledger.
- `CR-105` — due date fixed at sale time.
- `CR-106` — limit changes are authorised and audited.
- `CR-107` — ageing derived at read time.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/routes/customers.js`, `src/services/creditService.js`, `src/repositories/customerRepository.js`, `src/repositories/creditRepository.js` |
| Schema | `004_customers_credit.sql` — `customers`, `customer_credit_accounts`, `customer_credit_transactions`, `credit_allocations` |
| API | `GET POST PUT /customers`, `GET /customers/:id/credit`, `PUT /customers/:id/credit-limit` |
| Constraints | No code path writes `balance_centavos` without writing a transaction row in the same statement batch |

## Acceptance Criteria

- [ ] A credit-eligible customer must have a limit and terms
- [ ] Available credit = limit − balance, computed, never stored
- [ ] Balance always equals the sum of its credit transactions
- [ ] Ageing changes across a date boundary with no job running
- [ ] Due date is fixed at sale time and unaffected by a later terms change
- [ ] A limit change requires `TX-414` and audits both values
- [ ] A customer with a balance cannot be deactivated
- [ ] A transacted customer cannot be deleted, only deactivated

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-INT-46` | Balance reconciles to its ledger — permanent regression guard |
| `TC-UT-44` | Ageing derived across a date boundary |
| `TC-UT-40` | Credit requires a registered eligible customer |
| `TC-API-01` | `TX-414` enforced on limit change |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
