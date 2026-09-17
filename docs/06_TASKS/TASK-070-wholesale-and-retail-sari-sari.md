# TASK-070 — Wholesale & retail: a store type for sari-sari stores, groceries and distributors

**Priority:** **P1** · **Blocks release:** no · **Rules:** `PR-101`–`PR-104`, `UOM-002`,
`CR-101`–`CR-108`, `TAX-004`, `INV-101`, `POS-101`; new rules `PR-107`, `PR-108`, `POS-113`
(to be added to `PHARMACY_EDITION.md` §14) · **Follows:** `TASK-053` (industries),
`TASK-066` (how a store type is added), `TASK-069` (camera scanning) · **Status:** open, 2026-09-17

---

## The ask

The owner (2026-09-17): "make a task to set up for wholesale and retail industry like a sari sari
store deployment."

**Where it stands today.**

- **The store type.** `src/config/industries.js` already lists `RETAIL`, *Wholesale & retail*
  ("Groceries, general merchandise and distributors"), with `available: false`. The setup
  wizard shows it as coming soon, and the public site has a card for it.
- **What already fits.** Much of what a sari-sari store needs is in every store already:
  - selling by the piece from a box (`UOM-002`);
  - utang with limits and collections (`CR-*`);
  - retail, wholesale and dealer prices (`PR-101`);
  - quantity breaks (`PR-104`);
  - offline on a cheap Android phone;
  - the opening spreadsheet.
- **What is missing.** This task makes the type available, with sensible defaults. It adds the
  four things a sari-sari store or a small distributor does every day and cannot yet do.
  Then it deploys the first store.

## What a sari-sari store or distributor does that the POS cannot yet

| # | Need | Today | This task |
| :-: | :--- | :--- | :--- |
| 1 | **A walk-in buys at wholesale.** A neighbour's carinderia buys a case of noodles without an account | Wholesale applies only to a customer set to wholesale (`PR-101` level 3) | A **Wholesale** switch on the cart (`PR-107`) |
| 2 | **A case has its own price.** 24 bottles cost ₱300 as a case and ₱15 each loose | A pack sells at its contents × the unit price (`UOM-002`); a quantity break is the only way around it | **A price per pack**, per price level (`PR-108`) |
| 3 | **Items with no barcode.** Loose rice, eggs, ice, pandesal, a cigarette by the stick | Typed into search each time | **Quick keys**: a grid of the store's own buttons at the counter (`POS-113`) |
| 4 | **"₱20 worth of rice."** | The cashier works out 0.4 kg | **Sell by amount** on a fractional unit: the quantity is worked out and rounded to the unit's step |
| 5 | **A new utang customer at the counter.** "Isulat, Aling Nena" | A new customer is made on the Customers screen | **Add a customer from the counter** by name only, with the store's default limit |

Each is useful to every store type, and none is switched off elsewhere. The *Wholesale & retail*
type turns them on or up by default.

## Before starting — 6 answers are needed

1. **The name in the wizard.** Recommended: **"Sari-sari & wholesale"**, with the blurb
   *Sari-sari stores, groceries, general merchandise and distributors*. The code stays
   `RETAIL`.
2. **Senior/PWD discount, on or off by default?** Recommended: **off**, like agrivet.
   - **Why.** RA 9994's grocery benefit is a special 5% on basic necessities and prime
     commodities, not the 20% on everything. Most sari-sari stores are not in the program.
   - **When it is on.** If a store is, the owner turns it on, and which products count is set
     per product. A proper 5% basic-necessities mode is a later task.
3. **The price of a pack (need 2).** Recommended: **an optional price on the pack itself, per
   price level.**
   - **When it is blank.** The pack sells at its contents × the unit price, as today.
   - **What changes.** Stock still moves in pieces, and costing is unchanged.
   - **The alternative.** Quantity breaks only. No schema change, but "a case is ₱300" becomes
     "24 or more at ₱12.50", which owners find confusing.
4. **Who may switch a cart to wholesale (need 1)?** Recommended: **any cashier, recorded on the
   sale.** It is the store's normal trade, like choosing a customer.
   - **The dealer level.** It stays with customers only.
   - **The alternative.** Manager approval (`TX-404`-style), for stores that want it.
5. **The default utang limit for a counter-added customer (need 5).** Recommended: **₱500**, a
   setting the owner changes, with terms of 15 days.
6. **The first store.** Which store, on which device (Android phone, web, or both), and on
   which plan (monthly, or one-time with an activation key, TASK-067/068)? This decides step 4
   of the deployment below.

