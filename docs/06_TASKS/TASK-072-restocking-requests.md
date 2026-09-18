# TASK-072 — What to buy: the restocking request

**Priority:** **P1** · **Blocks release:** no · **Rules:** `INV-101`, `INV-109`, `INV-114`,
`UOM-005`, `PO-101`–`PO-105`, `TX-409`, `AUD-601`, `AUD-603`, `VR-103`; new rules
`PO-107`–`PO-109`, amended `INV-109` (`PHARMACY_EDITION.md` §15) · **Follows:** `TASK-019`
(suppliers and purchasing), `TASK-061` (a delivery short a line) ·
**Status:** **built 2026-09-18** · **No open questions**

---

> **✅ Delivered 2026-09-18.** `SCR-806` **Restock**, reached from Buying, behind `TX-409`.
> The whole suite passes: 22 unit files, 46 integration, 26 e2e, including 22 new cases in
> `src/tests/integration/restock.test.js` and six renderer guards.
>
> **The defect found while building it is the one worth reading.** `05_TECH_SPEC.md` §8.3
> forbids nesting one transaction inside another, and `purchaseOrderService.create()` opens
> its own — so `PO-108`'s "one order per supplier, all or nothing" could not be written at
> all as first drafted. The body is now `createWithin(input, actor, { at })`, which runs
> inside a transaction the caller owns, and `create()` wraps it for every ordinary caller.
> **This was already the codebase's own pattern** — `productService.createWithin` exists for
> the same reason — which is the reassuring half: the constraint is real and the answer to it
> was already settled, and only a nested-transaction guard that *throws* made either visible.
>
> **A second fault the tests caught rather than the author:** the rejection dialog was built
> on `window.prompt`, which Electron refuses — so in a packaged build the button would have
> done nothing at all. `renderer.test.js` already guards against exactly this (it was written
> after `order.js:386` shipped the same bug), and it failed the moment the file was added. It
> is `ui.ask` now.
>
> **`INV-109` is amended, and this is the substantive product change.**
> `inventoryRepository.lowStock():167` requires `min_stock_milli > 0`, so **a product nobody
> set a minimum on was invisible to every low-stock surface in the application, including at
> zero stock** — on a store stocked by hand, most of the catalogue. The restock list carries a
> second derivation, `OUT_OF_STOCK`, for exactly those, and marks them. The low-stock surfaces
> themselves are unchanged.
>
> **Still open:** the four items below. **Minimums in bulk (item 3) is the one that should come
> next and has no task number yet** — most of the catalogue has no minimum, so most of what this
> screen can suggest is still "say how many".

---

## The ask

The owner (2026-09-18): a module for restocking requests — "a list of products that needs to be
bought or requested to supplier."

Everything needed to answer *what is low* already exists, and nothing answers *what to buy*.
`INV-109` computes low stock at read time, `inventoryRepository.lowStock()`
(`src/repositories/inventoryRepository.js:163`) serves it, `GET /inventory/low-stock` exposes it,
`SCR-201` filters the product list by it and the dashboard carries a tile. All of them produce
**a list on a screen that dies when the screen closes.** The buyer reads it, writes on paper,
walks to `SCR-802` and keys the same products in again — once per supplier, from memory of which
supplier sells which.

Four things that costs the store, in the order they cost it:

1. **Ordering what is already coming.** Low stock is on-hand against minimum. It knows nothing
   about the forty sacks on a `PENDING` order. A buyer who orders on Monday and reads the list
   again on Thursday orders them twice, and the second forty arrive as money on a shelf.
2. **The products the list cannot see.** `inventoryRepository.lowStock():167` requires
   `p.min_stock_milli > 0`. **A product nobody set a minimum on is invisible to every low-stock
   surface in the application, including at zero stock.** On a store stocked by hand — which is
   how `TASK-026` says the first store was stocked — that is most of the catalogue. The buyer's
   real question is "what is empty", and the current answer silently excludes everything nobody
   configured.
3. **A request nobody can approve.** The inventory clerk holds `TX-409` and sees the shelf; the
   owner holds the money. There is no document between them, so the request is a text message
   and the approval is a reply to it.
4. **Forgetting the thing no derivation knows.** A customer asked for a wormer the shop does not
   stock. That is a restocking need, and no arithmetic over `min_stock_milli` will ever produce it.

## What it is

**`SCR-806` Restock**, reached from Buying beside Orders, behind **`TX-409`** — so the owner, the
manager and the inventory clerk reach it and a cashier does not. The same permission that governs
receiving governs asking, because they are the same person's job, and because
`04_UX_SPEC.md:120` has already recorded what happens when they are split: *"a reorder list the
stock role cannot open is a reorder list nobody reads."*

