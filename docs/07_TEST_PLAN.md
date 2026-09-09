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
| E2E | project runner | Whole scripted journeys: a trading day, a cutover from nothing, a cashier's shift to a counted close, a credit customer's life, an install configured, a day read back off the audit trail, and the offline and power-loss cases | `npm run test:e2e` |
| Performance | project runner | `NFR_1.*` budgets against a seeded 5,000-product database | `npm run test:perf` |
| Browser smoke | scripted, out of gate | The real renderer in Chromium: sign in, open a shift, scan, park, resume, pay, receipt, catalogue, adjustment, customers, a collection, the shift close, reports, users, settings, backups, restore confirmation, health and the audit trail | `./tools/browser-smoke/run.sh` |
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
§6 (sales/till), §7 (credit) and §9 (purchasing) must be cited by at least one `TC-*` case.** A
rule with no test is treated as unimplemented, whatever the code says. The mapping is the table
in §3–§5 below; coverage is asserted mechanically by `TC-UT-98`, which parses rule IDs from both
documents.

§9 joined the list with `TASK-019`, which built the whole of `PO-101`–`PO-207`. The obligation
follows the implementation rather than leading it: a coverage requirement over rules nobody has
built yet forces a fake citation, which makes the figure stop meaning anything (`TC-UT-98`'s
own comment says so). The obligation applies per release — a `PO-*` rule marked 1.1 is covered,
one marked 1.2 is reported and not asserted, exactly as the other sections work.

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
| `TC-INT-76` | `PO-103`: raising, sending, amending and cancelling an order writes no inventory movement, and moves no average cost | `PO-103`, `INV-101` |
| `TC-INT-77` | `PO-202`: fifty sacks with three split posts forty-seven; the damaged quantity is recorded and posts nothing, and a wholly damaged line posts no movement at all | `PO-202`, `INV-103` |
| `TC-INT-78` | `PO-203`: the average moves at the actual received cost, and the figure the ordered cost would have produced is asserted as the wrong answer | `PO-203`, `INV-106`, `MON-004` |
| `TC-INT-79` | `PO-102`, `PO-104`, `PO-105`: the status machine and the transitions it refuses; a revision rather than an overwrite; a cancellation refused once anything arrived | `PO-102`, `PO-104`, `PO-105` |
| `TC-INT-80` | `PO-204`, `PO-205`: over-receipt and an out-of-tolerance cost each refuse, name the rule and the role, flag the receipt, and record two distinct actors | `PO-204`, `PO-205`, `AUD-603` |
| `TC-INT-81` | `POS-301`: a line returns partially, repeatedly, and never beyond what was sold; the stored counter and the sum of the return lines agree afterwards, and three partial refunds of one line sum to exactly what the line charged | `POS-301`, `MON-003` |
| `TC-INT-82` | `POS-304`: a batch-tracked product defaults to write-off and the screen is told why; a cashier restocking it is refused naming the role, a manager releases it, and the override is on the trail with two distinct actors — with the rule's own answer still stored beside the chosen one | `POS-304`, `AUD-603` |
| `TC-INT-83` | `POS-305`, `POS-306`: a credit sale's refund goes back to the account it was charged to, before anything else and whether or not a balance still stands; the cash part of a credit sale is withheld while one does; and a **cash** sale is still refunded in cash to a customer who owes on a different sale | `POS-305`, `POS-306`, `CR-108`, `POS-509` |
| `TC-INT-84` | `POS-303`: a write-off posts both movements and nets to zero — asserted by counting the rows, because posting nothing leaves the same figure on the shelf | `POS-303`, `INV-102`, `INV-103` |
| `TC-INT-85` | `POS-401`: every movement, tender and credit transaction reverses — by compensating rows, never deletion — and both ledgers reconcile afterwards. The cash void corrects `POS-509`'s expected drawer **by the status alone**, and no till movement is written to do it | `POS-401`, `INV-102`, `CR-103`, `POS-509` |
| `TC-INT-86` | `POS-402`: refused once the originating shift is closed, naming the return as the correction that applies; the window is the sale's shift and not the actor's, so a manager with no drawer may still void and another cashier may not | `POS-402`, `TX-419` |
| `TC-INT-87` | `POS-403`: a cashier alone is refused naming the rule and the role, an approver's **stored** role is what counts, and both actors land on `AUD-603`'s own row. A manager voiding their own mis-scan is `self_authorised`, and writes no override row | `POS-403`, `AUD-603`, `SEC-6` |
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
| `TC-E2E-15` | A day's work is legible afterwards: a price change with its old figure, an adjustment naming both actors, a settings change, a reprint — findable by actor, action, entity and date, exportable, with no secret anywhere and no write path |

