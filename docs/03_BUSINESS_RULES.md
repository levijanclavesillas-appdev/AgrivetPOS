# 03 — Business Rules

**Product**: Chachi Agrivet POS · **Version**: 2.0 · **Date**: 2026-09-07
**Owns**: how the system behaves. Money and rounding (`MON-*`), units (`UOM-*`), tax and
statutory (`TAX-*`), pricing and discounts (`PR-*`), inventory (`INV-*`), sales and till
(`POS-*`), credit (`CR-*`), purchasing (`PO-*`), validation (`VR-*`), permissions (`TX-*`),
audit (`AUD-*`), operations (`OPS-*`), reporting (`RPT-*`), and every state machine.

**IDs are permanent.** A withdrawn rule is marked withdrawn in place and never reused.
`R` = release in which the rule takes effect.

---

## 1. Money, quantity and rounding (`MON-*`)

These rules exist because a credit ledger built on floating-point money accumulates balances
that never reach zero, and because `legacy/PRD_v1.1.md` §31.1 introduced fractional kilos with
no precision policy at all.

| ID | Rule | R |
| :--- | :--- | :-- |
| `MON-001` | **All money is stored and computed as a signed integer number of centavos.** No floating-point type appears in any money column, API field, or calculation. Display divides by 100 at the edge. | 1.0 |
| `MON-002` | **All quantities are stored as a signed integer number of thousandths of the product's base unit** (`qty_milli`). 1.255 KG is `1255`. Three decimal places is the limit; a fourth is rejected, not truncated. | 1.0 |
| `MON-003` | **Rounding is half-up, applied once per line, at the line total.** Order of operations is fixed: `unit_price × qty` → round to centavo → subtract line discount → round → sum lines → subtract transaction discount → round → apply tax treatment (`TAX-002`) → round. Intermediate values are never re-rounded outside this sequence. | 1.0 |
| `MON-004` | **Costing method for v1.0–v1.1 is moving weighted average**, recomputed on every stock increase as `(existing_value + received_value) / (existing_qty + received_qty)`, held as `products.avg_cost_centavos`. Batch/FEFO costing replaces it in v1.2 for batch-tracked products only; non-batch products keep moving average permanently. | 1.0 |
| `MON-005` | **Every sale line snapshots `unit_price_centavos`, `unit_cost_centavos`, `discount_centavos` and its tax treatment at the instant of sale.** All profit and tax reporting reads the snapshot. No report joins to the live product record for a historical figure. | 1.0 |
| `MON-006` | A transaction-level discount is **apportioned across lines in proportion to line total**, with the rounding remainder assigned to the largest line, so that the sum of line discounts equals the transaction discount exactly. | 1.0 |
| `MON-007` | Change due is `tendered − amount_due` and is never negative; a sale cannot complete with `tendered < amount_due` (`POS-204`). Change is cash only. | 1.0 |
| `MON-008` | The peso has no sub-centavo denomination in circulation, but the system does **not** round the payable to the nearest 5 or 25 centavos. Cash rounding, if the store wants it, is a `cash_rounding_centavos` setting defaulting to `1` (off). | 1.0 |

## 2. Units of measure (`UOM-*`)

Resolves `legacy/README.md` contradiction 3.

| ID | Rule | R |
| :--- | :--- | :-- |
| `UOM-001` | **Every product has exactly one base unit.** Stock on hand, every movement, average cost, valuation and every report are expressed in it. There is no second inventory figure. | 1.0 |
| `UOM-002` | A product may define **sellable packs**, each a `(unit, factor_milli)` pair against the base unit. A sack of feed on a KG-based product is a pack with factor 50,000. Selling one pack posts a movement of `factor_milli × qty` base thousandths. | 1.0 |
| `UOM-003` | The base unit is **immutable once any inventory movement exists** for the product. Changing it would silently reinterpret history. The correction path is a new product and a transfer adjustment. | 1.0 |
| `UOM-004` | **Break-bulk is an inventory event, not a UI convenience.** Where a product is stocked as sealed packs and sold loose, opening a pack posts a `BREAK_BULK` movement pair. Where the base unit is already the loose unit (the normal case for feed), no event is needed and selling by kilo simply deducts kilos. | 1.0 |
| `UOM-005` | Minimum stock, reorder point and every alert threshold are expressed in the **base unit**, and the UI labels them with it. | 1.0 |

## 3. Tax and statutory (`TAX-*`)

The client's answer was "cater both non-VAT, VAT, and not registered", so registration status is
configuration, not a build-time assumption.

