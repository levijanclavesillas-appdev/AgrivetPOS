# TASK-046 — Pharmacy edition: an over-the-counter drugstore on the same product

**Priority:** **P1** for the pharmacy client · **Blocks release:** the pharmacy go-live, not
agrivet v1.x · **Branch:** `pharmacy` · **Requirement:** `docs/PHARMACY_EDITION.md`, `TAX-004`,
`INV-201`, `INV-202`, `UOM-003`, `POS-304`, `OPS-105`

---

## Objective

Ship this product to an over-the-counter drugstore, changing only what a drugstore counter
needs, so that `main` can still be merged into the `pharmacy` branch without conflicts.

## Context

The client asked whether the agrivet POS could run a pharmacy. Most of what a pharmacy needs
already exists, because veterinary medicines have the same problems: batches, expiry and FEFO
(`TASK-029`), recall by batch (`TASK-030`), box/strip/tablet packs (`UOM-002`), the senior
citizen and PWD discount (`TASK-027`), VAT-exempt medicines (`TAX-003`) and write-off on return
(`POS-304`).

The store is **OTC only**. That rules out the two large gaps: prescription dispensing and a
dangerous-drugs register. Both stay out of scope, as `PHARMACY_EDITION.md` §5 states.

What was left was small but real. The shop's name was hard-coded in the UI. A drugstore
catalogue is searched by **generic name**, and the product had no such field. Batch tracking
and senior/PWD eligibility could not be set in the product editor. And the API accepted a
change to batch tracking after stock had moved, which leaves stock that nothing can sell.

## Requirements

1. The product name, installer, shortcut, Windows app id, data folder and backup names read
   **Chachi Pharmacy POS**. The pharmacy install has its own data folder and app id, so it can
   never open an agrivet database (`P-5`).
2. A product has an optional **generic name**. The counter search finds it, and the list and the
   counter show it under the brand name (`P-4`, `018_generic_name.sql`).
3. **Batch tracking** and **senior/PWD eligibility** can be edited on the Identity tab. A new
   product starts with both ticked; the server default stays off (`P-2`).
4. `INV-207`: batch tracking is fixed once any stock movement exists, and the API refuses the
   change after that point (`P-3`).
5. `TAX-004` ships **on** (`P-1`).
6. The default write-off categories and return reasons are a drugstore's, not an agrivet's
   (`POS-304`).
7. The opening-data spreadsheet carries `generic_name` and `senior_pwd`, uses pharmacy examples,
   and creates customers as `REGULAR` rather than `FARM`.
8. Internal identifiers stay as they are: `agrivet.db`, `AGRIVET_*` and the export format id
   (`P-6`).

## Business Rules

- `TAX-004`: shipping on changes the default only. Which products qualify is still set per
  product, and switching it off is still owner-only and audited (`AUD-601`).
- `INV-201`, `INV-202`: the reason `INV-207` exists.
- `UOM-003`: the same reasoning, applied to the base unit.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Schema | `018_generic_name.sql`: `products.generic_name TEXT`, nullable and not indexed. **See the migration-number warning in `PHARMACY_EDITION.md` §3** |
| Files | `package.json`, `src/config/paths.js`, `productRepository`, `productService`, `settingsService`, `setupService`, `backupService`, `openingDataService`, `public/js/catalogue/editor.js`, `list.js`, `public/js/pos/view.js`, `public/index.html`, `setup.html`, `shell/app.js` |
| API | No new endpoint. `genericName`, `isBatchTracked` and `statutoryDiscountEligible` are accepted on product create and update |
| Constraints | Branding and defaults only, apart from `018` and `INV-207`. Both of those belong on `main` (§3) |

## Acceptance Criteria

- [x] Nothing a user sees says "Agrivet". Internal names do (`P-6`)
- [x] A generic name is saved, searched and shown. A blank one reads as none
- [x] The editor sets batch tracking and senior/PWD eligibility; a new product starts with both on
- [x] Changing batch tracking after a movement is refused with `INV-207`
- [x] `TAX-004` is on in a fresh install, and switching it stays owner-only and audited
- [x] The full suite and the browser smoke are green on the branch
- [ ] `018` and `INV-207` merged to `main` before the first pharmacy install (§3). **Not
      done: this needs the owner's decision on the merge**
- [ ] The client's answers to `PQ-1`–`PQ-5` (`PHARMACY_EDITION.md` §4). **Not done: they are
      questions for the client, not code**

## Tests

| Case | Asserts |
| :--- | :--- |
| `catalog.test.js` | Generic name stored trimmed, blank as none; search ranks a generic prefix alongside a name prefix; `INV-207` before and after the first movement; `TAX-004` eligibility editable at any time |
| `statutory.test.js` · `TC-INT-101` | Ships on in a pharmacy, and switching it is owner-only and audited |
| `opening-data.test.js` | The product file carries `generic_name` and `senior_pwd`, and a typo is not a yes |
| `upgrade.test.js` | An install built at `017` upgrades through `018` with its products intact |
| browser smoke | The editor's two new switches, and the counter's `TAX-004` walk with the discount on |

**Status — 2026-09-14:** closed in `40e7fb2` on the `pharmacy` branch. That commit passes
`npm run test:all` by itself (292 unit, 622 integration, 207 e2e); the browser smoke passed on
the same tree before the onboarding work began.
