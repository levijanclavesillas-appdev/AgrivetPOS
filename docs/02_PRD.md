# 02 — Product Requirements

**Product**: Chachi Agrivet POS · **Version**: 2.0 · **Date**: 2026-09-07
**Supersedes**: `legacy/PRD_v1.1.md` (all sections)
**Owns**: the feature inventory (`FT-*`), functional requirements (`FR_*`), non-functional
requirements (`NFR_*`), and the release plan. Behaviour is owned by `03_BUSINESS_RULES.md`;
this document cites rule IDs and does not restate them.

---

## 1. Release plan

The `legacy/PRD_v1.1.md` §82 MVP listed 27 modules. It is restructured into four releases so a
store can be running on **v1.0** while the rest is built.

| Release | Name | Contains | Gate |
| :--- | :--- | :--- | :--- |
| **v1.0** | **Till** | Foundation, catalog, stock on hand, POS, payments, credit sales and collection, shift and closing, backup, audit | The store sells through it, all day, offline |
| **v1.1** | **Supply** | Purchasing and goods receipt, returns and voids, stock counting, discount rules engine, data import/export | The store buys and corrects through it |
| **v1.2** | **Trace** | Batches, expiry, FEFO, customer statements, payment reconciliation, profitability and movement analysis | The store can trace a lot and prove a margin |
| **v1.3+** | **Network** | LAN multi-terminal, Android companion, PostgreSQL, multi-branch | More than one device |

**The v1.0 rule**: a feature enters v1.0 only if the counter cannot operate without it for two
weeks. Everything the store can do on paper for two weeks is v1.1.

## 2. Feature inventory

`R` = release. Rules cited belong to `03_BUSINESS_RULES.md`; screens to `04_UX_SPEC.md`.

### FT-1xx — Foundation

| ID | Feature | R | Rules |
| :--- | :--- | :-- | :--- |
| `FT-101` | First-run setup wizard: store profile, tax mode, owner account, base currency, backup folder | 1.0 | `TAX-001`, `SEC-2` |
| `FT-102` | User accounts, roles, and the permission matrix | 1.0 | §6, `TX-*` |
| `FT-103` | Login, session, idle logout, cashier PIN fast-switch | 1.0 | `SEC-2`, `SEC-3` |
| `FT-104` | Owner credential recovery via offline recovery code | 1.0 | `SEC-5` |
| `FT-105` | System settings registry (all operator-owned figures in one place) | 1.0 | `OPS-005` |
| `FT-106` | Audit trail: write, browse, filter | 1.0 | `AUD-601`–`AUD-604` |

### FT-2xx — Catalog and inventory

| ID | Feature | R | Rules |
| :--- | :--- | :-- | :--- |
| `FT-201` | Products: identity, category, brand, base unit, cost, prices, min stock, active flag | 1.0 | `VR-201`–`VR-208` |
| `FT-202` | Categories and brands | 1.0 | `VR-209` |
| `FT-203` | Units and pack conversions (`1 Sack = 50 KG`), including break-bulk | 1.0 | `UOM-001`–`UOM-005` |
| `FT-204` | Multiple barcodes per product | 1.0 | `VR-205` |
| `FT-205` | Batch tracking, expiry status, FEFO allocation, recall-by-batch | 1.2 | `INV-201`–`INV-206` |
| `FT-206` | Stock on hand + the append-only inventory movement ledger | 1.0 | `INV-101`–`INV-107` |
| `FT-207` | Inventory adjustments with reason and authorisation | 1.0 | `INV-108`, `TX-407` |
| `FT-208` | Low-stock detection and alert list | 1.0 | `INV-109` |
| `FT-209` | Physical stock count: session, variance, approval, posting | 1.1 | `INV-110`–`INV-113` |
| `FT-210` | Price levels: retail, wholesale, dealer | 1.0 | `PR-101`, `PR-102` |
| `FT-211` | Customer-specific pricing | 1.1 | `PR-103` |
| `FT-212` | Quantity-break pricing | 1.1 | `PR-104` |

### FT-3xx — Point of sale