| ID | Rule | R |
| :--- | :--- | :-- |
| `TAX-001` | The store operates in exactly one **tax mode**, set at setup and changeable only by the owner with an audit record: `NONE` (unregistered), `NON_VAT` (percentage tax), or `VAT` (VAT-registered). | 1.0 |
| `TAX-002` | **Tax treatment by mode.** `NONE` and `NON_VAT`: the selling price is the final price; no tax is computed, split or printed; sale lines record `tax_amount_centavos = 0`. `VAT`: selling prices are **VAT-inclusive**, and each line is decomposed by its product's `tax_class`. | 1.0 |
| `TAX-003` | In `VAT` mode every product carries a `tax_class` of `VATABLE`, `VAT_EXEMPT` or `ZERO_RATED`. A VATable line at inclusive price `P` yields `net = round(P / 1.12)` and `vat = P − net`, computed per line after discount. Exempt and zero-rated lines yield `vat = 0`. The `tax_class` column exists and is populated in all modes so that a mode change is a configuration change, never a migration. | 1.0 |
| `TAX-004` | **Senior citizen and PWD discounts are supported but default OFF.** RA 9994 and RA 10754 grant the 20% discount and VAT exemption on goods and services for the *beneficiary's own* use — medicines, food, transport. Animal feeds and veterinary drugs are for an animal, so an agrivet's ordinary lines fall outside the entitlement. Where the store also sells a covered item, the owner may flag that product `statutory_discount_eligible`, and applying the discount then **requires** the ID type, ID number and beneficiary name to be captured on the sale. | 1.1 |
| `TAX-005` | A statutory discount, where applied, is computed **before** any voluntary discount and the two do not compound: the customer receives the larger, not the sum. | 1.1 |
| `TAX-006` | **The printed document is an internal transaction record.** It carries the store name and the words "This is not an official receipt". It must not carry the phrases "Official Receipt", "Sales Invoice", "OR No.", a BIR permit number, or an ATP serial range. This rule holds in every tax mode and is not configurable. | 1.0 |
| `TAX-007` | In `VAT` mode the internal transaction record prints the VATable / VAT-exempt / zero-rated / VAT-amount summary block, because the figures are needed for the store's own bookkeeping — while remaining subject to `TAX-006`. | 1.0 |

## 4. Pricing and discounts (`PR-*`)

| ID | Rule | R |
| :--- | :--- | :-- |
| `PR-101` | **Price resolution precedence**, first match wins: (1) customer-specific price, (2) quantity break for the customer's price level, (3) the customer's price level (retail / wholesale / dealer), (4) retail price. The resolved level is recorded on the sale line. | 1.0 (levels 3–4) · 1.1 (1–2) |
| `PR-102` | A product must have a retail price to be sellable. Wholesale and dealer prices are optional; where absent, the level falls through to retail rather than to zero. | 1.0 |
| `PR-103` | A customer-specific price overrides all others for that customer and product, including quantity breaks, and is itself subject to `PR-202`. | 1.1 |
| `PR-104` | Quantity breaks are defined per product per price level as ascending, non-overlapping `min_qty_milli` bands. The band containing the line quantity applies to the whole line, not marginally. | 1.1 |
| `PR-105` | **A price below average cost requires authorisation.** The POS blocks a line whose resolved or discounted unit price is below `avg_cost_centavos` unless a manager or owner authorises it, and the authorisation is audited (`AUD-603`). | 1.0 |
| `PR-106` | Transaction discount tiers are owner-configured ascending bands on the pre-discount subtotal. At most one tier applies. | 1.1 |
| `PR-201` | **Discount authority is a per-role ceiling** on the discount percentage of any single line and of the transaction: Cashier 2%, Manager 5%, Owner configurable (default 100%). Ceilings are settings, not constants. | 1.0 |
| `PR-202` | A product category may carry a **maximum discount** which overrides a higher role ceiling. The effective ceiling is the lower of role and category. | 1.1 |
| `PR-203` | A discount above the acting user's ceiling is not refused outright — it opens a **manager override prompt**. The approving user is recorded distinctly from the acting user on the sale. | 1.0 |
| `PR-204` | Every manual discount records the affected line or transaction, the original amount, the discount amount and percentage, the acting user, the approving user where applicable, the reason, and the timestamp (`AUD-603`). | 1.0 |
| `PR-205` | A discount may never make a line total negative, and the sum of discounts may never exceed the subtotal. | 1.0 |
| `PR-206` | Automatic rule-driven discounts (`PR-104`, `PR-106`) and manual discounts do not compound on the same line; the larger applies. | 1.1 |

