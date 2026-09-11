# TASK-006 — Catalog: categories, brands, units, products, barcodes, packs and prices

**Priority:** **P1** · **Blocks release:** yes · **Blocks:** `TASK-007`, `TASK-009`, `TASK-011` ·
**Requirement:** `FR_2.1`, `FR_2.2`, rules `VR-201`–`VR-209`, `UOM-001`–`UOM-005`, `PR-102`

---

## Objective

Build the product catalog around a single base unit per product, with many barcodes and explicit
pack conversions, so that "10 sacks" and "500 KG" can never both be the inventory figure.

## Context

`legacy/PRD_v1.1.md` §16 defined `1 Sack = 50 KG` but never said which unit stock was held in, and
§13 gave a product one barcode field while §79 listed a `product_barcodes` table. Both are
resolved here: one immutable base unit (`UOM-001`, `UOM-003`) and many barcodes (`VR-205`).

The base unit being immutable once movements exist is not a convenience restriction — changing it
would silently reinterpret every historical quantity in the ledger.

## Requirements

1. CRUD for categories, brands and units, with soft delete only (`VR-206`).
2. Products per the `05_TECH_SPEC.md` §3.4 schema, including `tax_class` populated in **every**
   tax mode (`VR-208`, `TAX-003`) so that a mode change is configuration, not migration.
3. The base unit is **immutable once any inventory movement exists**, and the UI states why
   (`UOM-003`).
4. Many barcodes per product, each globally unique (`VR-205`). A barcode with an embedded weight
   is **rejected with a clear message**, not misread as a plain code.
5. Packs: `(unit, factor_milli)` pairs with a positive factor (`VR-207`), one optionally marked the
   default sell unit.
6. Prices per level, with `effective_from`, and retail required (`PR-102`). Missing wholesale or
   dealer falls through to retail, never to zero.
7. Cost is visible and editable only under `TX-412`; the field is **absent** from the response for
   other roles, not merely disabled in the UI.
8. Product search across name, SKU, barcode and brand within `NFR_1.3`.

## Business Rules

- `VR-201`–`VR-209` — catalog validation.
- `UOM-001`, `UOM-003`, `UOM-005` — base unit, immutability, thresholds in base units.
- `UOM-002` — pack factors.
- `PR-102` — retail required, fall-through never zero.
- `TX-410`, `TX-411`, `TX-412` — who may edit what.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/routes/products.js`, `src/routes/reference.js`, `src/services/productService.js`, `src/repositories/productRepository.js` |
| Schema | `002_catalog.sql` — categories, brands, units, products, product_barcodes, product_packs, product_prices |
| API | `GET POST PUT /products`, `GET /products/barcode/:code`, `GET POST /categories|brands|units` |
| Constraints | Search ≤ 500 ms and barcode lookup ≤ 300 ms at 5,000 products (`NFR_1.2`, `NFR_1.3`) |

## Acceptance Criteria

- [x] A product cannot be created without SKU, name, category, base unit and retail price
- [x] Duplicate SKU and duplicate barcode both rejected, case-insensitively
- [x] Base unit editable before any movement, refused after, with the reason shown
- [x] Two barcodes resolve to the same product; a weight-embedded barcode is rejected clearly
- [x] A pack factor of 0 or negative is rejected
- [x] A product with no wholesale price returns retail for a wholesale customer
- [x] Cost absent from the payload for a `CASHIER`; present for `OWNER`
- [x] A referenced product cannot be deleted, only deactivated
- [ ] Search and barcode lookup meet their budgets at 5,000 products — `TC-PERF-02` measures and is green; `07_TEST_PLAN.md` §6 says a figure from a build machine is not a result (§10 item 6)

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-UT-10` | Base unit immutability |
| `TC-UT-32` | Price fall-through to retail |
| `TC-INT-30` | Unknown barcode returns an attach-offer |
| `TC-PERF-02`, `TC-PERF-03` | Lookup and search budgets |
| `TC-API-01` | `TX-412` hides cost |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
