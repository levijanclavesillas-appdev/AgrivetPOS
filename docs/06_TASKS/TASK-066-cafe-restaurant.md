# TASK-066 — Café / Restaurant, a third kind of store at setup

**Priority:** P1 · **Rules:** `INV-114`, `POS-109`–`POS-112` (new, `PHARMACY_EDITION.md` §13), `TAX-004`, `TAX-006`, `SYNC-001` · **Tests:** `cafe.test.js`, `orderingapp-import.test.js`, `renderer.test.js` · **Follows:** [TASK-064](TASK-064-restaurant-pos-review.md) (the review), `TASK-053` (industries)

## The ask

The store owner (2026-09-16), on TASK-064's review of back-end.store: "this will serve as another
type on set up as cafe/restaurant beside agrivet, pharmacy".

The first store is NAM-NAM, the café now on back-end.store. TASK-064 §2 is what a café needs that
Chachi POS lacked. This task builds that, sized to what NAM-NAM actually does: dine-in counter
service, mostly cash, orders taken before they are paid.

## Decisions

- **Open orders live on the device where they were taken.** They are not synced (TASK-063's rule
  for carts); the sale they become is. The simpler choice, and the one this document proposed.
- **No kitchen status.** An order is open, then paid. NAM-NAM rarely moved an order past
  "received" (899 of 1,303).
- **The service charge is a figure of its own on the sale, not a product line.** It is not
  discounted, nothing is returned against it, and the daily report carries it as its own term.

## As built

**The store type.** `CAFE`, *Café / Restaurant*, in `src/config/industries.js`.

- **Where it appears.** The setup wizard and the sign-in line (*Chachi POS (Café / Restaurant)*).
  `908_cafe.sql` rebuilds `store_profile` to admit it in the CHECK: same columns, row copied.
- **Its defaults:**
  - the 20% on (RA 9994 names restaurant meals);
  - open orders on, and kitchen tickets on the receipt printer;
  - no service charge until the owner sets one;
  - return reasons for food, and a new product made to order;
  - a coffee-cup mark in the rail and on products with no picture.
- **The opening spreadsheet.** Its examples are a menu, and it has a `made_to_order` column.
- **The public site.** It has a Café / Restaurant card, and the setup guide names the new type.

**Made to order (`INV-114`).** `products.is_stocked`. The one place stock moves
(`inventoryService.post`) decides what happens:

- **Sales, voids and returns.** Selling a made-to-order product moves nothing, and so does its void
  or return. Those two ask the sale's own movements whether a line moved stock, not the product's
  flag today.
- **Everything else is refused** with `INV-114`: a delivery, opening stock, an adjustment, a count
  or a purchase order.
- **Low stock and counts.** It is never low on stock, and the count sheet leaves it off.
- **What it cannot also be.** It cannot be batch-tracked or given a minimum, and a product with
  stock on hand cannot become one.
- **Screens.** The editor has *Made to order — no stock is kept*, and its Stock tab explains
  instead of offering a minimum. The list reads *made to order* and offers no Adjust.

**Open orders (`POS-109`).** `open_orders`, `openOrderService` and `routes/openOrders.js`.

- **Taking one.** An order has a type (dine-in, take-out, delivery), a table or name, the day's
  number on this counter, the lines as a cart holds them, and what the kitchen has been sent.
