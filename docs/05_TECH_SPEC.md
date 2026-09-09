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

-- v1.1
suppliers ──< purchase_orders ──< purchase_order_items
     │             └──────────┐
     └──────────────────────< goods_receipts ──< goods_receipt_items
                              (po_id NULL = PO-207's direct receipt)
-- v1.1+
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

CREATE TABLE carts (                     -- POS-105, POS-106; added by TASK-015
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  shift_id    TEXT NOT NULL REFERENCES cashier_shifts(id),
  customer_id TEXT REFERENCES customers(id),
  status      TEXT NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE','PARKED','RESUMED','EXPIRED','COMPLETED')),
  label       TEXT,
  payload     TEXT NOT NULL,            -- lines as JSON; prices are never stored
  line_count  INTEGER NOT NULL DEFAULT 0,
  parked_at   TEXT, resumed_at TEXT, expired_at TEXT,
  created_at  TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_carts_user_shift ON carts (user_id, shift_id, status);
CREATE INDEX idx_carts_shift      ON carts (shift_id, status);

-- The cart is a table rather than renderer storage because POS-105 requires an
-- in-progress cart to survive an application restart, and localStorage is lost to a
-- reinstall, a Windows profile change and v1.3's second terminal. It holds its lines
-- as JSON deliberately: a cart is not a business record — nothing reports on it and no
-- rule constrains it, and the moment it becomes real it is a sale with its own rows
-- (POS-107). A cart_items table would invite the reporting that must read sale_items.

CREATE TABLE backups (                   -- OPS-002, OPS-003, OPS-006
  id TEXT PRIMARY KEY,
  -- Nullable: a backup that failed before it had a name — no folder configured — is
  -- still an attempt, and it is the worst one to lose. A store with no backup folder
  -- is the most exposed state this product has.
  filename    TEXT,
  path        TEXT,
  size_bytes  INTEGER,
  taken_at    TEXT NOT NULL,
  trigger     TEXT NOT NULL CHECK (trigger IN
                ('SCHEDULED','SHIFT_CLOSE','MANUAL','PRE_RESTORE','PRE_IMPORT','PRE_MIGRATION')),
  -- OPS-002: written and verified are two different events, and the gap between them
  -- is where a bad backup hides. PENDING means the check never completed, so a crash
  -- mid-verify reads as unverified rather than as success.
  verified_at TEXT,
  verification_result TEXT NOT NULL DEFAULT 'PENDING'
                CHECK (verification_result IN ('PENDING','OK','FAILED')),
  error       TEXT,
  schema_version INTEGER,
  row_counts  TEXT,                      -- JSON, for the health panel
  created_by  TEXT REFERENCES users(id), -- NULL for a scheduled backup
  pruned_at   TEXT                       -- OPS-003: the row outlives the file
);

CREATE TABLE alert_dismissals (          -- OPS-007
  id TEXT PRIMARY KEY,
  alert_key    TEXT NOT NULL,
  kind         TEXT NOT NULL,
  dismissed_at TEXT NOT NULL,
  dismissed_by TEXT NOT NULL REFERENCES users(id),
  CHECK (kind NOT IN ('BACKUP_OVERDUE','BACKUP_UNVERIFIED','CLOCK_ANOMALY')),
  UNIQUE (alert_key)
);

CREATE TABLE system_events (             -- OPS-006, OPS-009
  id TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN
                ('CLOCK_ANOMALY','INTEGRITY_CHECK','EXPORT','RESTORE','LAUNCH')),
  occurred_at TEXT NOT NULL,
  ok          INTEGER NOT NULL DEFAULT 1 CHECK (ok IN (0, 1)),
  detail      TEXT,                      -- JSON
  actor_id    TEXT REFERENCES users(id)
);
```

**There is no `alerts` table, and that is deliberate.** `TASK-017` specified one
(`id, type, severity, raised_at, dismissible, dismissed_at, payload`) and it was not built,
because alerts in this product are **derived**: low stock is a query over inventory, overdue
credit a query over the ledger, cash variance a query over the closings, backup overdue a query
over `backups`. Storing them would need a writer deciding when to raise and when to clear, and
would produce rows that go stale — a `LOW_STOCK` row still saying low six hours after the
delivery arrived. `OPS-007` is recomputed on every read instead, which is also what makes
`TASK-017` requirement 11 hold: one derivation cannot disagree with itself, whereas one table
with two writers can.

What is stored is the single fact no query can derive — **that a person dismissed one, and
when** — keyed on the alert's identity so that dismissing "this shift has been open too long"
does not dismiss tomorrow's, and lapsing after a configured window so an alert whose condition
has not gone away comes back. The three that `OPS-007` says may never be dismissed are refused
by a `CHECK` on the table rather than by a guard in a service: a service check is a promise the
next caller can break.

### 3.4.1 v1.1 schema — purchasing (`TASK-019`)

Five tables, in `010_purchasing.sql`. §3.1's conventions are binding here as they are above,
and two of them carry most of the weight.

**`PO-103` is an absence.** Nothing on `purchase_orders` or `purchase_order_items` touches
stock, and no service writes an inventory movement from either. An order is a statement of
intent to a supplier; only a goods receipt moves stock, because `INV-101` has meant "what is on
the shelf" since `TASK-007`, and a system where ordering changes on hand is a system whose stock
figure means "what we expect" instead. `TC-INT-76` asserts it.

**`PO-202` is the split on the receipt line.** `received_qty_milli` is what the van brought;
`damaged_qty_milli` is the part of it that was unsound, not an arrival of its own; and
`sound_qty_milli` is the difference, which is the only figure that posts a `RECEIPT` movement. A
`CHECK` makes "damaged more than arrived" unrepresentable rather than merely unlikely.

```sql
CREATE TABLE suppliers (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,        -- VR-401, NOCASE: one account, one history
  contact_person TEXT, contact_no TEXT, email TEXT, address TEXT,
  terms_days INTEGER NOT NULL DEFAULT 0 CHECK (terms_days >= 0),   -- 0 = cash on delivery
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,            -- VR-401: deactivated, never deleted
  created_at TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT, updated_by TEXT REFERENCES users(id)
);

CREATE TABLE purchase_orders (
  id TEXT PRIMARY KEY,
  po_no TEXT NOT NULL UNIQUE,                      -- PO-YYYYMMDD-NNNNNN (VR-103)
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  status TEXT NOT NULL DEFAULT 'DRAFT'             -- PO-102, and nothing outside it
    CHECK (status IN ('DRAFT','PENDING','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
  -- PO-104: the supplier was told a number, so po_no never changes and the revision
  -- moves with it. The superseded lines live in audit_logs, which AUD-601 already
  -- requires to carry both values on every amendment.
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  ordered_at TEXT, expected_at TEXT, reference_no TEXT, notes TEXT,
  total_centavos INTEGER NOT NULL DEFAULT 0,
  submitted_at TEXT, submitted_by TEXT REFERENCES users(id),
  cancelled_at TEXT, cancelled_by TEXT REFERENCES users(id), cancel_reason TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT, updated_by TEXT REFERENCES users(id)
);
CREATE INDEX idx_po_supplier ON purchase_orders (supplier_id, ordered_at);
CREATE INDEX idx_po_status   ON purchase_orders (status);

CREATE TABLE purchase_order_items (
  id TEXT PRIMARY KEY,
  po_id TEXT NOT NULL REFERENCES purchase_orders(id),
  line_no INTEGER NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  product_name_snapshot TEXT NOT NULL,             -- MON-005's reasoning
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0), -- MON-002, base unit
  order_unit_id TEXT REFERENCES units(id),         -- UOM-002: "50 SACK", not "2,500 KG"
  order_pack_factor_milli INTEGER NOT NULL DEFAULT 1000 CHECK (order_pack_factor_milli > 0),
  unit_cost_centavos INTEGER NOT NULL CHECK (unit_cost_centavos >= 0),  -- per base unit
  line_total_centavos INTEGER NOT NULL,            -- MON-003, rounded once
  notes TEXT,
  UNIQUE (po_id, line_no)
);
CREATE INDEX idx_poitems_product ON purchase_order_items (product_id);

CREATE TABLE goods_receipts (
  id TEXT PRIMARY KEY,
  gr_no TEXT NOT NULL UNIQUE,                      -- GR-YYYYMMDD-NNNNNN (VR-103)
  po_id TEXT REFERENCES purchase_orders(id),       -- PO-207: NULL is the counter purchase
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),   -- required either way
  supplier_dr_no TEXT, invoice_no TEXT,
  -- PO-206: one status, so there is no draft to edit and no way to write anything
  -- else. The correction is an adjustment or a supplier return.
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED')),
  total_centavos INTEGER NOT NULL DEFAULT 0,
  has_over_receipt INTEGER NOT NULL DEFAULT 0,     -- PO-204, flagged on the receipt
  has_cost_variance INTEGER NOT NULL DEFAULT 0,    -- PO-205
  approved_by TEXT REFERENCES users(id),           -- AUD-603's second actor
  approval_reason TEXT, notes TEXT,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id)
);
CREATE INDEX idx_gr_supplier ON goods_receipts (supplier_id, received_at);
CREATE INDEX idx_gr_po       ON goods_receipts (po_id);
CREATE INDEX idx_gr_date     ON goods_receipts (received_at);

