# 05 — Technical Specification

**Product**: Chachi Agrivet POS · **Version**: 2.0 · **Date**: 2026-09-07
**Owns**: architecture, stack, ERD and schema, API contracts, integrations (`INT-*`), security
(`SEC-*`), infrastructure and DR, coding standards. Behaviour is owned by
`03_BUSINESS_RULES.md`; this document states implementation and cites rule IDs.

> **Conflict rule.** Where this document appears to contradict `03_BUSINESS_RULES.md`, the
> business rule wins and the contradiction is reported, not resolved in code
> (`docsrequirement.md` §6).

---

## 1. Architecture

v1.0 is **one Windows PC** (`01_PRODUCT_BRIEF.md` D-2). The Electron shell starts an embedded
Express server in-process; the renderer is the client. Nothing listens off-host.

```text
┌──────────────────── Windows PC ────────────────────────┐
│  Electron main (main.js)                               │
│    ├── BrowserWindow  ──▶ renderer  (public/)          │
│    └── requires src/app.js  ──▶ Express on 127.0.0.1   │
│                                    │                   │
│                              service layer             │
│                                    │                   │
│                            repository layer            │
│                                    │                   │
│                         better-sqlite3  (WAL)          │
│                                    │                   │
│                          agrivet.db  +  backups/       │
│                                                        │
│  USB: barcode scanner (keyboard wedge)                 │
│  USB/LAN: ESC/POS printer ──▶ RJ11 cash drawer         │
└────────────────────────────────────────────────────────┘
```

**Why an HTTP server for a single-machine app**: it is the only decision that makes v1.3 additive
rather than a rewrite. LAN terminals and the Android companion become clients of the same API by
changing a bind address and adding authentication transport — no business logic moves.

### Layering, and the rule that protects the PostgreSQL path

```text
routes/      HTTP only. Parse, authorise, delegate, serialise. No SQL. No business rules.
services/    All business rules. The only layer that may open a transaction.
repositories/  All SQL. The only layer that knows better-sqlite3 exists.
config/      Schema, migrations, pragmas, settings registry.
```

**No SQL outside `repositories/`, and no `better-sqlite3` import outside `repositories/` and
`config/`.** This is the whole of the portability requirement in `legacy/PRD_v1.1.md` §8, reduced
to something a grep can enforce (`TC-UT-99`).

## 2. Stack

| Layer | Choice | Version | Why |
| :--- | :--- | :--- | :--- |
| Shell | Electron | ^33.4 | Proven in `CHACHI_LOAN_STANDARD`; ships a Windows `.exe` |
| Server | Express | ^4.21 | Same |
| Database | better-sqlite3 | ^11.10 | Synchronous, transactional, no async race inside a sale |
| Auth | bcryptjs + jsonwebtoken | ^3.0 / ^9.0 | `SEC-1` |
| ID | UUIDv7 | — | Time-ordered, index-friendly, migration-stable (`VR-101`) |
| Frontend | Vanilla ES modules + CSS custom properties | — | No build step; a store PC gets a folder that runs |
| Packaging | electron-builder NSIS | ^25.1 | `ChachiAgrivetPOS-Setup-<version>.exe` |
| Tests | `node:test` + a project runner | — | `07_TEST_PLAN.md` |

**Deliberately absent**: no ORM (the repository layer is the abstraction), no frontend framework,
no bundler, no runtime network dependency. Every dependency must survive being offline forever.

## 3. Data model

### 3.1 Conventions — binding on every table

| # | Convention |
| :-- | :--- |
| 1 | Primary key `id TEXT` — UUIDv7, application-generated (`VR-101`). |
| 2 | **Money is `INTEGER` centavos**, suffixed `_centavos` (`MON-001`). No `REAL` in a money column, ever. |
| 3 | **Quantity is `INTEGER` thousandths of the base unit**, suffixed `_milli` (`MON-002`). |
| 4 | Timestamps are `TEXT` ISO-8601 **UTC**, suffixed `_at` (`VR-102`). |
| 5 | `created_at`, `created_by` on every business table; `updated_at`, `updated_by` where mutable. |
| 6 | Soft delete only: `is_active INTEGER NOT NULL DEFAULT 1`. No `DELETE` on a business table. |
| 7 | Enumerations are `TEXT` with a `CHECK` constraint — readable in a dump, portable to PostgreSQL. |
| 8 | Every foreign key is declared and enforced (`PRAGMA foreign_keys = ON`). **One deliberate exception**, annotated where it lives: `audit_logs.shift_id` (§3.4). |
| 9 | No SQLite-only syntax: no `WITHOUT ROWID`, no `AUTOINCREMENT`, no type affinity games. |

