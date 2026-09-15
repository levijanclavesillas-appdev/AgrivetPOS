# TASK-061 — A delivery short a whole line, and an order closed short

**Priority:** **P1** · **Rules:** `PO-102`, `PO-103`, `PO-105`, `PO-106` (new, `PHARMACY_EDITION.md` §11), `INV-202` · **Tests:** `purchasing.test.js` (TASK-061), `renderer.test.js`

## What was wrong

| # | Fault |
| :-: | :--- |
| 1 | **One missing product stopped the whole delivery.** Every line on "Receive against PO-…" needed an arrived quantity above zero, and no line could be taken off. If one product on the order did not come, the van could not be received. The server never required this; the screen did |
| 2 | **Batch fields blocked it too.** On a batch-tracked product that did not come, the batch number and expiry were still *required* inputs. The browser refused to submit the form over a box that never arrived. Found in the renderer walk |
| 3 | **A partly received order could never end.** `PO-105` rightly forbids cancelling an order once goods have arrived against it, and nothing else ended one. An order whose rest was not coming stayed *Partly received* for ever, still shown as awaiting goods. The guide's only advice was "wait, or email support" |
| 4 | **A delivery without an order could not drop a line.** It had "Add a line" and no way to remove one |

## As built

- **The delivery screen.** On an order, a line left at 0 (or blank) is not part of this
  delivery. It turns grey, its batch fields stop being required, it is not sent, and it stays
  outstanding. At least one line must have arrived. A note under the table says so. A
  delivery without an order has a remove button on each line.
- **`PO-106`: close short.** `POST /purchase-orders/:id/close` (`TX-409`) takes a required
  reason and is allowed only when the order is `PARTIALLY_RECEIVED`. A `PENDING` order is told
  to cancel instead. The order becomes `RECEIVED` (a transition `PO-102` already allows)
  with `closed_short_at`, `closed_short_by` and `close_reason` (`906_po_close_short.sql`).
  What was ordered and what arrived are unchanged, no stock moves (`PO-103`), and the audit
  row lists what was not delivered.
- **What the order shows once closed short.**
  - The status reads "Closed short", and the date and reason are shown.
  - The lines show *Not delivered* instead of *Outstanding*.
  - Nothing is outstanding, so the order is not open, cannot take a delivery, and cannot be
    closed again.
- **The order screen.** "Close short…" asks for the reason and names what will not come.

## Tests

`purchasing.test.js` (TASK-061), over HTTP:

- **A delivery that leaves a line out.** A two-line order was received with one line by the
  inventory clerk: 201. The order was *Partly received*, the other line was still
  outstanding, and it could be closed short.
- **Close short.**
  - An order with nothing received: refused, "Cancel it instead".
  - A cashier: refused (`TX-409`).
  - No reason: 400.
  - Closed with a reason: the order is `RECEIVED`, reads "Closed short", and is not open. What
    came stays received, outstanding is 0, not delivered is the difference, and no stock
    moved. The audit row names what was not delivered.
  - Afterwards, a second close and a delivery are both refused.

`migration-ranges.test.js` lists `906_po_close_short.sql`. `renderer.test.js` checks the zero
lines, the batch fields' `required` toggle, the remove button and the close-short button.

Walked in the renderer against the demo store, as Leo (inventory):

1. An order for 200 paracetamol and 300 ascorbic acid.
2. Ascorbic acid set to 0: its row greyed and its batch fields were no longer required.
3. The paracetamol, with its batch, posted as GR-…-000001, ₱300.00 into stock, and the order
   became *Partly received*.
4. "Close short…" named "Ascorbic acid 500 mg tablet (300 TAB)". Closed with a reason, the
   order read *Closed short* with *Not delivered 300 TAB*.