## 5. Inventory (`INV-*`)

| ID | Rule | R |
| :--- | :--- | :-- |
| `INV-101` | **Stock on hand is derived from the movement ledger, never written directly.** `inventory.qty_on_hand_milli` is a materialised running balance maintained only by the movement service, inside the same transaction as the movement, and reconcilable to `SUM(inventory_movements.qty_milli)` at any time. | 1.0 |
| `INV-102` | The ledger is **append-only**. A movement is never updated or deleted; a correction is a compensating movement citing the original. | 1.0 |
| `INV-103` | Movement types, and their sign: `RECEIPT` +, `SALE` −, `SALE_VOID` +, `CUSTOMER_RETURN` +, `SUPPLIER_RETURN` −, `ADJUSTMENT` ±, `DAMAGE` −, `EXPIRY` −, `INTERNAL_USE` −, `COUNT_VARIANCE` ±, `BREAK_BULK` ±, `OPENING` +. Every movement carries a type, a reference to its source document, a reason where the type requires one, and the acting user. | 1.0 |
| `INV-104` | **Stock may not go negative** unless `allow_negative_stock` is enabled, in which case the sale proceeds with a visible warning and the movement is flagged. The setting defaults to disabled. | 1.0 |
| `INV-105` | An inactive or withdrawn product may not be added to a cart, but its existing stock, history and valuation remain intact and reportable. | 1.0 |
| `INV-106` | Average cost is recomputed on `RECEIPT`, `OPENING` and positive `ADJUSTMENT` where a cost is supplied; it is **not** changed by sales, damage, expiry or negative adjustments, which consume at the prevailing average (`MON-004`). | 1.0 |
| `INV-107` | **A stock-moving document and its movements commit together or not at all.** Sale, receipt, return, adjustment and count posting each run in one database transaction spanning the document, its lines, its movements, the on-hand update and any credit or till effect. | 1.0 |
| `INV-108` | An adjustment requires a **reason from the configured list** and a user holding `TX-407`. A blank or free-text-only reason is rejected. Adjustments beyond a configured value threshold additionally require owner authorisation. | 1.0 |
| `INV-109` | A product is **low stock** when `qty_on_hand_milli ≤ min_stock_milli` and it is active. Low stock is computed at read time, not stored. | 1.0 |
| `INV-110` | A stock count session freezes the counted products' expected quantities at session start and records variance against that snapshot, so that sales during the count do not corrupt the variance. | 1.1 |
| `INV-111` | Posting a count writes one `COUNT_VARIANCE` movement per varying product, and none for products that matched. | 1.1 |
| `INV-112` | A count must be **approved by a user other than the counter** where the store has more than one active user. | 1.1 |
| `INV-113` | An unposted count session older than the configured window (default 7 days) is flagged stale and cannot be posted without owner authorisation. | 1.1 |
| `INV-201` | A batch-tracked product's stock is held per batch; the sum of batch quantities equals the product on-hand figure. | 1.2 |
| `INV-202` | A batch carries batch number, supplier, receipt date, expiry date, quantity and unit cost. Batch number is unique per product. | 1.2 |
| `INV-203` | Expiry status is derived at read time: `EXPIRED` when `expiry_date < today`, `NEAR_EXPIRY` when within the configured threshold (default 90 days), else `NORMAL`. | 1.2 |
| `INV-204` | **FEFO**: allocation for a batch-tracked product consumes the earliest non-expired expiry date first. | 1.2 |
| `INV-205` | **An expired batch may not be sold.** Owner override is permitted only where the store's own policy allows it, is recorded with a reason, and is reported. Expired stock is expected to leave by `EXPIRY` movement, not by sale. | 1.2 |
| `INV-206` | **Recall by batch**: given a batch, the system lists every sale, customer and quantity that consumed it. This is why batch identity is carried onto the sale line, not merely onto the movement. | 1.2 |

## 6. Sales, payments and the till (`POS-*`)

