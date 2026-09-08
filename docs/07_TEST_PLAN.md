# 07 — Test Plan

**Product**: Chachi Agrivet POS · **Version**: 2.0 · **Date**: 2026-09-07
**Owns**: test levels, every `TC-*` case, regression guards, defect severity, **release criteria
and current gate status**.

---

## 1. Levels

| Level | Runner | Scope | Command |
| :--- | :--- | :--- | :--- |
| Unit | `node:test` | Pure calculation: money, rounding, unit conversion, price resolution, tax, ageing | `npm run test:unit` |
| Integration | project runner | Service + repository against a temp SQLite file, real transactions | `npm run test` |
| API | project runner | Every endpoint, including authorisation refusals | `npm run test` |
| E2E | project runner | A scripted trading day end to end | `npm run test:e2e` |
| Performance | project runner | `NFR_1.*` budgets against a seeded 5,000-product database | `npm run test:perf` |
| Browser smoke | scripted, out of gate | The real renderer in Chromium: sign in, open the shift, scan, park, resume, pay, receipt, reports, backups, health | `./tools/browser-smoke/run.sh` |
| Installer macros | scripted, out of gate | `build/installer.nsh` compiles, and the uninstaller never removes the database or the backup folder | `./tools/installer/check.sh` |
| Installer | manual, scripted | The signed `.exe` on the reference machine: clean install, upgrade, uninstall | — |
| UAT | manual | `07_TEST_PLAN.md` §8, on the store's own hardware | — |

`npm run test:all` runs unit + integration + API + E2E, and is the release gate.

Every case that needs an HTTP server binds **port 0** and reads the assigned port back off it.
Fixed ports collided whenever two runs overlapped or a socket lingered, and the failure landed
on whichever file happened to be running — a flake that reads as a defect somewhere unrelated.
`server.test.js` is the exception: its `probe` and reuse cases need a port they can name.

The browser smoke is deliberately **outside** that gate. It needs Electron's Chromium and a
display, and a gate that silently skips a level it cannot run is worse than one that never
claimed it. It is the automatable part of §8: what it covers is layout-independent behaviour —
that the screens render, that the keyboard map reaches them, and that a cart survives a reload —
while the eyes-on checks in §8 stay manual.

## 2. Rule coverage obligation

`NFR_5.2`: **every rule in `03_BUSINESS_RULES.md` §1 (money), §2 (units), §5 (inventory),
§6 (sales/till) and §7 (credit) must be cited by at least one `TC-*` case.** A rule with no test
is treated as unimplemented, whatever the code says. The mapping is the table in §3–§5 below;
coverage is asserted mechanically by `TC-UT-98`, which parses rule IDs from both documents.

## 3. Unit cases

