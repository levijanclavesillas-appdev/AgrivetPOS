# 06 — Tasks

Work items, closed and open. Each task is self-contained: an implementer should need this file,
plus the specs it cites, and nothing else. **Never "build the POS". Always `TASK-011`.**

**v1.0 is code-complete; v1.1 is under way** — `TASK-019` to `TASK-026` are closed. With
`TASK-024` went the last of `PR-101`'s stubs, so every price the rules describe now resolves; with
`TASK-025` the store's data can leave the machine as something other than an opaque backup, and with
`TASK-026` another store's data can come *in* — a cutover from three spreadsheets rather than eight
hundred products keyed by hand. With them
come both of `POS-107`'s corrections, so a sale can be unsold either way round, and the
stocktake, so the shelf figure can be checked against the shelf.
`TASK-001`–`TASK-018` built it and `TASK-036`–`TASK-041` built the
screens the original backlog never assigned to anybody — see [the screen gap](#the-screen-gap--found-and-closed),
which is worth reading before writing the next backlog. What code-complete does **not** mean is
shippable: nothing has run in the store. [Status](#status) has the detail.

---

## The critical path to v1.0

`TASK-011` is the keystone: it is the sale transaction, and it is the only place where money,
stock, credit and the till meet in one commit. Everything before it exists to make it correct;
everything after it exists to make it usable. Order matters — this sequence is dependency-forced,
not preference.

```text
001 skeleton ──▶ 002 money ──▶ 009 pricing+tax ──┐
      │                                          │
      ├──▶ 003 auth ──▶ 005 audit                ├──▶ 011 SALE ──▶ 015 POS UI ──▶ 018 installer
      ├──▶ 004 setup                             │        │
      ├──▶ 006 catalog ──▶ 007 inventory ────────┤        ├──▶ 014 printing
      ├──▶ 008 customers+credit ─────────────────┘        ├──▶ 012 collections
      └──▶ 010 shift+till ───────────────────────┘        └──▶ 013 close ──▶ 016 reports
                                                                              017 backup
```

The diagram is the original backlog and is kept as it was written, because it was right about
the dependencies. What it does not show is the six screen tasks — `TASK-036`–`TASK-041` — which
hang off the tasks that built their services and were missed precisely because nothing in this
picture said a service needs a screen before anybody can use it.

## Closed — v1.0 "Till"

Every task below is implemented, tested and committed. The commit is the one that closed it.

| ID | Task | Commit | What it left behind |
| :--- | :--- | :--- | :--- |
| [TASK-001](TASK-001-app-skeleton-and-migrations.md) | Application skeleton, layering, migrations, pragmas | `9f1a03e` | `TC-UT-99` layering guard, forward-only runner |
| [TASK-002](TASK-002-money-and-unit-primitives.md) | Money, quantity and unit-conversion primitives | `6bb30d8` | Integer centavos and thousandths everywhere since |
| [TASK-003](TASK-003-auth-rbac-and-recovery.md) | Authentication, RBAC, session, PIN, lockout, recovery | `d668379` | The `TX-*` matrix; `OWN_SHIFT` went unused until `TASK-016` |
| [TASK-004](TASK-004-setup-wizard-and-settings.md) | First-run setup, store profile, tax mode, settings registry | `5d5c8de` | `SCR-001`; `TC-UT-06`, which has caught four constants since |
| [TASK-005](TASK-005-audit-service.md) | Audit service and trail | `4722384` | `assertKnownAction`, which has caught every unregistered action since |
| [TASK-006](TASK-006-catalog.md) | Catalog: categories, brands, units, products, barcodes, packs, prices | `2e3e76d` | Search at 12 ms after a 500× index fix |
| [TASK-007](TASK-007-inventory-ledger.md) | Inventory ledger, on-hand, adjustments, low stock | `c19c314` | `INV-101` derived, never stored |
| [TASK-008](TASK-008-customers-and-credit-accounts.md) | Customers and credit accounts | `975b4bd` | `CR-103` derived; ageing on Manila days |
| [TASK-009](TASK-009-pricing-and-tax-engine.md) | Price resolution and the three-mode tax engine | `05756c2` | Every blocking decision per line, not the first |
| [TASK-010](TASK-010-shift-and-till.md) | Cashier shift, till cash in/out, expected cash | `f32d0bc` | `POS-509` derived from the ledger |
| [TASK-011](TASK-011-the-sale-transaction.md) | **The sale transaction** — `POST /sales` | `c361267` | One transaction; the pack factor resolved server-side |
| [TASK-012](TASK-012-collections.md) | Credit collections and allocation | `dead8e6` | Oldest-first allocation |
| [TASK-013](TASK-013-shift-close-and-variance.md) | Shift close, per-method variance, backup trigger | `2ae68ec` | `CREDIT` reported but not counted against the drawer |
| [TASK-014](TASK-014-escpos-printing-and-drawer.md) | ESC/POS receipt, cash drawer, reprint, collection acknowledgement | `dac24f2` | Driver seams filled; printing never unwinds a sale |
| [TASK-015](TASK-015-pos-user-interface.md) | POS, payment and receipt screens | `c91a78d` | `SCR-301`–`304`; carts in the database, not the renderer |
| [TASK-016](TASK-016-dashboard-and-reports.md) | Dashboard and the v1.0 reports | `4f969b6` | `SCR-601`–`604`; gross profit pulled into v1.0 |
| [TASK-017](TASK-017-backup-restore-health-alerts.md) | Automatic backup, verification, restore, health, alerts | `812a82b` | `SCR-704`, `705`; verified `.zip` backups, restore, `TC-E2E-09` |
| [TASK-018](TASK-018-installer-and-uat.md) | Windows installer, first-run migration, UAT on store hardware | `c08f3af` | NSIS config, `TC-UT-98`, `TC-E2E-08`, handover and UAT sheets |
| [TASK-036](TASK-036-catalogue-screens.md) | Catalogue screens `SCR-201`–`SCR-204` | `cce3c8f` | `TC-E2E-10`, the cutover; on-hand joined into the product search |
| [TASK-038](TASK-038-shift-screens.md) | Shift screens `SCR-501`–`SCR-503` | `c4e0e9d` | `TC-E2E-11`, a counted close; one open path instead of two |
| [TASK-040](TASK-040-user-administration.md) | User administration `SCR-701` | `c9f97cf` | `TC-E2E-12`; an admin password reset now clears a `SEC-3` lockout |
| [TASK-039](TASK-039-settings-screen.md) | Settings screen `SCR-702` | `aa82cc4` | `TC-E2E-13`; `OPS-001` is now enforced wherever the backup folder is set, not only in the wizard |
| [TASK-037](TASK-037-customer-and-credit-screens.md) | Customer and credit screens `SCR-401`–`SCR-403` | `c6e4641` | `TC-E2E-14`; `GET /customers` now serves the enumerations a screen would otherwise copy |
| [TASK-041](TASK-041-audit-viewer.md) | Audit trail viewer `SCR-703` | *this commit* | `TC-E2E-15`, `TC-UI-10` — the guard that keeps the screen gap shut |

## The screen gap — found, and closed

The v1.0 backlog assigned screens to three tasks — `TASK-015` (`SCR-301`–`304`), `TASK-016`
(`SCR-601`–`604`) and `TASK-017` (`SCR-704`, `705`) — and never assigned the rest. It was found
while writing `DEPLOYMENT.md`, which told the installer to open a settings screen that did not
exist. `04_UX_SPEC.md` specifies **26 screens and 13 existed**; every service and API behind the
missing thirteen was built and tested, which is precisely why nothing caught it — the suite was
green because the suite tested the API.

All six are now closed, and `TC-UI-10` asserts the whole of §3 has a view, so it cannot open
again quietly.

| ID | Task | Screens | Commit |
| :--- | :--- | :--- | :--- |
| [TASK-036](TASK-036-catalogue-screens.md) | Catalogue | `SCR-201`–`SCR-204` | `cce3c8f` |
| [TASK-038](TASK-038-shift-screens.md) | Shift | `SCR-501`–`SCR-503` | `c4e0e9d` |
| [TASK-040](TASK-040-user-administration.md) | User administration | `SCR-701` | `c9f97cf` |
| [TASK-039](TASK-039-settings-screen.md) | Settings | `SCR-702` | `aa82cc4` |
| [TASK-037](TASK-037-customer-and-credit-screens.md) | Customers and credit | `SCR-401`–`SCR-403` | `c6e4641` |
| [TASK-041](TASK-041-audit-viewer.md) | Audit trail viewer | `SCR-703` | *this commit* |

## Closed — v1.1 "Supply"

| ID | Task | Commit | What it left behind |
| :--- | :--- | :--- | :--- |
| [TASK-019](TASK-019-suppliers-and-purchasing.md) | Suppliers, purchase orders, goods receipt | `372b2ba` | `010_purchasing.sql`; `supplierService`, `purchaseOrderService`, `goodsReceiptService` and their repositories; `SCR-801`–`SCR-804`; `TC-INT-76`–`TC-INT-80`, `TC-E2E-16`. The v1.1 gate in `07_TEST_PLAN.md` §10 |
| [TASK-020](TASK-020-sales-returns.md) | Sales returns with the restock/write-off decision | `3ea6fd1` | `011_returns.sql`; `returnService` and its repository; `SCR-305`; `TC-INT-81`–`TC-INT-84`, `TC-E2E-17`. `RPT-101`'s fourth term stopped being zero |
| [TASK-021](TASK-021-sale-voiding.md) | Sale voiding with full reversal | `5cc8370` | No schema — `006_sales.sql`'s four unused columns finally used. `voidService`; the void on `SCR-304`; `POS-404`'s void report; `TC-INT-85`–`TC-INT-87`, `TC-E2E-18`, and `TC-INT-62` re-pointed at a real void |
| [TASK-022](TASK-022-stock-counting.md) | Stock counting with frozen expected quantities | `b5b34a3` | `012_stock_counts.sql`; `stockCountService` and its repository; `SCR-205`; `TC-INT-88`–`TC-INT-91`, `TC-E2E-19`. The `INV-` prefix joined the audit guard's rule pattern |
| [TASK-023](TASK-023-discount-rules-engine.md) | Discount rules engine and category ceilings | `c9ad009` | No schema — `categories.max_discount_bp` finally read. `discountRuleService`; `PR-106` tiers in the registry; `TC-UT-45`–`TC-UT-47`, `TC-INT-92`. `settingsService`'s JSON coercion learned structured entries |
| [TASK-024](TASK-024-customer-and-quantity-pricing.md) | Customer-specific and quantity-break pricing | `52d7fe9` | `013_negotiated_pricing.sql`; `PR-101`'s top two levels, stubbed since `TASK-009`, now resolve; band and agreed-price editors; `TC-UT-48`–`TC-UT-49`, `TC-INT-93`, and `TC-UT-31` updated |
| [TASK-025](TASK-025-json-export-and-import.md) | JSON export and validated import | `9e134b0` | No schema. `exportService`, `importService`, `dataRepository`; `zip.js` grew multi-entry; `SCR-706`; `TC-INT-94`–`TC-INT-97`, `TC-E2E-20`. `api.saveAs` extracted from two screens that had each rolled their own |
| [TASK-026](TASK-026-opening-data-load.md) | Opening-data load from CSV | `f254088` | No schema. `openingDataService`; `config/csv.js` — the RFC 4180 **reader**, with `reportService`'s writer moved into it so both halves are one understanding of the format; the opening load on `SCR-706`; `TC-UT-100`, `TC-INT-98`–`TC-INT-100`, `TC-E2E-21`. `productService.create` and `customerService.create` split into `createWithin` so a whole cutover fits in one transaction |

**The answer to its opening question was "yes, build the full lifecycle."** The store does raise
orders, so `PO-101`–`PO-105` are built rather than deferred behind the receipt.

**What `TASK-019` also fixed, found by the browser smoke.** Switching screens while the previous one had
a fetch in flight left the *new* screen blank: the old view's reply landed after the switch and
cleared the shared `main` element from under it. Each screen now gets its own host element
(`shell/app.js`), so a late render writes into a node that is no longer in the document. It
predates this task — the products and customers lists could both do it — and nothing before this
walk switched screens fast enough to see it.

**What `TASK-020` found, and it is the kind of thing only a walk finds.** `POS-306` says a
return against a credit sale "never pays out cash while a balance remains", and the first
implementation read that as *no cash while the customer owes anything*. `TC-E2E-17` walked a
farm that owed ₱900 on one sale and returned ₱2,920 of goods off a **cash** sale, and the
refund was held as store credit — which is confiscating a refund to settle an unrelated debt.
The rule is scoped to a return against a credit sale, `POS-305` says a refund follows the means
it was tendered by, and both readings are now asserted so the wider one cannot come back.

**And what the smoke itself needed.** The catalogue walk opened "the first row of the product
list" and asserted its pack conversion. `TASK-020` seeded a second product so `SCR-305` would
have a batch-tracked line to default to write-off, the first row became the other product, and
two assertions started checking a product they were never about. The walk now finds its fixture
by name — a harness that reads its fixture by position is a harness that fails for a reason
nobody can see.

**What `TASK-021` found, and only a browser could.** `SCR-304`'s void submit computes its
`disabled` state when the panel is built. The reason field updated the variable and nothing
re-evaluated it, so the button stayed dead however much the cashier typed — a screen on which
the feature simply could not be used. Every unit guard passed: they asserted the *expression*,
which was correct, and never that anything re-ran it. The guard now asserts both, and the fix is
the same targeted refresh `SCR-803` and `SCR-305` already use to avoid moving the cursor.

**What `TASK-025` got wrong first, and it is the interesting one.** `OPS-104`'s collision check
looked at `id` — which is a UUID, so two stores set up independently *never* collide on one. They
collide constantly on `users.username`, `categories.name` and `products.sku`, because those are
what a person types. The rule reported "no collisions" and the import then failed on a constraint
halfway through: not working, wearing the clothes of a database error. Collisions are now
detected on every unique key SQLite declares.

**What `TASK-024` found: `TC-UT-31` would have gone on passing against stubs.** The case
asserted `step.resolve({}) === null` for the two unbuilt levels — which a *real* resolver also
satisfies when handed an empty context. Inverting the assertion was not enough; it now walks the
chain with real data at each of the four levels. A placeholder test is only as good as the thing
that distinguishes the placeholder.

**What `TASK-023` decided that its rule did not settle: what "on the same line" means.**
`PR-206` names a per-line rule and a per-transaction one together and says neither compounds with
a manual discount "on the same line" — which cannot be read literally for the transaction one.
The engine compares like with like at each level: a quantity break against a manual line
discount, and a tier against a manual transaction discount. This task's own acceptance criteria
settle it — "nothing compounds a line below cost **without `PR-105` catching it**" only makes
sense if cross-level compounding is still possible and `PR-105` is the guard.

**What `TASK-022` decided that its brief did not settle: a blank is not a zero.** An uncounted
line writes nothing; a line counted as `0` writes the whole quantity off. Neither the rules nor
the task file says which a missing figure is, and the wrong answer writes off the entire
unreached remainder of a shop the moment somebody posts a half-finished count. The column is
nullable with no default, `INV-111` is read as "per **counted** product that varies", and the
sheet renders the two differently so nobody has to remember which is which.

**And the two refusals `TASK-021` added that its brief did not name.** A sale with goods already
returned is not voided, because a void says the sale never happened and part of it demonstrably
did; and a credit sale a collection has been allocated against is not voided either, because
unpicking it would make money the customer actually paid disappear. Both name the return. The
`sales.approved_by` column turned out not to be the void's approver — it records who released a
discount at the time of *sale* — so the void report reads `AUD-603`'s own audit row instead.

## Open — v1.1 "Supply"

Written at v1.0 close, as planned. Ordered by dependency, not by number: `TASK-023` before
`TASK-024` because the second slots into the precedence the first defines — which it did:
`pricingService.automaticLineDiscount` was the seam `TASK-023` left, and `TASK-024` filled it
without changing its shape, though a break turned out to be a price *and* a discount rather than
only the latter. And `TASK-025` before `TASK-026` because the opening load reuses its validation
pass rather than growing a second one — which it did, taking the *shape* (a complete pass that
writes nothing, then a write that revalidates) rather than the archive checks, which mean nothing
about a spreadsheet. `TASK-020` came before `TASK-028` for the same kind of reason and has now landed —
a return is the other thing that creates store credit, and `CR-108`'s negative balance is
already written and tested by it.

| ID | Task | Feature | Depends on |
| :--- | :--- | :--- | :--- |
| [TASK-027](TASK-027-statutory-discount.md) | Senior citizen / PWD statutory discount | `FT-309` | — |
| [TASK-028](TASK-028-store-credit.md) | Store credit balances | `FT-408` | `TASK-020` |

One of them still carries a question that must be answered before the work starts, in the same
shape `TASK-016` and `TASK-018` used: `TASK-027` asks whether the store is required to grant the
statutory discount — a question for the store's accountant, which is why `TAX-004` ships it off
by default. (`TASK-019`'s was answered: the store does raise purchase orders, so the full
lifecycle was built.)

Four fill things v1.0 deliberately left stubbed rather than absent: `PR-101`'s top two
precedence levels (`TASK-024`), `RPT-101`'s `returns` term (`TASK-020`), `sales.voided_at` and
its siblings (`TASK-021`), and `sale_tenders`' `STORE_CREDIT` method (`TASK-028`). Each was
built with the seam in place, and each task's job is to fill it rather than to reshape anything.

## Open — v1.2 "Trace"

| ID | Task | Feature |
| :--- | :--- | :--- |
| `TASK-029` | Batches, expiry status, FEFO allocation | `FT-205` |
| `TASK-030` | Recall by batch | `INV-206` |
| `TASK-031` | Customer statements and ageing buckets | `FT-406`, `FT-407` |
| `TASK-032` | Payment reconciliation | `FT-606` |
| `TASK-033` | Profitability, fast/slow movers, movement analysis | `FT-602`, `FT-605` |
| `TASK-034` | Bad-debt write-off | `FT-409` |
| `TASK-035` | Evaluate SQLCipher encryption against POS latency | `SEC-9` |

<a id="status"></a>
## Status — 2026-09-08

**What is built.** 23,300 lines across 127 source files — 9 migrations, 28 renderer modules,
no build step and four runtime dependencies — against 17,900 lines of tests and harnesses.

`npm run test:all` is green: **750 cases** across 48 files — 195 unit, 437 integration and API,
118 end-to-end. Beside it, 4 performance files and two harnesses that are deliberately outside
the gate because they need things a gate machine may not have: `tools/browser-smoke` drives the
real renderer in Chromium through nineteen screens, and `tools/installer/check.sh` compiles the
NSIS macros with `makensis`.

Every v1.0 service, repository, API route, business rule **and screen** is implemented and
tested. `TC-UT-98` asserts the rule-coverage obligation mechanically — 62 covered v1.0 rules,
all cited by a test, and 51 of 51 outside the obligation as well — and `TC-UI-10` asserts every
screen in `04_UX_SPEC.md` §3 has a view.

**What that means at a counter.** A store can be installed, configured, stocked and staffed from
the application. A cashier can open a drawer, sell, take a split tender, park a cart, print a
receipt, move cash in and out, count the drawer and close it against a verified backup. A credit
customer can be created, given a limit, sold to on account and paid off with the oldest invoice
settled first. The owner can read who did all of it.

**Where the release gate stands.** `07_TEST_PLAN.md` §10 carries the per-criterion outcome:
**four of eleven met, four partly, three not started.** Every one of the seven that is not met
reduces to the same fact — **nothing has run in the store.** No receipt has been printed on
paper, no drawer has opened, no scanner has been used, no backup has been restored onto a second
machine, and every performance figure was measured on a build machine, which §6 says plainly is
not a measurement at all.

Two of the seven are half-proved rather than unproved, and the distinction matters:
`TC-E2E-08` shows the application reaches for no network but not that the machine has none, and
`TC-E2E-09` shows a killed process loses nothing but `SIGKILL` does not empty the write cache a
power cut does. Both have a UAT check waiting for them.

**Nothing further can be settled from a build machine.** The next step is a visit:
`npm run build:exe` on Windows with a signing certificate, then `docs/UAT_RECORD.md` at the
store's own counter.

**The two open business questions are answered.** `Q-1`: the store is **not BIR-registered**, so
`tax_mode` is `NONE` at install. `Q-4`: the product list is small enough to key in by hand, so
`TASK-026` stayed in v1.1 — and `TASK-036` built the screens that hand entry needs. **`TASK-026` has
since been built anyway**, which changes nothing about the first store: it is there for the second,
whose SKU count makes hand entry impractical, and its own note said to decide that before the
installer ships rather than on cutover day.

`Q-2` (cold-chain veterinary stock) and `Q-3` (delivery charges) remain open and affect only
v1.2 scope.

**One thing that is deliberately not software.** The off-machine backup copy in
`05_TECH_SPEC.md` §7 is a **process control handed to the owner**, not something the application
does. It is stated as such in `HANDOVER.md` §2 rather than quietly assumed, and the store is
told in those words that backups on the shop PC do not survive the shop PC.

---

## Task file format

```
Header line            Priority · Blocks release? · Requirement and rule IDs
Objective              One sentence: what changes and why it matters.
Context                Where this sits, what exists already, why it is open.
Requirements           Numbered, testable statements of what must be true when done.
Business Rules         The rule IDs this must honour, from 03_BUSINESS_RULES.
Technical Requirements Files, schema, endpoints, constraints.
Acceptance Criteria    Observable outcomes a reviewer can check.
Tests                  The TC-* cases that must exist and pass.
```

Template: `/root/AdWebsite/docs/templates/TASK.template.md`. **Task IDs are permanent and never
reused** — a closed `TASK-014` stays `TASK-014`.

---

*Chachi's Software Development Service · DTI BN 8089738 · BIR OCN 111RC20260000002455 · TIN 752-951-092-00000*