CREATE TABLE goods_receipt_items (
  id TEXT PRIMARY KEY,
  gr_id TEXT NOT NULL REFERENCES goods_receipts(id),
  line_no INTEGER NOT NULL,
  po_item_id TEXT REFERENCES purchase_order_items(id),  -- NULL on a direct receipt
  product_id TEXT NOT NULL REFERENCES products(id),
  product_name_snapshot TEXT NOT NULL,
  -- PO-201's four figures. ordered_qty_milli is a snapshot taken at receipt, so a
  -- later revision cannot change what this delivery was measured against.
  ordered_qty_milli  INTEGER NOT NULL DEFAULT 0,
  received_qty_milli INTEGER NOT NULL CHECK (received_qty_milli > 0),
  damaged_qty_milli  INTEGER NOT NULL DEFAULT 0 CHECK (damaged_qty_milli >= 0),
  sound_qty_milli    INTEGER NOT NULL CHECK (sound_qty_milli >= 0),
  receive_unit_id TEXT REFERENCES units(id),
  receive_pack_factor_milli INTEGER NOT NULL DEFAULT 1000 CHECK (receive_pack_factor_milli > 0),
  -- PO-203: the average moves at this one, the actual. The ordered cost sits beside it
  -- so PO-205's variance stays answerable from the row for ever.
  unit_cost_centavos INTEGER NOT NULL CHECK (unit_cost_centavos >= 0),
  ordered_unit_cost_centavos INTEGER,
  cost_variance_bp INTEGER,
  line_total_centavos INTEGER NOT NULL,            -- MON-003, the sound value
  is_over_receipt  INTEGER NOT NULL DEFAULT 0,
  is_cost_variance INTEGER NOT NULL DEFAULT 0,
  batch_no TEXT, expiry_date TEXT,                 -- INV-206, v1.2; nullable now
  movement_id TEXT REFERENCES inventory_movements(id),  -- NULL when sound is zero
  damage_note TEXT,
  UNIQUE (gr_id, line_no),
  CHECK (damaged_qty_milli <= received_qty_milli),
  CHECK (sound_qty_milli = received_qty_milli - damaged_qty_milli)
);
CREATE INDEX idx_gritems_product ON goods_receipt_items (product_id);
CREATE INDEX idx_gritems_poitem  ON goods_receipt_items (po_item_id);
```

**Two figures are derived rather than stored.** How much of a PO line has arrived is summed
from `goods_receipt_items` at read time, and the order's status is recomputed from that sum
after each receipt. Both follow `INV-101`'s reasoning applied to a different table: a stored
"received so far" is a second number that must agree with the receipts, and it drifts on
exactly the rollback the transaction exists to survive.

**`TASK-019`'s brief named these `purchase_order_lines` and `goods_receipt_lines`.** They are
`_items` here, matching §3.3's entity overview and `sale_items`, because §3.3 had already
published the names and the data model is this document's to own.

### 3.4.2 v1.1 schema — sales returns (`TASK-020`)

Two tables, in `011_returns.sql`. `POS-107` is not contradicted by them: a return is a **new
document that cites the sale**, exactly as a void will be. The two columns on the sale that a
return does move — `sale_items.returned_qty_milli` and `sales.status` — already existed in
`006_sales.sql` and were put there for this, and `saleRepository` gets two narrowly named
setters rather than a general update path.

**`POS-303` is the shape of `sale_return_items`.** The disposition is per line, and it is
recorded next to what the rule *said* it should be. `default_disposition` is not redundant with
`disposition`: `POS-304` makes a medicine default to write-off, and the pair of columns is what
distinguishes "restocked, as normal" from "restocked against the default, and here is who
authorised it". A single column would make that exception unfindable a month later.

**`POS-305`'s precedence is three columns rather than one method**, because a single refund can
split: a customer who owes ₱300 and returns ₱500 of goods has ₱300 taken off the balance and
₱200 handed back. A `method` column would have to pick one and lose the other. A `CHECK` makes
the three sum to the total, so that is a property of the table rather than a promise in a
service.

```sql
CREATE TABLE sale_returns (
  id TEXT PRIMARY KEY,
  return_no TEXT NOT NULL UNIQUE,                  -- RET-YYYYMMDD-NNNNNN (VR-103)
  sale_id TEXT NOT NULL REFERENCES sales(id),
  customer_id TEXT REFERENCES customers(id),       -- NULL = the walk-in who bought it
  shift_id TEXT NOT NULL REFERENCES cashier_shifts(id),          -- POS-509's sixth term
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED')),
  reason TEXT NOT NULL, notes TEXT,                -- POS-302: listed, plus free text
  total_centavos INTEGER NOT NULL CHECK (total_centavos > 0),
  refund_credit_centavos       INTEGER NOT NULL DEFAULT 0,       -- POS-305, in precedence
  refund_cash_centavos         INTEGER NOT NULL DEFAULT 0,
  refund_store_credit_centavos INTEGER NOT NULL DEFAULT 0,
  credit_txn_id TEXT REFERENCES customer_credit_transactions(id),-- POS-306
  beyond_window INTEGER NOT NULL DEFAULT 0,        -- POS-307, recorded not inferred
  approved_by TEXT REFERENCES users(id), approval_reason TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id),
  CHECK (refund_credit_centavos + refund_cash_centavos + refund_store_credit_centavos
         = total_centavos)
);