| ID | Feature | R | Rules |
| :--- | :--- | :-- | :--- |
| `FT-301` | Sale: scan or search, cart, fractional quantity, price resolution, totals | 1.0 | `POS-101`–`POS-108`, `MON-001`–`MON-006` |
| `FT-302` | Payment: cash with change, GCash, QR Ph, split tender | 1.0 | `POS-201`–`POS-207` |
| `FT-303` | Credit as a tender, with limit check and manager override | 1.0 | `CR-101`–`CR-105` |
| `FT-304` | Internal transaction receipt, print and reprint | 1.0 | `TAX-006`, `POS-208`, `INT-1` |
| `FT-305` | Manual line and transaction discount within role authority | 1.0 | `PR-201`–`PR-205` |
| `FT-306` | Discount rules engine: transaction tiers, quantity breaks, per-product ceilings | 1.1 | `PR-106`, `PR-206` |
| `FT-307` | Sales return against an original sale, with restock decision | 1.1 | `POS-301`–`POS-307` |
| `FT-308` | Void a sale, with full reversal | 1.1 | `POS-401`–`POS-404` |
| `FT-309` | Senior citizen / PWD statutory discount, configurable and off by default | 1.1 | `TAX-004` |

### FT-4xx — Customers and credit

| ID | Feature | R | Rules |
| :--- | :--- | :-- | :--- |
| `FT-401` | Customers: identity, type, price level, credit terms, active flag | 1.0 | `VR-301`–`VR-305` |
| `FT-402` | Credit account: limit, balance, available credit | 1.0 | `CR-101`, `CR-106` |
| `FT-403` | Collection: full and partial payment against the account | 1.0 | `CR-201`–`CR-205` |
| `FT-404` | Collection acknowledgement print | 1.0 | `CR-206`, `INT-1` |
| `FT-405` | Due dates and ageing status (`CURRENT`/`DUE_SOON`/`OVERDUE`) | 1.0 | `CR-107` |
| `FT-406` | Ageing report by bucket (1–30 / 31–60 / 61–90 / 90+) | 1.2 | `CR-301` |
| `FT-407` | Customer statement | 1.2 | `CR-302` |
| `FT-408` | Store credit balance from returns and overpayment | 1.1 | `CR-108` |
| `FT-409` | Bad-debt write-off with authorisation | 1.2 | `CR-303` |

### FT-5xx — Purchasing

| ID | Feature | R | Rules |
| :--- | :--- | :-- | :--- |
| `FT-501` | Suppliers and purchase history | 1.1 | `VR-401` |
| `FT-502` | Purchase order lifecycle | 1.1 | `PO-101`–`PO-105` |
| `FT-503` | Goods receipt against a PO, partial and over-receipt handling | 1.1 | `PO-201`–`PO-206` |
| `FT-504` | Direct receipt with no PO (counter purchase) | 1.1 | `PO-207` |
| `FT-505` | Supplier payables | 1.2 | — |

### FT-6xx — Reporting

| ID | Feature | R | Rules |
| :--- | :--- | :-- | :--- |
| `FT-601` | Dashboard: today's sales, payment mix, credit outstanding, low stock | 1.0 | — |
| `FT-602` | Sales reports: daily, by product, by category, by cashier, fast/slow movers | 1.0 daily · 1.2 rest | `RPT-101` |
| `FT-603` | Payment breakdown report | 1.0 | `RPT-102` |
| `FT-604` | Inventory reports: on hand, valuation, movement, low stock | 1.0 on hand + low stock · 1.1 rest | `RPT-103` |
| `FT-605` | Gross profit and margin, using the configured costing method | 1.1 | `MON-004`, `RPT-104` |
| `FT-606` | Payment reconciliation against actual settlement | 1.2 | `RPT-105` |
| `FT-607` | Near-expiry and expired stock report | 1.2 | `INV-203` |

### FT-7xx — Operations and data

| ID | Feature | R | Rules |
| :--- | :--- | :-- | :--- |
| `FT-701` | Cashier shift: open with float, till cash in/out, close | 1.0 | `POS-501`–`POS-508` |
| `FT-702` | End-of-day closing with expected-vs-actual per method | 1.0 | `POS-509`–`POS-511` |
| `FT-703` | Automatic scheduled local backup, with retention | 1.0 | `OPS-001`–`OPS-003` |
| `FT-704` | Manual backup and restore | 1.0 | `OPS-004` |
| `FT-705` | Full JSON data export | 1.1 | `OPS-101` |
| `FT-706` | Data import / restore from export, with pre-import backup | 1.1 | `OPS-102`–`OPS-104` |
| `FT-707` | Opening-data load: products, opening stock, opening credit balances from CSV | 1.1 | `OPS-105`–`OPS-107` |
| `FT-708` | Database health panel and integrity check | 1.0 | `OPS-006` |
| `FT-709` | Alert centre: low stock, overdue credit, backup overdue, cash variance | 1.0 | `OPS-007` |

## 3. Functional requirements — v1.0