`TX-409` and not `TX-422`, though the low-stock endpoint this borrows from uses `TX-422`: the
output of this screen is a purchase order, and `routes/purchasing.js:12-21` has already decided
that raising one is `TX-409`. The screen reads inventory under the permission that lets it write
an order, not the other way round.

### 1. The list builds itself, and then is edited

Three sources, merged, each row labelled with which one put it there:

| Source | Predicate |
| :--- | :--- |
| **Below minimum** | `min_stock_milli > 0 AND qty_on_hand ≤ min_stock_milli` — today's `INV-109` |
| **Empty, no minimum set** | `min_stock_milli = 0 AND qty_on_hand ≤ 0` — the gap above |
| **Added by hand** | anything the buyer picks |

All three keep `INV-114`'s exclusion: `is_stocked = 0` is made to order and is never low on stock.

Per row:

| Column | Where it comes from |
| :--- | :--- |
| Product, base unit | `products` |
| On hand | `inventory.qty_on_hand_milli` (`INV-101`) |
| Minimum | `products.min_stock_milli` (`UOM-005`, base unit, labelled with it) |
| **On order** | `SUM(poi.qty_milli) − SUM(gri.received_qty_milli)` over orders in `PENDING` / `PARTIALLY_RECEIVED` |
| **Suggested** | the arithmetic below |
| Last cost, last supplier | the most recent `goods_receipt_items` row for the product |

**On order is the column this module exists for.** It is the difference between a list read once a
week and a list that is trusted.

**Anything can be added by hand** — the ordinary product picker, so a barcode can be scanned into
it. That is how the wormer nobody stocks gets onto the list, and how a buyer orders ahead of a
season no minimum knows about.

**Any line can be taken off**, with no reason required. A buyer declining to order something is
not an exception to be audited; it is the job.

### 2. The suggestion is arithmetic, and says so

```
suggested = max(0, target − on_hand − on_order)

target = min_stock_milli × cover      where a minimum is set
       = 0                            where it is not — the row asks, it does not guess
```

`cover` is one store-wide setting (`restock_cover_multiplier`, default `2`) — "order up to twice
the minimum" — and the row states the sum rather than presenting a figure from nowhere.
**Every suggested quantity is editable**, and the figure sent is the one in the box, never the
derived one. A row with no minimum is offered with an empty quantity and a prompt, because a
store that never said how many it wants has not been asked yet, and inventing a number for it is
how a module loses the buyer's trust in its other columns.

Deliberately **not** sales velocity — yet. `reportRepository.moversOverview()`
(`src/repositories/reportRepository.js:472`) already returns units sold in a range beside on-hand
and `last_sold_at` for every product in one query, so the data is there and indexed. But a
suggestion computed from three weeks of trading in a month with a fiesta in it is worse than one
computed from the minimum the owner set by hand, and velocity also drags in `TX-421`, which the
inventory clerk does not hold. It is the first item under *Open*.

### 3. It is a document, and it is asked for

Saved, the list becomes a **restocking request**: a number (`RR-YYYYMMDD-NNNNNN`, `VR-103`, via a
new `RESTOCK_REQUEST` sequence type in `sequenceService`), a requester, a date, a note, and lines.
Status, mirroring `PO-102`'s shape because the buyer already reads that one:

```
DRAFT ──▶ SUBMITTED ──▶ APPROVED ──▶ ORDERED
              │              │
              └──▶ REJECTED  └──▶ CANCELLED
```

- **`DRAFT`** is the clerk's working list, edited in place.
- **`SUBMITTED`** is the ask. It is nobody's to edit but the approver's.
- **`APPROVED`** / **`REJECTED`** need a manager or owner, and a rejection needs a reason
  (`AUD-601`). Both record requester and approver as distinct actors (`AUD-603`). Approval is
  **per line** — a request for eleven things the owner will pay for nine of is the ordinary case,
  and all-or-nothing sends the clerk back to the start.
- **`ORDERED`** is reached only by §4, never by hand.

**The approval step is wanted, and is on.** Decided by the owner, 2026-09-18: the clerk raises the
request and the owner approves it. `restock_approval_required` defaults **on**, and a request
cannot become orders without a second person — which is the whole point of the module for a store
where the person who sees the shelf is not the person who pays for it.

**But a one-person store is not made to hold a meeting with itself.** Where the store has exactly
one active user there is no second person to ask, so a saved request goes straight to `APPROVED`
with the requester recorded as both actors and the request marked as self-approved — the same
honesty `INV-112` applies to a stock count that cannot have been double-checked. This is a
property of the store's staffing, not a setting somebody can switch off to skip the approver.