CREATE TABLE sale_return_items (
  id TEXT PRIMARY KEY,
  return_id TEXT NOT NULL REFERENCES sale_returns(id),
  line_no INTEGER NOT NULL,
  sale_item_id TEXT NOT NULL REFERENCES sale_items(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  product_name_snapshot TEXT NOT NULL,
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),              -- MON-002, base unit
  unit_price_centavos INTEGER NOT NULL,            -- MON-005: from the sale line,
  unit_cost_centavos  INTEGER NOT NULL,            -- never from the product today
  tax_centavos INTEGER NOT NULL DEFAULT 0,
  line_total_centavos INTEGER NOT NULL CHECK (line_total_centavos >= 0),
  disposition         TEXT NOT NULL CHECK (disposition IN ('RESTOCK','WRITE_OFF')),
  default_disposition TEXT NOT NULL CHECK (default_disposition IN ('RESTOCK','WRITE_OFF')),
  restock_approved_by TEXT REFERENCES users(id),                 -- POS-304
  return_movement_id    TEXT REFERENCES inventory_movements(id), -- POS-303: two columns,
  write_off_movement_id TEXT REFERENCES inventory_movements(id), -- because two rows
  UNIQUE (return_id, line_no)
);
```

**`POS-307` is stored rather than derived from the dates.** The window is a setting; a report
read next year must say whether a return was late *then*, not whether it would be late under
today's figure.

**Two figures are derived rather than stored.** How much of a sale line has come back is summed
from `sale_return_items` whenever the limit is checked, and the sale's status is recomputed from
those sums after each return. `sale_items.returned_qty_milli` is maintained alongside as the
figure every screen reads — `INV-101`'s reasoning applied to a fourth table, with `TC-INT-81`
asserting the two agree after repeated partial returns, because a materialised counter nobody
reconciles is a counter that drifts.

### 3.4.3 v1.1 schema — stock counting (`TASK-022`)

Two tables, in `012_stock_counts.sql`, and the whole design is one column:
`stock_count_lines.expected_milli`, **written when the session opens and never
re-read**. Without it a store that counts for three hours while trading measures its
variance against a figure that moved while somebody walked the aisle, and finds
discrepancies it created by counting slowly. `avg_cost_centavos` is frozen beside it
for the same reason (`MON-004`, `MON-005`): the variance report values the difference
at the cost that applied when it was found, not at whatever a delivery has since moved
the average to.

**The freeze is one `INSERT` per product inside one transaction**, not a read in
JavaScript followed by inserts. Writing the rows one at a time would leave a window in
which a sale could commit between the first product and the last, and the session would
then hold two different ideas of "now" — the corruption `INV-110` exists to prevent,
reintroduced by the code meant to implement it.

**`counted_milli` is nullable, has no default, and NULL is not zero.** A store counting
four hundred products may genuinely not reach them all, and a column defaulting to 0
would write off the entire uncounted remainder of the shop as shrinkage the moment
somebody posted a half-finished session. `INV-111`'s "one movement per varying product"
is therefore read as "per **counted** product that varies", and the posting reports how
many were never reached.

```sql
CREATE TABLE stock_count_sessions (
  id TEXT PRIMARY KEY,
  count_no TEXT NOT NULL UNIQUE,                   -- SC-YYYYMMDD-NNNNNN (VR-103)
  scope TEXT NOT NULL DEFAULT 'ALL' CHECK (scope IN ('ALL','CATEGORY')),
  category_id TEXT REFERENCES categories(id),
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','APPROVED','POSTED','CANCELLED')),
  notes TEXT,
  opened_at TEXT NOT NULL,                         -- INV-110's instant; INV-113 measures from it
  opened_by TEXT NOT NULL REFERENCES users(id),
  approved_at TEXT, approved_by TEXT REFERENCES users(id),
  approval_waived INTEGER NOT NULL DEFAULT 0,      -- INV-112, where there is no second user
  posted_at TEXT, posted_by TEXT REFERENCES users(id),
  was_stale INTEGER NOT NULL DEFAULT 0,            -- INV-113, recorded not inferred
  stale_approved_by TEXT REFERENCES users(id),
  cancelled_at TEXT, cancelled_by TEXT REFERENCES users(id), cancel_reason TEXT,
  counted_products INTEGER, varying_products INTEGER, variance_value_centavos INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE stock_count_lines (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES stock_count_sessions(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  product_name_snapshot TEXT NOT NULL,             -- MON-005
  expected_milli INTEGER NOT NULL,                 -- INV-110's freeze
  avg_cost_centavos INTEGER NOT NULL,              -- MON-004 at the freeze
  counted_milli INTEGER,                           -- NULL until counted; NULL is not zero
  counted_at TEXT, counted_by TEXT REFERENCES users(id),
  note TEXT,
  movement_id TEXT REFERENCES inventory_movements(id),   -- INV-111: NULL where it matched
  UNIQUE (session_id, product_id)
);
```

**The variance posted is `counted − expected`, never `counted − live`**, and the
difference is worth a worked example because both mistakes are one character away. A
shelf holds 10 sacks at the freeze, the counter finds 9 at 09:30, and the shop sells 2
at 11:00 before anybody posts. `counted − expected` is −1: posting it leaves 8 − 1 = 7,
which is right — nine really were there and two have since been sold. `counted − live`
is +1: it would *add* a sack, erase one of the two sales and report a surplus where
there was a shortage. **So after posting, on hand is not the counted figure** — it is
the counted figure plus whatever traded since the freeze, and `SCR-205` prints that
sentence because a store that does not know it will report the ledger as broken.

`stock_count_lines` is not `_items` (§3.3's convention for a document's children)
because these are not a document's contents: every product in scope gets a row whether
or not anybody counts it, which is a worksheet rather than a set of lines somebody
entered. `INV-111`'s whole point is that most of them do nothing.

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
migrations/007_carts.sql            carts (POS-105's parked sale)
migrations/008_report_indexes.sql   indexes only — no table
migrations/009_backups_alerts.sql   backups, alert_dismissals, system_events
migrations/010_purchasing.sql       suppliers, purchase orders and items, goods receipts and items
migrations/011_returns.sql          sale returns and items (POS-301 – POS-307)
migrations/012_stock_counts.sql     stock count sessions and lines (INV-110 – INV-113)
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
| `POST` | `/sales/price-check` | `TX-401` | resolves `PR-101` for a cart without committing. Since `TASK-023` it also applies `PR-106`'s tier and `PR-202`'s category ceiling, and reports `PR-206`'s choice per line |
| `GET` | `/sales/pricing-policy` | `TX-401` | The acting user's ceiling, who may approve above it, and — since `TASK-023` — the configured tiers and capped categories, so no screen holds a copy (`OPS-005`) |
| `POST` | `/sales` | `TX-401` | **the transaction** — `FR_3.5` |
| `POST` | `/sales/:id/reprint` | `TX-430` | `POS-208` |
| `GET` | `/reports/dashboard?date=` | `TX-421` | `FR_6.1` — every tile from the query behind it |
| `GET` | `/reports/alerts` | `TX-421` | `OPS-007` |
| `GET` | `/reports/daily?from=&to=&shiftId=` | `TX-421` | `RPT-101`, `RPT-104` |
| `GET` | `/reports/payments?from=&to=&shiftId=` | `TX-421` | `RPT-102` |
| `GET` | `/reports/inventory/valuation` | `TX-422` | `RPT-103` |
| `GET` | `/reports/:report/export.csv` | `TX-426` + the report's own grant | `AUD-601` |
| `GET` | `/suppliers?q=&includeInactive=` | `TX-409` | `FT-501` |
| `GET` | `/suppliers/:id` | `TX-409` | |
| `POST` `PUT` | `/suppliers` `/suppliers/:id` | `TX-409` | `VR-401` — name required and unique, NOCASE |
| `POST` | `/suppliers/:id/deactivate` `/reactivate` | `TX-409` | `VR-401` — refused while an order is outstanding |
| `DELETE` | `/suppliers/:id` | `TX-409` | Always 409. Orders and deliveries reference them (`VR-401`) |
| `GET` | `/purchase-orders?supplierId=&status=&open=&q=&from=&to=` | `TX-409` | `SCR-801`; serves the status list its filter is built from |
| `GET` | `/purchase-orders/:id` | `TX-409` | Lines, what has arrived against each, and the deliveries |
| `POST` | `/purchase-orders` | `TX-409` | `PO-101`. **Writes no inventory movement** (`PO-103`) |
| `PUT` | `/purchase-orders/:id` | `TX-409` | `PO-104` — a `DRAFT` is edited, a `PENDING` order is amended into a new revision. The server decides which |
| `POST` | `/purchase-orders/:id/submit` | `TX-409` | `PO-102` — `DRAFT` → `PENDING` |
| `POST` | `/purchase-orders/:id/cancel` | `TX-409` | `PO-105` — refused once anything has been received |
| `GET` | `/goods-receipts?supplierId=&poId=&flaggedOnly=&from=&to=` | `TX-409` | `flaggedOnly` finds `PO-204`/`PO-205` exceptions afterwards |
| `GET` | `/goods-receipts/:id` | `TX-409` | |
| `POST` | `/goods-receipts` | `TX-409` | `PO-201`–`PO-207`. `poId` absent is the counter purchase and still needs a `supplierId`. The `approver` is a username, resolved against `users` server-side (`SEC-6`) |
| `PUT` `DELETE` | `/goods-receipts/:id` | `TX-409` | Always 409 — `PO-206`, and the refusal names the adjustment or return that is the correction |
| `GET` | `/products/:id/purchase-history` | `TX-409` | What this product has cost, from whom, and when |
| `GET` `POST` | `/stock-counts` | `TX-407` | `INV-110` — the `POST` opens a session and **freezes** the expected quantity of every product in scope, in one transaction |
| `GET` | `/stock-counts/:id?varyingOnly=&uncountedOnly=` | `TX-407` | The session and its worksheet. A line's `counted_milli` is `null` until somebody counts it, and `null` is not `0` |
| `PUT` | `/stock-counts/:id/lines` | `TX-407` | Counted quantities, in batches and repeatedly — a stocktake spans a lunch break. `countedMilli: null` clears a line back to uncounted |
| `POST` | `/stock-counts/:id/approve` | `TX-408` | `INV-112` — refused to the person who took the count, on identity rather than role. Waived and **stated** where the store has one active user |
| `POST` | `/stock-counts/:id/post` | `TX-407` | `INV-111`, `INV-113`. One transaction. A stale session needs an owner in the `approver` |
| `POST` | `/stock-counts/:id/cancel` | `TX-407` | Abandoned with a reason — three abandoned counts in a row is itself a fact worth keeping |
| `GET` | `/stock-counts/:id/variance` | `TX-422` | Requirement 8's report: shortage and surplus separately, valued at the frozen cost |
| `DELETE` `PATCH` | `/stock-counts/:id` | `TX-407` | Always 409 — `INV-102` |
| `GET` | `/sales?q=&from=&to=&customerId=&status=&returnable=` | `TX-401` | `SCR-305`'s lookup. `returnable=true` is `POS-301`'s two statuses, named server-side so the screen keeps no copy |
| `GET` | `/sales/:id/voidable` | `TX-401` | `POS-402`'s window and `POS-403`'s authority, answered before `SCR-304` draws the button. Read-only |
| `POST` | `/sales/:id/void` | `TX-401` | `POS-401`–`POS-404`. One transaction. **Not `TX-405`** — see the note below the table |
| `GET` | `/reports/voids?from=&to=&shiftId=` | `TX-421` | `POS-404`'s second half: the one report that looks *for* voids rather than past them |
| `GET` | `/sales/:id/returnable` | `TX-406` | What is left to give back per line, `POS-304`'s default and the sentence for it, and `POS-307`'s window — every one of them a rule, so none is computed in the renderer |
| `POST` | `/sales/:id/returns` | `TX-406` | `POS-301`–`POS-307`. One transaction. The `approver` is a username, resolved against `users` server-side (`SEC-6`) |
| `GET` | `/sales/:id/returns` `/returns` `/returns/:id` | `TX-406` | The returns against one sale, the list, and one return with its lines |
| `PUT` `DELETE` | `/returns/:id` | `TX-406` | Always 409 — a posted return is immutable, and the refusal names the adjustment that is the correction (`INV-102`) |
| `GET` | `/audit?actor=&action=&entity=&from=&to=` | `TX-429` | `SCR-703`; serves the action and actor lists its filters are built from |
| `GET` | `/audit/export` | `TX-429` | The same query as CSV. Not `TX-426`: exporting the trail is reading it, and the export is itself audited (`AUD-601`) |
| `GET` | `/backups` | `TX-428` | `SCR-704` — the log, the folder, and `SEC-9`'s warning |
| `POST` | `/backups` | `TX-428` | `OPS-001`, `OPS-002` |
| `GET` | `/backups/restore/preflight` | `TX-427` | what must be true before a restore |
| `POST` | `/backups/:id/restore` | `TX-427` | `OPS-004` — owner only, typed filename |
| `GET` | `/alerts` | signed in | `OPS-007` |
| `POST` | `/alerts/dismiss` | signed in | `OPS-007` — never the undismissible three |
| `POST` | `/health/integrity-check` | `TX-428` | `OPS-006` |
| `GET` | `/health` | — | liveness only: a status and a version |
| `GET` | `/health/panel` | `TX-428` | `OPS-006` — `SCR-705`'s six figures |

`GET /health` is unauthenticated because `main.js` polls it before the window opens, so it is
deliberately thin: a status and a version, and nothing about the store. `OPS-006`'s figures are
on `/health/panel` behind `TX-428`. `SEC-8` opens the bind address to the LAN in v1.3, and an
unauthenticated endpoint reporting row counts and the database path would go with it.

`TX-421` is the one grant in this table the middleware does not fully decide. It is `OWN_SHIFT`
for a `CASHIER`, so `requirePermission` admits them and `reportService` decides which shift they
may read — refusing with `403` and writing an audit row, never narrowing the answer silently. A
cashier handed their own till's figures under a store-wide heading has been told something false.

**`PR-202` inverts the usual direction, and the API says so where it refuses.** A category
maximum overrides a *higher* role ceiling: the effective ceiling is the **lower** of the two, so
an owner with a 100% role ceiling still cannot give 20% on a category capped at 5%. The refusal
therefore names which of the two bound — and where it is the category, `requires_role` is
**null**, because no manager can release a cap the owner set on the category and sending the
cashier to fetch one would be an errand that ends in the same refusal.

**Counting is `TX-407` and approving is `TX-408`, and the split is the control.** §10 grants
`TX-407` — "post an inventory adjustment" — to the owner, the manager and the inventory clerk,
which is exactly the set who walk the aisles with a clipboard; `TX-408` — "approve a stock
count" — is the owner and the manager alone. A clerk may therefore count and may not release
what they counted, which is `INV-112` expressed in the permission matrix rather than only in a
service. Posting stays on `TX-407`: by then a second person has already approved it, and
requiring the approver to press the button as well would mean a manager walking back to the
terminal for a clerk's stocktake.

**The void sits under `TX-401`, not `TX-405`, and that is deliberate.** §10 grants `TX-405` to a
manager and an owner only, so a route behind it would be a route a cashier cannot call — and
`POS-403` says a cashier may never void *unaided*, which is a rule about authorisation, not about
who may ask. The cashier is the person who notices the mis-scan. So the counter's own grant opens
the door and `voidService` enforces `TX-405` inside, where the refusal can name `POS-403` and open
the inline authorisation panel rather than answering `403` at the edge with nothing to do next.
The same reasoning, from the other side, is why `POS-402`'s window is checked on the **sale's**
shift and not the actor's: a manager with no drawer of their own may still void a cashier's
mis-scan, and `TX-419` — "close another user's shift" — is the grant that already governs acting
on a drawer you did not count.

All of purchasing is behind `TX-409` — §10's "receive goods" — because §10 has no separate
grant for raising an order and `TX-409`'s roles are exactly the right set: owner, manager and
the inventory clerk, never a cashier. A new permission would be a change to
`03_BUSINESS_RULES.md` §10, which `TASK-019` was not scoped to make. A goods receipt moves
average cost, which is otherwise `TX-412` and owner-only; it is not gated on that, because
`PO-203` makes the cost move a **consequence** of a delivery rather than an edit of a product —
a clerk is being asked what the van charged, not being allowed to retype a margin, and
`PO-205`'s authorisation is what covers the case where that answer is wrong.

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
./tools/installer/check.sh       # the NSIS macros compile and say what §7 requires
npm run build:exe                # -> dist/ChachiAgrivetPOS-Setup-<version>.exe
npm rebuild better-sqlite3       # see below — do this before running the tests again
```

**Build the installer on Windows.** `electron-builder` needs `wine` to stamp the binary and
to assemble NSIS anywhere else; on a Linux build machine it packages the application
successfully and then stops at that step. `tools/installer/check.sh` compiles the
hand-written macros natively, so the half of the installer script that can be wrong is
verifiable without Windows.

**`build:exe` rebuilds `better-sqlite3` for the target platform**, which replaces the local
native module and leaves the test suite failing with `invalid ELF header` until
`npm rebuild better-sqlite3` puts it back. Run the gate before the build, not after — or
rebuild in between.

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
