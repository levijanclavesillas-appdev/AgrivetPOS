# TASK-037 — Customer and credit screens

**Priority:** **P1** — a credit ledger that only grows · **Blocks release:** yes ·
**Blocks:** `DEPLOYMENT.md` §6 cutover, `TASK-018` UAT check 5 · **Requirement:** `FR_4.1`–`FR_4.4`,
screens `SCR-401`–`SCR-403`, rules `CR-101`–`CR-107`, `CR-201`–`CR-206`, `VR-301`–`VR-305`,
`TX-413`, `TX-414`, `TX-416`, `AUD-601`

---

## Objective

Let the store put its credit customers into the system, see what each one owes, and **take a
payment against it** — from a screen.

## Context

The last of the six screens the v1.0 backlog never assigned that touches money. A store that
sells on credit and cannot record a payment has a ledger that only grows: `FR_4.2` writes the
debt on every credit sale, and `FR_4.3` — the collection — has had no way in.

It is also the half of the cutover still missing. `DEPLOYMENT.md` §6 says opening balances are
posted as credit transactions dated at cutover (`OPS-107`), reconciled against the store's
notebook customer by customer. Without `SCR-401` there is nowhere to create the customer, and
without `SCR-403` nowhere to take the first payment.

`customerService`, `creditService` and `collectionService` have done all of this since
`TASK-008` and `TASK-012`, with oldest-first allocation, the acknowledgement, the drawer pulse
and the audit rows. This is a renderer task.

**Two things this screen must not do.**

It must not compute a balance. `CR-103` makes the balance derived from the transactions, and a
screen that adds up its own would eventually disagree with the ledger — which is the one
disagreement a credit system cannot survive. The preview before confirming a collection is the
server's own arithmetic, not the screen's.

It must not let an overpayment through quietly. `CR-204` makes the excess store credit and
requires the cashier to say so explicitly. A tick that defaults to on is not explicit.

## Requirements

1. `SCR-401` list: name, code, type, price level, balance, ageing status. `OVERDUE` in the error
   colour with its day count (`CR-107`). Filters: credit customers only, inactive.
2. Create and edit a customer: name, code, type, price level, contact, address, and credit
   eligibility with its limit and terms (`VR-301`–`VR-303`).
3. **The credit limit is its own action** under `TX-414`, not a field on the customer form —
   folding it in would let a `TX-413` holder raise a limit as a side effect of correcting a
   phone number, which is why the API separates them. Audited with both values (`CR-106`).
4. `SCR-402` profile: limit, balance, **available credit** and ageing as the first block
   (`CR-104`, `CR-107`), then the statement — every credit transaction with its document number,
   due date and running balance — then the collection history with what each payment settled.
5. `SCR-403` collection: the outstanding balance, an amount with a **pay in full** shortcut, the
   method, a reference where non-cash (`CR-202`), and **a preview of the resulting balance before
   confirming** — computed by the server, never by the screen.
6. `CR-203`: after recording, the screen shows **which invoices the payment settled**, oldest
   first. A cashier who cannot see that cannot answer the customer standing in front of them.
7. `CR-204`: an overpayment requires an explicit, unticked confirmation, and the screen states
   that the excess becomes store credit before it is accepted — not after.
8. `CR-206`: the acknowledgement is printed by the collection itself; the screen says whether it
   printed or queued, as the shift close does.
9. `CR-205`: a cash collection is till cash and opens the drawer. The screen says so, because a
   cashier who does not expect the drawer will not have it ready.
10. `VR-304`, `VR-305`: a customer is deactivated, never deleted, and cannot be deactivated while
    a balance stands. Both refusals are surfaced with their rule.
11. Five states, plain-language refusals, touch targets ≥ 44 px (`NFR_4.3`).

## Business Rules

- `CR-101`–`CR-103` — the account, its limit, and the balance derived from transactions.
- `CR-104`, `CR-107` — available credit, and ageing.
- `CR-106` — a limit change needs `TX-414` and is audited with both values.
- `CR-201`–`CR-206` — the collection: who may take one, references, oldest-first allocation,
  overpayment, till cash, the acknowledgement.
- `VR-301`–`VR-305` — customer validation, and why one is deactivated rather than deleted.
- `TX-413`, `TX-414`, `TX-416` — edit a customer, change a limit, take a collection.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `public/js/customers/list.js`, `profile.js`, `collection.js`, `public/css/customers.css`, wiring in `public/js/shell/app.js` |
| Schema | None. |
| API | Consumes `GET /customers`, `GET /customers/:id`, `GET /customers/:id/credit`, `POST /customers`, `PUT /customers/:id`, `POST /customers/:id/deactivate`, `PUT /customers/:id/credit-limit`, `GET|POST /customers/:id/collections`. **No new endpoint.** |
| Constraints | No build step, no framework · **the screen computes no balance** · the resulting-balance preview is the server's figure |

## Acceptance Criteria

- [x] A credit customer can be created with a limit and terms, and appears with them
- [x] The profile shows limit, balance, available credit and ageing before anything else
- [x] `OVERDUE` renders in the error colour with the number of days
- [x] A collection settles the oldest invoice first and the screen shows which ones
- [x] Paying in full leaves a zero balance and the screen says so
- [x] An overpayment cannot be recorded without an explicit tick, and the excess is named
- [x] The acknowledgement's outcome is reported, printed or queued
- [x] A cashier without `TX-414` is refused a limit change, with the rule named
- [x] A customer with a balance cannot be deactivated

## Tests

| Case | Asserts | |
| :--- | :--- | :--- |
| `TC-UI-08` | The collection screen computes no balance — the preview is the server's figure | new |
| `TC-INT-40` – `TC-INT-44` | The credit and collection rules themselves | **already exist** (`TASK-008`, `TASK-012`) |
| `TC-E2E-14` | A credit customer's life: create → limit → buy on credit → part payment → oldest settled → pay in full → overpay refused then accepted → deactivation refused then allowed | new |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