| ID | Rule | R |
| :--- | :--- | :-- |
| `POS-101` | A sale requires at least one line with a positive quantity. | 1.0 |
| `POS-102` | A cart line quantity is entered in the base unit or in a defined pack; the UI shows both and the ledger stores base (`UOM-002`). | 1.0 |
| `POS-103` | A customer is optional. Absent one, the sale is a walk-in at retail price and may not use credit tender (`CR-102`). | 1.0 |
| `POS-104` | The cart shows, per line: product, quantity with unit, resolved unit price, price level, discount, line total, and remaining stock after the line. | 1.0 |
| `POS-105` | An in-progress cart survives an idle logout and an application restart, and is recoverable by the same user on the same shift. | 1.0 |
| `POS-106` | A cart may be **parked** and resumed, so a customer fetching another item does not block the counter. Parked carts expire at shift close. | 1.0 |
| `POS-107` | A completed sale is **immutable**. It is never edited and never deleted. The only corrections are void (`POS-401`) and return (`POS-301`). | 1.0 |
| `POS-108` | Sale numbers are `SALE-YYYYMMDD-NNNNNN`, sequential per day, gapless, allocated inside the sale transaction so that a rollback does not consume a number. The database identity remains a separate UUID (`VR-101`). | 1.0 |
| `POS-201` | Tender types: `CASH`, `GCASH`, `QRPH`, `CREDIT`, plus owner-configured types. | 1.0 |
| `POS-202` | A sale may carry multiple tenders (split payment). | 1.0 |
| `POS-203` | Only `CASH` may over-tender and produce change (`MON-007`). | 1.0 |
| `POS-204` | A sale completes only when `SUM(tenders) ≥ amount_due`. | 1.0 |
| `POS-205` | `GCASH` and `QRPH` tenders **require a non-empty reference number**, which is not auto-generated and not defaulted. | 1.0 |
| `POS-206` | Non-cash tenders are recorded with status `RECORDED`, meaning "the cashier saw it". The system must never display, print or report them as `VERIFIED` or "confirmed" while no payment API confirms them. | 1.0 |
| `POS-207` | A tender reference number is unique per tender type per day; a duplicate raises a warning that the cashier must explicitly accept, because double-keying the same GCash reference is the common till error. | 1.0 |
| `POS-208` | A receipt may be reprinted. Every reprint is marked `REPRINT` on the document and written to the audit trail (`AUD-601`), because an unmarked reprint is a shrinkage tool. | 1.0 |
| `POS-301` | A return requires an original sale and may not exceed the quantity sold on that line, less quantities already returned. | 1.1 |
| `POS-302` | A return requires a reason from the configured list. | 1.1 |
| `POS-303` | The return decides **restock or write-off** per line. Restock posts `CUSTOMER_RETURN` +; write-off posts `CUSTOMER_RETURN` + followed by `DAMAGE` −, so that the return is visible and the loss is separately visible. | 1.1 |
| `POS-304` | **Veterinary medicines, vaccines and any batch-tracked product default to write-off, not restock.** Restocking one requires manager authorisation and a reason, because the store cannot attest to how the item was stored while it was out. | 1.1 |
| `POS-305` | A return refunds by the same means as the original tender, in this precedence: reduce the customer's outstanding credit balance where the sale was on credit; else cash from the till where the shift is open; else store credit (`CR-108`). GCash and QR Ph are **not** refunded by the system — it records a cash or store-credit refund, because the system moves no funds. | 1.1 |
| `POS-306` | A return against a credit sale reduces the customer's outstanding balance and writes a credit transaction; it never pays out cash while a balance remains. | 1.1 |
| `POS-307` | Returns are permitted within the configured window (default 7 days) and require manager authorisation beyond it. | 1.1 |
| `POS-401` | A void fully reverses a sale: reverses every inventory movement, every tender, and any credit transaction, and marks the sale `VOIDED` with actor, timestamp and reason. | 1.1 |
| `POS-402` | A void is only permitted **within the shift in which the sale occurred** and while that shift is open. After the shift closes, the correction is a return. | 1.1 |
| `POS-403` | A void requires manager or owner authorisation. A cashier may never void unaided. | 1.1 |
| `POS-404` | A voided sale remains in the ledger, the audit trail and the sequence. It is excluded from net sales and included in a void report. | 1.1 |
| `POS-501` | **No shift, no money.** A user may not complete a sale, take a collection, or move till cash without an open shift belonging to them. | 1.0 |
| `POS-502` | One open shift per user at a time. A second open attempt resumes the existing shift. | 1.0 |
| `POS-503` | A shift records the opening float, counted and confirmed by the opening user. | 1.0 |
| `POS-504` | Till cash in/out requires an amount, a reason from the configured list, and the acting user. Owner withdrawals and petty cash are the expected uses. | 1.0 |
| `POS-505` | Cash out may not exceed the expected cash currently in the drawer. | 1.0 |
| `POS-506` | A till movement is never a sale and never touches inventory, revenue or the customer ledger. | 1.0 |
| `POS-507` | The drawer is pulsed on completion of any sale carrying a cash tender, on a cash collection, and on any till movement (`INT-2`). | 1.0 |
| `POS-508` | A shift left open past the configured maximum (default 24 h) raises an alert and requires owner authorisation to close with a variance. | 1.0 |
| `POS-509` | **Expected cash** = opening float + cash sales + cash collections + cash in − cash out − cash refunds. Expected non-cash per method = sum of that method's tenders in the shift. | 1.0 |
| `POS-510` | Closing captures actual counted cash and actual non-cash totals per method, computes variance per method, and **requires a reason** where any variance exceeds the configured tolerance (default ₱100). Closing is never silently forced to balance. | 1.0 |
| `POS-511` | A closed shift is **immutable**. Nothing may be back-dated into it. Corrections belong to the next shift. | 1.0 |