| Case | Asserts | Rules |
| :--- | :--- | :--- |
| `TC-UT-01` | bcrypt verify; wrong password rejected; hash never returned | `SEC-1` |
| `TC-UT-05` | An audited mutation writes exactly one row with before and after | `AUD-601`, `AUD-606` |
| `TC-UT-06` | The settings registry is the whole `OPS-005` list, typed and bounded; no service declares a figure of its own | `OPS-005` |
| `TC-UT-07` | Every action `AUD-601`/`AUD-603` names is registered; credentials are stripped from a payload; no repository has an `UPDATE` or `DELETE` path on `audit_logs` | `AUD-601`, `AUD-603`, `AUD-605`, `SEC-11` |
| `TC-UT-10` | Base unit immutable once a movement exists | `UOM-001`, `UOM-003` |
| `TC-UT-11` | 1 sack (factor 50,000) from 500.000 KG leaves 450.000 KG | `UOM-002` |
| `TC-UT-12` | 1.255 KG × ₱62.50 = ₱78.44 half-up; 1,000 lines sum with zero drift | `MON-002`, `MON-003` |
| `TC-UT-13` | Four decimal places rejected, never truncated | `MON-002` |
| `TC-UT-14` | Transaction discount apportions to the centavo; remainder to the largest line | `MON-006` |
| `TC-UT-15` | Moving average after two receipts at different costs | `MON-004` |
| `TC-UT-16` | Sale, damage and negative adjustment leave average cost unchanged | `INV-106` |
| `TC-UT-17` | `NONE`/`NON_VAT` modes compute zero tax and print no VAT block | `TAX-002` |
| `TC-UT-18` | `VAT` mode: inclusive ₱1,120 VATable → net ₱1,000, VAT ₱120 | `TAX-003` |
| `TC-UT-19` | A basket of VATable + exempt lines decomposes per line, not in aggregate | `TAX-003` |
| `TC-UT-20` | Statutory and voluntary discounts do not compound; larger wins | `TAX-005` |
| `TC-UT-31` | Price precedence: customer → qty break → level → retail | `PR-101` |
| `TC-UT-32` | Missing wholesale price falls through to retail, never to zero | `PR-102` |
| `TC-UT-33` | GCash tender with empty reference rejected | `POS-205` |
| `TC-UT-34` | Discount above role ceiling refused without an approver | `PR-201`, `PR-203` |
| `TC-UT-35` | Discount cannot drive a line negative | `PR-205` |
| `TC-UT-40` | Credit tender without a customer rejected | `CR-102` |
| `TC-UT-44` | Ageing derives from due date at read time across a date boundary | `CR-107` |
| `TC-UT-90` | Timestamps stored UTC, rendered `Asia/Manila` | `VR-102`, `NFR_4.2` |
| `TC-UT-98` | Every rule in the covered sections is cited by ≥ 1 test | `NFR_5.2` |
| `TC-UT-99` | No SQL and no `better-sqlite3` import outside `repositories/` and `config/` | `05` §8.1 |

## 4. Integration and API cases

