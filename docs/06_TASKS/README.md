# 06 — Tasks

Open work items. Each task is self-contained: an implementer should need this file, plus the
specs it cites, and nothing else. **Never "build the POS". Always `TASK-011`.**

**`TASK-001` through `TASK-018` are built, committed and green** (`c08f3af`, 2026-09-08). The
v1.0 backlog as written is closed. What that does **not** mean is that v1.0 is finished — see
[Status](#status) below, which names a screen gap the backlog never assigned to anybody.

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
| [TASK-036](TASK-036-catalogue-screens.md) | Catalogue screens `SCR-201`–`SCR-204` | *this commit* | `TC-E2E-10`, the cutover; on-hand joined into the product search |

## Open — v1.0 "Till", the screen gap

**These are release-blocking.** The v1.0 backlog assigned screens to three tasks — `TASK-015`
(`SCR-301`–`304`), `TASK-016` (`SCR-601`–`604`) and `TASK-017` (`SCR-704`, `705`). Nobody was
given the rest. `04_UX_SPEC.md` specifies **26 screens; 17 now exist**; every service and API
behind the missing nine is built and tested, but there is no screen to reach them from.

`TASK-036` closed the catalogue half — a store can now be stocked, and `TC-E2E-10` proves a
cutover end to end. The store can sell and can be set up. It still cannot take a payment on
account, close a shift, add a user, change a setting or read its own audit trail.

| ID | Task | Screens | Why it blocks release |
| :--- | :--- | :--- | :--- |
| `TASK-037` | Customer and credit screens | `SCR-401`–`SCR-403` | No way to add a customer, set a limit, or take a payment on account (`FR_4.3`) |
| `TASK-038` | Shift screens | `SCR-501`–`SCR-503` | Shift open exists inside the POS screen; **there is no close screen**, so `FR_5.3` cannot be performed by a cashier |
| `TASK-039` | Settings screen | `SCR-702` | No way to set the printer, the receipt width, the backup folder or any `OPS-005` figure |
| `TASK-040` | User administration | `SCR-701` | No way to create the cashiers. The store would trade on the owner login, which defeats `TX-412` and every audit row |
| `TASK-041` | Audit trail viewer | `SCR-703` | The trail is written and queryable but cannot be read by the owner (`FR_1.5`) |

`TASK-038` is the sharpest: a shift that can be opened and not closed is a till that cannot be
counted, and the close is where `POS-509`, `POS-510`, the variance and the automatic backup all
happen.

## Open — v1.1 "Supply" (no task files yet; write them at v1.0 close)

| ID | Task | Feature |
| :--- | :--- | :--- |
| `TASK-019` | Suppliers, purchase orders, goods receipt | `FT-501`–`FT-504` |
| `TASK-020` | Sales returns with restock/write-off decision | `FT-307` |
| `TASK-021` | Sale voiding with full reversal | `FT-308` |
| `TASK-022` | Stock counting with frozen expected quantities | `FT-209` |
| `TASK-023` | Discount rules engine and category ceilings | `FT-306` |
| `TASK-024` | Customer-specific and quantity-break pricing | `FT-211`, `FT-212` |
| `TASK-025` | JSON export and validated import | `FT-705`, `FT-706` |
| `TASK-026` | **Opening-data load from CSV** — products, opening stock, opening credit balances | `FT-707` |
| `TASK-027` | Senior citizen / PWD statutory discount | `FT-309` |
| `TASK-028` | Store credit balances | `FT-408` |

> `TASK-026` is v1.1 by release but is needed **at cutover**, before the store's first real day.
> If the client's SKU count makes manual entry impractical (`01_PRODUCT_BRIEF.md` `Q-4`), it is
> pulled into v1.0 and the backlog is re-ordered — that is the one planned exception.
>
> **`Q-4` is answered:** the list is small enough to key in by hand, so `TASK-026` stays in v1.1
> and the exception is not taken. Hand entry is possible now that `TASK-036` has landed.

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

## Closed

`TASK-001` – `TASK-018`, listed above with their commits.

---

<a id="status"></a>
## Status — 2026-09-08

**What is built.** 19,700 lines across 113 source files, 9 migrations, and 14,700 lines of
tests. `npm run test:all` is green: **642 cases** — 160 unit, 436 integration and API, 46
end-to-end — plus 4 performance files and two out-of-gate harnesses (`tools/browser-smoke`
drives the real renderer in Chromium; `tools/installer/check.sh` compiles the NSIS macros).

Every v1.0 service, repository, API route and business rule is implemented and tested.
`TC-UT-98` asserts the coverage obligation mechanically: **62 covered v1.0 rules, all cited by
a test**, and 51 of 51 rules outside the obligation as well.

**What is not built.** Nine of the twenty-six screens in `04_UX_SPEC.md` do not exist — see
[the screen gap](#open--v10-till-the-screen-gap) above. The backlog assigned screens to
`TASK-015`, `016` and `017` and never assigned the rest, and nothing caught it because every
one of those screens has a working, tested API underneath. The suite was green because the
suite tests the API.

`TASK-036` closed the catalogue half. In practical terms now: a store can be set up and
stocked, and a cashier can sell, take a split tender, park a cart, print a receipt and read the
day's reports. Nobody can take a payment on account, close a shift, create a user, change a
setting, or read the audit trail from the application.

**Where the release gate stands.** `07_TEST_PLAN.md` §10 carries the per-criterion outcome.
Seven of eleven criteria are green. Four need the store and cannot be settled from a build
machine — the store's own hardware, a backup restored onto a second machine, `TAX-006` read on
paper, and the power-cut half of `OPS-008`. The screen gap above is now a fifth reason, and
unlike the other four it is code, not a visit.

**The two open business questions are answered.** `Q-1`: the store is **not BIR-registered**,
so `tax_mode` is `NONE` at install. `Q-4`: the product list is small enough to key in by hand,
so `TASK-026` stays in v1.1. `TASK-036` built the screens that hand entry needs.

`Q-2` (cold-chain veterinary stock) and `Q-3` (delivery charges) remain open and affect only
v1.2 scope.

**One thing that is deliberately not software.** The off-machine backup copy in
`05_TECH_SPEC.md` §7 is a **process control handed to the owner**, not something the
application does. It is stated as such in `HANDOVER.md` §2 rather than quietly assumed, and
the store is told in those words that backups on the shop PC do not survive the shop PC.

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
