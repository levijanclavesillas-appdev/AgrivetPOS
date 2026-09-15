# TASK-064 — Review back-end.store (a restaurant POS) for integration and data migration

**Priority:** P1 for what follows (TASK-066) · **Status:** reviewed 2026-09-16 · **Tests:** `orderingapp-import.test.js`, `data-transfer.test.js` (TASK-064)

## The ask

The store owner: "review the back-end.store deployed on docker on this server. Can we
integrate that in this POS since it's also a POS for restaurants? And check if we can migrate
the data there into here."

Their decision after the review started (2026-09-16): "this will serve as another type on set up
as cafe/restaurant beside agrivet, pharmacy". Chachi POS gets a **Café / Restaurant** store
type, and back-end.store's café moves onto it. That work is [TASK-066](TASK-066-cafe-restaurant.md).

## Answers

1. **What it is.** back-end.store is **OrderingApp**:
   - a small ordering app for one Korean café, **NAM-NAM**, used daily since 2026-07-07;
   - a Flutter portal on a Node/Postgres API;
   - it holds 11 MB: 1,303 orders and ₱390,654.40.
2. **Fit.** Chachi POS already does most of what the café uses, and more (shifts, credit,
   offline, web). It lacks five things a café needs: items made to order, orders paid after
   eating, a kitchen ticket, notes on a line, and a service charge.
3. **Integration.** None of its code is worth bringing over. Build the café features into
   Chachi POS as a new store type, move the café and retire back-end.store. The owner has
   chosen this.
4. **Migration.** It works. The whole store went into a throwaway Chachi POS store through
   the normal import, and every report matches OrderingApp to the centavo.
   `tools/orderingapp/to-archive.js` does it. What cannot move is listed below.
5. **Recommendation.**
   - Build TASK-066.
   - Then cut NAM-NAM over on a quiet morning with the tool, and retire back-end.store.
   - Until then, fix OrderingApp's three worst security faults (below), because it is live on
     the internet.

## 1. What back-end.store is

- **Where it runs.**
  - Code: `/root/OrderingApp`, 15 commits from 2026-07-16 to 07-28, and none since.
  - Containers: compose project `mmcafe`, with `mmcafe-api-1` on `127.0.0.1:4210` and
    `mmcafe-db-1` (Postgres 16). nginx serves the web build from `/var/www/back-end.store`.
- **Stack.** Node 20 and Express with raw `pg` (no ORM), JWT sign-in and bcrypt. The Flutter app
  runs on Android, the web and iOS, and works offline on Android only. It has no tests.
- **Features:**

  | | |
  | :--- | :--- |
  | Menu | categories, one price per item, available on/off, "popular" |
  | Orders | dine-in, take-out, pickup and delivery; a free-text table label |
  | Order status | received → preparing → ready → completed, plus cancelled |
  | Payments | one per order: cash, GCash (typed reference), QR Ph, PayMongo |
  | Discounts | promo codes, Senior/PWD, a typed amount |
  | Service fee | a per-store rate |
  | Printing | kitchen tickets through a queue and a LAN agent, or straight to Bluetooth, network or a browser |
  | Stock | ingredients with recipes; set up but unused (1 ingredient, no recipes) |
  | Users | owner and staff per store, and a superadmin |

- **What it does not have:**
  - modifiers (add-ons are a category);
  - split bills;
  - customer accounts or credit;
  - shifts or cash counts;
  - VAT on the receipt;
  - an audit trail in use (0 rows).
- **Who uses it.** Three stores are on it:
  - **NAM-NAM** is real, with 1,303 orders from 2026-07-07 to 2026-09-15 (130–200 a week),
    38 menu items, an owner and one staff login (and a former one who placed orders);
  - ERWIN STORE (3 orders) and ZZ Web Smoke Test2 (3 orders) are tests.
- **What NAM-NAM actually does:**
  - 95% dine-in;
  - almost all cash (1 QR Ph, 2 GCash);
  - one discount and five service fees in ten weeks;
  - notes on 38 of 3,556 lines;
  - order status is rarely advanced: 899 orders still say "received".
