# Industries — Chachi POS (formerly the Pharmacy Edition)

**Branch**: `main` (was `pharmacy`) · **Date**: 2026-09-15 · **Tasks**: `TASK-046`–`TASK-053`
(`06_TASKS/README.md`) · **Scope of the pharmacy industry**: an **over-the-counter** drugstore.
Not a dispensing pharmacy — see §5.

**Since `TASK-053` there is one product, Chachi POS**, and what kind of store it runs is chosen in
the setup wizard (§9). This file began as the record of the pharmacy edition, a branch of the
agrivet product; §1–§8 are that record, and still say what a pharmacy store gets. §9 says how the
two editions became one application and what an industry decides. Every rule in
`03_BUSINESS_RULES.md` still holds unless this file names it.

---

## 1. What changed

| Area | Agrivet (`main`) | Pharmacy (`pharmacy`) | Where |
| :--- | :--- | :--- | :--- |
| Product name, installer, shortcut, Windows app id | Chachi Agrivet POS · `store.chachisoftware.agrivetpos` | Chachi Pharmacy POS · `store.chachisoftware.pharmacypos` | `package.json`, `public/` |
| Data folder | `%LOCALAPPDATA%\ChachiAgrivetPOS` | `%LOCALAPPDATA%\ChachiPharmacyPOS` | `src/config/paths.js` |
| Default backup folder, backup file names | `ChachiAgrivetPOS Backups`, `agrivet_backup_….zip` | `ChachiPharmacyPOS Backups`, `pharmacy_backup_….zip` | `setupService`, `backupService` |
| Generic name on a product | — | Optional, searched at the counter, shown under the brand name | `900_generic_name.sql` |
| Batch tracking, senior/PWD eligibility in the product editor | Not editable on screen | Both on the Identity tab; new products start with both ticked | `public/js/catalogue/editor.js` |
| Changing batch tracking after stock has moved | Accepted by the API, and breaks the product | Refused — `INV-207` | `productService` |
| Senior citizen / PWD discount (`TAX-004`) | Ships **off** | Ships **on** | `settingsService` |
| Return write-off categories (`POS-304`) | Veterinary, Vaccines, Biologics… | Medicines, OTC Medicines, Vitamins, Supplements, Vaccines, Biologics | `settingsService` |
| Return reasons | …"Animal refused the feed"… | …"Seal broken or packaging tampered", "Adverse reaction reported"… | `settingsService` |
| Opening-data spreadsheet | Three CSV files, emailed as a workbook; categories and units keyed in by hand first | **One `.xlsx`**, downloaded from the app and uploaded back unchanged, with its own tabs for categories, units, brands, suppliers and packs; `generic_name` and `senior_pwd` columns (`TASK-047`) | `openingWorkbookService`, `config/xlsx.js`, `openingDataService` |
| Setup wizard (`SCR-001`) | Unstyled (it never loaded `tokens.css`); five steps | Styled and fitting 1366×768; an optional **step 6** loads the workbook as the new owner (`TASK-047`) | `setup.html`, `setup.js`, `shell/opening.js` |
| Customers created by the opening balance load | `FARM` | `REGULAR` | `openingDataService` |
| Product pictures (`TASK-052`) | None | One per product: on the editor, beside each name in the list and in the counter's search. In the database, so backups and exports carry them (`IMG-001`–`IMG-002`, §7) | `902_product_images.sql`, `productImageService`, `shell/pictures.js` |
| A recalled batch (`INV-208`) | A list of who bought it (`INV-206`); the counter goes on selling it | **Held**: put on recall with a reason, never sold until lifted, what is left returned to the supplier; a dashboard alert while it is on the shelf (§8) | `903_batch_recall.sql`, `batchService.recall`, `SCR-207` |
| Subscription (`TASK-048`) | None | A signed licence, renewed online at least every 30 days; no new shift opens once it lapses (`LIC-001`–`LIC-004`, §6). **On**: the build names `pos.chachisoftware.store` | `licenceService`, `901_licence.sql`, `licence-server/` |

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