### 3.2 Pragmas

```sql
PRAGMA journal_mode = WAL;        -- OPS-008: survives power loss
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

### 3.3 Entity overview

```text
store_profile ── system_settings ── schema_migrations

users ──< user_sessions
  └──< audit_logs

categories ──┐
brands ──────┤
units ───────┼──< products ──< product_barcodes
             │        ├──< product_packs          (UOM-002)
             │        ├──< product_prices         (PR-101)
             │        ├──< inventory              (1:1, INV-101)
             │        └──< inventory_movements    (append-only, INV-102)
             │
customers ──< customer_credit_accounts ──< customer_credit_transactions
     │                                          └──< credit_allocations   (CR-203)
     └──< sales ──< sale_items
                └──< sale_tenders
                └──< sale_discounts

cashier_shifts ──< till_movements
      └──< cashier_closings ──< closing_method_lines

-- v1.1+
suppliers ──< purchase_orders ──< purchase_order_items
                   └──< goods_receipts ──< goods_receipt_items
sales_returns ──< sales_return_items
stock_counts ──< stock_count_items
inventory_adjustments
-- v1.2
inventory_batches
```

`legacy/PRD_v1.1.md` §79 omitted `stock_counts`, `stock_count_items`, `inventory_adjustments`,
`customer_specific_prices`, `product_packs`, `payment_methods`, `credit_allocations`,
`schema_migrations`, `backup_log`, `store_profile` and `closing_method_lines`. All are present
above.

### 3.4 v1.0 schema

```sql
-- ── Foundation ──────────────────────────────────────────────────────────
CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TEXT NOT NULL
);

CREATE TABLE store_profile (
  id            TEXT PRIMARY KEY,
  store_name    TEXT NOT NULL,
  address       TEXT,
  contact_no    TEXT,
  tin           TEXT,
  tax_mode      TEXT NOT NULL CHECK (tax_mode IN ('NONE','NON_VAT','VAT')),  -- TAX-001
  currency      TEXT NOT NULL DEFAULT 'PHP',
  created_at    TEXT NOT NULL,
  updated_at    TEXT,
  updated_by    TEXT REFERENCES users(id)
);

CREATE TABLE system_settings (           -- OPS-005: every operator-owned figure
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  value_type  TEXT NOT NULL CHECK (value_type IN ('INT','STRING','BOOL','JSON')),
  updated_at  TEXT,
  updated_by  TEXT REFERENCES users(id)
);

CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  username          TEXT NOT NULL UNIQUE COLLATE NOCASE,       -- VR-501
  full_name         TEXT NOT NULL,
  password_hash     TEXT NOT NULL,                              -- SEC-1, bcrypt cost 12
  pin_hash          TEXT,                                       -- SEC-2, 6 digits
  role              TEXT NOT NULL CHECK (role IN ('OWNER','MANAGER','CASHIER','INVENTORY')),
  recovery_code_hash TEXT,                                      -- SEC-5, owner only
  failed_attempts   INTEGER NOT NULL DEFAULT 0,                 -- SEC-3
  locked_until_at   TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  created_by        TEXT REFERENCES users(id)
);

CREATE TABLE audit_logs (                -- AUD-605/606: append-only, never deleted
  id            TEXT PRIMARY KEY,
  occurred_at   TEXT NOT NULL,
  actor_id      TEXT REFERENCES users(id),
  actor_username TEXT NOT NULL,          -- denormalised: AUD-606
  approver_id   TEXT REFERENCES users(id),
  approver_username TEXT,                -- AUD-603: two distinct actors
  action        TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT,
  before_value  TEXT,                    -- JSON
  after_value   TEXT,                    -- JSON
  reason        TEXT,
  -- NOT a foreign key, deliberately. SQLite resolves a foreign key's parent table at
  -- INSERT time, so a declared REFERENCES cashier_shifts(id) makes *every* audit write
  -- fail with "no such table" until migration 005 creates that table — including a
  -- write whose shift_id is NULL. Audit would be unwritable from first-run setup
  -- (AUD-604) onwards, which is the one thing an audit trail may never be.
  --
  -- Enforcing it later would mean rebuilding the table in 005. It is not worth it: the
  -- trail is append-only (AUD-605), nothing deletes a shift (POS-511), and an audit row
  -- must be writable in every circumstance, including ones where its referents are gone.
  -- This is the same reasoning that denormalises actor_username in AUD-606.
  shift_id      TEXT                     -- soft reference to cashier_shifts(id)
);
CREATE INDEX idx_audit_time   ON audit_logs (occurred_at DESC);
CREATE INDEX idx_audit_entity ON audit_logs (entity_type, entity_id);