| `TC-E2E-16` | A delivery: register the mill → order fifty sacks → nothing on the shelf moves → the clerk keys in forty-seven sound, three split, at 20% above the agreed price → refused, naming the rule and the role → the owner authorises → stock, average cost, ledger, order status and the damaged figure are all right afterwards, and the receipt cannot be edited |
| `TC-E2E-18` | A void: Tess opens her drawer, rings a good sale, then rings four sacks when the farmer wanted one → `SCR-304` asks whether it can be undone and is told yes, but not by her → she is refused naming `POS-403` → Rosa authorises → stock, ledger and account all reverse → the sale keeps its number, stays on the daily report marked voided, and appears on the void report with both actors → **the shift closes with no variance**, which is the assertion the whole task is for → and the same void, tried again after the close, is refused naming the return |
| `TC-E2E-17` | A return: a farm buys feed and antibiotic for cash and a drench on account → the counter looks the sale up and is told what is left on it and which line defaults to write-off, and why → the cashier tries to restock the antibiotic and is refused, naming `POS-304` and the role → the manager authorises → a sack goes back on the shelf, the second bottle is written off with both movements → the drench goes back onto the account it was charged to and pays out nothing → the trail, the drawer, the balance and `RPT-101`'s reconciliation are all right afterwards, and the return cannot be edited |

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
| `TC-UI-09` | The audit viewer holds no action list and writes nothing | `AUD-605` |
| `TC-UI-10` | Every screen in `04_UX_SPEC.md` §3 has a view | `FR_1`–`FR_7` |
| `TC-INST-01` | An upgrade over a prior install preserves the database, writes and verifies a pre-migration backup, and migrates on first launch | `NFR_5.1` |
| `TC-INST-02` | A database ahead of the binary refuses to start **through the installed application**, with a message an owner can act on | `NFR_5.1` |

`TC-INST-01` and `TC-INST-02` are automated against the working tree in
`src/tests/integration/upgrade.test.js`, with the prior install built by running the previous
release's own migrations rather than by hand-writing an old schema. Both are re-run against the
**installed** `.exe` at UAT (checks D and E), because an installer can lose a database in ways a
service call cannot.

## 6.3 v1.1 cases, reserved

`TC-*` ids are owned by this document, so the v1.1 task files do not invent them privately —
the ids they cite are reserved here. The cases themselves are written with the tasks; what this
section prevents is two tasks reaching for the same number, which is how a suite ends up with
two `TC-INT-84`s that assert different things.

| Range | Task | Subject |
| :--- | :--- | :--- |
| ~~`TC-INT-76` – `TC-INT-80`~~ | `TASK-019` | **Written** — see §4. Purchasing: no stock on a PO, damaged quantity, actual cost, the status machine, over-receipt |
| ~~`TC-INT-81` – `TC-INT-84`~~ | `TASK-020` | **Written** — see §4. Returns: the quantity ceiling, write-off defaults, refund precedence, both movements |
| ~~`TC-INT-85` – `TC-INT-87`~~ | `TASK-021` | **Written** — see §4. Voids: full reversal, the shift window, the authorisation |
| `TC-INT-88` – `TC-INT-91` | `TASK-022` | Stock counts: the freeze, no movement when matched, self-approval, staleness |
| `TC-INT-92` – `TC-INT-93`, `TC-UT-45` – `TC-UT-49` | `TASK-023`, `TASK-024` | Discount tiers, category ceilings, non-compounding, the four precedence levels |
| `TC-INT-94` – `TC-INT-100` | `TASK-025`, `TASK-026` | Import validation before writing, determinism, collisions, the opening load |
| `TC-INT-101` – `TC-INT-102`, `TC-UT-50` – `TC-UT-51` | `TASK-027` | Statutory discount: off by default, no compounding, VAT exemption |
| `TC-INT-103` – `TC-INT-106` | `TASK-028` | Store credit: both sources, spending it, reconciliation, never aged overdue |
| ~~`TC-E2E-16`~~ – ~~`TC-E2E-18`~~, `TC-E2E-19` – `TC-E2E-22` | one per task | The journey each task exists for. `TC-E2E-16` to `TC-E2E-18` are written — see §5 |