| Case | Asserts | Rules |
| :--- | :--- | :--- |
| `TC-INT-01` | Migrations apply once, are idempotent, and a database ahead of the binary refuses to start | `05` §8.9 |
| `TC-INT-02` | 5 failures lock for 15 minutes; the lock survives a restart | `SEC-3` |
| `TC-INT-03` | PIN unlock reaches POS; refused on settings, users, cost fields | `SEC-2`, `SEC-6` |
| `TC-INT-04` | Recovery code works once, is replaced, and is audited before the reset | `SEC-5`, `AUD-604` |
| `TC-INT-05` | An audit row is writable at schema version 1, before `cashier_shifts` exists — with `shift_id` null and populated | `AUD-605`, `05` §3.4 |
| `TC-INT-20` | `SUM(movements) = inventory.qty_on_hand` for every product after the E2E day | `INV-101` |
| `TC-INT-21` | Negative stock blocked; and permitted-with-flag when the setting is on | `INV-104` |
| `TC-INT-22` | Selling to the threshold surfaces the product in low stock | `INV-109` |
| `TC-INT-23` | Adjustment without a listed reason rejected; above threshold needs owner | `INV-108` |
| `TC-INT-24` | A movement is never updated or deleted; a correction cites the original | `INV-102` |
| `TC-INT-30` | Unknown barcode returns an attach-offer, not a 404 swallowed by the UI | `FR_3.1` |
| `TC-INT-32` | Split tender ₱600 cash + ₱400 GCash completes ₱1,000; ₱600 alone does not | `POS-202`, `POS-204` |
| `TC-INT-34` | **Injected failure after movements leaves no sale, no movement, no balance change** | `INV-107`, `FR_3.5` |
| `TC-INT-35` | Changing a product cost after a sale does not change that sale's profit | `MON-005` |
| `TC-INT-36` | Drawer pulsed on cash and split-with-cash; not on pure credit | `POS-507` |
| `TC-INT-37` | Client-computed totals are ignored; a tampered total is rejected | `05` §4.1 |
| `TC-INT-38` | Duplicate GCash reference in a day warns and requires explicit acceptance | `POS-207` |
| `TC-INT-39` | A reprint is stamped and audited | `POS-208` |
| `TC-INT-41` | Over-limit credit blocked; override records requester and approver distinctly | `CR-104`, `AUD-603` |
| `TC-INT-42` | ₱3,000 against ₱10,000 leaves ₱7,000 and allocates oldest-first | `CR-203` |
| `TC-INT-43` | Collection prints an acknowledgement with a `COLL-` number | `CR-206` |
| `TC-INT-45` | Overpayment requires confirmation and becomes store credit | `CR-204` |
| `TC-INT-46` | Balance always equals the sum of its credit transactions | `CR-103` |
| `TC-INT-47` | A credit transaction is writable before `sales` and `cashier_shifts` exist — `sale_id` and `shift_id` are soft references | `CR-103`, `05` §3.4 |
| `TC-INT-50` | Sale and collection both refused with no open shift | `POS-501` |
| `TC-INT-51` | Expected cash arithmetic asserted against a scripted shift | `POS-509` |
| `TC-INT-52` | A ₱200 short close demands a reason and writes the audit row | `POS-510`, `AUD-602` |
| `TC-INT-53` | No endpoint mutates a closed shift | `POS-511` |
| `TC-INT-54` | Cash out exceeding drawer cash refused | `POS-505` |
| `TC-INT-55` | Sale numbers gapless per day; a rolled-back sale consumes none | `POS-108` |
| `TC-INT-60` | Dashboard tiles equal the report queries for the same day | `FR_6.1` |
| `TC-INT-61` | `gross − discounts − returns = net`, and `net = tenders − change` | `RPT-101` |
| `TC-INT-62` | Voided sales excluded from net in every report | `RPT-106` |
| `TC-INT-63` | CSV export matches the on-screen report, figure for figure | `RPT-106`, `TX-426` |
| `TC-INT-70` | Shift close writes a backup; the 31st prunes the oldest | `OPS-001`, `OPS-003` |
| `TC-INT-71` | A corrupt backup target fails verification and raises an alert | `OPS-002` |
| `TC-INT-72` | Clock advanced past the backup period raises the launch warning | `OPS-007` |
| `TC-INT-73` | Clock set earlier than the last transaction raises the anomaly alert | `OPS-009`, `VR-103` |
| `TC-INT-74` | Restore is owner-only, takes a pre-restore backup, needs typed confirmation, and is audited | `OPS-004`, `AUD-601` |
| `TC-INT-75` | A backup taken while a sale is mid-flight restores to a consistent database | `OPS-002`, `OPS-008` |
| `TC-API-01` | Every route refuses an actor lacking its `TX-*`, with 403, and audits it | `SEC-6` |
| `TC-API-02` | No endpoint returns `password_hash`, `pin_hash` or `recovery_code_hash` | `SEC-1` |

## 5. E2E cases

| Case | Scenario |
| :--- | :--- |
| `TC-E2E-00` | Fresh install → setup wizard → owner created → first login |
| `TC-E2E-01` | Open shift → scan 3 items → 1.255 KG fractional line → cash → change → receipt, under `NFR_1.1` |
| `TC-E2E-02` | Credit sale to a farm customer within limit → balance rises → collection → balance falls → acknowledgement |
| `TC-E2E-03` | Over-limit credit → refusal → manager override → sale completes with both actors recorded |
| `TC-E2E-04` | Sack and kilo sales of the same product in one day → ledger reconciles in the base unit |
| `TC-E2E-05` | Split tender: cash + GCash + credit in one sale |
| `TC-E2E-06` | Full trading day → close shift → variance → reason → backup written and verified |
| `TC-E2E-07` | Adjustment for damage → valuation falls → movement ledger and audit both show it |
| `TC-E2E-08` | A full trading day with `dns`, `net`, `tls`, `http`, `https` and `fetch` removed, and nothing in the renderer loaded from off the machine. The machine-level version is UAT check F | 
| `TC-E2E-09` | `kill -9` mid-sale loop → restart → ledger consistent, no partial sale, no lost committed sale. Proves the process-death half of `OPS-008`; §8 item 7 is the power-loss half |
| `TC-E2E-10` | A cutover from nothing: wizard → category → unit → product → barcode → pack → price → opening stock → scan → sell. The case that proves a store can be set up |
| `TC-E2E-11` | A cashier's day from the shift screens: open → resume → sell → cash out → count short → refused → reason → close → summary → backup. The case that proves a till can be counted |
| `TC-E2E-12` | The owner creates a cashier who then trades under their own name: create → sign in → refused what a cashier may not do → open → sell → PIN unlock → lock out → reset → deactivate. The case that proves the store need not trade on the owner login |
| `TC-E2E-13` | An installer configures a store from `SCR-702`: printer, width, test page, backup folder, a bounded figure refused, an owner-only one refused to a manager, the tax mode changed and audited |
| `TC-E2E-14` | A credit customer's life: create → limit → buy on credit → part payment settling the oldest → overpayment refused then acknowledged → deactivation refused while owing, then allowed |