-- ── Catalog ─────────────────────────────────────────────────────────────
CREATE TABLE categories (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  max_discount_bp INTEGER,               -- PR-202, basis points; NULL = no ceiling
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE brands (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);

CREATE TABLE units (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- KG, PC, SACK, L
  name TEXT NOT NULL, allows_fraction INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);

CREATE TABLE products (
  id                  TEXT PRIMARY KEY,
  sku                 TEXT NOT NULL UNIQUE COLLATE NOCASE,        -- VR-201
  name                TEXT NOT NULL,                              -- VR-202
  category_id         TEXT NOT NULL REFERENCES categories(id),
  brand_id            TEXT REFERENCES brands(id),
  base_unit_id        TEXT NOT NULL REFERENCES units(id),         -- UOM-001, UOM-003
  description         TEXT,
  tax_class           TEXT NOT NULL DEFAULT 'VATABLE'
                        CHECK (tax_class IN ('VATABLE','VAT_EXEMPT','ZERO_RATED')),  -- TAX-003
  statutory_discount_eligible INTEGER NOT NULL DEFAULT 0,         -- TAX-004
  avg_cost_centavos   INTEGER NOT NULL DEFAULT 0,                 -- MON-004
  avg_cost_as_of      TEXT,
  min_stock_milli     INTEGER NOT NULL DEFAULT 0,                 -- UOM-005, VR-204
  is_batch_tracked    INTEGER NOT NULL DEFAULT 0,                 -- v1.2
  is_active           INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, created_by TEXT REFERENCES users(id),
  updated_at TEXT, updated_by TEXT REFERENCES users(id)
);
CREATE INDEX idx_products_name     ON products (name);
CREATE INDEX idx_products_category ON products (category_id);
CREATE INDEX idx_products_active   ON products (is_active);

CREATE TABLE product_barcodes (          -- VR-205: many per product
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  barcode    TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_barcode ON product_barcodes (barcode);

CREATE TABLE product_packs (             -- UOM-002: 1 SACK = 50 KG -> factor_milli 50000
  id TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products(id),
  unit_id     TEXT NOT NULL REFERENCES units(id),
  factor_milli INTEGER NOT NULL CHECK (factor_milli > 0),          -- VR-207
  is_default_sell INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  UNIQUE (product_id, unit_id)
);

CREATE TABLE product_prices (            -- PR-101 levels 3-4 in v1.0
  id TEXT PRIMARY KEY,
  product_id     TEXT NOT NULL REFERENCES products(id),
  price_level    TEXT NOT NULL CHECK (price_level IN ('RETAIL','WHOLESALE','DEALER')),
  price_centavos INTEGER NOT NULL CHECK (price_centavos >= 0),      -- VR-203
  effective_from TEXT NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT REFERENCES users(id),
  UNIQUE (product_id, price_level, effective_from)
);

-- ── Inventory ───────────────────────────────────────────────────────────
CREATE TABLE inventory (                 -- INV-101: materialised, service-maintained only
  product_id         TEXT PRIMARY KEY REFERENCES products(id),
  qty_on_hand_milli  INTEGER NOT NULL DEFAULT 0,
  updated_at         TEXT NOT NULL
);

CREATE TABLE inventory_movements (       -- INV-102: append-only
  id            TEXT PRIMARY KEY,
  product_id    TEXT NOT NULL REFERENCES products(id),
  movement_type TEXT NOT NULL CHECK (movement_type IN (
                  'OPENING','RECEIPT','SALE','SALE_VOID','CUSTOMER_RETURN',
                  'SUPPLIER_RETURN','ADJUSTMENT','DAMAGE','EXPIRY',
                  'INTERNAL_USE','COUNT_VARIANCE','BREAK_BULK')),   -- INV-103
  qty_milli     INTEGER NOT NULL,        -- signed
  balance_after_milli INTEGER NOT NULL,  -- running balance for the ledger view
  unit_cost_centavos  INTEGER,           -- INV-106: set on increases
  reference_type TEXT,
  reference_id   TEXT,
  reference_no   TEXT,
  reason         TEXT,
  corrects_movement_id TEXT REFERENCES inventory_movements(id),     -- INV-102
  is_negative_stock INTEGER NOT NULL DEFAULT 0,                     -- INV-104 flag
  occurred_at   TEXT NOT NULL,
  created_by    TEXT NOT NULL REFERENCES users(id)
);
CREATE INDEX idx_move_product ON inventory_movements (product_id, occurred_at);
CREATE INDEX idx_move_ref     ON inventory_movements (reference_type, reference_id);

-- ── Customers and credit ────────────────────────────────────────────────
CREATE TABLE customers (
  id            TEXT PRIMARY KEY,
  code          TEXT UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,                                      -- VR-301
  contact_no    TEXT,                                               -- VR-302
  address       TEXT,
  customer_type TEXT NOT NULL DEFAULT 'RETAIL'
                  CHECK (customer_type IN ('WALK_IN','RETAIL','REGULAR','WHOLESALE','DEALER','FARM')),
  price_level   TEXT NOT NULL DEFAULT 'RETAIL'
                  CHECK (price_level IN ('RETAIL','WHOLESALE','DEALER')),
  is_credit_eligible INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  notes         TEXT,
  created_at TEXT NOT NULL, created_by TEXT REFERENCES users(id),
  updated_at TEXT, updated_by TEXT REFERENCES users(id)
);
CREATE INDEX idx_customers_name ON customers (name);

CREATE TABLE customer_credit_accounts (
  id                    TEXT PRIMARY KEY,
  customer_id           TEXT NOT NULL UNIQUE REFERENCES customers(id),
  credit_limit_centavos INTEGER NOT NULL DEFAULT 0 CHECK (credit_limit_centavos >= 0),  -- VR-303
  balance_centavos      INTEGER NOT NULL DEFAULT 0,   -- CR-103; negative = store credit (CR-108)
  terms_days            INTEGER NOT NULL DEFAULT 0,   -- 0 = COD
  updated_at            TEXT NOT NULL
);

CREATE TABLE customer_credit_transactions (     -- CR-103: the balance derives from here
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES customer_credit_accounts(id),
  txn_type      TEXT NOT NULL CHECK (txn_type IN
                  ('CREDIT_SALE','COLLECTION','RETURN_CREDIT','WRITE_OFF','OPENING','ADJUSTMENT')),
  amount_centavos INTEGER NOT NULL,      -- signed: debit +, credit -
  balance_after_centavos INTEGER NOT NULL,
  sale_id       TEXT REFERENCES sales(id),
  due_at        TEXT,                    -- CR-105
  document_no   TEXT NOT NULL,           -- COLL-YYYYMMDD-NNNNNN for collections
  method        TEXT CHECK (method IN ('CASH','GCASH','QRPH','STORE_CREDIT')),
  reference_no  TEXT,
  shift_id      TEXT REFERENCES cashier_shifts(id),
  reason        TEXT,
  occurred_at   TEXT NOT NULL,
  created_by    TEXT NOT NULL REFERENCES users(id)
);
CREATE INDEX idx_credit_account ON customer_credit_transactions (account_id, occurred_at);

CREATE TABLE credit_allocations (        -- CR-203: which invoices a payment settled
  id TEXT PRIMARY KEY,
  collection_txn_id TEXT NOT NULL REFERENCES customer_credit_transactions(id),
  sale_txn_id       TEXT NOT NULL REFERENCES customer_credit_transactions(id),
  amount_centavos   INTEGER NOT NULL CHECK (amount_centavos > 0),
  created_at        TEXT NOT NULL
);

-- ── Shift and till ──────────────────────────────────────────────────────
CREATE TABLE cashier_shifts (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id),
  opened_at           TEXT NOT NULL,
  opening_float_centavos INTEGER NOT NULL DEFAULT 0,   -- POS-503
  closed_at           TEXT,
  status              TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED'))
);
CREATE INDEX idx_shift_open ON cashier_shifts (user_id, status);

CREATE TABLE till_movements (            -- POS-504..506
  id TEXT PRIMARY KEY,
  shift_id   TEXT NOT NULL REFERENCES cashier_shifts(id),
  direction  TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  amount_centavos INTEGER NOT NULL CHECK (amount_centavos > 0),
  reason     TEXT NOT NULL,
  notes      TEXT,
  occurred_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id)
);