**Two existing cases are re-pointed rather than replaced**, and both are named in their tasks.
`TC-INT-62` forced a `VOIDED` status by hand because no void path existed; **`TASK-021` has now
pointed it at a real void**, and it asserts the stock came back and `POS-401`'s four columns are
on the row — neither of which the hand-forced status ever did, and both of which it would have
gone on passing without. `TC-UT-31` still asserts that two of `PR-101`'s four precedence levels
are stubbed, and `TASK-024` makes it assert that all four resolve. A case that was written
against a placeholder is a case that must change when the placeholder does — and noticing that
at v1.1 close is cheaper than noticing it in review.

A third was re-pointed unannounced, for the same reason: `TASK-020`'s "a voided sale has nothing
to return against" forced the status the same way, and now drives the real void. Anything that
writes `status = 'VOIDED'` by hand is a fake, and `saleRepository.setStatus` now refuses that
value outright so a new one cannot be written.

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
| 1 | All `FR_1`–`FR_7` acceptance criteria met | ☑ **built, tested and reachable.** Every screen in `04_UX_SPEC.md` §3 exists — 26 at v1.0, 30 since `TASK-019` — asserted by `TC-UI-10`. The criteria are *confirmed* on the store's hardware at UAT (item 9) |
| 2 | `npm run test:all` green | ☑ green — **779 cases**: 196 unit, 459 integration and API, 124 E2E, across 50 files. (v1.0 closed at 750 across 48; the difference is `TASK-019`.) |
| 3 | `TC-UT-98` passes — every covered rule has a test | ☑ green. 62 covered v1.0 rules, all cited; 51 of 51 outside §2's obligation as well |
| 4 | `TC-UT-99` passes — layering intact | ☑ green |
| 5 | Zero open S1 or S2 defects | ◐ **none known, and nothing has run in the store.** Settled at UAT sign-off (`docs/UAT_RECORD.md`) |
| 6 | `NFR_1.1`–`NFR_1.5` met on the reference machine — `TC-PERF-01`–`TC-PERF-05` | ◐ all five written, measuring and green. **Every figure below is from a build machine, not the reference spec, and establishes nothing about the budget** (§6) |
| 7 | `TC-E2E-08` passes with networking disabled | ◐ green with `dns`, `net`, `tls`, `http`, `https` and `fetch` replaced by throwing stubs — the application reaches for nothing. **The machine-level version, cable out at the wall, is UAT check F** |
| 8 | `TC-E2E-09` passes — power-loss durability | ◐ green against `SIGKILL`, which proves the process-death half and would pass with `synchronous = OFF`. **The plug-pull is UAT check 7** |
| 9 | UAT §8 complete on the store's hardware, owner signed | ☐ **not started.** `docs/UAT_RECORD.md` is the sheet it is recorded on |
| 10 | Backup verified restorable onto a second machine | ☐ **not done.** `TC-INT-74` restores in place; the second machine is UAT check G |
| 11 | `TAX-006` confirmed on the printed document | ☐ **not done.** Asserted in the encoder's output and in `TC-E2E-08`; never read on paper. UAT check 10 |

### v1.1 gate

Opened by `TASK-019`. The v1.0 criteria above stay in force — the four still open are still
open, and none of them is made better or worse by a purchasing module, a return or a void.

The three "not started" rows at the foot are all the same kind of thing and are worth reading
together: every one of them is a question about whether people in a shop use the feature, and
none of them is a question a suite can answer.

| # | Criterion | Status |
| :-: | :--- | :--- |
| 1 | `FT-501`–`FT-504` built, tested and reachable | ☑ **done** (`TASK-019`). `SCR-801`–`SCR-804` exist and are driven end to end by the browser smoke |
| 2 | `TC-INT-76`–`TC-INT-80`, `TC-E2E-16` green | ☑ green |
| 3 | `FT-307` built, tested and reachable | ☑ **done** (`TASK-020`). `SCR-305` exists; `RPT-101`'s fourth term carries a figure |
| 4 | `TC-INT-81`–`TC-INT-84`, `TC-E2E-17` green | ☑ green |
| 5 | `FT-308` built, tested and reachable | ☑ **done** (`TASK-021`). The void is on `SCR-304`; `POS-404`'s void report exists |
| 6 | `TC-INT-85`–`TC-INT-87`, `TC-E2E-18` green | ☑ green |
| 7 | `FT-505`, `FT-6xx` and the rest of the v1.1 backlog | ☐ `TASK-022` – `TASK-028` outstanding |
| 8 | Purchasing exercised on the store's own supplier data | ☐ **not started.** A delivery keyed by the person who unloads the van is the only test of `SCR-803` that counts |
| 9 | A return taken at the counter on the store's own stock | ☐ **not started.** `POS-304`'s default is the one rule in this release whose value is decided by whether a cashier reads the sentence beside it, and that is not a thing a test can answer |
| 10 | A void taken at the counter, and the drawer counted after it | ☐ **not started.** `TC-E2E-18` proves the arithmetic; what it cannot prove is that a cashier under pressure finds the button and a manager is willing to walk over. `POS-403` is a workflow before it is a rule |