## 7. Customers and credit (`CR-*`)

| ID | Rule | R |
| :--- | :--- | :-- |
| `CR-101` | A credit-eligible customer has a credit account with a limit, a balance, and payment terms. Available credit = `limit − balance`. | 1.0 |
| `CR-102` | A credit tender requires a customer who is **registered, active and credit-eligible**. A walk-in may not buy on credit. | 1.0 |
| `CR-103` | Balance is derived from the credit transaction ledger — credit sales debit, collections credit, returns credit, write-offs credit — and is reconcilable to it at any time. | 1.0 |
| `CR-104` | A credit tender where `balance + tender > limit` is **blocked**, releasable only by a manager or owner override recorded with actor and reason (`AUD-603`). | 1.0 |
| `CR-105` | A credit sale carries a due date computed from the customer's terms (`COD`, 7, 15, 30 days, or an explicit date) at the moment of sale. | 1.0 |
| `CR-106` | A credit limit change requires owner or manager authority and is audited with both values (`AUD-601`). | 1.0 |
| `CR-107` | Ageing status is **derived at read time** from the due date and the current date: `PAID` when settled, `OVERDUE` past due, `DUE_SOON` within the configured window (default 3 days), else `CURRENT`. It is never a stored column that a missed job can leave stale. | 1.0 |
| `CR-108` | A customer may hold a **store credit balance** — from a return or an overpayment — represented as a negative outstanding balance. Store credit is spendable as a tender and is never paid out as cash without owner authorisation. | 1.1 |
| `CR-201` | A collection records amount, date, method (cash / GCash / QR Ph), reference where non-cash, the receiving user and the shift. | 1.0 |
| `CR-202` | Partial collections are permitted. Every collection is its own transaction; collections are never merged. | 1.0 |
| `CR-203` | A collection is applied **oldest credit sale first**, and the allocation is recorded per sale so a statement can show which invoices a payment settled. | 1.0 |
| `CR-204` | A collection may not exceed the outstanding balance unless the store accepts advances, in which case the excess becomes store credit (`CR-108`) and requires explicit confirmation. | 1.0 |
| `CR-205` | A cash collection is till cash: it increases expected cash for the receiving shift (`POS-509`). | 1.0 |
| `CR-206` | Every collection prints an acknowledgement carrying customer, amount, method and reference, the new running balance, the receiving user, and a `COLL-YYYYMMDD-NNNNNN` number. This document is subject to `TAX-006`. | 1.0 |
| `CR-301` | Ageing buckets are 1–30, 31–60, 61–90 and 90+ days past due, computed from each unsettled sale's due date. | 1.2 |
| `CR-302` | A statement shows opening balance, every debit and credit in the period in date order, and the closing balance, and the closing balance must equal the account balance at that date. | 1.2 |
| `CR-303` | A write-off requires owner authority and a reason, credits the account, and is reported separately from collections so it never inflates collection performance. | 1.2 |
| `CR-304` | The system charges **no interest and no penalty** on overdue balances. Where a store wants one, it is a separate commissioned requirement — an undocumented finance charge is a Truth-in-Lending exposure. | — |

## 8. Purchasing (`PO-*`)

