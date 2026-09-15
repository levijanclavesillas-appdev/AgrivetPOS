# TASK-056 — A PIN reaches the counter, and the counter works by touch

**Priority:** **P1** · **Rules:** `SEC-2`, `SEC-6`, `NFR_4.3` · **Tests:** `TC-INT-03`

## What was wrong

| # | Fault |
| :-: | :--- |
| 1 | **After a PIN unlock the counter would not open.** `SEC-2` scopes a PIN "to POS and collections", but the counter's own reads — the open shift (`TX-418`), product search, the product, its stock and picture (`TX-422`) — were behind permissions the PIN scope does not hold. The POS and Receipts screens failed, and so did searching by name |
| 2 | **On a touch screen there was no way to change a quantity, give a discount or the senior/PWD 20%, remove a line, park or retrieve a sale.** Each was an F-key only, and the key bar was hidden on touch screens and phones — the Android tablet could not do them at all |

## As built

- `requirePermission` takes a list, any one of which passes. The counter's reads accept their own
  permission **or** the one they serve: `GET /products`, `/products/:id`, `/products/:id/image`
  and `/inventory/:productId` accept `TX-422` or `TX-401`; `GET /shifts/current`, `/shifts/:id`
  and `/shifts/:id/expected` accept `TX-418`, `TX-401` or `TX-420`. The PIN scope itself is
  unchanged: a PIN still cannot open reports (valuation, low stock), users, costs, returns, or
  close the shift — each refused as `SEC-2` with "Sign in with your password".
- The counter's key bar is now buttons — Qty, Discount, Txn discount, SC/PWD, Remove line, Park,
  Retrieve — each with its key beside it as a `.key-hint`, which a touch screen hides. The keys
  with a button elsewhere (Search, Customer, Pay, Exact cash, Park & new) stay listed as hints
  on a keyboard device. The bar shows on phones and touch screens.

## Tests

`authz.test.js` (`TC-INT-03`): after a real PIN unlock, the shift, product search, product,
stock and picture reads answer and a sale completes; costs are not on the product; valuation,
low stock, users and closing the shift are refused as `SEC-2`. `renderer.test.js`: every action
with no button of its own is a button with its key as a hint; nothing hides the bar on touch.
Walked in the renderer: a cashier locked the screen, unlocked with a PIN, and Receipts, the
counter and product search worked; with touch emulation at tablet and phone size, the buttons
showed without keys, Qty opened the quantity panel and Remove line removed the line.
