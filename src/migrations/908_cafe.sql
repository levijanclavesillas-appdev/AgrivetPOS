-- 908_cafe.sql — a café or restaurant (TASK-066)
-- Source of truth: docs/PHARMACY_EDITION.md §13 and src/config/industries.js. Conventions in
-- 05_TECH_SPEC.md §3.1 are binding.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).
--
-- A café sells food made when it is ordered, takes the order before it is paid, tells
-- the kitchen, and may add a service charge to a dine-in bill. Four changes carry that:
--
--   * `store_profile.industry` admits CAFE. 904's CHECK named the industries on the
--     roadmap and a café was not one of them, and a CHECK cannot be altered in SQLite, so
--     the table is rebuilt: the same columns, in the same order, and the one row copied.
--   * `products.is_stocked` (INV-114). A made-to-order product keeps no stock: selling it
--     moves none, and nothing can receive, count or adjust it.
--   * `sales` records how the order was served and where (POS-109), and the service charge
--     (POS-112) as its own figure: it is not a product, and it is not in the subtotal.
--     `sale_items.note` is the line's note to the kitchen (POS-111).
--   * `open_orders` (POS-109): an order taken and not yet paid. Like a cart it belongs to
--     the counter it was taken at and is never synced (config/syncTables.js); unlike a
--     parked cart it outlives the shift, because the table is still eating when the
--     drawer is counted. Its lines are JSON for the reason 007_carts.sql gives: the order
--     becomes a sale with its own rows the moment it is paid, and nothing reports on it
--     before then.

CREATE TABLE store_profile_new (
  id            TEXT PRIMARY KEY,
  store_name    TEXT NOT NULL,
  address       TEXT,
  contact_no    TEXT,
  tin           TEXT,
  tax_mode      TEXT NOT NULL CHECK (tax_mode IN ('NONE','NON_VAT','VAT')),  -- TAX-001
  currency      TEXT NOT NULL DEFAULT 'PHP',
  created_at    TEXT NOT NULL,
  updated_at    TEXT,
  updated_by    TEXT REFERENCES users(id),
  industry      TEXT NOT NULL DEFAULT 'PHARMACY'
                  CHECK (industry IN ('PHARMACY', 'AGRIVET', 'CAFE', 'MOTORCYCLE', 'RETAIL'))
);

INSERT INTO store_profile_new
  (id, store_name, address, contact_no, tin, tax_mode, currency, created_at, updated_at, updated_by, industry)
SELECT id, store_name, address, contact_no, tin, tax_mode, currency, created_at, updated_at, updated_by, industry
  FROM store_profile;

DROP TABLE store_profile;
ALTER TABLE store_profile_new RENAME TO store_profile;

-- INV-114: 1 keeps stock, as every product before this file did.
ALTER TABLE products ADD COLUMN is_stocked INTEGER NOT NULL DEFAULT 1 CHECK (is_stocked IN (0, 1));

-- POS-109: NULL on a sale rung up the way a shop rings one up.
ALTER TABLE sales ADD COLUMN order_type TEXT CHECK (order_type IN ('DINE_IN', 'TAKE_OUT', 'DELIVERY'));
ALTER TABLE sales ADD COLUMN table_label TEXT;
-- POS-112: the rate in force and what it came to, both snapshotted (MON-005).
ALTER TABLE sales ADD COLUMN service_charge_bp INTEGER NOT NULL DEFAULT 0 CHECK (service_charge_bp >= 0);
ALTER TABLE sales ADD COLUMN service_charge_centavos INTEGER NOT NULL DEFAULT 0 CHECK (service_charge_centavos >= 0);

-- POS-111
ALTER TABLE sale_items ADD COLUMN note TEXT;

CREATE TABLE open_orders (
  id              TEXT PRIMARY KEY,
  -- The number called across the counter, from 1 each day (Manila) on this counter.
  order_no        INTEGER NOT NULL CHECK (order_no > 0),
  business_date   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'PAID', 'VOIDED')),
  order_type      TEXT NOT NULL CHECK (order_type IN ('DINE_IN', 'TAKE_OUT', 'DELIVERY')),
  table_label     TEXT,
  customer_id     TEXT REFERENCES customers(id),
  -- The lines as a cart holds them. Prices are not stored: they are resolved when it is
  -- paid (§4.1 step 2), as a parked cart's are.
  payload         TEXT NOT NULL,
  -- What the kitchen has been told, so the next ticket carries only what changed.
  sent            TEXT NOT NULL DEFAULT '[]',
  line_count      INTEGER NOT NULL DEFAULT 0,
  ticket_count    INTEGER NOT NULL DEFAULT 0,
  opened_by       TEXT NOT NULL REFERENCES users(id),
  opened_shift_id TEXT REFERENCES cashier_shifts(id),
  opened_at       TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  sale_id         TEXT REFERENCES sales(id),
  closed_at       TEXT,
  closed_by       TEXT REFERENCES users(id),
  void_reason     TEXT,
  UNIQUE (business_date, order_no),
  -- Paid means a sale, and a void means a reason.
  CHECK (status <> 'PAID' OR sale_id IS NOT NULL),
  CHECK (status <> 'VOIDED' OR void_reason IS NOT NULL)
);

CREATE INDEX idx_open_orders_status ON open_orders (status, opened_at);
CREATE INDEX idx_open_orders_sale ON open_orders (sale_id);
