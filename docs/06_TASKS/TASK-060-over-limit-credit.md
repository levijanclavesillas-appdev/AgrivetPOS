# TASK-060 — Over the credit limit, approved at the payment screen

**Priority:** **P1** · **Rules:** `CR-104`, `AUD-603` · **Tests:** `sales.test.js` (TASK-060), `renderer.test.js`

## What was wrong

| # | Fault |
| :-: | :--- |
| 1 | **No way to approve it.** `CR-104` releases an over-limit credit sale by a manager or owner override, recorded with both actors and a reason, and the server accepted one. The payment screen said "A manager or owner must authorise it" and offered nobody a way to. Complete was refused, so the cashier's only options were to split the bill or have the limit raised. The guide said so |
| 2 | **An approval for anything covered the credit too.** An approval proved only *who* agreed. The counter's panel sends one approval per sale, so a manager approving a discount above the cashier's ceiling also approved, unseen, the same sale going over the customer's limit |
| 3 | **The reason could be empty.** With no reason given, the audit row recorded "Over-limit credit authorised by …", a sentence nobody said |

## As built

- **Approvals name their rules.** `POST /auth/approve` takes `rules`, the ids the approver
  was shown, and signs them into the approval. The middleware passes them on with the
  proven approver.
- **The sale checks them.** `saleService` accepts an over-limit credit tender only with an
  approval whose rules include `CR-104` and that carries a reason. Otherwise it refuses:
  "The approval given was not for credit …" (403), or "Say why … may go over their credit
  limit" (400). A refused sale gives the approval back.
- **The payment screen asks.** When more is on CREDIT than the customer has available,
  pressing Complete opens the authorisation panel under the tenders:
  - It states the available credit, the amount going on credit, how far over the limit this
    takes them, and the limit.
  - It takes the approver's username and password, and a **Reason** (a new option on the
    shared panel).
  - A cashier's name is refused in the panel itself.
  - The approval it asks for names `CR-104` plus any rules the counter already needed
    approval for (discount, below cost), and replaces the counter's approval, so one
    approval covers the whole sale.
  - A `CR-104` refusal from the server, for example because the balance moved at another
    till, reopens the panel with the server's sentence.
  - Escape inside the panel closes the panel, not the payment screen.
- The counter's discount approval now names its rules too.

## Tests

`sales.test.js` (TASK-060) runs over HTTP:

- **No approval:** refused `CR-104`.
- **A manager's approval for `PR-203` only:** refused, "not for credit".
- **An approval for `PR-203` and `CR-104` with no reason:** 400, and nothing is debited.
- **The same approval with a reason:** 201. The balance is debited, and the audit row names
  the cashier, the manager and the reason.
- **The same token a second time:** refused `AUD-603`.

`TC-INT-41` still passes at the service level. `renderer.test.js` checks the panel's trigger,
its reason field, the rules it asks for, and that the payment screen still sends a token and
never a bare name.

Walked in the renderer against the demo store. Baby Reyes had ₱1,275 of her ₱2,000 limit
available, and a ₱2,000 sale went on CREDIT:

1. Complete opened the panel: "…taking them ₱725.00 over their limit of ₱2,000.00".
2. Joy (cashier) was refused in the panel.
3. Ben (manager) approved with a reason, and the receipt printed `CREDIT RECORDED 2,000.00`.
4. The audit trail read joy / ben / "Pays every Friday; owner agreed".