## Objective

A sari-sari store or small distributor:

- picks *Sari-sari & wholesale* at setup;
- loads its goods from the spreadsheet;
- sells by the piece, the pack or the case, at retail or wholesale, with or without barcodes;
- keeps its utang.

The first store runs on it.

## Requirements

**The store type.**

1. **Available.** `RETAIL` is `available: true`, with answer 1's label and the `store` mark.
   The sign-in line reads *Chachi POS (Sari-sari & wholesale)*.
2. **Its defaults** (`industries.js`), editable later like any setting:
   - senior/PWD discount off (answer 2);
   - credit on, with the counter-add limit (answer 5);
   - quick keys on;
   - return reasons for groceries: *Expired*, *Damaged or dented*, *Wrong item*, *Spoiled*;
   - write-off categories: *Food*, *Beverages*, *Frozen*, *Bread*;
   - a new product that is not batch-tracked and not senior/PWD-eligible;
   - tax mode `NONE` suggested in the wizard, since most sari-sari stores are not VAT-registered.
3. **The opening spreadsheet.** Its examples are a sari-sari store's goods:
   - a coffee sachet sold by the piece, with a strip of 10 and a box of 30 as packs, each with
     its own price;
   - a soda in bottles and cases;
   - rice by the kilo and the sack;
   - a utang balance.

   A `pack_retail_price` and a `pack_wholesale_price` column go on the *Packs* sheet
   (answer 3).
4. **Where it shows.** The public site's card leaves *coming soon*, and the guide's *Getting
   started* names the type.

**The four needs.**

5. **`PR-107`: the wholesale switch.**
   - **The switch.** The counter has **Retail | Wholesale** above the cart, and a shortcut in the
     keymap.
   - **Wholesale.** Every line resolves at the `WHOLESALE` level, falling back to retail where
     a product has no wholesale price (`PR-102`), with a mark on those lines.
   - **With a customer.** Choosing a customer sets the switch to that customer's level. A
     customer-specific price (`PR-103`) still wins.
   - **Recorded.** The level is recorded on each line, as today, and on the sale
     (`sales.price_level`, which exists).
   - **Who.** Answer 4 decides who may switch.
6. **`PR-108`: a price per pack.**
   - **Where it is kept.** `product_pack_prices`: a pack, a price level, a price and an
     effective date, the same shape as `product_prices`.
   - **Selling a pack.** A line sold in a pack uses that price where one is set. Otherwise it
     uses its contents × the unit price.
   - **What does not change.** Quantity breaks, discounts and the below-cost check (`PR-105`,
     per base unit) still apply.
   - **The screens.** The editor's *Units* tab shows each pack's price beside its contents, and
     the receipt shows `1 CASE × ₱300.00`.
7. **`POS-113`: quick keys.**
   - **The grid.** A tab on the counter shows up to 24 buttons, each a product (and a pack),
     with its picture or first letters. Pressing one adds one, the same as a scan.
   - **Arranging them.** The owner arranges them on a *Quick keys* screen under Products. They
     are per store and synced (TASK-063).
   - **Suggestions.** A new store gets up to 8 suggested from its spreadsheet's products with no
     barcode.
8. **Sell by amount.**
   - **The button.** On a line whose unit allows fractions, **By amount** takes pesos and sets
     the quantity to amount ÷ unit price, rounded down to the unit's step (0.001 kg).
   - **What the receipt shows.** The quantity and the price as usual.
   - **The unit's step.** Units gain an optional `step_milli` (for example 250 for quarter-kilos)
     for stores that sell rice only in quarters.
9. **Add a customer at the counter.**
   - **The form.** The customer picker has **New**, which asks for a name (and optionally a phone
     number) and makes a credit-eligible customer with the default limit and terms.
   - **Who.** Any cashier with `TX-413` can use it. It is audited.
   - **Raising the limit.** Only the owner or a manager can raise it (`CR-*`).

**The deployment.**

10. **The runbook.** `docs/DEPLOYMENT.md` gains *A sari-sari store*:
    1. **The device.** A phone (the Play Store app, or the APK) or a web store
       (`web/store.sh create <store>`).
    2. **Setup.** Set it up as *Sari-sari & wholesale*.
    3. **Goods.** Fill the spreadsheet on a computer or the phone, and load it.
    4. **The licence.** Link it: Google, or an activation key from the admin page (answer 6).
    5. **Staff and utang.** Add staff, and the notebook's utang as opening balances.
    6. **Printing.** Optional: a 58 mm Bluetooth or network printer, or no printer (receipts on
       screen).
    7. **Scanning.** The camera, once TASK-069 is in.
