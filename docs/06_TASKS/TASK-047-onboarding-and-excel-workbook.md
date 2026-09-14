# TASK-047 — Onboarding: a wizard that fits, and the store's data from one Excel workbook

**Priority:** **P1** for the pharmacy go-live · **Blocks release:** the pharmacy cutover ·
**Branch:** `pharmacy` · **Requirement:** `SCR-001`, `SCR-706`, `FT-707`, `OPS-103`,
`OPS-105`–`OPS-107`, `UOM-001`, `UOM-002`, `INV-202`, `VR-205`, `VR-209`, `VR-401`

---

## Objective

A new store goes from installer to a stocked, balanced catalogue in one sitting. The wizard
looks like the rest of the product and fits the screen. The store's existing data arrives as
**one Excel workbook**, with a tab for each list, that it downloads from the application and
uploads back unchanged.

## Context

The client asked for three things, in their own words:

> fix the design on the onboarding funnel, as well as include the excel template and
> importation of existing data on the store.
>
> refine the import file to include separate worksheet for brand, unit and other dependent
> data.

**The wizard's design fault was a missing stylesheet.** `TASK-045` moved every colour, space and
shape into `tokens.css` and added it to `index.html`, but not to `setup.html`. So every variable
`app.css` reads was undefined, and the wizard rendered as browser defaults. Behind that sat a
second fault that affects the whole product: `tokens.css` gives `button` a `display`, which beats
the browser's own `[hidden] { display: none }`. Every `el.hidden = true` on a button did nothing,
which is why **Back** showed on step 1.

**The Excel workbook existed only as a file for emailing.** `tools/opening-template/build.js`
wrote a workbook the client filled in, and someone then had to save each tab as CSV and upload
three files on `SCR-706`. Saving as CSV is where the data breaks: Excel turns `2027-03-31` into
`31/03/2027`, drops a barcode's leading zero, and adds a thousands separator. Each of those is a
refusal the owner cannot diagnose.

**An empty store could not be loaded at all.** Every product row names a category and a unit,
the load refused any it did not already have, and there was no way to create them except typing
them in by hand first. That is correct, since a category carries its own discount ceiling
(`PR-204`) and should not be invented from a product row, but it meant a cutover was two
sittings.

## Requirements

1. `SCR-001` loads the design system and fits 1366×768 on every step. The document does not
   scroll there (`TASK-045` requirement 5).
2. `[hidden]` hides, everywhere, whatever the element's own `display`.
3. **One workbook**, served at `GET /data/opening/workbook` and generated from
   `openingDataService.KINDS`, the same table that validates the upload. It has a Read me tab,
   then one tab per kind **in load order**: Categories, Units, Brands, Suppliers, Products,
   Packs, Opening stock, Credit balances.
4. Every column is formatted as **Text**. Row 1 is the column name. Row 2 says whether the column
   is required and gives an example. The data rows start **empty**, because the workbook is read
   back and an example row left in place would be loaded.
5. The filled-in workbook is uploaded **as it is** (`workbook`, base64) to the existing
   `/data/opening/validate` and `/data/opening`. It is read into the same per-sheet CSV the
   separate files arrive as, so there is still exactly one validator.
6. The reader handles what a spreadsheet application writes on save: shared strings, rich
   text, numbers typed into Text columns, date serials (including the 1904 system), formulas
   (their cached value), omitted cells and rows, and namespace prefixes. Anything that is not a
   workbook is refused with a sentence the owner can act on.
7. **The reference tabs create what the store does not have yet**, before anything that points
   at them, in the same transaction. A row the store already has is a warning and is left as it
   is, so sending the workbook again is safe.
8. Every problem names **its tab and the row number Excel shows**, blank rows included.
9. Nothing the check calls clean may be refused by the load. In particular: a pack in the
   product's own base unit, a fraction of a unit that cannot be sold in parts, and one barcode
   on two new products.
10. The wizard gets an optional sixth step, **Your data**. After the recovery code has been
    shown, it signs in as the new owner and offers the same panel `SCR-706` shows: download,
    choose, check, load.

## Business Rules

- `OPS-103`: a verified backup first, then one transaction. Unchanged.
- `OPS-105`: every row checked before anything is written. There is one judge, whichever way
  the file arrived.