| ID | Rule | R |
| :--- | :--- | :-- |
| `PO-101` | A purchase order carries supplier, dates, lines with quantity and unit cost, and a status. | 1.1 |
| `PO-102` | PO status machine: `DRAFT → PENDING → PARTIALLY_RECEIVED → RECEIVED`, with `CANCELLED` reachable from `DRAFT` and `PENDING` only. | 1.1 |
| `PO-103` | **A purchase order moves no stock.** Only a goods receipt does. | 1.1 |
| `PO-104` | A PO may be edited while `DRAFT`; once `PENDING` it is amended by a new revision, not overwritten. | 1.1 |
| `PO-105` | A PO cannot be cancelled once any quantity has been received. | 1.1 |
| `PO-201` | A goods receipt records, per line, ordered quantity, received quantity, damaged quantity, unit cost, and — for batch-tracked products — batch and expiry. | 1.1 |
| `PO-202` | **Only the sound received quantity increases stock.** Damaged quantity is recorded on the receipt and posts no `RECEIPT` movement. | 1.1 |
| `PO-203` | A receipt updates average cost at the **actual** received unit cost, not the ordered cost (`INV-106`). | 1.1 |
| `PO-204` | Over-receipt beyond the ordered quantity requires authorisation and is flagged on the receipt. | 1.1 |
| `PO-205` | A receipt whose unit cost differs from the PO by more than the configured tolerance (default 10%) requires manager authorisation, because a mis-keyed cost silently destroys every margin figure. | 1.1 |
| `PO-206` | A posted goods receipt is immutable; corrections are adjustments or supplier returns. | 1.1 |
| `PO-207` | A direct receipt with no PO is permitted, requires a supplier, and follows every other receipt rule. | 1.1 |

## 9. Validation (`VR-*`)

| ID | Rule | R |
| :--- | :--- | :-- |
| `VR-101` | Every business entity carries a **UUIDv7** primary identity, generated by the application, stable across export, import and any future PostgreSQL migration. Human-readable document numbers are a separate column. | 1.0 |
| `VR-102` | All timestamps are stored in **UTC** as ISO-8601 strings and displayed in `Asia/Manila`. | 1.0 |
| `VR-103` | **The device clock is not trusted for sequencing.** Document numbers derive from a monotonic per-day sequence in the database, not from the clock, and a clock that moves backwards past the last recorded transaction raises an alert (`OPS-009`). | 1.0 |
| `VR-201` | Product SKU is required, unique, case-insensitive, and trimmed. | 1.0 |
| `VR-202` | Product name is required, 2–120 characters. | 1.0 |
| `VR-203` | Retail price and average cost are required and non-negative. | 1.0 |
| `VR-204` | Minimum stock is required and non-negative, in the base unit. | 1.0 |
| `VR-205` | A product may carry **many barcodes**; each barcode is globally unique across products. A barcode encoding an embedded weight is out of scope for v1.0 and is rejected with a clear message rather than misread. | 1.0 |
| `VR-206` | A product may not be deleted once referenced by any movement or sale. It is deactivated. | 1.0 |
| `VR-207` | Pack conversion factors are positive and non-zero. | 1.0 |
| `VR-208` | `tax_class` is required in every tax mode (`TAX-003`). | 1.0 |
| `VR-209` | Category and brand names are unique and required where referenced. | 1.0 |
| `VR-301` | Customer name is required, 2–120 characters. | 1.0 |
| `VR-302` | A contact number, where given, matches a Philippine mobile or landline pattern. | 1.0 |
| `VR-303` | Credit limit is non-negative; a credit-eligible customer must have a limit and terms. | 1.0 |
| `VR-304` | A customer may not be deleted once transacted; they are deactivated. | 1.0 |
| `VR-305` | A customer with a non-zero balance may not be deactivated. | 1.0 |
| `VR-401` | Supplier name is required and unique. | 1.1 |
| `VR-501` | Username is required, unique, 3–32 characters. | 1.0 |
| `VR-502` | Password is at least 10 characters. The PIN is exactly 6 digits and may not be a repeated or sequential run. | 1.0 |
| `VR-503` | The last active `OWNER` account may not be deactivated or demoted. | 1.0 |

## 10. Permissions (`TX-*`)

Roles: `OWNER`, `MANAGER`, `CASHIER`, `INVENTORY`. A permission is checked **server-side on every
request**; hiding a button is not a permission (`SEC-6`).