> **Superseded by `TASK-053` (owner, 2026-09-15).** One application is published, so the
> branches are one: `pharmacy` was fast-forwarded into `main`, and the pharmacy features are now
> every store's, with what differs by industry decided at setup (§9). The history below is kept
> because the migration ranges it set up still hold.

**Decision (owner, 2026-09-14): `main` is the base product and the pharmacy features stay on
this branch.** `main` is merged into `pharmacy` and never the other way. The generic-name
migration, `INV-207` and the editor fields are not merged to `main`. This replaces the earlier
recommendation to merge them, and it means the `INV-207` fault (batch tracking can be changed
after stock has moved) remains on `main`, where agrivet stores run.

**Migration numbers, enforced in code (owner's choice, 2026-09-14).** Keeping the branches apart
made the numbers a shared resource: if `main` shipped a `018` of its own, a pharmacy store that
had recorded this branch's `018` would skip it without an error. So:

- **Two ranges.** `001`–`899` are the base product's and are written on `main`. `900`–`999` are
  this edition's and exist only here. The generic name is `900_generic_name.sql`, renumbered
  from `018` before any store ran it. `main`'s next migration is simply its next number.
- **Pending means "not yet recorded", not "above the highest".** A store runs every shipped
  file it has not recorded, so `main`'s `018` merged in later still runs on a store already at
  `900`. A recorded migration the build does not ship is refused as "written by a newer build",
  whatever its number (`config/migrate.js`, `migrate.status()`). Upgrade, restore, the health
  panel and import all ask the same question. Exports list every applied migration
  (`schema_versions`); an older archive without the list is judged by its highest number, as
  before.
- **Held by a test on this branch alone.** `migration-ranges.test.js` needs no `main` and no
  git. Every file below 900 must be listed, with its SHA-256, in
  `src/tests/fixtures/base-migrations.sha256`. A pharmacy change written into the base range,
  or an edited base migration, fails the suite. When a merge from `main` brings a new base
  migration, its line is added to that list in the same merge.

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

## 6. The subscription (`TASK-048`)

**Rules `LIC-001`–`LIC-004`** exist only on this branch. The full record is in
`06_TASKS/TASK-048-google-sign-in-and-subscription.md`; the licence server is `licence-server/`.

| # | Rule |
| :-: | :--- |
| `LIC-001` | No new shift opens on a POS that is not linked, or whose licence has lapsed. An open shift runs to its close; reports, export, backup and restore always work |
| `LIC-002` | The licence ends at the earlier of its paid-until and 30 days after its last check; 7 days' warning before, 7 days' grace after |
| `LIC-003` | Only a licence signed by the build's key counts, and setting the clock back does not undo a lapse |
| `LIC-004` | Only the owner links the POS or asks for a check; linking is audited |

**`NFR_3.1` is amended on this branch:** every core operation works with no internet for the
licence's validity plus grace, 37 days after the last check. **`TC-E2E-08` runs with licensing
on** and a licence 20 days old, the network cut: the day trades and nothing reaches out. The
rest of the gate runs with `AGRIVET_LICENSING=off`.

**The linking needs no Google code on the POS.** The owner approves a code on
`pos.chachisoftware.store/link` in any browser. So the Electron and Android builds link the
same way, and neither holds a Google token.

## 7. Product pictures (`TASK-052`)

| # | Rule |
| :-: | :--- |
| `IMG-001` | A picture is a JPEG, PNG or WebP, checked by its first bytes, at most 600 KB, with a thumbnail of at most 64 KB in the same format. The POS shrinks a photo to 640 px (and 128 px) before sending it; the server never decodes one. Never SVG |
| `IMG-002` | Whoever may edit the product (`TX-410`) sets or removes its picture; anyone who reads the catalogue sees it, the cashier included. Both changes are audited by the picture's hash, never its bytes |

The pictures live in the database (`product_images`), so a backup, a restore and an export carry
them with nothing else to copy. An export writes them as base64 in `product_images.json`; a real
photo, shrunk, is roughly 40–80 KB, which leaves an export of several hundred pictured products
inside the 64 MB an import accepts. The opening workbook (`TASK-047`) carries no pictures: they are
added per product, from the editor.

## 8. A recalled batch is held (`INV-208`)

| # | Rule |
| :-: | :--- |
| `INV-208` | A batch put on recall is **held**: FEFO never offers it to a sale, and a sale that would need it is refused naming the batch, until the recall is lifted. Placing and lifting a recall need `TX-407` and a reason; what is left of a recalled batch leaves the shop by a `SUPPLIER_RETURN` movement for all of it. All three are audited (`BATCH_RECALLED`, `BATCH_RECALL_LIFTED`, `BATCH_RETURNED_TO_SUPPLIER`) |

`INV-206`'s recall said who bought a batch and did nothing to the batch itself, so the counter's
FEFO allocator went on selling a recalled lot — usually first, since the lot in a notice is often
the oldest. A drugstore holding a manufacturer's or FDA notice must be able to stop the sale of
that lot at once, from `SCR-207`, where the list of buyers already is.

Recall is **state**, where expiry is arithmetic (`INV-203`): it is somebody's decision, on a day,
for a reason. `product_batches.recalled_at`, `recalled_by` and `recall_reason` hold it; a lifted
recall sets them back to null, and the audit trail keeps both events. Goods a customer brings back
return to the batch they came from (`POS-303`), so recalled goods returned are held too, and are
sent back in turn. Only a recalled batch is returned to the supplier from here; returning good
stock to a supplier is a purchasing question for another screen.

## 9. One application, the industry chosen at setup (`TASK-053`)

A Play Store listing is one app, so Chachi Agrivet POS and Chachi Pharmacy POS became **Chachi
POS**: one Android package (`store.chachisoftware.pos`), one Windows installer
(`ChachiPOS-Setup-<version>.exe`), one data folder (`%LOCALAPPDATA%\ChachiPOS`), and backups named
`chachipos_backup_….zip`. No store was live on either edition when this was done, so nothing is
migrated from the old names.

The setup wizard's first step asks **what kind of store this is**. The choice is
`store_profile.industry` (`904_store_industry.sql`), **fixed once made** (owner's decision: a store
set up as the wrong kind is set up again), and shown at sign-in as *Chachi POS **(Pharmacy)***.
Motorcycle shops and wholesale & retail are listed as coming soon and cannot be chosen yet.

**What an industry decides is small, on purpose.** Every feature is in every store — generic
names, batches and expiry, recall, pictures, packs, credit, the subscription, the Android app. An
industry decides only the defaults a store would otherwise change on day one, and the words it
sees. All of it is in `src/config/industries.js`:

| | Pharmacy | Agrivet |
| :--- | :--- | :--- |
| Senior citizen / PWD discount (`statutory_discount_enabled`, P-1) | On | Off — a question for the accountant |
| Return reasons (`POS-302`) | …"Seal broken or packaging tampered", "Adverse reaction reported"… | …"Animal refused the feed"… |
| Return write-off categories (`POS-304`) | Medicines, OTC Medicines, Vitamins, Supplements, Vaccines, Biologics | Veterinary, Veterinary Medicines, Medicines, Vaccines, Biologics |
| A new product in the editor (P-2) | Batch-tracked and senior/PWD-eligible, ticked | Both unticked |
| Customers from the opening credit balances | `REGULAR` | `FARM` |
| The opening spreadsheet's examples and Read me | Paracetamol, boxes of 100 tablets | Hog feed, sacks of 50 kg |
| Sign-in, sidebar mark | *Chachi POS (Pharmacy)*, pill | *Chachi POS (Agrivet)*, sprout |

The settings are **seeded** from the industry at setup and are ordinary settings afterwards: the
owner can change any of them. Adding an industry is a block in `industries.js` with
`available: true`; the column's CHECK already names the two on the roadmap.
