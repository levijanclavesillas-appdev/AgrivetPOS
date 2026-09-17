# TASK-071 — Changing many prices at once

**Priority:** **P1** · **Blocks release:** no · **Rules:** `PR-101`, `PR-105`, `TX-411`,
`AUD-601`, `MON-001`; new rule `PR-109` (`PHARMACY_EDITION.md` §14) · **Follows:**
`TASK-036` (the catalogue screens), `TASK-070` (price levels and packs) ·
**Status:** built 2026-09-17

---

## The ask

The owner (2026-09-17): "also make a process for bulk price adjustment, where the user can adjust
prices for multiple products conveniently not by going to each product 1 by 1."

That is exactly what the supplier's letter forces every few months, and what the software made
into an afternoon: `SCR-202` edits one product's price, so a 5% rise across two hundred products
was two hundred screens, two hundred reasons typed, and — the part that actually costs a store —
two hundred chances to fat-finger a figure nobody would notice until the till was short.

---

## What it is

**`SCR-209` Change prices**, reached from Products, behind `TX-411` (the permission that has
always governed a price; owner and manager).

1. **Which products, two ways.** The owner (2026-09-17): "the user can add or select a product to
   be added on the list to have the price be updated."
   - **What the search finds** — name, generic, SKU or barcode, and a category, the same two the
     product list uses. Up to 200 at a time, and the screen says when a narrower search is needed.
     This is "every drink goes up 5%".
   - **The list I build** — the ordinary product picker (`shell/picker.js`, so a barcode can be
     scanned into it) adds one product at a time; each row carries a ✕ and the list is kept until
     it is saved or emptied. This is the eleven items a supplier's letter names, which no search
     expresses. A product added this way is read again with `withPrices=true`, because the
     picker's own search carries only the retail price.
2. **What to do to them.** One price level (retail, wholesale or dealer) and one rule:

   | Rule | What it does |
   | :--- | :--- |
   | Raise / lower by % | `current × (1 ± p/100)`, to the centavo |
   | Raise / lower by ₱ | `current ± amount` |
   | Set to ₱ | one figure for all of them |
   | Set from cost, margin % | the price at which that margin is made **on the selling price** — ₱80 of cost at 20% is ₱100, not ₱96, which is how a store says it |

   and where the prices should land: no rounding, or the nearest ₱0.25, ₱1 or ₱5.
3. **Read it before it happens.** **Work it out** fills a **New price** column beside the cost
   and the current price, with the margin each new price would make. Any figure can be typed over
   by hand, and a row whose price would not change is not sent.
4. **Say why, once.** One reason (`AUD-601`) is kept on every product changed.

## How it is built

**The screen proposes and the server disposes.**

| Piece | Where |
| :--- | :--- |
| The arithmetic, pure and on its own — `newPrice()`, `marginBp()`, `RULES`, `ROUNDINGS` | `public/js/catalogue/price-rules.js` |
| The screen | `public/js/catalogue/prices.js`, styled in `public/css/catalogue.css` |
| `PUT /products/prices` (`TX-411`) | `src/routes/products.js`, **declared before `/products/:id`** so the word *prices* is never read as an id |
| `setPricesBulk(changes, actor, session, { reason })` | `src/services/productService.js` |
| `GET /products?withPrices=true` — every level, for the preview | `src/routes/products.js` |

`setPricesBulk` **validates the whole list before it writes a single row**: an unknown product on
row 2 of 200 refuses all 200 rather than leaving the store half changed. Then, in one
transaction, each product's price is written by the same dated path `SCR-202` uses (`PR-101`), so
the old price stays in the history, and each gets its own `PRICE_CHANGED` audit row carrying the
shared reason. A price identical to the one already in force is skipped, not rewritten. At most
500 products in one call.

The browser's arithmetic is a preview and nothing more — the server re-derives every figure it is
sent and refuses a negative one, a non-integer one, an unknown product, a missing reason, an empty
list and a list over the cap.

## Tested

| Where | What |
| :--- | :--- |
| `src/tests/integration/catalog.test.js` | the change writes and audits one row per product with the shared reason; an unchanged price is skipped; refusals for no reason, an unknown product on row 2, a negative price, an empty list, over 500 |
| `src/tests/unit/renderer.test.js` | `newPrice()` per rule and per rounding to the centavo, the margin on the selling price, the nulls (no price to raise, no cost for a margin); the screen sends only what changed, with the reason, and is behind `TX-411` |
| A walk in Electron | the hand-built list: "cof" suggests the coffee sachet, picking it starts the list, rice joins it, ₱1 off each writes ₱7.00 → ₱6.00 and ₱52.00 → ₱51.00, the list survives the save and ✕ takes a row off it |
| A walk in Electron | Products → **Change prices**, raise retail 5% rounded to ₱0.25 on a five-product store: ₱7.00 → ₱7.25, ₱15.00 → ₱15.75, ₱9.00 → ₱9.50, ₱5.00 → ₱5.25, ₱52.00 → ₱54.50; saving without a reason is refused by the screen; saving with one writes five prices and five audit rows |

## Open

1. **A schedule.** A change takes effect now. "Put these up on the first of next month" is
   `PR-101`'s dated price waiting to be given a screen; nobody has asked for it yet.
2. **A pack's price in bulk.** `PR-108`'s pack prices are still edited on `SCR-202`. The same
   screen could take them; a sari-sari store's day is unit prices.

---

*Chachi's Software Development Service · DTI BN 8089738 · BIR OCN 111RC20260000002455 · TIN 752-951-092-00000*