- **Chachi Dine** (`dine.chachisoftware.store`, `/root/AdWebsite/CHACHI_DINE`):
  - It began as a copy of OrderingApp on 2026-08-05 and was rebuilt from scratch the same
    day. Only the print agent's design survives, so it shares no schema or code with
    OrderingApp.
  - It is a full-service restaurant system: floor plan, kitchen display, modifiers, split
    bills, BIR readings.
  - By its own test plan it is not ready to ship. The live image predates the fix that
    restores opening a shift, and a branch cannot go live.
  - It is a separate product, and nothing here depends on it.

## 2. Fit with Chachi POS

| Café need | OrderingApp | Chachi POS today | TASK-066 |
| :--- | :--- | :--- | :--- |
| Menu with categories and prices | Yes | Yes (products) | Café wording and defaults |
| Items made to order, not stocked | Yes (no stock) | **No:** a sale needs stock on hand (`INV-104`) | Made-to-order products |
| Order first, pay after eating | Yes (status, then payment) | **No:** a sale is paid when it is made; parked carts expire at shift close | Open orders |
| Table or name on the order | Free text | No | On the open order and the sale |
| Kitchen ticket | Yes | No (receipt printer only) | Kitchen ticket |
| Notes on a line ("less ice") | Yes | No | Line notes |
| Service charge | A store rate | No | A setting, and its own line |
| Dine-in / take-out | Yes | No | Recorded on the sale |
| Cash, GCash, QR Ph | Yes | Yes, with split tender | — |
| Senior/PWD discount | Typed into the customer's name | Yes, with the ID recorded (`TAX-004`) | On by default |
| Promo codes | Yes | Manual and basket discounts | Later, if asked |
| Shifts and cash counts | No | Yes | — |
| Customer credit (utang) | No | Yes | — |
| Offline, web and phone together | Android only | Yes (TASK-063) | — |
| Reports | Daily sales | Daily, payments, category, cashier, product, reconciliation | — |
| Modifiers with prices, split bills, floor plan, kitchen screen | No | No | Not in 066; Chachi Dine's ground |

## 3. Integration options

| Option | Effort | Verdict |
| :--- | :--- | :--- |
| **A. A Café / Restaurant store type in Chachi POS; move NAM-NAM; retire back-end.store** | About the size of TASK-062 and TASK-063 together, in the five pieces TASK-066 lists; the move itself is ready | **Chosen by the owner** |
| B. Keep OrderingApp as the front and send its orders into Chachi POS | An inbound order API in Chachi POS, OrderingApp changes, and fixing OrderingApp's security first, because its orders would become the store's books. Two menus to keep in step | Not recommended |
| C. Leave it separate | Nothing now, but three restaurant codebases on one server and an insecure one live | Not recommended |

## 4. Data migration

**Tested on a copy.** `pg_dump` of `mmcafe-db-1` (read-only), restored into a throwaway Postgres,
converted with `tools/orderingapp/to-archive.js`, and imported through `/data/import/validate`
and `/data/import` into a throwaway Chachi POS store. Nothing live was changed. The copy, the
throwaway containers and stores are deleted.

| OrderingApp | Chachi POS | Notes |
| :--- | :--- | :--- |
| `category` (7) | `categories` | Group name and icon dropped |
| `menu_item` (38) | `products` in a **Serving** unit, a retail price, stock 0 | Slug as SKU; unavailable ones inactive; cost 0 |
| `store_member` + `users` (3) | `users` | Owner → owner, staff → cashier; a former staff member who placed orders comes in inactive. **No passwords** (`SEC-1`): each is set after the import |
| `customer` (140) | `customers` (optional: `--no-customers`) | They are names written on orders (no phone numbers), so the owner may prefer to leave them out |
| `orders` (1,302) | `sales` under their own number (`MM-2315`) | Found by that number in the sales search; completed, received, preparing and ready all become completed sales |
| `order_item` (3,556) | `sale_items` | Name and price as sold |
| `service_fee` (5 orders) | a **Service charge** line | ₱102.40 |
| discount + `promo_code` (1 order) | a basket discount, reason "Promo …" | |
| `payment` | `sale_tenders` | Cash as handed over, with the change (₱42,150); GCash reference kept |
| cancelled (37) | voided sales, "Cancelled in OrderingApp" | ₱9,927, on the voids report |
| pending_payment (1) | left out | Never paid |
| — | 77 closed `cashier_shifts` | One per cashier per day; no cash count, because none was taken |

**What cannot move:**