- **Paying for it.** Paying is an ordinary sale (`POS-108`'s number, prices resolved then) that
  records the order's type and table (`sales.order_type`, `table_label`) and marks the order paid.
- **Without an order.** A café's sale rung up without one — a take-out paid at once — gets a
  number too.
- **Cancelling one.** It needs a reason and is audited (`OPEN_ORDER_VOIDED`).
- **Where they live.** Orders are local to the device: not synced, and cleared from a snapshot a
  device adopts.
- **At shift close.** A shift closes with orders open. `/shifts/current` and the close answer
  `open_orders`, and the close screen lists them.

**The kitchen ticket (`POS-110`).** `printService.renderKitchenTicket`.

- **What it shows.** The number, table, type and time, then each item with its quantity and note.
  No prices.
- **Only what changed.** The first send prints the whole order; later sends print `+`/`−` changes
  only.
- **At payment.** The sale route prints whatever was added at the counter and never sent, as
  `kitchen.printed` beside the receipt.
- **Cancel and reprint.** Cancelling prints *ORDER CANCELLED*, and *Ticket* reprints the whole
  order, marked REPRINT.
- **The printer.** `kitchen_printer` is `NONE`, `RECEIPT` or `LAN` (with its own host and port),
  set per device. On `BROWSER`, one print dialog carries the receipt and the ticket, a page each.
- **`TAX-006`.** It holds on the ticket as on every document. Free text (notes, tables, names) is
  printed with any forbidden-looking phrase broken (`documentService.neutralise`): "or no sugar"
  prints as "o-r no sugar" rather than being refused.

**Line notes (`POS-111`).** `sale_items.note`, up to 60 characters.

- **The cart.** A note makes a line its own: another scan adds to the plain line.
- **Where it shows.** On the ticket, the receipt and the sale.
- **Pricing.** Price-check lines are matched by position now, since one product can be two lines.

**Service charge (`POS-112`).** `service_charge_bp` (owner, 0–20%, default 0).

- **What it is charged on.** `pricingService.priceCart({ serviceChargeBp })` adds it on the lines
  after every discount, VATable in VAT mode. It goes to dine-in only, decided by
  `openOrderService.serviceChargeBpFor`.
- **Where it is kept.** `sales.service_charge_bp` and `service_charge_centavos`.
- **Where it shows.** On the counter, the payment screen and the receipt. The daily report's
  identity is now gross − discounts + service charge − returns = net, and the CSV has the row. A
  return does not refund it.

**The counter.** When orders are on:

- **The order block.** Dine-in / Take-out / Delivery and the table or name, with the order's number
  and whether the kitchen has everything, plus *Discard changes* or *Put the order back*.
- **The keys.** **Send to kitchen / Send changes** (`F6`, `F12`) and **Orders** (`F7`, with the
  count) replace Park and Retrieve. **Note** is a button, since `F11` belongs to the screen.
- **The Orders panel.** It lists orders oldest first with table, lines, age and total, and offers
  **Ticket** and **Cancel…**.
- **Payment and receipt.** Both show *Order 1 · Dine-in · Table 4*, and the receipt screen warns
  when the kitchen ticket did not print.
- **After a restart.** A draft that was an open order reattaches to it.

**The move from back-end.store.** `tools/orderingapp/to-archive.js` now requires a Café base
store. Menu items come in made to order; each order's type, table, notes and service fee land in
the new columns.

## Tests

- **`cafe.test.js` (12).** A café set up through the real service, driven through the API with the
  printer on `BROWSER` so every document comes back as text:
  - **Setup.** The café's defaults.
  - **Made to order.** It sells with no stock and cannot be received, adjusted, ordered from a
    supplier, batch-tracked or given a minimum. A stocked product with stock cannot become one.
  - **Table 4.** The order goes out, then only its changes, with the note printed under its line
    and made safe for `TAX-006`.
  - **Paying.** Table 4 pays with the 10% charge and a water added at the counter. Only the water
    moves stock, and the kitchen gets `+ 1 x Bottled Water`. Paying twice is refused.
  - **Take-out.** A take-out paid at once gets order 2 and a full ticket.
  - **Cancelling.** A cancel needs a reason, is audited and tells the kitchen.
  - **Shift close.** A shift closes with an order open, and the owner's next shift is paid for it.
  - **The daily report.** It reconciles with *+ ₱43.30 service charge*.
  - **VAT.** The charge carries VAT.
  - **Void and return.** A void and a return of a meal move no stock.
  - **A shop.** A shop refuses open orders and sells as before.
  - **Local and low stock.** Open orders and the kitchen printer are local, and made to order is
    never low.
- **`orderingapp-import.test.js`.** The converted history keeps the fee as a service charge (5%,
  ₱4.45), the table, the note and the order type. Menu items are made to order, and the report
  reconciles.
- **`renderer.test.js`.**
  - **The cart.** A note splits and merges lines, and the cart carries its order, its changes since
    sent, and its type across `clear()`.
  - **The counter.** It sends, lists and cancels orders and shows the charge.
  - **Printing and the editor.** The browser prints the kitchen ticket with the receipt, and the
    editor has *Made to order*.
- **Lists.** The migration, table and industry lists are updated.
- **Suites.** Unit 333, integration 719, e2e 208, licence 14.

**Walked in Electron** on a fresh café store set up over the API (10% charge, `BROWSER` printing):

- **Taking the order.** The counter opened on *Dine-in*. Table 4 ordered two bibimbap and an iced
  latte, noted *less ice*: subtotal ₱319.00, service charge 10% ₱31.90, total ₱350.90.
- **Sending it.** *Send to kitchen* printed ORDER 1 with the note under the latte and no prices,
  and the counter cleared.
- **Taking it up again.** *Orders (1)* listed it. Taken up with a water added, it read *Changes not
  sent to the kitchen yet*.
- **Paying.** The payment screen showed *Order 1 · Dine-in · Table 4 · incl. service charge 10%
  ₱34.40*. Paid, it printed `SALE-20260916-000001` with *Service charge 10% 34.40 · TOTAL 378.40*,
  and on its own page *KITCHEN - CHANGES · + 1 x Bottled Water*.
- **The editor and list.** A new product in the editor starts *Made to order*. The list reads
  *made to order* for the meals and *23 BOT* for the water.
- **Closing.** With orders 2 and 3 still open, *Close the shift* said *2 orders are still open —
  Order 2 (Table 4), Order 3 (Table 2)… They stay open for whoever is on the counter next.*
- **A refusal.** Paying for a water with none in stock was refused (`INV-104`), as it should be
  for a stocked product.

## Known limits

- **Devices.** An open order is on the device it was taken on. A café using the web and a phone
  together takes up an order on the one it was sent from.
- **Returns.** A return does not refund the service charge; a whole bill that was wrong is voided
  during its shift.
- **Not built:** modifiers with prices of their own, split bills by item, a floor plan, a kitchen
  display, and ingredient recipes. These are Chachi Dine's ground, to add here only if a café
  asks.

## Next

NAM-NAM's move (TASK-064 §5): `web/store.sh create nam-nam`, set it up as Café / Restaurant,
export, run `tools/orderingapp/to-archive.js` against `mmcafe-db-1`, import, set passwords, and
stop taking orders on back-end.store. It waits on the owner's three answers in TASK-064.