CREATE TABLE cashier_closings (          -- POS-509..511
  id TEXT PRIMARY KEY,
  shift_id  TEXT NOT NULL UNIQUE REFERENCES cashier_shifts(id),
  expected_cash_centavos INTEGER NOT NULL,
  actual_cash_centavos   INTEGER NOT NULL,
  variance_centavos      INTEGER NOT NULL,
  variance_reason        TEXT,           -- required beyond tolerance
  closed_at  TEXT NOT NULL,
  closed_by  TEXT NOT NULL REFERENCES users(id)
);

CREATE TABLE closing_method_lines (      -- POS-510: variance per method
  id TEXT PRIMARY KEY,
  closing_id TEXT NOT NULL REFERENCES cashier_closings(id),
  method     TEXT NOT NULL,
  expected_centavos INTEGER NOT NULL,
  actual_centavos   INTEGER NOT NULL,
  variance_centavos INTEGER NOT NULL
);

-- ── Sales ───────────────────────────────────────────────────────────────
CREATE TABLE sales (
  id              TEXT PRIMARY KEY,
  sale_no         TEXT NOT NULL UNIQUE,          -- POS-108 SALE-YYYYMMDD-NNNNNN
  customer_id     TEXT REFERENCES customers(id), -- NULL = walk-in (POS-103)
  shift_id        TEXT NOT NULL REFERENCES cashier_shifts(id),   -- POS-501
  status          TEXT NOT NULL DEFAULT 'COMPLETED'
                    CHECK (status IN ('COMPLETED','VOIDED','PARTIALLY_RETURNED','RETURNED')),
  price_level     TEXT NOT NULL,
  tax_mode        TEXT NOT NULL,                 -- TAX-002 snapshot; RPT-106
  subtotal_centavos        INTEGER NOT NULL,
  line_discount_centavos   INTEGER NOT NULL DEFAULT 0,
  txn_discount_centavos    INTEGER NOT NULL DEFAULT 0,   -- MON-006
  statutory_discount_centavos INTEGER NOT NULL DEFAULT 0, -- TAX-004, v1.1
  vatable_centavos    INTEGER NOT NULL DEFAULT 0,        -- TAX-003
  vat_exempt_centavos INTEGER NOT NULL DEFAULT 0,
  zero_rated_centavos INTEGER NOT NULL DEFAULT 0,
  vat_centavos        INTEGER NOT NULL DEFAULT 0,
  total_centavos      INTEGER NOT NULL,
  change_centavos     INTEGER NOT NULL DEFAULT 0,        -- MON-007
  approved_by     TEXT REFERENCES users(id),             -- AUD-603
  voided_at       TEXT, voided_by TEXT REFERENCES users(id), void_reason TEXT,
  occurred_at     TEXT NOT NULL,
  created_by      TEXT NOT NULL REFERENCES users(id)
);
CREATE INDEX idx_sales_date  ON sales (occurred_at);
CREATE INDEX idx_sales_shift ON sales (shift_id);
CREATE INDEX idx_sales_cust  ON sales (customer_id);