| ID | Transaction | Owner | Manager | Cashier | Inventory |
| :--- | :--- | :-: | :-: | :-: | :-: |
| `TX-401` | Complete a sale | ✓ | ✓ | ✓ | — |
| `TX-402` | Apply a discount within role ceiling (`PR-201`) | ✓ | ✓ | ✓ | — |
| `TX-403` | Authorise a discount above another's ceiling | ✓ | ✓ | — | — |
| `TX-404` | Sell below average cost (`PR-105`) | ✓ | ✓ | — | — |
| `TX-405` | Void a sale (`POS-403`) | ✓ | ✓ | — | — |
| `TX-406` | Process a return | ✓ | ✓ | ✓ | — |
| `TX-407` | Post an inventory adjustment | ✓ | ✓ | — | ✓ |
| `TX-408` | Approve a stock count | ✓ | ✓ | — | — |
| `TX-409` | Receive goods | ✓ | ✓ | — | ✓ |
| `TX-410` | Create or edit a product | ✓ | ✓ | — | ✓ |
| `TX-411` | Change a selling price | ✓ | ✓ | — | — |
| `TX-412` | Change a product cost | ✓ | — | — | — |
| `TX-413` | Create or edit a customer | ✓ | ✓ | ✓ | view |
| `TX-414` | Set or change a credit limit | ✓ | ✓ | — | — |
| `TX-415` | Authorise an over-limit credit sale (`CR-104`) | ✓ | ✓ | — | — |
| `TX-416` | Record a collection | ✓ | ✓ | ✓ | — |
| `TX-417` | Write off a balance | ✓ | — | — | — |
| `TX-418` | Open / close own shift | ✓ | ✓ | ✓ | — |
| `TX-419` | Close another user's shift | ✓ | ✓ | — | — |
| `TX-420` | Till cash in / out | ✓ | ✓ | ✓ | — |
| `TX-421` | View sales and profit reports | ✓ | ✓ | own shift | — |
| `TX-422` | View inventory reports | ✓ | ✓ | view | ✓ |
| `TX-423` | Manage users | ✓ | — | — | — |
| `TX-424` | Change system settings | ✓ | limited | — | — |
| `TX-425` | Change tax mode | ✓ | — | — | — |
| `TX-426` | Export data | ✓ | ✓ | — | — |
| `TX-427` | Import / restore data | ✓ | — | — | — |
| `TX-428` | Run a manual backup | ✓ | ✓ | — | — |
| `TX-429` | View the audit trail | ✓ | ✓ | — | — |
| `TX-430` | Reprint a receipt | ✓ | ✓ | ✓ | — |

## 11. Audit (`AUD-*`)

| ID | Rule | R |
| :--- | :--- | :-- |
| `AUD-601` | The following write an audit row without exception: price change, cost change, discount rule change, credit limit change, inventory adjustment, stock count posting, sale void, return, receipt reprint, user create/modify/deactivate, role change, permission change, tax mode change, settings change, data import, data export, backup restore, password reset, login failure beyond threshold. | 1.0 |
| `AUD-602` | A shift closing with a variance beyond tolerance writes an audit row carrying the variance, the reason and the closing user. | 1.0 |
| `AUD-603` | Every authorisation override — discount above ceiling, over-limit credit, below-cost sale, expired-stock sale, over-receipt, cost variance, restock against default, late return — records the **requesting user and the approving user as distinct actors**, with the reason. | 1.0 |
| `AUD-604` | An owner password reset via recovery code writes an audit row before the reset takes effect. | 1.0 |
| `AUD-605` | Audit rows are **append-only and never deleted by any application path**, including data import. Import appends its own audit row rather than replacing the trail. | 1.0 |
| `AUD-606` | An audit row records: UTC timestamp, actor user ID and username as text, action, entity type, entity ID, before value, after value, reason, and the shift ID where one is open. The username is denormalised so that deactivating a user does not blank the history. | 1.0 |

## 12. Operations (`OPS-*`)

