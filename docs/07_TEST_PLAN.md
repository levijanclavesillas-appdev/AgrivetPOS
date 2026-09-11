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
| Browser smoke | scripted, out of gate | The real renderer in Chromium: sign in, open a shift, scan, park, resume, pay, receipt, catalogue, adjustment, customers, a collection, the shift close, reports, users, settings, backups, restore confirmation, health, the statutory discount switched on and off again, store credit earned and spent, and the audit trail | `./tools/browser-smoke/run.sh` |
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
| `TC-UT-20` | Statutory and voluntary discounts do not compound; larger wins — **written as `TC-UT-50`** (`TASK-027`), which is where it lives; the row is kept because the promise was made here | `TAX-005` |
| `TC-UT-31` | Price precedence: customer → qty break → level → retail. **Updated by `TASK-024`** — it asserted the top two levels were stubbed, and now asserts all four resolve against real data | `PR-101` |
| `TC-UT-32` | Missing wholesale price falls through to retail, never to zero | `PR-102` |
| `TC-UT-33` | GCash tender with empty reference rejected | `POS-205` |
| `TC-UT-34` | Discount above role ceiling refused without an approver | `PR-201`, `PR-203` |
| `TC-UT-35` | Discount cannot drive a line negative | `PR-205` |
| `TC-UT-40` | Credit tender without a customer rejected | `CR-102` |
| `TC-UT-44` | Ageing derives from due date at read time across a date boundary | `CR-107` |
| `TC-UT-45` | `PR-106`: the highest band the basket reaches and **only one** — a ₱10,000 basket over three bands earns 8%, not 2 + 5 + 8. Thresholds are inclusive; overlapping and descending bands are refused where they are typed | `PR-106`, `OPS-005` |
| `TC-UT-46` | `PR-202`: the effective ceiling is the **lower** of role and category, so an owner's 100% is still capped at the category's 5%. The refusal names which bound, and offers no approver where the category did | `PR-202`, `PR-201` |
| `TC-UT-48` | `PR-104`: exactly one band contains a quantity and boundaries land in the band they start; the band applies to the **whole line**, not marginally; and a set that overlaps, descends or could never lower a price is refused where it is defined | `PR-104`, `VR-203` |
| `TC-UT-49` | `PR-103`: the customer price beats a **cheaper** quantity break at every quantity — "overrides all others", not "the cheaper of" — and is still bound by `PR-202` and checked by `PR-105` | `PR-103`, `PR-202`, `PR-105` |
| `TC-UT-50` | `TAX-005`: the statutory discount is computed **before** the voluntary one and the two never add — ₱200 statutory against ₱50 by hand is ₱200, not ₱250, and the case asserts both figures are known so "not the sum" is an assertion rather than an absence. Symmetric: a larger store discount wins instead, so presenting an ID never makes a customer worse off. Equal figures go to the statutory one, because that is the claimable one | `TAX-005`, `TAX-004` |
| `TC-UT-51` | `TAX-002`, `TAX-003`: in `VAT` mode the line is **exempted first** and the 20% is taken on the VAT-exclusive amount — ₱1,120 inclusive is ₱800 payable, and the case asserts it is *not* ₱896, which is what a 20% price cut gives. In `NONE` and `NON_VAT` there is no VAT to lift, so the 20% is on the selling price; an already-exempt line is not exempted twice | `TAX-002`, `TAX-003`, `TAX-004` |
| `TC-UT-47` | `PR-206`: the larger applies and never the sum — asserted with both figures non-zero and equal, which is the input an additive implementation fails and the only one it fails | `PR-206` |
| `TC-UT-90` | Timestamps stored UTC, rendered `Asia/Manila` | `VR-102`, `NFR_4.2` |
| `TC-UT-100` | RFC 4180 both ways, against the writer the exports already use: a quoted comma, quote and newline; CRLF and LF; Excel's BOM; whitespace kept rather than trimmed. The **line numbers `OPS-105` reports rejections with** are asserted in both directions they can drift — a blank row spends a number, a quoted newline does not — and anything the writer writes the reader reads back unchanged | `OPS-105` |
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
| `TC-INT-88` | `INV-110`: the shop trades between the freeze and the posting and the variance does not move. Asserts both the variance the count reports **and** on-hand afterwards, because the two naive mistakes — measuring against live stock, and setting stock to the counted figure — each get one of those two right | `INV-110`, `INV-101` |
| `TC-INT-89` | `INV-111`: one movement for the product that varied, and **none at all** for the one that matched — asserted as an absence, since a suite checking only the varying line would pass against an implementation writing a movement of zero for every product in the shop. And an uncounted line is not a zero: it writes nothing, while a counted `0` writes the whole quantity off | `INV-111`, `INV-103` |
| `TC-INT-90` | `INV-112`: self-approval refused on **identity**, not role — a manager who took the count is still the counter. Waived, stated and recorded on the row for a single-user store, in a database of its own | `INV-112`, `AUD-601` |
| `TC-INT-91` | `INV-113`: a stale session is refused, a manager is not enough, an owner releases it, and the release is an `AUD-603`-shaped row with two distinct actors. An owner posting their own stale count needs nobody else | `INV-113`, `AUD-603` |
| `TC-INT-92` | The whole precedence in one pass: `PR-202` binds an owner whose role ceiling is 100% and the refusal names the category with **no approver to fetch**; the same discount keyed by a cashier reports `PR-203` *and* `PR-105` together rather than one at a time; `PR-106`'s tier applies to the basket and exercises nobody's ceiling; `PR-206` resolves the tier against a hand-typed figure both ways round; `PR-205` still caps the lot | `PR-106`, `PR-202`, `PR-203`, `PR-205`, `PR-206`, `PR-105` |
| `TC-INT-93` | `PR-104`: an overlapping band set is refused over HTTP naming the offending pair, and **nothing is written** — a set is refused whole. A cashier may define neither a band nor a customer price (`TX-411`), and a customer price is superseded rather than updated, with both values on the trail | `PR-104`, `PR-103`, `TX-411`, `AUD-601` |
| `TC-INT-94` | `OPS-102`: six invalid archives — an edited entity file, a future schema version, a dangling reference, a manifest whose counts disagree, another application's format, a missing file — each refuse, and **not one row moves** across any of them. The row counts before and after are the assertion; the refusals are not | `OPS-102`, `OPS-101` |
| `TC-INT-95` | `OPS-103`: an archive that passes every pre-write check and fails **late**, inside the transaction, rolls back wholly — every table, not merely the first. The pre-import backup survives it, because it is taken before the transaction opens | `OPS-103`, `OPS-102` |
| `TC-INT-96` | `OPS-104`: collisions reported in the summary; `SKIP` leaves the local rows and `REPLACE` overwrites them, both read back from the database rather than trusted from the counts; `ABORT` refuses; an unknown choice is refused rather than defaulted | `OPS-104` |
| `TC-INT-97` | The export is deterministic: two exports byte-identical, the checksum unchanged by the clock, and moved by a single changed row | `OPS-101` |
| `TC-INT-103` | `CR-108`: both sources leave a spendable balance — an overpayment (refused first, then acknowledged under `CR-204`) and a return with nothing owing, which goes to the ledger past zero rather than paying out notes. Neither is a debt: the account reads `PAID` with nothing outstanding | `CR-108`, `CR-204`, `POS-305` |
| `TC-INT-104` | A `STORE_CREDIT` tender within the balance settles the sale and moves the balance by exactly that; beyond it is refused **with the figure**, and a walk-in has no account to pay from. It takes no cash and opens no drawer — the money arrived when the credit was created — and `CR-104`'s limit has nothing to say about it: a limit governs what a customer may owe, not what they may hold | `CR-108`, `CR-104`, `POS-509` |
| `TC-INT-105` | `CR-103` reconciles with negative balances in the data, across an account that overpaid, bought, returned, spent credit and paid some off. Every row carries the running balance it left behind, and the worklist reports the debt and the liability **apart** — netting them answers neither | `CR-103`, `CR-108` |
| `TC-INT-106` | A credit balance is never aged as a debt: a fully returned credit sale leaves no invoice to chase (the return credit **allocates**, which it did not before `TASK-028`), and an account in credit a year later is still `PAID`. A sale paid from store credit opens no invoice either | `CR-107`, `CR-108`, `CR-203` |
| `TC-INT-101` | `TAX-004`: it ships **off**, and off means refused rather than priced at nothing — a claim while off answers `409` and writes no sale. Turning it on is owner-only (a manager is refused) and leaves an `AUD-601` row with both values, the actor and the reason. On, an ID type outside the two registries, a missing number or a missing name is refused, and so is a claim that reaches no eligible product | `TAX-004`, `AUD-601`, `TX-424` |
| `TC-INT-102` | The record reaches all three places: the sale row (statutory kept apart from both voluntary figures), `sale_discounts` (`PR-204`'s type, the VAT-exclusive base, the ID type, number and name), the printed document (the discount, the ID and the name), and the daily report (statutory separated from voluntary, and the identity still reconciling). Includes `TAX-005` in a real cart, and a basket discount that may not reach a statutory line by the back door | `TAX-004`, `TAX-005`, `PR-204`, `RPT-101` |
| `TC-INT-98` | `OPS-106`: a stock row with **no unit cost is rejected, never defaulted to zero** — and the rest of the file still reports, because an owner fixing a spreadsheet needs the whole list. A loaded row sets `avg_cost_centavos` to the cost in the cell, to the centavo, and the movement carries it. A cost of `0` loads and **warns**, because a store does receive free samples and it is also what a mis-keyed cell looks like | `OPS-106`, `MON-004`, `INV-106` |
| `TC-INT-99` | `OPS-107`: an opening balance posts as a **credit transaction dated at cutover**, referencing "opening balance", so it is the chronologically first line of the statement and `CR-103`'s derived balance equals it. A customer already keyed in by hand is matched and given their balance rather than refused; a negative balance is refused, naming store credit | `OPS-107`, `CR-103`, `CR-108` |
| `TC-INT-100` | Requirement 7 — the rehearsal. Validate-only answers `200` with the rejected rows, **writes nothing** (asserted as row counts before and after, not as the absence of an error), names every bad row with its line and rule rather than the first, and reports per-file counts the load then matches exactly. A load whose files are bad writes nothing and says so | `OPS-105`, `UOM-001` |
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
| `TC-E2E-20` | The move to a new machine: a store that has received stock, sold for cash, sold on credit and taken a part payment is exported → a second, empty installation validates the archive **writing nothing** → imports it with a backup taken first → and then every ledger is recomputed there and agrees: `INV-101`'s stock, `CR-103`'s balance, `RPT-101`'s day, all reconciling. Every row the archive carried is compared one by one against a fresh export of the imported store, and importing the same archive twice changes nothing |
| `TC-E2E-21` | A cutover from three CSVs — the second store, where hand entry is not a slower option but an impossible one: an empty install is set up and its categories, brands and units created → the three templates are downloaded → the first rehearsal fails the way a first attempt does, naming an unknown unit, a costless stock row and a negative balance each with its line number, and **writing nothing** → the spreadsheet is fixed and rehearses clean, still writing nothing → the load runs after its backup, in one transaction, reporting both reconciliations → **and then the store trades**: the loaded product is scanned by the barcode the CSV carried and sold on credit to a loaded customer, with the gross profit `OPS-106`'s cost makes real → the sale lands on top of the opening balance in order, both ledgers still reconcile, and running the same load again is refused rather than silently doubled |
| `TC-E2E-22` | The money the store owes a customer: a farm buys 10 KG on account → hands over ₱1,000, and the excess is refused until the cashier acknowledges it, then becomes store credit → brings a sack back, and with nothing owing the refund goes to the balance rather than opening the till → then buys again and pays half from the credit and half in notes → a tender past the balance is refused with the figure and moves nothing → and the statement reads down the page: bought, paid, returned, spent, each row carrying the balance it left behind, with `CR-103` reconciling and the worklist keeping the debt and the liability apart |
| `TC-E2E-19` | A stocktake at scale: open a count over 200 products → the shop keeps selling while the aisles are walked → the clerk reaches 170 of them and finds eight wrong → cannot approve their own count, and is refused at the route → a manager approves → posting writes eight movements and touches **nothing else**, neither the 162 that matched nor the 30 nobody reached → the variance report splits shortage from surplus at the frozen cost → and `INV-101`'s ledger reconciles across all 200 |
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
| ~~`TC-INT-88` – `TC-INT-91`~~ | `TASK-022` | **Written** — see §4. Stock counts: the freeze, no movement when matched, self-approval, staleness |
| ~~`TC-INT-92` – `TC-INT-93`, `TC-UT-45` – `TC-UT-49`~~ | `TASK-023`, `TASK-024` | **Written** — see §3 and §4. Discount tiers, category ceilings, non-compounding, and all four precedence levels |
| ~~`TC-INT-94` – `TC-INT-97`~~, ~~`TC-INT-98` – `TC-INT-100`~~ | `TASK-025`, `TASK-026` | **Written** — see §4. Import validation before writing, determinism, collisions; the opening load's costless row, the opening balance on a statement, and the rehearsal that writes nothing |
| ~~`TC-INT-101` – `TC-INT-102`~~, ~~`TC-UT-50` – `TC-UT-51`~~ | `TASK-027` | **Written** — see §3 and §4. Statutory discount: off by default, no compounding, VAT exemption |
| ~~`TC-INT-103` – `TC-INT-106`~~ | `TASK-028` | **Written** — see §4. Store credit: both sources, spending it, reconciliation, never aged overdue |
| ~~`TC-E2E-16`~~ – ~~`TC-E2E-22`~~ | one per task | The journey each task exists for. All seven are written — see §5 |

**Two existing cases were re-pointed rather than replaced, and both are now done.**
`TC-INT-62` forced a `VOIDED` status by hand because no void path existed; **`TASK-021` pointed
it at a real void**, and it asserts the stock came back and `POS-401`'s four columns are on the
row — neither of which the hand-forced status ever did, and both of which it would have gone on
passing without. `TC-UT-31` asserted that two of `PR-101`'s four precedence levels were stubbed;
**`TASK-024` makes it assert that all four resolve**, against real data rather than against an
empty context, because "returns null on an empty call" could not tell a stub from a resolver
that simply declined. A case written against a placeholder must change when the placeholder
does — and noticing that at v1.1 close is cheaper than noticing it in review.

A third was re-pointed unannounced, for the same reason: `TASK-020`'s "a voided sale has nothing
to return against" forced the status the same way, and now drives the real void. Anything that
writes `status = 'VOIDED'` by hand is a fake, and `saleRepository.setStatus` now refuses that
value outright so a new one cannot be written.

## 6.4 v1.2 cases, reserved

The same reservation, for `TASK-029`–`TASK-035`, and for `TASK-042`–`TASK-044`, which were raised
while `TASK-029` was being built. `TC-UT-52` follows `TC-UT-51`; the 90s and the 98–100 band stay
where they are, holding the guards that are not numbered by task.

**Three of those late tasks first took ids this table had already reserved** — `TASK-042` reached
for `TASK-031`'s block, `TASK-043` and `TASK-044` for `TASK-032`'s and `TASK-033`'s `TC-E2E`
numbers — because they were written against the backlog rather than against this table. They were
renumbered into the free range before `TASK-031` was built, which is the moment the collision
would have stopped being a bookkeeping fault and started being two cases with one name. The rule
that catches it is the one already stated above: **an id names one case**, and this table is where
that is decided.

| Range | Task | Subject |
| :--- | :--- | :--- |
| `TC-UT-52` – `TC-UT-54`, `TC-INT-107` – `TC-INT-111` | `TASK-029` | Batches: the three expiry statuses at the boundary, FEFO across two batches, batch cost against moving average, batches reconciling to on-hand, the expired refusal, the near-expiry alert |
| `TC-INT-112` – `TC-INT-113` | `TASK-030` | Recall: per-batch quantities on a line that spanned two, and the voided, returned and walk-in sales that must appear as themselves |
| `TC-UT-55`, `TC-INT-114` – `TC-INT-116` | `TASK-031` | Statements and ageing: the bucket boundaries, the closing balance that must equal the account, one account in two buckets, the invoices a collection settled |
| `TC-INT-117` – `TC-INT-119` | `TASK-032` | Reconciliation: the variance, the tolerance and reason, and that no recorded figure moved |
| `TC-INT-120` – `TC-INT-122` | `TASK-033` | Breakdowns reconciling to the daily report, a slow mover that sold nothing, movement analysis against the on-hand change |
| `TC-INT-123` – `TC-INT-125` | `TASK-034` | Write-off: owner only, the debits that stop ageing, and the collections figures that must not move |
| `TC-E2E-23` – `TC-E2E-28` | one per task | The journey each task exists for. `TASK-035` has none — it ships a decision, not a path |
| `TC-UT-56`, `TC-INT-126` – `TC-INT-128`, `TC-E2E-29` | `TASK-042` | Counting by batch: the sheet's line shape, a variance landing on the batch it was found in, `INV-201` after a posted count, a batch at zero counted up |
| `TC-UI-11`, `TC-E2E-30` | `TASK-043` | `SCR-206`: the batch list with no quantity field, and the alert-to-write-off walk |
| `TC-UI-12`, `TC-E2E-31` | `TASK-044` | `SCR-306`: a list that cannot edit, and finding a receipt again after the next customer has started |
| `TC-UI-13` | `TASK-045` | The three-transition walk, per role, against `04_UX_SPEC.md` §2.1's reach table — and every report one press from the dashboard |
| `TC-PERF-07` | `TASK-033` | The new reports inside `TC-PERF-05`'s budget at `TC-PERF-06`'s scale |
| `TC-PERF-08` – `TC-PERF-09` | `TASK-035` | Encrypted against plain, across the budgets and across backup, verification and restore |

**`TC-INT-120` reconciles to two different anchors, and that was a finding rather than a
choice.** The task asks that category and cashier totals "sum to the daily report's net", and only
one of the two can. A cashier is a property of the **sale**, so summing `total_centavos` by cashier
is net sales exactly; a category is a property of the **line**, and the transaction discount, the
change and the returns all sit on the sale with no honest way to split them between shelves. So the
category breakdown reconciles to `profit.revenue_centavos` — the figure margin is computed from and
the only one that is a sum of lines — and both reports print which anchor they used. A single
assertion against net would have been met by a report that quietly prorated a discount.

**Two cases are expected to be re-pointed, and both are named in their tasks.** `TC-UT-31` asserts
`PR-101`'s four precedence levels resolve; if `TASK-029`'s sale-line decision splits a line across
batches, the price it resolves is unchanged but the line count is not, and the case has to say so.
`TC-INT-62`'s void, re-pointed once already at `TASK-021`, reverses stock — and reversing
batch-tracked stock has to put it back in the batch it came from, which is an assertion that case
does not currently make.

**`TC-PERF-08` and `TC-PERF-09` are reserved but cannot be run here.** §6 says a figure from a
build machine is not a measurement, and `TASK-035` is gated on the reference machine for exactly
that reason. Reserving the ids now keeps them from being taken by something that *can* run.

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

The "not started" rows at the foot are all the same kind of thing and are worth reading
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
| 7 | `FT-209` built, tested and reachable | ☑ **done** (`TASK-022`). `SCR-205` exists; `INV-110`'s freeze is a stored column |
| 8 | `TC-INT-88`–`TC-INT-91`, `TC-E2E-19` green | ☑ green |
| 9 | `FT-306` built, tested and reachable | ☑ **done** (`TASK-023`). Tiers are in the registry; `PR-202` binds on `SCR-301`; the counter holds no copy |
| 10 | `TC-UT-45`–`TC-UT-47`, `TC-INT-92` green | ☑ green |
| 11 | `FT-211`, `FT-212` built, tested and reachable | ☑ **done** (`TASK-024`). All four of `PR-101`'s levels resolve; the bands and the agreed prices have editors |
| 12 | `TC-UT-31`, `TC-UT-48`–`TC-UT-49`, `TC-INT-93` green | ☑ green |
| 13 | `FT-705`, `FT-706` built, tested and reachable | ☑ **done** (`TASK-025`). `SCR-706` exists; the archive opens in Python's `zipfile` |
| 14 | `TC-INT-94`–`TC-INT-97`, `TC-E2E-20` green | ☑ green |
| 15 | `FT-707` built, tested and reachable | ☑ **done** (`TASK-026`). The opening load is on `SCR-706`; the three templates come from the validator's own column list |
| 16 | `TC-UT-100`, `TC-INT-98`–`TC-INT-100`, `TC-E2E-21` green | ☑ green |
| 17 | `FT-309` built, tested and reachable | ☑ **done** (`TASK-027`). Off by default; `F8` on `SCR-301` where an owner has switched it on; the 20% is statute and is not a setting |
| 18 | `TC-UT-50`–`TC-UT-51`, `TC-INT-101`–`TC-INT-102` green | ☑ green |
| 19 | `FT-408` built, tested and reachable | ☑ **done** (`TASK-028`). `STORE_CREDIT` is a tender on `SCR-303`; a customer in credit is never aged as a debtor |
| 20 | `TC-INT-103`–`TC-INT-106`, `TC-E2E-22` green | ☑ green |
| 21 | Purchasing exercised on the store's own supplier data | ☐ **not started.** A delivery keyed by the person who unloads the van is the only test of `SCR-803` that counts |
| 22 | A return taken at the counter on the store's own stock | ☐ **not started.** `POS-304`'s default is the one rule in this release whose value is decided by whether a cashier reads the sentence beside it, and that is not a thing a test can answer |
| 23 | A void taken at the counter, and the drawer counted after it | ☐ **not started.** `TC-E2E-18` proves the arithmetic; what it cannot prove is that a cashier under pressure finds the button and a manager is willing to walk over. `POS-403` is a workflow before it is a rule |
| 24 | A stocktake walked in the store, on the store's own shelves | ☐ **not started.** `TC-E2E-19` proves 200 products. What it cannot prove is that somebody counting an aisle understands that a blank field and a `0` are different answers — which is the one misunderstanding on `SCR-205` that costs real money |
| 25 | A cutover loaded from the store's own spreadsheet | ☐ **not started.** `TC-E2E-21` proves the arithmetic and the refusals. What it cannot prove is that an owner reading `OPS-106`'s refusal goes and finds the cost rather than typing a plausible one — and a plausible cost is indistinguishable from a real one for ever afterwards |
| 26 | A statutory discount granted at the counter, on the store's own goods | ☐ **not started**, and the one row here that is blocked on somebody other than the store. `TC-UT-51` proves the arithmetic and `TC-INT-102` proves the record; what neither can answer is whether an agrivet's goods qualify at all — a question for the store's accountant, which is why `TAX-004` ships off and why turning it on is audited |

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