CREATE TABLE sale_items (                -- MON-005: every figure is a snapshot
  id TEXT PRIMARY KEY,
  sale_id     TEXT NOT NULL REFERENCES sales(id),
  line_no     INTEGER NOT NULL,
  product_id  TEXT NOT NULL REFERENCES products(id),
  product_name_snapshot TEXT NOT NULL,
  qty_milli   INTEGER NOT NULL CHECK (qty_milli > 0),    -- MON-002, base unit
  sold_unit_id TEXT NOT NULL REFERENCES units(id),       -- what the cashier picked
  sold_pack_factor_milli INTEGER NOT NULL DEFAULT 1000,  -- UOM-002
  unit_price_centavos    INTEGER NOT NULL,               -- per base unit
  price_level_applied    TEXT NOT NULL,                  -- PR-101
  unit_cost_centavos     INTEGER NOT NULL,               -- MON-004 snapshot
  discount_centavos      INTEGER NOT NULL DEFAULT 0,
  tax_class_snapshot     TEXT NOT NULL,                  -- TAX-003
  tax_centavos           INTEGER NOT NULL DEFAULT 0,
  line_total_centavos    INTEGER NOT NULL,               -- MON-003
  batch_id    TEXT,                                      -- v1.2, INV-206
  returned_qty_milli INTEGER NOT NULL DEFAULT 0,         -- v1.1, POS-301
  UNIQUE (sale_id, line_no)
);
CREATE INDEX idx_saleitems_product ON sale_items (product_id);