| Item | Why, and what happens to it |
| :--- | :--- |
| Passwords | Credentials never travel (`SEC-1`), so each user sets a new password |
| Line notes (38), table labels (4), dine-in/take-out | Chachi POS has nowhere to keep them until TASK-066 adds the columns; then the tool carries them |
| Order status history | Chachi POS has no kitchen status: an order is completed when paid |
| Print queue (1,864 jobs) | Never printed, and it is not history |
| Promo code definitions (4) | There are no promo codes in Chachi POS |
| Senior/PWD IDs | They were typed into the customer's name, not recorded as `TAX-004` discounts |
| Store settings | GCash number and QR, order prefix, PayMongo key. Re-entered by hand; the key is not copied |
| The two test stores | Left behind |

**Proof, on the copy:**

| | OrderingApp | Chachi POS after the import |
| :--- | ---: | ---: |
| Orders | 1,303 | 1,302 sales (+1 never paid, left out) |
| Completed takings | ₱380,628.40 | Daily report net ₱380,628.40 over 1,265 sales |
| Payments | cash, GCash ₱750, QR Ph ₱560 | Payments report ₱380,628.40: cash ₱379,318.40, GCash ₱750, QR Ph ₱560 |
| Cancelled | 37, ₱9,927 | 37 voided, ₱9,927 |
| By category | — | ₱380,678.40 before the one ₱50 discount, and it adds up to the daily report |
| Validation | — | 6,550 rows, no problems, 40 of the store's own rows skipped as collisions, a verified backup first |

The imported store opened in the app: Products listed the menu, Reports → Sales analysis
showed the ten weeks by category, and the sales search found an old order by its number.

**What the proof exposed.**

- **Selling fails.** Selling an imported menu item fails ("Not enough Bibimbap", `INV-104`).
  This is TASK-066's first piece.
- **Import bug, fixed here.** Chachi POS refused any import over about 750 KB:
  - The 1 MB body limit that every other route has ran before the data routes' own 64 MB one.
  - It answered 500 "request entity too large".
  - Every store with product pictures exports well past that.
  - `app.js` now gives `/data` its 64 MB parser first, as TASK-063 did for `/sync`.
  - A refused body now says `TOO_LARGE`, "That is too large to send in one request."
  - `data-transfer.test.js` sends a 1.5 MB archive, which failed before the fix and passes
    after it.

## 5. The cutover, when TASK-066 is built

1. `web/store.sh create nam-nam` (or a PC), set up as Café / Restaurant, then **Admin →
   Export / import → Export**.
2. `node tools/orderingapp/to-archive.js --base <export> --store NAM-NAM --psql "docker exec
   mmcafe-db-1 psql -U <user> -d <db>"`. This is read-only against OrderingApp.
3. **Import** the file it wrote in the same store. It shows the validation summary first.
4. Set each user's password, check the day's totals against OrderingApp, and stop taking
   orders on back-end.store.

## OrderingApp's faults, while it stays live

From the code, not tried against the live site. Most serious first:

1. **Payment return page.** The page PayMongo returns to marks an order paid with no sign-in
   and no check with PayMongo, and order numbers are sequential.
2. **Account takeover path.** Adding a staff member by email overwrites that email's password
   in every store, the superadmin's included. For now it is masked by a missing `bcrypt`
   import, which is also why setting a staff password fails.
3. **Public order endpoint.** It accepts any discount type from anyone, Senior/PWD and
   custom amounts included.
4. **Other faults:**
   - recipe endpoints are not limited to the caller's store;
   - a default superadmin is created with a fixed password;
   - the JWT secret has a fallback and tokens last ten years;
   - CORS is open, and sign-in has no rate limit;
   - the Android app keeps the password for offline sign-in in plain storage;
   - two database dumps with customer names and password hashes are committed in its repo.
5. **Kitchen printing.** Every one of the 1,864 print jobs is still queued: the print agent
   is not running.

## Questions for the owner

- **Unpaid orders.** Payment is rarely marked in OrderingApp:
  - 777 of the 1,265 orders kept still say "cash on delivery" or "GCash pending", including
    232 marked completed;
  - 899 never left "received".

  The migration counts them all as paid, as OrderingApp's own daily total does. Is that right?
- **NAM-NAM's customers.** Bring in the 140 names written on its orders, or start the
  customer list empty?
- **The move itself.** Does NAM-NAM agree to move, and when?