## 6. Non-functional cases

Every case here maps to an `NFR_*` in `02_PRD.md` §4. These are **budgets, not assertions about a
value**: they are measured on the reference machine (`NFR_4.1`) against a database seeded to
`NFR_2.1` scale, and a figure taken on a developer's machine is not a result. A missed budget is a
defect at the severity of whatever it blocks (§9).

### 6.1 Performance and scale

| Case | Asserts | Budget | NFR |
| :--- | :--- | :--- | :--- |
| `TC-PERF-01` | Sale completion, confirm to receipt | ≤ 2 s | `NFR_1.1` |
| `TC-PERF-02` | Barcode scan to cart line, 5,000 products | ≤ 300 ms | `NFR_1.2` |
| `TC-PERF-03` | Product search, first result, 5,000 products | ≤ 500 ms | `NFR_1.3` |
| `TC-PERF-04` | Application cold start to login | ≤ 8 s | `NFR_1.4` |
| `TC-PERF-05` | Dashboard load at 100,000 sale lines | ≤ 3 s | `NFR_1.5` |
| `TC-PERF-06` | The seeded scale itself holds: 5,000 products, 2,000 customers, 60,000 sales in a year, with every other budget still met | — | `NFR_2.1` |

### 6.2 Interface and packaging

| Case | Asserts | NFR |
| :--- | :--- | :--- |
| `TC-UI-01` | Touch targets ≥ 44 px on POS and payment, measured as rendered at 1366×768 | `NFR_4.3` |
| `TC-UI-02` | Cost is absent — not disabled — from the catalogue for every role but `OWNER` | `TX-412` |
| `TC-UI-03` | The base unit is locked once movements exist, and the screen renders the reason | `UOM-003` |
| `TC-UI-04` | The close screen never pre-fills a counted figure from the expected one | `POS-510` |
| `TC-UI-05` | `CREDIT` is rendered as unreconcilable, with its reason, and takes no counted input | `POS-510` |
| `TC-UI-06` | No password or PIN value is ever rendered back into the DOM | `SEC-1` |
| `TC-UI-07` | The settings screen holds no copy of the registry — every field is built from the server's declaration | `OPS-005` |
| `TC-UI-08` | No customer screen computes a balance; the collection preview is labelled an estimate and the result is the server's | `CR-103` |
| `TC-INST-01` | An upgrade over a prior install preserves the database, writes and verifies a pre-migration backup, and migrates on first launch | `NFR_5.1` |
| `TC-INST-02` | A database ahead of the binary refuses to start **through the installed application**, with a message an owner can act on | `NFR_5.1` |

`TC-INST-01` and `TC-INST-02` are automated against the working tree in
`src/tests/integration/upgrade.test.js`, with the prior install built by running the previous
release's own migrations rather than by hand-writing an old schema. Both are re-run against the
**installed** `.exe` at UAT (checks D and E), because an installer can lose a database in ways a
service call cannot.

## 7. Regression guards

Permanent, never deleted, run on every build:

1. `TC-INT-20` — the ledger reconciles. Every inventory defect ends up here.
2. `TC-INT-34` — the sale transaction is atomic.
3. `TC-INT-46` — the credit balance reconciles to its ledger.
4. `TC-INT-61` — the daily sales report reconciles.
5. `TC-UT-12` — no money or quantity drift.
6. `TC-UT-98` / `TC-UT-99` — rule coverage and layering hold.