CREATE TABLE sale_tenders (              -- POS-202: split tender
  id TEXT PRIMARY KEY,
  sale_id  TEXT NOT NULL REFERENCES sales(id),
  method   TEXT NOT NULL CHECK (method IN ('CASH','GCASH','QRPH','CREDIT','STORE_CREDIT','OTHER')),
  amount_centavos INTEGER NOT NULL CHECK (amount_centavos > 0),
  reference_no TEXT,                     -- POS-205: required for GCASH/QRPH
  status   TEXT NOT NULL DEFAULT 'RECORDED' CHECK (status IN ('RECORDED')),  -- POS-206
  created_at TEXT NOT NULL
);
CREATE INDEX idx_tender_sale ON sale_tenders (sale_id);
CREATE INDEX idx_tender_ref  ON sale_tenders (method, reference_no);   -- POS-207

CREATE TABLE sale_discounts (            -- PR-204: the discount audit trail
  id TEXT PRIMARY KEY,
  sale_id      TEXT NOT NULL REFERENCES sales(id),
  sale_item_id TEXT REFERENCES sale_items(id),      -- NULL = transaction level
  discount_type TEXT NOT NULL CHECK (discount_type IN
                  ('MANUAL_LINE','MANUAL_TXN','RULE_TXN','RULE_QTY','STATUTORY')),
  original_centavos INTEGER NOT NULL,
  discount_centavos INTEGER NOT NULL,
  discount_bp       INTEGER NOT NULL,               -- basis points
  reason            TEXT,
  applied_by        TEXT NOT NULL REFERENCES users(id),
  approved_by       TEXT REFERENCES users(id),      -- PR-203
  statutory_id_type TEXT, statutory_id_no TEXT, statutory_name TEXT,  -- TAX-004
  created_at        TEXT NOT NULL
);

CREATE TABLE backup_log (                -- OPS-002, OPS-006
  id TEXT PRIMARY KEY,
  file_path   TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  trigger     TEXT NOT NULL CHECK (trigger IN ('SCHEDULED','SHIFT_CLOSE','MANUAL','PRE_RESTORE','PRE_IMPORT')),
  verified    INTEGER NOT NULL DEFAULT 0,
  verify_error TEXT,
  created_at  TEXT NOT NULL,
  created_by  TEXT REFERENCES users(id)
);
```

### 3.5 Migrations

Numbered, forward-only, one file per migration, applied in a transaction, recorded in
`schema_migrations`. The app refuses to start when the database version exceeds the binary's
known version — a newer database opened by an older `.exe` is a data-loss event, not a warning.

```text
migrations/001_foundation.sql       users, settings, store_profile, audit
migrations/002_catalog.sql          categories, brands, units, products, barcodes, packs, prices
migrations/003_inventory.sql        inventory, inventory_movements
migrations/004_customers_credit.sql customers, accounts, transactions, allocations
migrations/005_shifts.sql           shifts, till, closings, closing lines
migrations/006_sales.sql            sales, items, tenders, discounts
migrations/007_backup_log.sql       backup_log
```

## 4. API

`http://127.0.0.1:PORT/api/v1`. JSON in, JSON out. Every route authorises against `TX-*`
server-side (`SEC-6`). Errors: `{ error: { code, message, rule_id, requires_role } }`, where
`rule_id` lets the UI show the rule's plain-language refusal (`04_UX_SPEC.md` §5).

| Method | Path | `TX-*` | Notes |
| :--- | :--- | :--- | :--- |
| `POST` | `/auth/login` | — | `SEC-3` lockout |
| `POST` | `/auth/pin-unlock` | — | `FR_1.3`, shift must be open |
| `POST` | `/auth/recover` | — | `SEC-5`, `AUD-604` |
| `GET` | `/products?q=&category=&low=` | `TX-422` | `NFR_1.3` |
| `GET` | `/products/barcode/:code` | `TX-401` | `NFR_1.2` |
| `POST` `PUT` | `/products` `/products/:id` | `TX-410` | cost only under `TX-412` |
| `GET` | `/inventory/:productId/movements` | `TX-422` | the ledger view |
| `POST` | `/inventory/adjustments` | `TX-407` | `INV-108` |
| `GET` | `/customers?q=` | `TX-413` | |
| `GET` | `/customers/:id/credit` | `TX-413` | limit, balance, available, ageing |
| `POST` | `/customers/:id/collections` | `TX-416` | `CR-201`..`CR-206` |
| `POST` | `/shifts/open` | `TX-418` | `POS-502` |
| `POST` | `/shifts/:id/till` | `TX-420` | `POS-504` |
| `GET` | `/shifts/:id/expected` | `TX-418` | `POS-509` |
| `POST` | `/shifts/:id/close` | `TX-418` | `POS-510`, triggers `OPS-001` |
| `POST` | `/sales/price-check` | `TX-401` | resolves `PR-101` for a cart without committing |
| `POST` | `/sales` | `TX-401` | **the transaction** — `FR_3.5` |
| `POST` | `/sales/:id/reprint` | `TX-430` | `POS-208` |
| `GET` | `/reports/daily?date=` | `TX-421` | `RPT-101` |
| `GET` | `/reports/payments?from=&to=` | `TX-421` | `RPT-102` |
| `GET` | `/reports/inventory/valuation` | `TX-422` | `RPT-103` |
| `GET` | `/audit?actor=&entity=&from=&to=` | `TX-429` | |
| `POST` | `/backups` | `TX-428` | `OPS-001`, `OPS-002` |
| `POST` | `/backups/:id/restore` | `TX-427` | `OPS-004` |
| `GET` | `/health` | — | `OPS-006` |

