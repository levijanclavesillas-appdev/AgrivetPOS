# TASK-044 — `SCR-306`, this shift's receipts

**Priority:** **P1** — a rule the store may use and cannot reach ·
**Blocks release:** no · **Depends on:** — ·
**Requirement:** rules `POS-107`, `POS-208`, `POS-401`, `POS-402`, `TX-401`, `TX-421`,
screen `SCR-306`

---

## Objective

Let a cashier find a receipt from earlier in their shift, so they can reprint it or void
it while `POS-402` still allows the void.

## Context

**Nothing here edits a sale, and nothing ever will.** `POS-107` makes a completed sale
immutable; there is no `PUT` and no `DELETE` on `/sales`, and the absence of the route is
the enforcement, the same way `AUD-605` has no delete. This task adds a way to *find* a
sale, not a way to change one. The two corrections stay exactly what they were: a **void**
while the shift that made the sale is still open (`POS-401`), and a **return** afterwards
(`POS-301`).

**The gap is reachability, not permission.** `SCR-304` appears when a sale completes and
nowhere else. Start the next customer — the normal flow, and what the Enter key on that
screen does — and the receipt is gone from the counter. A cashier who notices the mis-scan
three customers later still holds the right under `POS-402` (same shift, still open) and
has no screen to exercise it from. The same is true of `POS-208`'s reprint: the endpoint
and the REPRINT stamp exist, and the button that reaches them is on a screen that has
gone.

The only list of sales at the counter today is inside `SCR-305`, and it filters
`returnable=true` — which is right for a return and useless here: it hides exactly the
sale somebody wants to void, and every sale they might want to reprint after voiding it.

**Scope is the cashier's own open shift, deliberately.** `TX-421` already governs who may
read the day, and `SCR-602` shows it. The question this screen answers is only ever "the
one I just did" — a list of the whole day at the counter would be a different screen with
a different rule behind it, and the wrong one to reach for at a till with a customer
waiting.

## Requirements

1. `SCR-306` lists the sales of the **current user's open shift**, most recent first:
   receipt number, the time in Manila (`TIME-001`), the total, and the status where it is
   not a plain completed sale.
2. Choosing one opens `SCR-304` on it, with everything that screen already does — the
   rendered document, `POS-208`'s reprint, and the void where `GET /sales/:id/voidable`
   says so, with `POS-402`'s sentence in the button's place where it does not.
3. `SCR-304` gains a way back to the list when it was opened from one. Reached from a
   completed sale it behaves exactly as it does now.
4. No shift open: the screen says so and says where an older receipt is found — a return
   is against the sale, and the day is `SCR-602`'s. It does not silently list nothing.
5. Behind `TX-401`, so the counter reaches it and the inventory clerk does not.
6. **No edit, anywhere on it.** No quantity, no price, no field of any kind: the list is a
   list and the receipt is a document.

## Business Rules

- `POS-107` — a completed sale is immutable, and this screen does not change that.
- `POS-401`, `POS-402` — the void, and the window it lives in.
- `POS-208` — a reprint is stamped and audited.
- `TX-401` — the counter's own grant.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `public/js/receipt/list.js`, `public/js/receipt/view.js` (a way back), `public/js/shell/app.js` (the rail item and the route), `docs/04_UX_SPEC.md` |
| Schema | **None** |
| API | **None** — `GET /sales?shiftId=…`, `GET /sales/:id` and `GET /shifts/current` all exist |
| Constraints | The list is the shift's, not the day's · no field on the screen writes anything · the receipt screen's behaviour when opened from a completed sale is unchanged |

## Acceptance Criteria

- [x] The shift's sales are listed, newest first, with number, time and total
- [x] Choosing one opens the receipt, and the void is offered where the server allows it
- [x] A voided sale is listed and marked, and reprints
- [x] With no shift open the screen says so and where else to look
- [x] A cashier reaches it; an inventory clerk does not — `TX-401`, from the rail's own matrix
- [x] Nothing on the screen writes to a sale

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-UI-12` | The list has no input of any kind, and opens the receipt by id |
| `TC-E2E-27` | Sell, start another sale, come back through the list and void the first — in the browser smoke |

`TC-E2E-27` is in `tools/browser-smoke/main.js` because what it proves needs a browser: the
receipt leaving the screen when the next customer starts is the whole premise, and it cannot be
shown from an HTTP client.

**What writing it turned up.** Three assertions in the walk sampled a state instead of waiting
for it, and failed on a loaded machine — the restore dialog's was the expensive one, because the
step after it then threw and took the rest of the walk down. All three now wait. And the first
draft of `TC-E2E-27` matched the receipt number with `includes('')` when the sale had not
completed, which passes against every row: the walk now asserts the number's shape before using
it, because an assertion that cannot fail is worse than one that is missing.

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