### 4. It becomes orders, one per supplier

From an `APPROVED` request: **Create orders**. Lines are grouped by the supplier on each line and
one **`DRAFT` purchase order per supplier** is raised through the path `SCR-802` already uses —
`purchaseOrderService.create({ supplierId, lines: [{ productId, qtyMilli, unitCostCentavos }] })`
(`src/services/purchaseOrderService.js:325`) — carrying the quantity, the buying unit and the
last cost as the opening figure. The buyer then opens each in `SCR-802` and does what `SCR-802`
has always done: check the costs, send it.

Nothing about `PO-101`–`PO-104` changes. A draft is freely editable before submit, which is
exactly what a suggested order should be.

**The supplier per line is derived, not stored**, because no product↔supplier link exists in the
schema — no `preferred_supplier_id`, no `product_suppliers`, no `supplier_sku`. The default comes
from `goodsReceiptService.historyForProduct()`, the most recent receipt of that product, and the
buyer can change it. A product never received has no default and the row says so.

A line with no supplier does not stop the others: it stays on the request, and the request says
so rather than silently dropping it.

### 5. What it does not do

**A restocking request moves no stock and commits the store to nothing** (`PO-107`) — the same
sentence `PO-103` says about a purchase order, for the same reason, and the screen says it where
a reader might look for a "receive" shortcut.

## How it would be built

| Piece | Where |
| :--- | :--- |
| Schema — `restock_requests`, `restock_request_items` | `src/migrations/910_restock.sql` |
| `restockRepository.js` — `suggestionRows()`, `contextFor()`, the document and its lines | `src/repositories/` |
| `restockService.js` — `suggest()`, save, submit, decide, cancel, convert | `src/services/` |
| `RESTOCK_REQUEST` number series (`RR-YYYYMMDD-NNNNNN`) | `src/services/sequenceService.js`, **and `sequenceRepository.js`'s `ALLOWED` map** — it keeps its own allow-list, because the table and column are interpolated |
| Seven audit actions, `RESTOCK_REQUEST_*` | `src/services/auditService.js` |
| `restock_cover_multiplier` (2), `restock_approval_required` (on) | `src/services/settingsService.js`, group `PURCHASING` |
| `GET /restock/suggestions`, `POST /restock/context`, `GET/POST/PUT /restock-requests`, `POST …/submit`, `/decide`, `/cancel`, `/orders` | `src/routes/restock.js`, mounted in `src/app.js` |
| The screen — three views in one module: the requests, the list being built, one request decided | `public/js/purchasing/restock.js` |
| Registration — import, the Buying callback, `show()` | `public/js/shell/app.js`; the button in `public/js/purchasing/orders.js` |

Reached as a sub-screen of Buying, like Deliveries and Suppliers — a callback from `SCR-801`
calling `renderRail('buying')` itself, not a fifth rail item. `TX-409` is already in `GRANTS`,
so no permission change was needed.

**`purchaseOrderService.createWithin()` is new, and is the interesting part.** §8.3 forbids a
nested transaction, so `convert()` cannot call `create()`. The order-raising body is now a
function that runs inside the caller's transaction; `create()` wraps it for everyone else. The
same split already existed on `productService`, which is how we know it is the house answer
rather than an expedient.

**The outstanding-quantity query is the one piece with a performance question.** *On order* per
product is a sum over open orders less what has been received, and asking it once per row is the
N+1 that `002_catalog.sql:62` already warns about for barcodes. It is **one grouped query for the
whole list**, joined in memory, over `purchase_order_items` and `goods_receipt_items` — and
`idx_poitems_product` (`010_purchasing.sql:92`) already indexes the join.

