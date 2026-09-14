# Pharmacy Edition — Chachi Pharmacy POS

**Branch**: `pharmacy` · **Base**: `main` at `9eb81c2` · **Date**: 2026-09-14 ·
**Tasks**: `TASK-046`–`TASK-049` (`06_TASKS/README.md`, *Pharmacy edition*)
**Scope**: an **over-the-counter** drugstore. Not a dispensing pharmacy — see §5.

This is the agrivet product with the changes a drugstore counter needs, and nothing else.
Every rule in `03_BUSINESS_RULES.md` still holds unless this file names it. The branch is
kept small on purpose, so `main` can be merged into it without a fight.

---

## 1. What changed

| Area | Agrivet (`main`) | Pharmacy (`pharmacy`) | Where |
| :--- | :--- | :--- | :--- |
| Product name, installer, shortcut, Windows app id | Chachi Agrivet POS · `store.chachisoftware.agrivetpos` | Chachi Pharmacy POS · `store.chachisoftware.pharmacypos` | `package.json`, `public/` |
| Data folder | `%LOCALAPPDATA%\ChachiAgrivetPOS` | `%LOCALAPPDATA%\ChachiPharmacyPOS` | `src/config/paths.js` |
| Default backup folder, backup file names | `ChachiAgrivetPOS Backups`, `agrivet_backup_….zip` | `ChachiPharmacyPOS Backups`, `pharmacy_backup_….zip` | `setupService`, `backupService` |
| Generic name on a product | — | Optional, searched at the counter, shown under the brand name | `018_generic_name.sql` |
| Batch tracking, senior/PWD eligibility in the product editor | Not editable on screen | Both on the Identity tab; new products start with both ticked | `public/js/catalogue/editor.js` |
| Changing batch tracking after stock has moved | Accepted by the API, and breaks the product | Refused — `INV-207` | `productService` |
| Senior citizen / PWD discount (`TAX-004`) | Ships **off** | Ships **on** | `settingsService` |
| Return write-off categories (`POS-304`) | Veterinary, Vaccines, Biologics… | Medicines, OTC Medicines, Vitamins, Supplements, Vaccines, Biologics | `settingsService` |
| Return reasons | …"Animal refused the feed"… | …"Seal broken or packaging tampered", "Adverse reaction reported"… | `settingsService` |
| Opening-data spreadsheet | Three CSV files, emailed as a workbook; categories and units keyed in by hand first | **One `.xlsx`**, downloaded from the app and uploaded back unchanged, with its own tabs for categories, units, brands, suppliers and packs; `generic_name` and `senior_pwd` columns (`TASK-047`) | `openingWorkbookService`, `config/xlsx.js`, `openingDataService` |
| Setup wizard (`SCR-001`) | Unstyled (it never loaded `tokens.css`); five steps | Styled and fitting 1366×768; an optional **step 6** loads the workbook as the new owner (`TASK-047`) | `setup.html`, `setup.js`, `shell/opening.js` |
| Customers created by the opening balance load | `FARM` | `REGULAR` | `openingDataService` |

## 2. Recorded decisions