- `OPS-106`: `unit_cost` stays required. Unchanged.
- `UOM-001`: a unit is resolved by code and must exist, **on the Units tab or in the store**.
- `UOM-002`: a pack is not in the base unit; a quantity in a no-fractions unit is whole.
- `VR-209`: a category, unit or brand is created only from its own tab, never inferred from a
  product row.
- `SEC-7`: the wizard's session token is held in memory only, like the shell's.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/config/xlsx.js` (new reader) · `src/services/openingWorkbookService.js` (new writer and reader) · `openingDataService` (four reference kinds, packs, sheet-tagged problems, the three new checks) · `referenceService.createWithin` · `src/routes/data.js` · `tools/opening-template/build.js` (now a wrapper) and `fixture.js` (new) · `public/setup.html`, `public/js/setup.js`, `public/css/app.css`, `public/css/tokens.css` · `public/js/shell/opening.js` (new shared panel) · `public/js/admin/data.js` |
| Schema | **None** |
| API | `GET /data/opening/workbook` (`TX-427`). `POST /data/opening/validate` and `POST /data/opening` take `workbook` alongside the per-kind CSV fields, and now accept `categories`, `units`, `brands`, `suppliers` and `packs` too. Problems and warnings carry `kind` and `sheet` |
| Constraints | No dependency: `05_TECH_SPEC.md` §2 keeps this product at four. The reader is tested against a fixture written by ExcelJS, which shares no code with it, and ExcelJS is not installed by `npm install` |

## Acceptance Criteria

- [x] The workbook downloads from the application, and the app and the tool write the same bytes
- [x] Every tab carries the validator's columns in its own order, every cell is Text, and no
      example row can be loaded
- [x] A workbook saved by another application loads an empty store in one pass. Categories,
      units, brands, suppliers, products, packs, batch-tracked stock and balances all land, and
      both ledgers reconcile
- [x] Numbers come back as typed: `4.55`, a 13-digit barcode, a leading zero, a date cell, a
      formula
- [x] Sending the same workbook again writes nothing, warns on each reference row, and names
      each refused product by tab and Excel row
- [x] The three mid-transaction refusals are caught at the check
- [x] `[hidden]` hides a button again, and the wizard fits 1366×768 on every step. Checked in
      a real 1366×768 Electron window; a long step scrolls inside the card, and the action bar
      stays in view
- [x] The wizard's sixth step loads a workbook for the new owner. Driven in a real window with
      the ExcelJS fixture: check, load, reconciliation, pre-load backup named
- [x] `SCR-706` offers the workbook first and the CSV files second, through the same panel
- [x] The full suite and the browser smoke are green
- [ ] A workbook filled in and saved by **Microsoft Excel itself** on the store's PC. **Not
      done:** the fixture is ExcelJS's, which writes the way Excel does, but this is a UAT check
      and not a claim

## Tests

| Case | Asserts |
| :--- | :--- |
| `opening-template.test.js` | The package is a readable OPC file; tab order equals `KIND_NAMES`; headers and legend are the validator's; no row 3; a blank workbook reads back as no files; the legend is recognised only under the header; every cell is Text; deterministic bytes |
| `TC-INT-129` | The ExcelJS fixture checks clean and loads an empty store end to end |
| `TC-INT-130` | Re-sending is safe and reports by tab and Excel row; a non-workbook is refused with a sentence |
| `TC-INT-131` | Pack in base unit, half a tablet (and half a millilitre allowed), a unit arriving with its own fraction rule, one barcode on two rows |

| `renderer.test.js` | `SCR-706` and the wizard mount one panel; the load waits for a clean check; problems name tab and row; the workbook is offered first; `.danger` is defined once, in `tokens.css` |
| `TC-E2E-21` | The CSV route, unchanged, with the new counts in its result |
| browser smoke | `SCR-706`'s text, the rehearsal and its line numbers, against the new panel |

**What the work found.** `checkPacks` read the base unit off the wrong object for a product
arriving in the same load, so "a pack cannot be in the base unit" never fired for one. The check
passed, and `productService` then refused inside the transaction, which is exactly what
`OPS-105` promises cannot happen. Opening stock never applied the unit's no-fractions rule, so
2.5 tablets would have loaded as stock no sale could take to zero. And two new products with one
barcode passed the check, then failed on the second insert. `TC-INT-131` holds all three.

**Status — 2026-09-14:** closed in the commit after `40e7fb2` on the `pharmacy` branch.
`npm test` 926 of 926, `npm run test:e2e` 207 of 207, and the browser smoke all green (436 checks).
