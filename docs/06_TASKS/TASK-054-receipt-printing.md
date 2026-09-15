# TASK-054 — The receipt prints when the sale completes, and adds up

**Priority:** **P1** · **Rules:** `FR_3.7`, `INT-1`, `POS-208`, `UOM-002`, `TAX-004`

## What was wrong

| # | Fault | Since |
| :-: | :--- | :--- |
| 1 | **Nothing printed a receipt when a sale completed.** `saleService.printReceipt` was written "to be called by the route after POST /sales" and no route called it; the only way to paper was Reprint, so the first copy of every sale said `*** REPRINT ***` | `TASK-014` |
| 2 | **A pack line printed "100 BOX" for one box**: the base quantity formatted with the pack's code | `UOM-002` |
| 3 | **No discounted receipt added up.** The item line printed the line's net beside "1 x 1,120.00", the deductions were taken off it again underneath, and the totals read *Subtotal 900 · SC disc −200 · TOTAL 900* | `TAX-004`, `PR-*` |
| 4 | **A LAN printer that was off was reported as printed**, and never queued: the socket had not answered yet | `INT-1` |
| 5 | On 58 mm paper a long line **cut the price** ("1 SACK (50 KG) x 50.0") | — |

## As built

- `POST /sales` prints the receipt after the sale commits and answers `printed: { delivered,
  transport, error }`; it never fails the sale. A LAN printer's answer is awaited (its socket
  times out at 4 s), so the screen says what happened — `printService.outcome`, used by the sale,
  Print it, Reprint and the test page.
- A receipt that did not print can be printed **once more as the original** — `POST
  /sales/:id/print`, while it is on the failed queue — so a customer is not handed REPRINT for a
  sale rung up a minute ago. After that, a copy is a reprint (`POS-208`). No printer set up
  (`NONE`) is said, not queued as a failure.
- The receipt screen says *Receipt printed.*, *No receipt printer is set up*, or *The receipt did
  not print: <reason>* with **Print it**. Reasons are words, not `ENOENT`
  (`printService.plainReason`).
- Pack lines read `1 BOX (100 TAB)` wherever a sale line is shown.
- The receipt's arithmetic closes: each item line is quantity × price = its gross, the line's own
  deductions under it; the totals are Subtotal − Less VAT − SC/PWD − line discounts − discount =
  TOTAL, summed from the lines. A figure is never cut to fit the paper.

## Tests

`printing.test.js`: a sale prints at once, unmarked, over HTTP; a failed print is queued and
prints as the original once, then refuses; `NONE` queues nothing; a LAN printer that answers and
one that does not; a pack line and a discounted receipt checked by a helper that reads any
receipt and asserts it adds up. `statutory.test.js`: the senior receipt reads 1 × 1,120.00 =
1,120.00 and closes at 800.00. Walked in the renderer: a sale through the counter printed to a
USB device file unmarked; with the device gone the screen said why, and Print it printed the
original.