| # | Decision | Rationale |
| :-: | :--- | :--- |
| P-1 | **`statutory_discount_enabled` ships on.** | RA 9994 and RA 10754 name medicines for the beneficiary's own use first. For an agrivet, whether the discount applied was a question for an accountant. For a drugstore it applies from the day it opens. The owner can still turn it off, and the change is audited (`AUD-601`). Which products it covers is still set per product. |
| P-2 | **A new product starts batch-tracked and senior/PWD-eligible in the editor.** The server default stays off. | Nearly everything on the shelf needs both. The two mistakes are not equal: forgetting batch tracking cannot be undone once stock arrives, and forgetting eligibility denies a statutory discount. Staff untick the few exceptions. The spreadsheet load stays explicit, so a blank cell still means no. |
| P-3 | **`INV-207` — whether a product is batch-tracked is fixed once any stock movement exists.** Before that it can be changed. | Same reasoning as `UOM-003`. `INV-201` refuses a movement without a batch on a batch-tracked product, and refuses a batch on one that is not. Flipping the flag on a product with history leaves stock nothing can sell, or sales nothing can return. To fix a wrong setting: create a new product and move the stock across with an adjustment. |
| P-4 | **Generic name is a column, not text in the description.** | The customer asks for "paracetamol" and the box says "Biogesic". Searching by generic is how the counter finds every brand of the same medicine. |
| P-5 | **Separate data folder and Windows app id.** | A pharmacy install can never open an agrivet database by accident, and uninstalling one never touches the other. |
| P-6 | **Internal names are kept**: `agrivet.db`, the `AGRIVET_*` environment variables, and the export format id `chachi-agrivet-pos-export`. | No owner sees them. Renaming them would change the backup, restore and import code without benefiting any user. |

## 3. Branches, and the migration number

**Decision (owner, 2026-09-14): `main` is the base product and the pharmacy features stay on
this branch.** `main` is merged into `pharmacy` and never the other way. `018_generic_name.sql`,
`INV-207` and the editor fields are not merged to `main`. This replaces the earlier
recommendation to merge them, and it means the `INV-207` fault (batch tracking can be changed
after stock has moved) remains on `main`, where agrivet stores run.

**What the decision requires of migration numbers.** Migrations are forward-only and numbered
(`05_TECH_SPEC.md` §3.5). A store records each number it has applied, and on launch
`upgradeService` compares only the *highest* applied number with the highest file number: if
they are equal, nothing runs. Two consequences follow.

- If `main` ships its own `018` and it is merged into this branch, a pharmacy store has already
  recorded 018, so `main`'s change is **skipped without an error**.
- A pharmacy-only file in a separate high range (say `900_…`) does not avoid that: a store at
  900 would treat `main`'s later `019` as already covered and never run it either.

So **one number sequence is shared across both branches**. Until the runner is changed, every
migration on either branch takes the next number above everything on *both*, and **`main`'s next
migration is `019`**, because `018` is taken here. `TASK-046`'s open box tracks making that rule
enforce itself rather than depend on memory.

## 4. Open questions for the client

| # | Question | Blocks |
| :-: | :--- | :--- |
| PQ-1 | Is the store VAT-registered, non-VAT, or unregistered? (`TAX-001`) | Go-live configuration |
| PQ-2 | Which stocked medicines are VAT-exempt under the FDA/BIR list (for diabetes, hypertension, high cholesterol, cancer, mental illness, tuberculosis, kidney disease)? Each one gets `tax_class = VAT_EXEMPT`. | Catalogue load, VAT mode only |
| PQ-3 | What category names does the store use? The write-off list in `POS-304` matches categories by name. | Settings at go-live |
| PQ-4 | What near-expiry warning does the store want? The default is 90 days; many drugstores return stock to suppliers at 3–6 months. (`INV-203`, `near_expiry_days`) | Settings at go-live |
| PQ-5 | Does the store's accountant or LGU still require a senior citizen purchase booklet for medicines? The system records ID type, number and name only. | Confirm before go-live |

## 5. Out of scope for this edition

Each needs its own task if it is ever needed. None has been started.

- **Prescription-only medicines.** Nothing marks a product as Rx-only. The sale records no
  prescription, prescriber or pharmacist, and no pharmacist signs off at the counter. A
  store that dispenses prescription drugs must not use this edition for them.
- **Dangerous drugs register** (RA 9165). There is no controlled-substance log.
- **BIR official receipts or sales invoices.** `TAX-006` is unchanged: the printed document
  is an internal transaction record and says so. A registered store still issues its BIR
  invoice separately.
- **FDA licence details** on the printout (LTO number, pharmacist on duty).

The regulatory notes in this file are a developer's reading of the statutes. They are not
legal advice. Confirm them with the store's accountant and the FDA licensing requirements.