## 8. UAT script — on the store's hardware, before go-live

| # | Check | Pass when |
| :-: | :--- | :--- |
| 1 | Scanner adds items without a driver install | 20 consecutive scans, no misses |
| 2 | 58 mm and 80 mm receipts print legibly | Both layouts checked against the real printer |
| 3 | Drawer opens on a cash sale | Physical drawer opens |
| 4 | Feed sold by sack and by kilo | On-hand matches a physical count afterwards |
| 5 | A real credit customer's balance matches the notebook | Reconciled at cutover |
| 6 | A full day's takings reconcile at close | Variance ≤ ₱50 |
| 7 | Unplug the PC mid-sale | Restart is clean, no phantom sale |
| 8 | Backup file exists and opens after close | Verified in `SCR-704` |
| 9 | Cashier cannot see cost or reach settings | Confirmed on their own login |
| 10 | Receipt carries "This is not an official receipt" | Printed and read | 

These ten, plus the eight installer and recovery checks `TASK-018` adds, are recorded on
`docs/UAT_RECORD.md` — filled in by hand on the day, on the store's own hardware. A
pre-ticked UAT record is not evidence of anything.

## 9. Defect severity

| Severity | Definition | Ship? |
| :--- | :--- | :--- |
| **S1 — Critical** | Money, stock or credit balance wrong; data loss; a completed sale lost or duplicated | Never |
| **S2 — Major** | A rule bypassable; a report that does not reconcile; a workflow blocked with no workaround | Never |
| **S3 — Moderate** | Workflow degraded but workable; a non-money report wrong | With owner sign-off |
| **S4 — Minor** | Cosmetic, wording, layout | Yes, logged |

Any defect touching `MON-*`, `INV-101`, `CR-103` or `POS-509` is **S1 by definition**, regardless
of how small it looks.

## 10. Release criteria and current gate status

### v1.0 gate

| # | Criterion | Status |
| :-: | :--- | :--- |
| 1 | All `FR_1`–`FR_7` acceptance criteria met | ◐ **every service, API and rule is built and tested; 1 of the 26 screens in `04_UX_SPEC.md` is not.** `FR_1.1`–`FR_1.4`, `FR_2.*`, `FR_3.*`, `FR_4.*`, `FR_5.*`, `FR_6.*` and `FR_7.*` are all reachable. Only `FR_1.5` — reading the audit trail — has no screen (`TASK-041`) |
| 2 | `npm run test:all` green | ☑ green — unit 15 files, integration 21, E2E 11 |
| 3 | `TC-UT-98` passes — every covered rule has a test | ☑ green. 62 covered v1.0 rules, all cited; it found `UOM-004` and `POS-103` untested on its first run and both now have cases |
| 4 | `TC-UT-99` passes — layering intact | ☑ green |
| 5 | Zero open S1 or S2 defects | ◐ **none known, and nothing has run in the store.** Settled at UAT sign-off (`docs/UAT_RECORD.md`) |
| 6 | `NFR_1.1`–`NFR_1.5` met on the reference machine — `TC-PERF-01`–`TC-PERF-05` | ◐ all five written and measuring. **Every figure below is from a build machine, not the reference spec, and therefore establishes nothing about the budget** (§6) |
| 7 | `TC-E2E-08` passes with networking disabled | ◐ written and green with `dns`, `net`, `tls`, `http`, `https` and `fetch` replaced by throwing stubs — the application reaches for nothing. **The machine-level version, cable out at the wall, is UAT check F** |
| 8 | `TC-E2E-09` passes — power-loss durability | ◐ written and green against `SIGKILL`, which proves the process-death half and would pass with `synchronous = OFF`. **The plug-pull is UAT check 7** |
| 9 | UAT §8 complete on the store's hardware, owner signed | ☐ **not started.** `docs/UAT_RECORD.md` is the sheet it is recorded on |
| 10 | Backup verified restorable onto a second machine | ☐ **not done.** `TC-INT-74` restores in place; the second machine is UAT check G |
| 11 | `TAX-006` confirmed on the printed document | ☐ **not done.** Asserted in the encoder's output and in `TC-E2E-08`; never read on paper. UAT check 10 |