| ID | Rule | R |
| :--- | :--- | :-- |
| `OPS-001` | An automatic backup runs on every shift close and at the configured daily hour, writing a timestamped file to the configured folder, which defaults **outside** the application data directory. | 1.0 |
| `OPS-002` | Every backup is **verified immediately after writing** by opening it and running an integrity check. A failed verification raises an alert and does not count as a backup. | 1.0 |
| `OPS-003` | Backups are retained by count (default 30) and pruned oldest-first only after a successful newer backup is verified. | 1.0 |
| `OPS-004` | A restore requires owner authority, takes a fresh backup of the current database first, and requires typed confirmation naming the file being restored. | 1.0 |
| `OPS-005` | Every operator-owned figure lives in the settings registry, not in code: near-expiry days, backup hour and retention, discount ceilings, cash variance tolerance, negative stock, return window, void window, idle timeout, due-soon window, cost variance tolerance, adjustment authorisation threshold, cash rounding. | 1.0 |
| `OPS-006` | The health panel reports database size, row counts, last successful backup, last export, last integrity check, and the schema version. | 1.0 |
| `OPS-007` | Alerts are raised for: low stock, overdue credit, credit limit reached, backup overdue, unverified backup, shift open too long, cash variance beyond tolerance, near-expiry (v1.2), and clock anomaly. | 1.0 |
| `OPS-008` | The database runs in WAL mode with `synchronous = NORMAL` and foreign keys enforced, so an abrupt power loss loses no committed transaction and commits no partial one. | 1.0 |
| `OPS-009` | On launch, a system clock earlier than the latest recorded transaction timestamp raises a clock-anomaly alert and is audited. Transactions continue; the sequence does not depend on the clock (`VR-103`). | 1.0 |
| `OPS-101` | Export produces a single archive containing one JSON file per entity plus a `manifest.json` carrying schema version, export timestamp, row counts per entity, and a checksum. | 1.1 |
| `OPS-102` | Import validates the manifest, the schema version, referential integrity and the checksum **before** writing anything, and presents a summary for confirmation. | 1.1 |
| `OPS-103` | Import takes a full backup before it writes (`OPS-004`) and runs as a single transaction. | 1.1 |
| `OPS-104` | Import never silently overwrites: a colliding identity is reported and the operator chooses skip, replace or abort for the whole run. | 1.1 |
| `OPS-105` | Opening-data load accepts CSV for products, opening stock and opening credit balances, validates every row before writing, and reports rejected rows with line numbers. | 1.1 |
| `OPS-106` | Opening stock is posted as `OPENING` movements carrying the opening unit cost, so that valuation and average cost start correct. | 1.1 |
| `OPS-107` | Opening credit balances are posted as credit transactions dated at cutover, referencing "opening balance", so a statement reconciles from day one. | 1.1 |

## 13. Reporting (`RPT-*`)

| ID | Rule | R |
| :--- | :--- | :-- |
| `RPT-101` | Daily sales must reconcile: `gross − discounts − returns = net`, and `net = SUM(tenders) − change`. A report that does not reconcile is a defect, not a rounding artefact. | 1.0 |
| `RPT-102` | The payment report groups tenders by method and states, per method, recorded total and count. Non-cash rows are labelled `RECORDED` (`POS-206`). | 1.0 |
| `RPT-103` | Inventory valuation is `SUM(qty_on_hand_milli × avg_cost_centavos)` in the base unit, computed at read time, stated with its as-of timestamp. | 1.0 |
| `RPT-104` | Gross profit reads the **sale-line cost snapshot** (`MON-005`), never the current average cost. Revenue is taken net of VAT, because output VAT is not the store's money. | 1.0 |
| `RPT-105` | Reconciliation compares recorded per-method totals against operator-entered actual settlement, and reports variance. It never adjusts the recorded figure. | 1.2 |
| `RPT-106` | Every report states its date range, the tax mode in force, and whether voided sales are included. Voided sales are excluded from net sales in all reports. | 1.0 |

## 14. State machines

```text
SALE          DRAFT ──▶ PARKED ──▶ COMPLETED ──▶ VOIDED          (POS-107, POS-401)
                 └──────────────▶ COMPLETED ──▶ PARTIALLY_RETURNED ──▶ RETURNED

SHIFT         OPEN ──▶ CLOSED                                     (POS-511, immutable)

PURCHASE      DRAFT ──▶ PENDING ──▶ PARTIALLY_RECEIVED ──▶ RECEIVED
ORDER            └──▶ CANCELLED ◀──┘                              (PO-102, PO-105)

STOCK COUNT   DRAFT ──▶ COUNTING ──▶ REVIEW ──▶ POSTED            (INV-110, INV-112)
                                        └──▶ CANCELLED

CREDIT SALE   CURRENT ──▶ DUE_SOON ──▶ OVERDUE ──▶ PAID           (CR-107, derived)
                                          └──▶ WRITTEN_OFF        (CR-303)

BATCH         NORMAL ──▶ NEAR_EXPIRY ──▶ EXPIRED                  (INV-203, derived)
```

## 15. Withdrawn rules

| ID | Was | Withdrawn because |
| :--- | :--- | :--- |
| — | Stock transfer as a movement type (`legacy §19`) | No location entity before v1.3. Reinstated then with a new ID. |
| — | Single product barcode field (`legacy §13`) | Superseded by `VR-205`. |

---

*Chachi's Software Development Service · DTI BN 8089738 · BIR OCN 111RC20260000002455 · TIN 752-951-092-00000*
*Statutory references: RA 10173 (Data Privacy), RA 10175 (Cybercrime), RA 8792 (E-Commerce), RA 9994 / RA 10754 (Senior Citizen / PWD).*
