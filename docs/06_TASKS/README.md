# 06 — Tasks

Work items, closed and open. Each task is self-contained: an implementer should need this file,
plus the specs it cites, and nothing else. **Never "build the POS". Always `TASK-011`.**

**v1.0 is code-complete; v1.1 is complete** — `TASK-019` to `TASK-028` are closed. With
`TASK-024` went the last of `PR-101`'s stubs, so every price the rules describe now resolves; with
`TASK-025` the store's data can leave the machine as something other than an opaque backup, and with
`TASK-026` another store's data can come *in* — a cutover from three spreadsheets rather than eight
hundred products keyed by hand. With them
come both of `POS-107`'s corrections, so a sale can be unsold either way round, and the
stocktake, so the shelf figure can be checked against the shelf. With `TASK-027` the store can
grant the senior citizen and PWD discount correctly on the day it is asked for one — and grants it
to nobody until an owner switches it on, which is the only honest thing to do with a question
belonging to the store's accountant. With `TASK-028` a balance may be money the store owes the
customer, and they may spend it — which is the difference between a figure on a screen and a
feature.
`TASK-001`–`TASK-018` built it and `TASK-036`–`TASK-041` built the
screens the original backlog never assigned to anybody — see [the screen gap](#the-screen-gap--found-and-closed),
which is worth reading before writing the next backlog. What code-complete does **not** mean is
shippable: nothing has run in the store. [Status](#status) has the detail.

**The v1.2 backlog is now written** — `TASK-029` to `TASK-035`, plus `TASK-042` and `TASK-043`
raised while `TASK-029` was built, nine files, of which seven are in. See
[Open — v1.2 "Trace"](#open--v12-trace). Writing it is not the same as starting it: the next
thing that moves this product is a Windows build and a visit to the counter, not another task.

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
| [TASK-019](TASK-019-suppliers-and-purchasing.md) | Suppliers, purchase orders, goods receipt | `2938348` | `010_purchasing.sql`; `supplierService`, `purchaseOrderService`, `goodsReceiptService` and their repositories; `SCR-801`–`SCR-804`; `TC-INT-76`–`TC-INT-80`, `TC-E2E-16`. The v1.1 gate in `07_TEST_PLAN.md` §10 |
| [TASK-020](TASK-020-sales-returns.md) | Sales returns with the restock/write-off decision | `7069805` | `011_returns.sql`; `returnService` and its repository; `SCR-305`; `TC-INT-81`–`TC-INT-84`, `TC-E2E-17`. `RPT-101`'s fourth term stopped being zero |
| [TASK-021](TASK-021-sale-voiding.md) | Sale voiding with full reversal | `c0b2e95` | No schema — `006_sales.sql`'s four unused columns finally used. `voidService`; the void on `SCR-304`; `POS-404`'s void report; `TC-INT-85`–`TC-INT-87`, `TC-E2E-18`, and `TC-INT-62` re-pointed at a real void |
| [TASK-022](TASK-022-stock-counting.md) | Stock counting with frozen expected quantities | `f11c716` | `012_stock_counts.sql`; `stockCountService` and its repository; `SCR-205`; `TC-INT-88`–`TC-INT-91`, `TC-E2E-19`. The `INV-` prefix joined the audit guard's rule pattern |
| [TASK-023](TASK-023-discount-rules-engine.md) | Discount rules engine and category ceilings | `14c68cf` | No schema — `categories.max_discount_bp` finally read. `discountRuleService`; `PR-106` tiers in the registry; `TC-UT-45`–`TC-UT-47`, `TC-INT-92`. `settingsService`'s JSON coercion learned structured entries |
| [TASK-024](TASK-024-customer-and-quantity-pricing.md) | Customer-specific and quantity-break pricing | `c2f6ff3` | `013_negotiated_pricing.sql`; `PR-101`'s top two levels, stubbed since `TASK-009`, now resolve; band and agreed-price editors; `TC-UT-48`–`TC-UT-49`, `TC-INT-93`, and `TC-UT-31` updated |
| [TASK-025](TASK-025-json-export-and-import.md) | JSON export and validated import | `2cba5a1` | No schema. `exportService`, `importService`, `dataRepository`; `zip.js` grew multi-entry; `SCR-706`; `TC-INT-94`–`TC-INT-97`, `TC-E2E-20`. `api.saveAs` extracted from two screens that had each rolled their own |
| [TASK-026](TASK-026-opening-data-load.md) | Opening-data load from CSV | `b68deb1` | No schema. `openingDataService`; `config/csv.js` — the RFC 4180 **reader**, with `reportService`'s writer moved into it so both halves are one understanding of the format; the opening load on `SCR-706`; `TC-UT-100`, `TC-INT-98`–`TC-INT-100`, `TC-E2E-21`. `productService.create` and `customerService.create` split into `createWithin` so a whole cutover fits in one transaction |
| [TASK-027](TASK-027-statutory-discount.md) | Senior citizen and PWD statutory discount | `330ab28` | No schema — `sales.statutory_discount_centavos`, `sale_discounts`' three ID columns and `products.statutory_discount_eligible`, carried unused since `TASK-011`, all finally written. `taxService.statutoryLine` and `chooseStatutory`; `statutory_discount_enabled` (off, owner-only); `F8` on `SCR-301`; `TC-UT-50`–`TC-UT-51`, `TC-INT-101`–`TC-INT-102`. And `POS-207`'s day window, which had been eight hours out since `TASK-011` |
| [TASK-028](TASK-028-store-credit.md) | Store credit balances | `0e49805` | No schema — `sale_tenders`' `STORE_CREDIT` method, unissued since `TASK-011`, finally issued. `creditService.spendStoreCredit`, `allocateToDebits` and `allocateToDebit`; `creditRepository.openCredits`; the tender on `SCR-303`; `TC-INT-103`–`TC-INT-106`, `TC-E2E-22`. And `CR-203`'s allocation applied to a **return** credit, which had never had it |

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

**What `TASK-027` decided that `TAX-005` did not settle, and it is the one to read.** In `VAT`
mode the entitlement is *two* things — the line becomes exempt **and** 20% comes off — and the rule
says only that the statutory and voluntary discounts do not compound, "the larger, not the sum".
Read as one figure, a 6% clearance discount would beat the statutory treatment and thereby cancel a
beneficiary's **VAT exemption**, which is not the store's to withhold. So the exemption stands
whichever discount wins and only the 20% is in the scale. The same question has a second half
nobody would think to ask: `PR-106`'s basket tier is apportioned across lines, so a statutory line
taking its share would have received 20% *and* a slice of the band — the 25% `TAX-005` exists to
forbid, arriving by the back door. A line under the entitlement therefore neither earns the tier nor
takes a share of it.

**And what `TASK-027` found, which only the clock could have shown.** `POS-207`'s duplicate-
reference check built its "that day" window as the Manila date at **UTC** midnight — the Manila day
slid eight hours late. Between midnight and 08:00 Manila the window began in the future, the check
found nothing, and a double-keyed GCash reference went through unremarked: on a store that opens at
seven, the first hour of every day. `TC-INT-38` had been asserting it since `TASK-011` and fails
only when the suite is run in those hours, which is how it survived every green run in this
project's history — this task happened to be worked at 23:20 UTC. `auditService` had done the same
conversion correctly since `TASK-005`; the defect was a *second* implementation of one idea, and the
fix was to delete it rather than to correct it.

## The last two of v1.1, and the questions they carried

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

**Nothing is open.** Both remaining tasks landed together, and the table that held them is kept
below as the record of what they were and what each depended on.

| ID | Task | Feature | Depends on | Closed |
| :--- | :--- | :--- | :--- | :--- |
| [TASK-027](TASK-027-statutory-discount.md) | Senior citizen / PWD statutory discount | `FT-309` | — | ✓ |
| [TASK-028](TASK-028-store-credit.md) | Store credit balances | `FT-408` | `TASK-020` | ✓ |

`TASK-027` carried a question that had to be answered before the work started, in the same shape
`TASK-016` and `TASK-018` used: whether the store is required to grant the statutory discount — a
question for the store's accountant. **It was not answered, and the task landed anyway**, which is
worth recording as a pattern rather than as an exception: the question governs whether the store
*switches it on*, not whether the code is correct, and `TAX-004` had already decided that by
shipping it off. A task blocked on an answer nobody at a keyboard can give is only really blocked
where the answer would change the code. (`TASK-019`'s was answered the other way: the store does
raise purchase orders, so the full lifecycle was built.)

Four filled things v1.0 deliberately left stubbed rather than absent: `PR-101`'s top two
precedence levels (`TASK-024`), `RPT-101`'s `returns` term (`TASK-020`), `sales.voided_at` and
its siblings (`TASK-021`), and `sale_tenders`' `STORE_CREDIT` method (`TASK-028`). Each was
built with the seam in place, and each task's job was to fill it rather than to reshape anything.
**All four are filled, and none of them needed a migration** — which is the whole of what leaving a
seam is for.
`TASK-027` was a fifth of the same kind and is now filled: `sales.statutory_discount_centavos`,
`sale_discounts`' three ID columns and `products.statutory_discount_eligible` have carried nothing
since `TASK-011` precisely so that granting the discount would be a settings change and not a
migration — and it was.

**What `TASK-028` found, and it was pointing the wrong way round.** `CR-107` ages an account from
its **unsettled debits**, and `credit_allocations` is what marks a debit settled. Collections have
allocated since `TASK-012`; **return credits never did**. So a farm whose ₱600 credit sale was
returned in full carried a balance of nothing and an open ₱600 invoice at the same time — `PAID` by
the balance and `OVERDUE` by the ageing, and it is the ageing that reaches the collections worklist
and the dashboard's overdue count. The store would have chased a customer for money it had itself
given back. It was found by requirement 6, which asks that a credit balance never be *rendered* as a
debt; the fix is not in the rendering. A credit settles the debits it covers, whichever kind of
credit it is — so `allocate` moved out of `collectionService` into `creditService`, where the ledger
is, and both callers use it.

**And what only the browser could find, again.** `TASK-028`'s walk waited for the receipt preview
on `SCR-304` and never saw it. `04_UX_SPEC.md` §5's loading state **clears the element it is given**,
and the receipt handed it the sheet the paper lives in — so the `<pre>` was detached, the document
then arrived and was written into a node no longer in the page, and the preview stayed a grey
skeleton. It had done that since `TASK-015`. Every assertion anybody had written read `.screen`,
where the sale number and the total are, so a walk through the receipt screen passed while the
receipt itself was never on it: a cashier's only way to read what had printed was to press Reprint,
which stamps REPRINT on it (`POS-208`). The guard now waits for the paper, and the error state goes
into the sheet rather than over the whole screen.

**And what `TASK-028` decided that `CR-108` did not settle: which row spends it.** The schema names
six transaction types and the task forbids a migration, so a store-credit spend is a `CREDIT_SALE`
carrying `method = 'STORE_CREDIT'` — which turned out to be the honest reading rather than a
workaround. The account *is* debited for the goods and the credit held *is* what covers it, so the
statement reads `RETURN_CREDIT −₱300` then `CREDIT_SALE +₱300` and the balance walks back to zero in
front of whoever is reading it. What stops that debit looking like a debt is the allocation written
beside it, in the same transaction, by the same allocator running the other way: it is settled the
instant it exists, so it has no due date and nothing to age.

## Closed — v1.2 "Trace", so far

| ID | Task | Commit | What it left behind |
| :--- | :--- | :--- | :--- |
| [TASK-029](TASK-029-batches-and-fefo.md) | Batches, expiry status, FEFO allocation | `74a29ab` | `014_batches.sql` — `product_batches`, `sale_item_batches`, `inventory_movements.batch_id`; `batchService` and `batchRepository`; FEFO inside the sale transaction; `MON-004`'s second costing path; `OPS-007`'s two expiry alerts; `GET /products/:id/batches`, `POST /batches/:id/expire`; the opening load's batch columns; `TC-UT-52`–`54`, `TC-INT-107`–`111`, `TC-E2E-23`. And `INV-201` joined `/inventory/reconciliation`, so one page answers whether the ledger is telling the truth |
| [TASK-042](TASK-042-count-by-batch.md) | Counting batch-tracked stock, by batch | *this commit* | `015_count_by_batch.sql` — `stock_count_lines.batch_id`, and the only table rebuild in this schema's history; the sheet's line per batch, with the product's own totals computed server-side; `TC-UT-56`, `TC-INT-126`–`116`, `TC-E2E-29`. It removed the exclusion `TASK-029` added, along with the two tests that pinned it — the count sheet has one way of treating batch-tracked stock again |
| [TASK-033](TASK-033-sales-analysis.md) | Category, cashier, movers and movement analysis | *this commit* | `017_analysis_indexes.sql` — one index, on the ledger's date, because movement analysis was the only one of the five with no access path at all. `reportService.byCategory`/`byCashier`/`byProduct`/`movers`/`movements` and five repository queries; `SCR-607`'s four tabs and `SCR-608` behind `TX-422`; CSV on all five; `TC-INT-120`–`122`, `TC-E2E-27`, `TC-PERF-07`. It found that requirement 1 could only be half true — a category cannot carry a transaction discount — so the two breakdowns reconcile to two anchors and each prints which |
| [TASK-032](TASK-032-payment-reconciliation.md) | Payment reconciliation | *this commit* | `016_reconciliation.sql` — one table, and **no column on `sale_tenders`**, which is `RPT-105`'s prohibition as schema. `reconciliationService`; `GET /reports/reconciliation` and its drill-down; `GET`/`POST /reconciliations`; `SCR-606`; a settlement tolerance of its own; `TC-INT-117`–`119`, `TC-E2E-26`. Both the integration and the e2e case snapshot every sale and tender and assert byte-identity afterwards |
| [TASK-034](TASK-034-bad-debt-write-off.md) | Bad-debt write-off | `24065f6` | No schema — `WRITE_OFF` had been in `txn_type`'s `CHECK` since `TASK-008` with nothing writing one. `creditService.writeOff` (the allocator's third caller) and `writeOffReport`; `POST /customers/:id/write-off`, `GET /reports/write-offs`; the owner-only control on `SCR-402`; `TC-INT-123`–`125`, `TC-E2E-28`. `CR-303`'s separation was already true by construction, and `TC-INT-125` now holds it there |
| [TASK-031](TASK-031-statements-and-ageing.md) | Customer statements and ageing buckets | `f91ec53` | No schema. `creditService.statement`, `ageingReport` and their CSVs; `printService.renderStatement`; `GET /customers/:id/statement` and `/reports/ageing`; `SCR-404` and `SCR-605`; `TC-UT-55`, `TC-INT-114`–`116`, `TC-E2E-25`. It found that the rule's own reconciliation was not true as written — ageing sums debts gross and a balance nets them — and reconciles against the arithmetic that is |
| [TASK-030](TASK-030-recall-by-batch.md) | Recall by batch | `744a0e0` | No schema, which was `TASK-029`'s own test of its sale-line decision. `batchService.recallFor` and `recallCsv`; `GET /batches/:id/recall` and its CSV; `SCR-207`, one step from any batch; `TC-INT-112`, `TC-INT-113`, `TC-E2E-24`. It also fixed a test that failed every evening after 21:00 Manila, having quietly assumed office hours |
| [TASK-044](TASK-044-shift-receipts.md) | `SCR-306`, this shift's receipts | `4eff796` | `public/js/receipt/list.js`; the rail item and `SCR-306` in `04_UX_SPEC.md` §3; a way back on `SCR-304` where it was opened from a list; `TC-UI-12` and `TC-E2E-31`. It found nothing wrong with the void or the reprint — both worked, and neither could be reached once the next customer had started |
| [TASK-043](TASK-043-batch-screen.md) | `SCR-206`, the batch list and the write-off | `044fb57` | `public/js/catalogue/batches.js`; `SCR-206` in `04_UX_SPEC.md` §3; the row action on `SCR-201` and the action on `SCR-601`'s expiry alerts; `TC-UI-11` and the browser smoke's fourteen. It also found that the smoke had been seeding its batch-tracked medicine with a bare adjustment `INV-201` refuses — the fixture had silently held no stock since `TASK-029` |

**What `TASK-029` handed on, and what came back.** Two tasks that were not in the backlog when it
started — `TASK-042`, because a product-level stock count has no batch to name and inventing one
would produce a balance that reconciles perfectly and is wrong; and `TASK-043`, because the API
and the alert shipped without anywhere to act on them. Both are now in, and the exclusion
`TASK-029` left behind is gone with them.

## Open — v1.2 "Trace"

**The files are written, and eight of the nine are built.** All nine are in the established format,
each self-contained enough that an implementer needs it plus the specs it cites and nothing else. Every one of the ten v1.2
rules in `03_BUSINESS_RULES.md` is claimed by exactly one task, checked mechanically rather than
by eye, and `07_TEST_PLAN.md` §6.4 reserves the case ids so no two tasks reach for the same
number.

**In dependency order, which is not numeric order.** The batch arc is closed: `TASK-029` laid the
substrate, `TASK-043` gave it a screen, `TASK-042` made it countable and `TASK-030` made it
recallable — and none of the four needed a column the first had not already written. What is left
depends on nothing in v1.2 except each other. `TASK-031` before `TASK-034`, because a
write-off has to land on a statement and it is cheaper to have the statement first. `TASK-032`,
`TASK-033` and `TASK-035` depended on nothing in v1.2 and could be taken in any order; the first
two are in. `TASK-035` should not be started at all until the store visit, for the reason its own
first section gives.

| ID | Task | Feature | Depends on |
| :--- | :--- | :--- | :--- |
| [TASK-035](TASK-035-evaluate-sqlcipher.md) | Evaluate SQLCipher encryption against POS latency | `SEC-9` | the store visit |

**Three carry a question that has to be answered before the code is written.** `TASK-029` needs
`Q-2` from the brief — which of the store's goods are batch-tracked, and whether it holds anything
cold-chain — because `is_batch_tracked` decides how a product is costed, whether a sale has to
choose stock and whether a return defaults to write-off. It also needs `INV-205`'s own deferral
answered: the rule permits an owner override on selling expired stock "only where the store's own
policy allows it", and if the answer is no, the override is not built, because a switch nobody may
use is a switch somebody will. `TASK-035` needs the reference machine, which is not a question but
a visit.

**Four fill seams v1.0 and v1.1 left deliberately, and this is the pattern by now.**
`products.is_batch_tracked` has been read by exactly one thing since `TASK-006`;
`goods_receipt_lines.batch_no` and `expiry_date` were added nullable by `TASK-019` with a comment
saying they exist so batch receiving would be a service change rather than a migration;
`sale_items.batch_id` has been written `null` on every line ever sold since `TASK-011`; and
`WRITE_OFF` has been in `customer_credit_transactions.txn_type`'s `CHECK` since `TASK-008` with
nothing able to write one. `CR-103` already names write-offs in the list of things the balance
derives from, so the arithmetic is correct for a transaction that has never occurred.

**Two of the seven are where the money can quietly go wrong, and both are called out in their
files rather than left to review.** `TASK-029` has to keep `INV-201`'s batch quantities and
`INV-101`'s derived on-hand from disagreeing — the safe reading is that they are the same sum
against the same ledger, one column finer, rather than a stored counter maintained beside it. And
`TASK-034` has to keep a write-off out of every collections figure (`CR-303`), or the store's
collection performance improves every time it gives up on a debt.

**The screen-gap lesson is applied.** Each task names the `SCR-` id it needs in its technical
requirements — `SCR-206`, `SCR-207`, `SCR-404`, `SCR-605`, `SCR-606` — rather than assuming
somebody will notice. None of them is added to `04_UX_SPEC.md` §3 yet, on purpose: `TC-UI-10`
reads that section and requires a view for every screen in it, so a screen enters the spec in the
commit that builds it and the guard stays green in between.

<a id="status"></a>
## Status — 2026-09-10

**What is built.** 25,500 lines across 102 server files — 13 migrations — and 9,800 lines across
35 renderer modules, with no build step and four runtime dependencies, against 27,700 lines of
tests and harnesses.

*(The figures above were written once at v1.0 close and not recomputed until now, so they had
drifted by seven tasks. They are counted as: `src/**/*.js` outside `src/tests`, then `public/js`,
then `src/tests` plus `tools`.)*

`npm run test:all` is green: **991 cases** across 65 files — 258 unit, 556 integration and API,
177 end-to-end. Beside it, 4 performance files and two harnesses that are deliberately outside
the gate because they need things a gate machine may not have: `tools/browser-smoke` drives the
real renderer in Chromium through nineteen screens, and `tools/installer/check.sh` compiles the
NSIS macros with `makensis`.

Every v1.0 **and v1.1** service, repository, API route, business rule and screen is implemented
and tested. `TC-UT-98` asserts the rule-coverage obligation mechanically — 62 covered v1.0 rules and
28 built v1.1 rules, all cited by a test, and 51 of 51 outside the obligation as well — and
`TC-UI-10` asserts every screen in `04_UX_SPEC.md` §3 has a view.

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

**v1.1 is closed.** `TASK-019` to `TASK-028` are all in, and `07_TEST_PLAN.md` §10's v1.1 gate
reads twenty of twenty-six: every criterion that a machine can answer is met, and the six that are
not are the six that need a counter, a customer and a store — purchasing on the store's own
supplier data, a return, a void, a stocktake, a cutover, and a statutory discount actually granted.

**One question is deliberately still open, and the software is finished around it.** `TASK-027`
asks whether an agrivet's goods carry the senior citizen and PWD entitlement at all. Nobody at a
keyboard can answer that — it is the store's accountant's — so the discount is built, tested and
**off**, a claim made while it is off is refused rather than quietly priced at nothing, and the
switch records who turned it on and when. The `07_TEST_PLAN.md` §10 row for it says "not started"
and will until somebody grants one at the counter.

**The two open business questions from the brief are answered.** `Q-1`: the store is **not BIR-registered**, so
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