### 4.1 `POST /sales` — the one contract that matters

Everything in `FR_3.5` happens inside one `better-sqlite3` transaction:

```text
BEGIN IMMEDIATE
  1  validate shift is open and belongs to the actor          POS-501
  2  re-resolve every line price server-side                  PR-101   (never trust the client)
  3  re-check stock for every line                            INV-104
  4  recompute every total server-side                        MON-003, MON-006, TAX-002
  5  verify SUM(tenders) >= total                             POS-204
  6  verify each GCASH/QRPH tender carries a reference        POS-205
  7  verify credit tender: eligible, within limit or approved CR-102, CR-104
  8  allocate sale_no from the daily sequence                 POS-108
  9  INSERT sale, sale_items (with cost snapshot), tenders,
     sale_discounts                                           MON-005
 10  INSERT one inventory_movement per line, UPDATE inventory INV-101, INV-107
 11  INSERT credit transaction where credit-tendered          CR-103
 12  INSERT audit rows for any override                       AUD-603
COMMIT
```

**The client's computed totals are never persisted.** They are compared against the server's, and
a mismatch beyond zero rejects the sale — that is how a stale price list or a tampered renderer is
caught rather than banked.

## 5. Integrations

| ID | Integration | Detail |
| :--- | :--- | :--- |
| `INT-1` | **ESC/POS receipt printer** | 58 mm (32 col) and 80 mm (48 col) layouts, selected in settings. USB via node printer bridge, LAN via raw TCP 9100. Printing is best-effort and asynchronous: **a printer failure never rolls back a committed sale** — it queues the document for reprint (`POS-208`) and raises a toast. |
| `INT-2` | **Cash drawer** | RJ11 driven by the printer, ESC/POS pulse `0x1B 0x70 0x00 0x19 0xFA`. Fired on cash tender, cash collection, and any till movement (`POS-507`). |
| `INT-3` | **Barcode scanner** | USB HID keyboard wedge. No driver, no pairing. The renderer routes keystrokes to the search field when no modal is open (`04_UX_SPEC.md` §7); a terminating `Enter` within the scan interval marks it a scan rather than typing. |
| `INT-4` | **Weighing scale** | Manual entry in v1.0–v1.2. RS232/USB direct capture is v1.3. |
| `INT-5` | **GCash / QR Ph** | **No API integration, in any release currently planned.** The system records a reference number the cashier read off their own device (`POS-206`). |

## 6. Security

| ID | Control | Implementation |
| :--- | :--- | :--- |
| `SEC-1` | **Password storage** | bcrypt, cost ≥ 12. Never logged, never returned by any endpoint, never exported. Local-only credential — see the platform boundary in `01_PRODUCT_BRIEF.md` §8. |
| `SEC-2` | **Cashier PIN** | 6 digits, bcrypt-hashed, `VR-502`. Scoped to POS and collections only, and issued only by an owner or manager. It is not an alternative login: it unlocks an already-authenticated user's open shift. |
| `SEC-3` | **Brute force** | 5 failed passwords locks the account 15 minutes; per-account, counted in the database so a restart does not clear it. Failures beyond the threshold are audited (`AUD-601`). |
| `SEC-4` | **No payment credentials** | The system stores reference numbers and amounts. It must never store or accept a card number, a GCash MPIN, a bank credential, or an OTP. There is no schema column capable of holding one. |
| `SEC-5` | **Offline recovery** | A single-use recovery code, generated at setup, shown once, stored bcrypt-hashed. Consuming it resets the owner password, issues a replacement code, and writes `AUD-604` before the reset commits. Rate-limited identically to `SEC-3`. |
| `SEC-6` | **Authorisation is server-side** | Every route checks the `TX-*` permission. The renderer's hidden buttons are cosmetic; a hand-crafted request to a forbidden route is refused with 403 and audited. |
| `SEC-7` | **Session** | JWT in memory in the renderer, never in `localStorage`. Idle timeout from settings, default 15 minutes. Signing secret generated at install, stored in the app data directory with OS file permissions. |
| `SEC-8` | **Local exposure** | Express binds `127.0.0.1` in v1.0. It is never bound to `0.0.0.0` until v1.3 adds device authentication — a POS API on an open LAN with no client auth is a store-wide compromise. |
| `SEC-9` | **Backups** | Written to a configured folder with OS permissions; the operator is told plainly in `SCR-704` that a backup on a shared drive is readable by anyone with the drive. Full database encryption (SQLCipher, as in ChachiLoan) is a v1.2 option gated on measured POS latency. |
| `SEC-10` | **Data privacy (RA 10173)** | Customer data is limited to name, contact, address and trading history — what the credit relationship requires. No customer data leaves the machine. Retention: transactional data 5 years (`NFR_2.2`); a customer with a zero balance may be anonymised on request, preserving the transactions and blanking the identity, which is auditable and irreversible. |
| `SEC-11` | **Audit integrity** | `audit_logs` has no `UPDATE` or `DELETE` path in any repository (`AUD-605`), and the export includes it. |