Measured on a build machine, reported for regression purposes and for nothing else:

| Case | Budget | Measured here | On the reference machine |
| :--- | :--- | :--- | :--- |
| `TC-PERF-01` — sale, confirm to receipt | `NFR_1.1` ≤ 2 s | median 12 ms | not measured |
| `TC-PERF-02` — scan to cart line | `NFR_1.2` ≤ 300 ms | median 0.6 ms | not measured |
| `TC-PERF-03` — product search | `NFR_1.3` ≤ 500 ms | median 20 ms | not measured |
| `TC-PERF-04` — cold start to login | `NFR_1.4` ≤ 8 s | median 713 ms, server only | not measured; excludes Electron and Chromium starting |
| `TC-PERF-05` — dashboard at 100,000 lines | `NFR_1.5` ≤ 3 s | median 125 ms | not measured |

> ### Gate status, 2026-09-08 — **NOT SHIPPABLE, and one step from being assessable**
>
> `TASK-001` through `TASK-018` are built. Every automatable criterion is green: the suite
> passes, the layering holds, every covered rule is cited by a test, and the offline and
> durability cases that were unwritten a day ago now exist.
>
> **Nine of the twenty-six screens in `04_UX_SPEC.md` do not exist.** The backlog assigned
> screens to `TASK-015`, `016` and `017` and never assigned the catalogue, customers, shift
> close, users, settings or the audit viewer. Nothing here caught it, because every one of
> those screens has a working, tested API underneath and this suite tests the API.
>
> Five of the six are closed. `TASK-036` built the catalogue, `TASK-038` the shift screens,
> `TASK-039` the settings, `TASK-040` user administration, and `TASK-037` the customer and
> credit screens — `TC-E2E-10` to `TC-E2E-14` walk all five paths end to end. A store can now
> be installed, configured, stocked, staffed and traded from the application, its till counted
> and its credit customers paid off.
>
> **One screen remains**: the audit viewer (`TASK-041`). The trail is written and queryable and
> nothing can be reached without leaving a row on it — but the owner it exists for cannot read
> it, which is `FR_1.5`. This is criterion 1, and unlike the four below it is code rather than a
> visit.
>
> **Four further criteria need the store.** They are not paperwork:
>
> - **Nothing has run on the store's hardware** (5, 6, 9). No receipt has been printed on
>   paper, no drawer has opened, no scanner has been used, and every performance figure
>   above came from a machine that is not the one the store will use. §6 says plainly that
>   a budget measured anywhere else is not a budget.
> - **A backup has never been restored onto a second machine** (10). This is the scenario
>   `05_TECH_SPEC.md` §7's disaster-recovery table actually describes, and until it has
>   been done once the store's backups are untested where it counts.
> - **`TAX-006` has never been read on paper** (11). It is a legal requirement about a
>   physical document handed to a customer, and it has only ever been asserted against a
>   byte stream.
> - **The two hardest guarantees are half-proved** (7, 8). `TC-E2E-08` proves the
>   application reaches for no network; it does not prove the machine has none.
>   `TC-E2E-09` proves a killed process loses nothing; `SIGKILL` does not empty the
>   operating system's write cache, and a power cut does.
>
> **The installer is built but not produced.** `npm run build:exe` packages the application
> correctly and then stops: assembling and signing a Windows installer needs Windows or
> `wine`, and signing needs a certificate the business holds. The NSIS macros are compiled
> and checked by `tools/installer/check.sh`, so the hand-written half is verified — but no
> `.exe` has been produced, installed, upgraded over or uninstalled.
>
> The path to a shippable gate is: close the screen gap (`TASK-036`–`TASK-041`), build and
> sign the installer on a Windows machine, then work down `docs/UAT_RECORD.md` on the store's
> own counter. The visit is the last step, not the next one.

---

*Chachi's Software Development Service · DTI BN 8089738 · BIR OCN 111RC20260000002455 · TIN 752-951-092-00000*