11. **The first store** (answer 6) is set up this way, and the walk is recorded in this file:
    a morning's sales, one wholesale case, one sale by amount, one new utang customer, and the
    day closed.

## Business rules (new)

| ID | Rule |
| :--- | :--- |
| `PR-107` | A cart has a price level: retail unless switched or set by its customer. Every line resolves at it, falling back to retail where a product has no price at that level. The level is recorded on the sale and on each line |
| `PR-108` | A pack may carry its own price per price level. A line sold in that pack uses it. Otherwise the line costs its contents × the unit price. Stock and cost are always in base units |
| `POS-113` | Quick keys are the store's own buttons for products and packs. Pressing one is the same as scanning that product or pack |

## Technical requirements

| Area | Detail |
| :--- | :--- |
| Schema | `909_wholesale_retail.sql`: `product_pack_prices`; `units.step_milli`; `store_profile` admits `RETAIL` (rebuilt as `908_cafe.sql` did for `CAFE`); `quick_keys (id, position, product_id, pack_unit_id)`. Update the migration and table lists, and `base-migrations.sha256` only if a base file changes (it should not) |
| Pricing | `pricingService.priceCart({ priceLevel })`; `resolvePackPrice` before the per-unit chain for pack lines; tests beside the existing `PR-101`–`PR-106` ones |
| Services | `quickKeyService`; `customerService.quickAdd`; the settings `quick_keys_enabled`, `counter_customer_credit_limit_centavos`, `counter_customer_terms_days` |
| Sync | `quick_keys` and `product_pack_prices` join the synced tables (`SYNC-001`) |
| Screens | `SCR-301` (the switch, the quick keys tab, By amount, New customer), `SCR-202` (pack prices), a new *Quick keys* screen, `SCR-001` (the type is available) |
| Import/export | Pack prices in the export, and in the workbook's *Packs* sheet |
| Docs | `industries.js`, the public site's card, the guide, `DEPLOYMENT.md`, `PHARMACY_EDITION.md` §14, the Play listing's description (it already names shops) |

## Acceptance criteria

- [ ] **Setup.** A store set up as *Sari-sari & wholesale* starts with the defaults in
      requirement 2, and its spreadsheet examples are grocery goods.
- [ ] **Wholesale switch.** A walk-in cart switched to wholesale sells a case of noodles at the
      case's wholesale price. The receipt and the sale record *WHOLESALE*. A product with no
      wholesale price sells at retail and is marked.
- [ ] **Pack prices.** A box of 30 coffee sachets priced ₱180 sells at ₱180, not 30 × ₱7.
      Stock falls by 30 pieces. A strip of 10 with no pack price sells at 10 × ₱7.
- [ ] **Below cost.** A pack price below cost asks for a manager (`PR-105`).
- [ ] **Quick keys.** The key *Ice* adds one ice, and the owner's arrangement shows on the
      store's other device after a sync.
- [ ] **By amount.** ₱20 of rice at ₱52/kg adds 0.384 kg (₱19.97), or 0.25 kg where the
      unit's step is 250.
- [ ] **New customer.** *Aling Nena*, added from the counter, takes ₱350 on credit. A ₱600
      sale goes over the ₱500 limit and needs approval (`CR-104`).
- [ ] **Other store types.** A pharmacy and a café still sell as before, and the switch shows
      only where quick keys or wholesale prices exist.
- [ ] **The first store** (answer 6) has run for a day and closed its shift.
- [ ] **Tests.** All suites pass.

## Tests

- **`pricing.test.js`.** `PR-107` levels with and without a customer, and the fallback.
  `PR-108` pack prices at each level, with breaks, discounts and below-cost.
- **`retail.test.js`, new, like `cafe.test.js`.** A sari-sari store set up through the real
  service, then a morning through the API:
  - the wholesale case;
  - a sale by amount;
  - quick keys;
  - a counter-added utang customer over the limit;
  - the daily report adding up;
  - a void of a pack sale restoring 30 pieces.
- **`sync.test.js`.** Quick keys and pack prices reach a device.
- **`data-transfer.test.js`, `opening-*`.** Pack prices exported, imported and loaded from
  the workbook.
- **`renderer.test.js`.**
  - The switch.
  - The quick keys grid is touchable (44 px).
  - By amount shows the worked-out quantity.
  - The new-customer form.
- **Industry lists.** The industry, migration and table lists are updated.
