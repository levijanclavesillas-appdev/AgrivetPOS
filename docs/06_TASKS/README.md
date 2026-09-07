# 06 — Tasks

Open work items. Each task is self-contained: an implementer should need this file, plus the
specs it cites, and nothing else. **Never "build the POS". Always `TASK-011`.**

The repository contains **documentation only** — the last commit before the 2026-09-07
restructuring was `2c3218e Add PRD documentation`. Every task below is open.

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

## Open — v1.0 "Till"

| ID | Task | Priority | Blocks release? |
| :--- | :--- | :--- | :--- |
| [TASK-001](TASK-001-app-skeleton-and-migrations.md) | Application skeleton, layering, migrations, pragmas | P1 | Yes — everything |
| [TASK-002](TASK-002-money-and-unit-primitives.md) | Money, quantity and unit-conversion primitives | P1 | Yes — `MON-*`, `UOM-*` |
| [TASK-003](TASK-003-auth-rbac-and-recovery.md) | Authentication, RBAC, session, PIN, lockout, recovery | P1 | Yes — `FR_1.2`–`FR_1.4` |
| [TASK-004](TASK-004-setup-wizard-and-settings.md) | First-run setup, store profile, tax mode, settings registry | P1 | Yes — `FR_1.1` |
| [TASK-005](TASK-005-audit-service.md) | Audit service and trail | P1 | Yes — `FR_1.5` |
| [TASK-006](TASK-006-catalog.md) | Catalog: categories, brands, units, products, barcodes, packs, prices | P1 | Yes — `FR_2.1`, `FR_2.2` |
| [TASK-007](TASK-007-inventory-ledger.md) | Inventory ledger, on-hand, adjustments, low stock | P1 | Yes — `FR_2.4`–`FR_2.6` |
| [TASK-008](TASK-008-customers-and-credit-accounts.md) | Customers and credit accounts | P1 | Yes — `FR_4.1` |
| [TASK-009](TASK-009-pricing-and-tax-engine.md) | Price resolution and the three-mode tax engine | P1 | Yes — `FR_3.2`, `TAX-*` |
| [TASK-010](TASK-010-shift-and-till.md) | Cashier shift, till cash in/out, expected cash | P1 | Yes — `FR_5.1`, `FR_5.2` |
| [TASK-011](TASK-011-the-sale-transaction.md) | **The sale transaction** — `POST /sales` | P1 | Yes — `FR_3.3`–`FR_3.6` |
| [TASK-012](TASK-012-collections.md) | Credit collections and allocation | P1 | Yes — `FR_4.3`, `FR_4.4` |
| [TASK-013](TASK-013-shift-close-and-variance.md) | Shift close, per-method variance, backup trigger | P1 | Yes — `FR_5.3`, `FR_5.4` |
| [TASK-014](TASK-014-escpos-printing-and-drawer.md) | ESC/POS receipt, cash drawer, reprint, collection acknowledgement | P1 | Yes — `FR_3.7`, `TAX-006` |
| [TASK-015](TASK-015-pos-user-interface.md) | POS, payment and receipt screens | P1 | Yes — `SCR-301`–`SCR-304` |
| [TASK-016](TASK-016-dashboard-and-reports.md) | Dashboard and the v1.0 reports | P2 | Yes — `FR_6.1`, `FR_6.2` |
| [TASK-017](TASK-017-backup-restore-health-alerts.md) | Automatic backup, verification, restore, health, alerts | P1 | Yes — `FR_7.1`–`FR_7.4` |
| [TASK-018](TASK-018-installer-and-uat.md) | Windows installer, first-run migration, UAT on store hardware | P1 | Yes — the gate |

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

*None. Work has not started.*

---

**Status of everything else.** Zero percent of `02_PRD.md` is built and zero percent is covered
by tests. `07_TEST_PLAN.md` §10 gates v1.0 **not shippable** for the plainest possible reason:
there is no application. The specifications are complete enough to implement from — every rule
carries an ID, the v1.0 schema is written out in full in `05_TECH_SPEC.md` §3.4, and the sale
transaction's step order is fixed in §4.1. Four business questions remain open
(`01_PRODUCT_BRIEF.md` §9); only `Q-4` (the client's existing product list) can delay a task, and
it delays `TASK-026`, not the critical path.

**What remains.** Ten of the eleven v1.0 gate criteria are automated and belong to the tasks
above. The eleventh — UAT on the store's own scanner, printer, drawer and PC — cannot be
automated and is `TASK-018`. The off-machine backup copy in `05_TECH_SPEC.md` §7 is a **process
control handed to the owner, not a software control**, and it is called out as such at handover
rather than quietly assumed.

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