Statutes: **RA 10173** Data Privacy, **RA 10175** Cybercrime, **RA 8792** E-Commerce. Tax
position and the Official Receipt boundary: `03_BUSINESS_RULES.md` `TAX-006`.

## 7. Infrastructure and DR

### Build

```bash
npm ci
npm run test:all                 # gate: 07_TEST_PLAN.md §Release
npm run build:exe                # -> dist/ChachiAgrivetPOS-Setup-<version>.exe
```

electron-builder NSIS, `oneClick: false`, install directory selectable, desktop and start-menu
shortcuts, `requestedExecutionLevel: asInvoker` — the app never needs administrator rights.

### Runtime layout on the store PC

```text
%LOCALAPPDATA%\ChachiAgrivetPOS\
  agrivet.db              agrivet.db-wal      agrivet.db-shm
  session.key             logs\app-YYYY-MM-DD.log      (30-day rotation)
<configured backup folder, default Documents\ChachiAgrivetPOS Backups>\
  agrivet_backup_YYYY-MM-DD_HH-mm.zip                  (OPS-001, retention 30)
```

### Update distribution — `NFR_5.1`

Signed installer delivered by hand or USB. **No forced auto-update**: a store PC that
self-updates mid-shift is an outage. The installer preserves the database, runs pending
migrations on first launch, and takes a pre-migration backup automatically.

### Disaster recovery

| Scenario | Recovery |
| :--- | :--- |
| Power loss mid-sale | WAL replay on next open; the uncommitted sale is absent (`OPS-008`). Nothing to do. |
| Database corruption | Restore the newest verified backup (`OPS-002`, `OPS-004`); re-key sales since that backup from receipts. RPO = last shift close. |
| PC failure | Reinstall on new hardware, restore the newest backup from the backup folder or its off-machine copy. RTO ≈ 1 hour. |
| Ransomware / theft | Backups on the same machine are not a backup. The operator is instructed to copy the backup folder weekly to external media. **This is a process control, not a software control, and it is stated as such in the handover.** |

## 8. Coding standards

1. **No SQL outside `repositories/`. No `better-sqlite3` import outside `repositories/` and
   `config/`.** Enforced by `TC-UT-99`.
2. **No business rule in `routes/`.** A route parses, authorises, delegates, serialises.
3. **A service owns the transaction.** A repository never opens one; nested transactions are a
   design error, not a thing to work around.
4. **No floating-point arithmetic on money or quantity anywhere** (`MON-001`, `MON-002`). The
   only division permitted on a money value is the VAT decomposition in `TAX-003`, and it rounds
   explicitly.
5. **Every rule implemented in code cites its ID in a comment** — `// CR-104: over-limit blocked`.
   That citation is what makes the rule greppable when it changes.
6. Errors carry `rule_id`. A refusal the UI cannot explain is an unfinished refusal.
7. Structured JSON logging; **never log a password hash, a PIN, a token, or a full customer
   record**.
8. `node:test` for units, the project runner for integration and E2E (`07_TEST_PLAN.md`).
9. Migrations are forward-only and never edited once applied anywhere.

---

*Chachi's Software Development Service · DTI BN 8089738 · BIR OCN 111RC20260000002455 · TIN 752-951-092-00000*
