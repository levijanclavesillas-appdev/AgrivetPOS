# TASK-053 — One application: Chachi POS, the industry chosen at setup

**Priority:** **P1** · **Blocks release:** the Play Store listing · **Branch:** `main` (from
`pharmacy`) · **Source of truth:** `PHARMACY_EDITION.md` §9, `src/config/industries.js`

---

## Objective

Publish one app, **Chachi POS**, for every kind of store, instead of one app per industry.

## Context

The owner, preparing the Play Store listing:

> i stumbled on the scenario that i need to publish separate apps for different industry. we
> should revise that we can set it on settings upon store set up. so that i can push to main and
> only publish chachi POS and industry will just be appended on parenthesis as emphasis upon login

## Decisions (owner, 2026-09-15)

| # | Decision |
| :-: | :--- |
| D-1 | Android package **`store.chachisoftware.pos`** — permanent once on Play. **Superseded 2026-09-17:** Play Console holds the app as `store.chachisoftware.pharmacypos`, so that is the `applicationId`; the Java package and namespace stay `store.chachisoftware.pos` |
| D-2 | **No live stores** on either edition: nothing is migrated from the old names or folders |
| D-3 | The industry is **fixed at setup**; a store set up as the wrong kind is set up again |

## As built

| Piece | Where |
| :--- | :--- |
| The industries: name, availability, and what each decides | `src/config/industries.js` |
| `store_profile.industry`, CHECK naming the four on the roadmap | `904_store_industry.sql` |
| Required at setup, refused if not offered, refused on update | `setupService.complete`, `storeProfileService` |
| Settings seeded from the industry (P-1, `POS-302`, `POS-304`) | `settingsService.seedDefaults`, `defaultOf` |
| The wizard's first question, coming-soon kinds disabled | `setup.html`, `setup.js` |
| *Chachi POS **(Agrivet)*** at sign-in; the sidebar mark | `shell/app.js` |
| A new product's ticks (P-2) | `catalogue/editor.js`, from `GET /setup`'s `industry.product_defaults` |
| Opening balances' customer type; the spreadsheet's examples and Read me | `openingDataService`, `openingWorkbookService`, `tools/opening-template --industry` |
| One identity: app id, installer, data folder, backups, Play package | `package.json`, `build/installer.nsh`, `config/paths.js`, `backupService`, `android/`, `licence-server/src/config.js` |

The Android Java package moved to `store.chachisoftware.pos`, and the JNI entry point in
`native-lib.cpp` with it — the two must match or the app stops at launch.

## Tests

`setup.test.js`: the industries offered and refused; an agrivet's and a pharmacy's seeded
settings; the name at sign-in; the industry refused on update. `opening-template.test.js`: the
examples and title follow the industry, the columns do not. `renderer.test.js`: the sign-in line,
the wizard's question, the editor's ticks. The whole suite runs against a pharmacy store unless a
case asks otherwise (`tempdb.seedStore`).

Walked in Electron on a fresh install set up as an agrivet: the wizard refuses Next without a
kind, the coming-soon kinds cannot be picked, sign-in reads *Chachi POS (Agrivet)*, the sidebar
carries the sprout, a new product starts unticked, and the settings are the agrivet's.

**Status — 2026-09-15:** built. The Android build with the new package has not been run on a
device (this host cannot run an emulator).
