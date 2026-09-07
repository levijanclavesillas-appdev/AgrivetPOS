# TASK-012 — Credit collections and oldest-first allocation

**Priority:** **P1** · **Blocks release:** yes · **Blocks:** `TASK-013`, `TASK-016` ·
**Requirement:** `FR_4.3`, `FR_4.4`, rules `CR-201`–`CR-206`

---

## Objective

Record a payment against a customer's account, allocate it to the invoices it settles, and print
the acknowledgement the customer expects to be handed.

## Context

Collection is half the reason the store wants this system (`01_PRODUCT_BRIEF.md` §1.2). The
allocation in `CR-203` is what later makes a statement (`TASK-031`) possible: without recording
*which* sales a payment settled, a statement can only ever show a running balance, which is
exactly the notebook the store is trying to leave behind.

`legacy/PRD_v1.1.md` specified a sales receipt (§65) but never a collection acknowledgement, even
though a customer handing over ₱3,000 in cash expects paper. `CR-206` closes that.

## Requirements

1. `POST /customers/:id/collections` recording amount, date, method, reference where non-cash, the
   receiving user and the shift (`CR-201`), under `TX-416` and an open shift (`POS-501`).
2. Partial collections permitted; each is its own transaction and collections are never merged
   (`CR-202`).
3. Allocation **oldest credit sale first**, writing a `credit_allocations` row per settled or
   part-settled sale (`CR-203`).
4. A collection exceeding the balance requires explicit confirmation and the excess becomes store
   credit (`CR-204`) — the negative-balance representation, whose spending is `TASK-028`.
5. A cash collection increases the shift's expected cash (`CR-205`, `POS-509`) and pulses the
   drawer (`POS-507`).
6. Printing an acknowledgement with a `COLL-YYYYMMDD-NNNNNN` number, subject to `TAX-006`
   (`CR-206`); the print itself is `TASK-014` and is called outside the transaction.
7. The whole operation is one transaction: credit transaction, allocations and balance update.

## Business Rules

- `CR-201`–`CR-206` — the collection's shape, allocation, overpayment, till effect and document.
- `CR-103` — the balance still derives from the ledger after every collection.
- `POS-501`, `POS-507`, `POS-509` — shift, drawer and expected cash.
- `TAX-006` — the acknowledgement is not an Official Receipt.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/collectionService.js`, `src/routes/collections.js`, `src/repositories/creditRepository.js` |
| Schema | `customer_credit_transactions`, `credit_allocations` (from `TASK-008`) |
| API | `POST /customers/:id/collections`, `GET /customers/:id/collections` |
| Constraints | One transaction. Printing outside it. Sequence allocated inside it. |

## Acceptance Criteria

- [ ] ₱3,000 against ₱10,000 leaves ₱7,000
- [ ] The oldest unsettled sale is marked part-paid, with an allocation row
- [ ] A collection with no open shift is refused
- [ ] A non-cash collection without a reference is refused
- [ ] Overpayment requires explicit confirmation and produces a negative balance
- [ ] A cash collection raises the shift's expected cash by exactly the amount
- [ ] The drawer is pulsed on a cash collection
- [ ] The acknowledgement prints with a `COLL-` number and the `TAX-006` wording
- [ ] The balance still reconciles to its ledger afterwards

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-INT-42` | Partial payment and oldest-first allocation |
| `TC-INT-43` | Acknowledgement printing and numbering |
| `TC-INT-45` | Overpayment to store credit |
| `TC-INT-46` | Balance reconciliation holds |
| `TC-E2E-02` | Credit sale → collection → balance falls |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