Each requirement is testable and carries acceptance criteria. `TC-*` cases are in
`07_TEST_PLAN.md`.

### FR_1 — Foundation

- **`FR_1.1`** On first launch with an empty database, the app shall run a setup wizard capturing
  store name, address, TIN (optional), `tax_mode`, currency, backup folder, and the owner account
  with password and recovery code. The app shall not expose any other screen until setup
  completes.
  *AC*: fresh install → wizard; killing the app mid-wizard → wizard again; completed wizard writes
  exactly one `OWNER` user and one `store_profile` row. `TC-E2E-00`.
- **`FR_1.2`** The app shall authenticate a user by username and password (bcrypt, cost ≥ 12) and
  issue a session valid for the configured idle timeout, default 15 minutes.
  *AC*: wrong password rejected without disclosing which field was wrong; 5 failures locks the
  account for 15 minutes (`SEC-3`); idle past the timeout returns to the lock screen with the cart
  preserved. `TC-UT-01`, `TC-INT-02`.
- **`FR_1.3`** A cashier shall be able to unlock the till with a 6-digit PIN when a shift is open,
  without a full logout, and the PIN shall never grant access outside POS and collections.
  *AC*: PIN opens POS; PIN cannot reach Settings, Users, Products edit, or Reports beyond
  `Limited`. `TC-INT-03`.
- **`FR_1.4`** The owner shall be able to reset a forgotten owner password offline using the
  recovery code issued at setup, and doing so shall write an audit record.
  *AC*: recovery code works once, then a new one is issued; a wrong code is rate-limited;
  `AUD-604` row exists. `TC-INT-04`.
- **`FR_1.5`** Every mutation listed in `AUD-601` shall write an audit row carrying actor, action,
  entity, entity ID, before value, after value, reason where required, and UTC timestamp.
  *AC*: changing a product price produces one audit row with both values. `TC-UT-05`.

### FR_2 — Catalog and stock

- **`FR_2.1`** A product shall carry exactly one base unit, in which all stock, movements, costing
  and reporting are expressed (`UOM-001`).
  *AC*: a product's base unit cannot be changed once any movement exists. `TC-UT-10`.
- **`FR_2.2`** A product may define one or more sellable packs, each with an integer or decimal
  conversion factor to the base unit. Selling one pack shall deduct `factor × quantity` base units.
  *AC*: `1 Sack = 50 KG`; selling 1 sack from 500 KG leaves 450 KG. `TC-UT-11`.
- **`FR_2.3`** The system shall accept fractional quantities to three decimal places in the base
  unit and compute line totals from them without floating-point drift (`MON-001`).
  *AC*: 1.255 KG at ₱62.50/KG bills ₱78.44 (half-up), and 1000 such lines sum exactly. `TC-UT-12`.
- **`FR_2.4`** Stock on hand shall be derived only from the append-only movement ledger; no code
  path shall write an on-hand figure directly (`INV-101`).
  *AC*: `SUM(movements.qty)` equals `inventory.qty_on_hand` for every product after the E2E suite.
  `TC-INT-20`.
- **`FR_2.5`** A sale shall be blocked when it would drive stock below zero, unless
  `allow_negative_stock` is enabled in settings, in which case it warns and proceeds (`INV-104`).
  *AC*: both modes exercised. `TC-INT-21`.
- **`FR_2.6`** A product at or below its minimum stock shall appear in the low-stock list and the
  alert centre within one refresh (`INV-109`).
  *AC*: selling down to the threshold surfaces the product. `TC-INT-22`.

### FR_3 — Point of sale

- **`FR_3.1`** Scanning a barcode shall add the matching product to the cart at quantity 1 base
  unit, or increment the existing line, in ≤ 300 ms at 5,000 products (`NFR_1.2`).
  *AC*: unknown barcode shows an offer to attach it to a product, not a silent failure.
  `TC-INT-30`.
- **`FR_3.2`** The cart shall resolve each line's price by the precedence in `PR-101`, and shall
  display which price level was applied.
  *AC*: a dealer customer gets dealer price; a walk-in gets retail. `TC-UT-31`.
- **`FR_3.3`** The system shall support split tender across cash, GCash, QR Ph and credit in one
  sale, and shall not complete the sale until tendered ≥ amount due (`POS-204`).
  *AC*: ₱1,000 due paid ₱600 cash + ₱400 GCash completes; ₱600 alone does not. `TC-INT-32`.
- **`FR_3.4`** GCash and QR Ph tenders shall require a reference number and shall be recorded with
  status `RECORDED`, never `VERIFIED` (`POS-206`).
  *AC*: empty reference blocks completion; the receipt and reports say `RECORDED`. `TC-UT-33`.