**The conversion runs in one transaction** (`INV-107`'s reasoning, though no stock moves): every
order for the request is written, or none is, and the request's status moves with them. A
half-converted request is a store that orders from two of its three suppliers and believes it
ordered from three.

**Sync needs nothing.** `syncRepository` builds its triggers from the live schema at launch, so
new tables replicate without editing `907_sync.sql`.

## Business rules

Cited, not restated:

- `INV-109` — what low stock is, and that it is computed and never stored.
- `INV-114` — a made-to-order product is never low on stock.
- `INV-101` — on hand comes from the ledger's materialised balance.
- `UOM-005` — minimum stock and every threshold in the base unit, labelled with it.
- `PO-101`, `PO-102`, `PO-104` — what the orders this raises must be, and that they are raised `DRAFT`.
- `TX-409` — the permission, held by the inventory clerk.
- `AUD-601`, `AUD-603` — the rejection's reason; the approval's two distinct actors.
- `VR-103` — the document number format.

**New, to be written into `03_BUSINESS_RULES.md` and `PHARMACY_EDITION.md` §15:**

| ID | Rule |
| :--- | :--- |
| `PO-107` | A restocking request moves no stock and commits the store to nothing. Only a purchase order commits, and only a goods receipt moves stock. |
| `PO-108` | An approved restocking request converts to one `DRAFT` purchase order per distinct supplier, in one transaction; each resulting order cites the request, and each converted line cites its order. |
| `PO-109` | A suggested restocking quantity nets off the quantity already outstanding on open purchase orders. A suggestion that ignores what is already coming is a defect, not a convenience. |

**Amended:** `INV-109` currently defines low stock only where a minimum is set, and every
implementation honours that. It gains a second sentence: *a product with no minimum and no stock
is **out of stock**, which is reported beside low stock and never silently omitted.* The
low-stock surfaces keep their present meaning; what changes is that "nothing to sell" stops being
invisible.

## Acceptance criteria

- [x] The list opens on every active, stocked product at or below its minimum, in the base unit, labelled with it
- [x] A product with **no minimum set and no stock** appears, marked as such — today it appears nowhere
- [x] A product with enough already on order is suggested **zero**, and the row says why
- [x] A product not on the derived list can be added by the picker, including by scanning
- [x] Every suggested quantity is editable, and the edited figure is what is stored
- [x] A saved request has a number, a requester, a date and a status
- [x] A `SUBMITTED` request cannot be edited by its requester
- [x] Approval and rejection require a manager or owner; a rejection requires a reason; both are audited with two distinct actors
- [x] A request cannot become orders without an approver distinct from its requester, where the store has more than one active user
- [x] On a single-user store a saved request is `APPROVED` with the requester recorded as both actors, and marked self-approved
- [x] Approving converts to one `DRAFT` PO per supplier, in one transaction, with the links written both ways
- [x] A line with no supplier is left on the request and reported, and does not block the rest
- [x] Nothing in the module writes an `inventory_movements` row
- [x] A cashier is refused every endpoint, server-side, and the refusal is audited

## Tests

| Where | What |
| :--- | :--- |
| `src/tests/integration/purchasing.test.js` | the suggestion nets off an open order; a fully-covered product suggests zero; a product with no minimum and no stock is listed; a made-to-order product is not (`INV-114`); submit → approve → convert writes one PO per supplier and links both ways; a failure mid-conversion leaves the request `APPROVED` and no orders; rejection needs a reason; a cashier is refused each endpoint |
| `src/tests/unit/renderer.test.js` | `suggest()` per case — below minimum, at minimum, covered by an open order, no minimum set, negative result clamped to zero; the screen sends the edited figure and not the derived one |
| `src/tests/perf/catalog.test.js` | the list over 5,000 products issues a bounded number of queries — no per-row *on order* lookup — and meets `FR_3.1`'s budget |
| A walk in Electron | a clerk raises a request from a five-product store, adds one by the picker, submits; the owner approves nine of eleven lines; two draft orders appear under Buying with the right lines on each |

## Open

1. **Sales velocity.** Once the first store has a season of history, the suggestion should read
   "what sold in the last N days" rather than the minimum somebody guessed.
   `reportRepository.moversOverview()` is most of it. Not before there is history to read — and
   it crosses `TX-421`, which the clerk does not hold, so the permission question comes with it.
2. **A preferred supplier on the product.** Deriving from the last receipt is right until a store
   changes supplier, and absent for a product never received. A `preferred_supplier_id` on
   `products` would settle it — a schema change worth making once somebody has said which of the
   two the store means. It would also give the conversion a supplier for a product bought for the
   first time, which today has none.
3. **Minimum stock in bulk.** Criterion 2 exists because most products have no minimum. The real
   fix is a screen that sets minimums for many products at once — `TASK-071`'s shape applied to
   `min_stock_milli` instead of price. Arguably it should come *first*.
4. **Recurring requests.** "The usual monthly order" is a saved request re-opened. Nobody has
   asked for it yet.

## Decisions taken

| Date | Question | Answer |
| :--- | :--- | :--- |
| 2026-09-18 | Does the store want the approval step? | **Yes** — the clerk raises, the owner approves. `restock_approval_required` defaults on; a single-user store self-approves and says so |

---

*Chachi's Software Development Service · DTI BN 8089738 · BIR OCN 111RC20260000002455 · TIN 752-951-092-00000*
