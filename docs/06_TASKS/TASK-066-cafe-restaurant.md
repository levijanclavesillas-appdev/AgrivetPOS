# TASK-066 — Café / Restaurant, a third kind of store at setup

**Priority:** P1 · **Status:** queued · **Follows:** [TASK-064](TASK-064-restaurant-pos-review.md) (the review), `TASK-053` (industries)

## The ask

The store owner (2026-09-16), on TASK-064's review of back-end.store: "this will serve as another
type on set up as cafe/restaurant beside agrivet, pharmacy".

The first store is NAM-NAM, the café now on back-end.store. Section 2 of TASK-064 is what a
café needs that Chachi POS lacks. This task builds that, sized to what NAM-NAM actually does:
dine-in counter service, mostly cash, orders taken before they are paid.

## Scope

1. **The store type.**
   - `CAFE` ("Café / Restaurant") becomes available in `src/config/industries.js`, the setup
     wizard, the `store_profile.industry` CHECK and the public site.
   - **Its defaults:**
     - Senior/PWD discount on (RA 9994 and RA 10754 cover restaurants);
     - a *Serving* unit;
     - return reasons that fit food;
     - opening-spreadsheet examples from a menu;
     - the words the counter shows (menu item, order, table).
2. **Made to order.**
   - A product can be *not stocked*. Selling it needs no stock (`INV-104` does not apply) and
     makes no stock movement.
   - It stays out of stock counts, valuation and low stock.
   - On by default for a café's new products.
3. **Open orders.**
   - An order is taken with a table or a name, goes to the kitchen, and is paid when the
     customer leaves. Several are open at once, listed at the counter.
   - An order can have items added before it is paid.
   - An order still open at shift close must be paid, voided or handed to the next shift. It
     is not silently lost, unlike a parked cart (`POS-106`).
   - Dine-in, take-out or delivery is recorded on the sale, and so is the table.
4. **Kitchen ticket.**
   - When an order is sent or changed, a ticket prints with the table, items, quantities and
     notes, and only what was added since the last ticket.
   - The kitchen printer is its own setting, and may be the receipt printer, `BROWSER`
     included.
5. **Line notes and service charge.**
   - A note on a line ("less ice") goes on the ticket and the sale.
   - A service-charge rate in Settings adds its own line to dine-in orders. It shows on the
     receipt, the daily report and the payments reconciliation.
6. **The move.**
   - `tools/orderingapp/to-archive.js` gains the new columns: notes, table, order type,
     made to order.
   - Then NAM-NAM moves on the day the owner picks (TASK-064 §5).

**Not in this task:**

- modifiers with their own prices;
- split bills by item;
- a floor plan;
- a kitchen display;
- ingredient recipes.

These are Chachi Dine's ground. Add them here only if a café asks.

## Decisions to make before building

- **Open orders on devices (TASK-063).** An open order may be on the web copy and a phone at
  once. Either one device owns it until it is paid, or it syncs as it changes. The simpler
  choice, and TASK-063's rule for carts, is that it lives where it was opened.
- **Kitchen status.** Should an order carry received / preparing / ready? NAM-NAM rarely
  advanced it: 899 of 1,303 orders never left "received". The default is no status: an order
  is open, then paid.