- **`FR_3.5`** Completing a sale shall write the sale, its lines, its tenders, its inventory
  movements and its credit transaction in **one** database transaction, rolling back entirely on
  any failure (`INV-107`).
  *AC*: an injected failure after movements leaves no sale, no movement, no balance change.
  `TC-INT-34`.
- **`FR_3.6`** Each sale line shall snapshot unit price, unit cost, discount and tax at the moment
  of sale, and reports shall read the snapshot, never the current product record (`MON-005`).
  *AC*: changing a product's cost after a sale does not change that sale's gross profit.
  `TC-INT-35`.
- **`FR_3.7`** Completing a cash sale shall open the cash drawer via the receipt printer (`INT-2`).
  *AC*: drawer pulse sent on cash and split-with-cash; not sent on pure credit. `TC-INT-36`.

### FR_4 — Credit

- **`FR_4.1`** A credit tender shall require a registered, credit-eligible, active customer
  (`CR-102`). *AC*: walk-in cannot pay on credit. `TC-UT-40`.
- **`FR_4.2`** The system shall block a credit tender where `balance + tender > credit_limit`,
  releasing it only on a manager or owner override that is recorded with actor and reason
  (`CR-104`). *AC*: over-limit blocked; override recorded in `AUD-603`. `TC-INT-41`.
- **`FR_4.3`** A collection shall reduce the customer balance by exactly the amount received, be
  recorded as its own transaction, and be applied oldest-invoice-first (`CR-203`).
  *AC*: ₱3,000 against ₱10,000 leaves ₱7,000 and marks the oldest sale part-paid. `TC-INT-42`.
- **`FR_4.4`** A collection shall print an acknowledgement carrying the customer, amount, running
  balance, cashier and reference (`CR-206`). *AC*: printed and reprintable. `TC-INT-43`.
- **`FR_4.5`** Ageing status shall be derived from the due date and the system date at read time,
  never stored stale (`CR-107`). *AC*: crossing the due date changes status without a job.
  `TC-UT-44`.

### FR_5 — Shift and closing

- **`FR_5.1`** A cashier shall not process a sale or a collection without an open shift
  (`POS-501`). *AC*: POS refuses with an "open your shift" prompt. `TC-INT-50`.
- **`FR_5.2`** A shift shall record opening float, every till cash in/out with reason and actor,
  and shall compute expected cash as `float + cash sales + cash collections + cash in − cash out −
  cash refunds` (`POS-509`).
  *AC*: the arithmetic is asserted against a scripted shift. `TC-INT-51`.
- **`FR_5.3`** Closing shall capture counted cash per denomination or as a total, compute variance
  per payment method, and refuse to close silently on a variance beyond the configured threshold —
  requiring a reason (`POS-510`).
  *AC*: a ₱200 short close demands a reason and writes `AUD-602`. `TC-INT-52`.
- **`FR_5.4`** A closed shift shall be immutable; corrections are new transactions in the next
  shift (`POS-511`). *AC*: no endpoint mutates a closed shift. `TC-INT-53`.

### FR_6 — Reporting

- **`FR_6.1`** The dashboard shall show today's gross sales, transaction count, payment mix, total
  credit outstanding, overdue count, low-stock count, and **gross profit**, refreshed on navigation.
  *AC*: figures equal the underlying report queries for the same day. `TC-INT-60`.
  > The seventh tile resolves a contradiction between three documents. `01_PRODUCT_BRIEF.md` §6
  > metric 5 makes "the owner can state yesterday's gross profit" a **week-1 v1.0** success
  > criterion, while this requirement listed six tiles and `RPT-104` was scheduled for 1.1.
  > Resolved in favour of the metric in `TASK-016`: the cost snapshot has been written on every
  > sale line since `TASK-011` (`MON-005`), so the figure costs a join, and a release that cannot
  > answer "did we make money yesterday" fails its own success criteria on the day it ships.
  > `RPT-104` moved to 1.0 and `TC-INT-35` is a v1.0 gate test.
- **`FR_6.2`** The daily sales report shall reconcile: `gross − discounts − returns = net`, and net
  shall equal the sum of tenders less change (`RPT-101`). *AC*: asserted after the E2E day.
  `TC-INT-61`.

### FR_7 — Operations

- **`FR_7.1`** The system shall create an automatic backup on the configured schedule (default: on
  every shift close and daily at a configured hour), retain the configured number (default 30),
  and delete older ones (`OPS-001`, `OPS-003`).
  *AC*: closing a shift produces a timestamped backup file; the 31st prunes the oldest.
  `TC-INT-70`.