Measured on a build machine, reported for regression purposes and for nothing else:

| Case | Budget | Measured here | On the reference machine |
| :--- | :--- | :--- | :--- |
| `TC-PERF-01` — sale, confirm to receipt | `NFR_1.1` ≤ 2 s | median 20 ms | not measured |
| `TC-PERF-02` — scan to cart line | `NFR_1.2` ≤ 300 ms | median 0.9 ms | not measured |
| `TC-PERF-03` — product search | `NFR_1.3` ≤ 500 ms | median 37 ms | not measured |
| `TC-PERF-04` — cold start to login | `NFR_1.4` ≤ 8 s | median 766 ms, server only | not measured; excludes Electron and Chromium starting |
| `TC-PERF-05` — dashboard at 100,000 lines | `NFR_1.5` ≤ 3 s | median 355 ms | not measured |

**How little these figures mean, measured.** The same suite on the same machine produced
figures two to three times apart depending on what else the host was doing — the quarter-wide
report took 2,143 ms running alone and 3,687 ms alongside three other perf files on a box
carrying a load average of fifteen. That is the whole of §6's point, observed rather than
asserted: a budget measured anywhere but the reference machine is not a budget. The cases
assert a ceiling at four times the budget, which catches a structural regression — a full scan,
a query per row, a dropped index — and nothing finer.

> ### Gate status, 2026-09-08 — **NOT SHIPPABLE. Everything that can be settled here is.**
>
> **v1.1 has started.** `TASK-019` adds purchasing, four screens and 27 cases. It does not move
> any of the four v1.0 items below, and it must not be read as progress towards them: they all
> reduce to the same thing, and a larger application that has still never run in the store is
> further from shipping, not nearer.
>
> `TASK-001` through `TASK-018`, and `TASK-036` through `TASK-041`, are built. **Four of the
> eleven criteria are met and cannot be advanced further from a build machine.** The remaining
> seven all reduce to one thing: nothing has run in the store.
>
> **The screen gap is closed.** `04_UX_SPEC.md` specifies 26 screens; 13 existed when the gap
> was found while writing `DEPLOYMENT.md`, which told an installer to open a settings screen
> that did not exist. Every service and API behind the missing thirteen was built and tested,
> which is exactly why nothing caught it — the suite was green because the suite tests the API.
> `TC-UI-10` now asserts the whole of §3 has a view, so it cannot reopen quietly, and
> `TC-E2E-10` to `TC-E2E-15` walk the paths end to end: a store can be installed, configured,
> stocked, staffed and traded from the application, its till counted, its credit customers paid
> off, and its audit trail read by the owner it was written for.
>
> **What is left needs the store, and none of it is paperwork:**
>
> - **Nothing has run on the store's hardware** (5, 6, 9). No receipt has been printed on paper,
>   no drawer has opened, no scanner has been used, and every performance figure above came from
>   a machine that is not the one the store will use.
> - **A backup has never been restored onto a second machine** (10). This is the scenario
>   `05_TECH_SPEC.md` §7's disaster-recovery table actually describes, and until it has been
>   done once the store's backups are untested where it counts.
> - **`TAX-006` has never been read on paper** (11). It is a legal requirement about a physical
>   document handed to a customer, and it has only ever been asserted against a byte stream.
> - **The two hardest guarantees are half-proved** (7, 8). `TC-E2E-08` proves the application
>   reaches for no network; it does not prove the machine has none. `TC-E2E-09` proves a killed
>   process loses nothing; `SIGKILL` does not empty the operating system's write cache, and a
>   power cut does.
>
> **The installer is configured but not produced.** `npm run build:exe` packages the application
> correctly and then stops: assembling and signing a Windows installer needs Windows or `wine`,
> and signing needs a certificate the business holds. `tools/installer/check.sh` compiles the
> hand-written NSIS macros and checks they say what requirement 6 requires — so the half that
> can be wrong is verified — but no `.exe` has been produced, installed, upgraded over or
> uninstalled.
>
> **The path to a shippable gate is one visit, and it is now the next step rather than the last
> one.** Build and sign the installer on a Windows machine, then work down
> `docs/UAT_RECORD.md` on the store's own counter.

---

*Chachi's Software Development Service · DTI BN 8089738 · BIR OCN 111RC20260000002455 · TIN 752-951-092-00000*