- **`FR_7.2`** A backup shall be verified as readable immediately after being written, and a failed
  verification shall raise an alert rather than pass silently (`OPS-002`).
  *AC*: a corrupted target raises the alert. `TC-INT-71`.
- **`FR_7.3`** The system shall warn on launch when no successful backup exists within the
  configured backup period (`OPS-007`). *AC*: clock advanced past the period → warning.
  `TC-INT-72`.
- **`FR_7.4`** The database shall survive an abrupt power loss without losing a committed sale, and
  shall not commit a partial one (`OPS-008`).
  *AC*: kill -9 during the E2E loop leaves a consistent ledger. `TC-E2E-09`.

## 4. Non-functional requirements

| ID | Requirement | Target | Verified by |
| :--- | :--- | :--- | :--- |
| `NFR_1.1` | Sale completion, confirm to receipt | ≤ 2 s | `TC-PERF-01` |
| `NFR_1.2` | Barcode scan to cart line | ≤ 300 ms at 5,000 products | `TC-PERF-02` |
| `NFR_1.3` | Product search first result | ≤ 500 ms at 5,000 products | `TC-PERF-03` |
| `NFR_1.4` | Application cold start to login | ≤ 8 s on the reference machine | `TC-PERF-04` |
| `NFR_1.5` | Dashboard load at 100,000 sale lines | ≤ 3 s | `TC-PERF-05` |
| `NFR_2.1` | Scale: products / customers / sales per year | 5,000 / 2,000 / 60,000 | `TC-PERF-06` |
| `NFR_2.2` | Data retained online before archival is offered | 5 years | — |
| `NFR_3.1` | Core operations available with no internet | 100% of v1.0 features | `TC-E2E-08` |
| `NFR_3.2` | Recovery from abrupt power loss | No committed transaction lost | `TC-E2E-09` |
| `NFR_4.1` | Reference machine | Windows 10/11 x64, 4 GB RAM, dual core, 1366×768 | — |
| `NFR_4.2` | Language | English UI, Philippine peso, `Asia/Manila` display, UTC storage | `TC-UT-90` |
| `NFR_4.3` | Touch targets on the POS screen | ≥ 44 px | `TC-UI-01` |
| `NFR_5.1` | Update distribution | Signed installer, manual or USB; no forced auto-update | `05_TECH_SPEC.md` §7 |
| `NFR_5.2` | Automated test coverage of `03_BUSINESS_RULES` money, stock and credit rules | 100% of rules have ≥ 1 `TC-*` | `07_TEST_PLAN.md` §Release |

## 5. Assumptions

1. One Windows PC, owned by the store, on mains power with a UPS recommended but not assumed.
2. The store has an existing product list in a spreadsheet (`Q-4`).
3. GCash and QR Ph are verified by the cashier on their own phone or terminal; the system records,
   it does not verify (`POS-206`).
4. Feeds are the volume line and are sold both by sack and by kilo (`UOM-002`).
5. The store is a single branch with a single counter for the life of v1.0–v1.2.

## 6. Dependencies

| Dependency | For | Risk if absent |
| :--- | :--- | :--- |
| Thermal receipt printer, 58 or 80 mm, ESC/POS | `FT-304`, `FT-404` | Receipts on screen only; drawer cannot be pulsed |
| RJ11 cash drawer wired to the printer | `FR_3.7` | Manual drawer; no impact on data |
| USB barcode scanner in keyboard-wedge mode | `FT-301` | Search-only selling; slower but functional |
| Client's product list and opening balances | Go-live | Manual entry of 5,000 SKUs |

## 7. Withdrawn from `legacy/PRD_v1.1.md`

| Item | Was | Status |
| :--- | :--- | :--- |
| Stock transfer between locations | §19 | **Withdrawn** until v1.3 — no location entity exists before multi-branch |
| Single `Barcode` field on the product | §13 | **Withdrawn** — replaced by `product_barcodes` (`VR-205`) |
| Android / tablet in the first release | §5, §5.4 | **Deferred** to v1.3 (`D-2`) |
| The 17-document sequence | §91 | **Withdrawn** — superseded by `docsrequirement.md` |
| "FIFO / batch-based" costing in the MVP | §61 | **Deferred** to v1.2; v1.0 is moving weighted average (`MON-004`) |

---

*Chachi's Software Development Service · DTI BN 8089738 · BIR OCN 111RC20260000002455 · TIN 752-951-092-00000*
