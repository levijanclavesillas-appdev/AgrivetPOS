-- 002_catalog.sql — categories, brands, units, products, barcodes, packs, prices
-- Source of truth: 05_TECH_SPEC.md §3.4. Conventions in §3.1 are binding:
-- TEXT UUIDv7 keys (VR-101), INTEGER centavos (MON-001), ISO-8601 UTC text (VR-102),
-- enumerations as TEXT + CHECK, every foreign key declared.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).
--
-- This resolves the two legacy contradictions the catalog inherited: legacy §16 fixed
-- 1 Sack = 50 KG without saying which unit stock was held in, and §13 gave a product
-- one barcode field while §79 listed a product_barcodes table. Here a product has
-- exactly one immutable base unit (UOM-001, UOM-003), packs convert against it
-- (UOM-002), and barcodes are a table (VR-205).

CREATE TABLE categories (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE,               -- VR-209
  max_discount_bp INTEGER,               -- PR-202, basis points; NULL = no ceiling
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE brands (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- VR-209
  is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);

CREATE TABLE units (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- KG, PC, SACK, L
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
-- Both directions are hot. idx_barcode answers the scan at the counter (NFR_1.2);
-- this one answers "the barcodes of this product", which the editor asks for and,
-- more importantly, which product search asks once per candidate row. Without it a
-- search over 5,000 products scans the whole barcode table per row.
CREATE INDEX idx_barcode_product ON product_barcodes (product_id);

CREATE TABLE product_packs (             -- UOM-002: 1 SACK = 50 KG -> factor_milli 50000
  id TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products(id),
  unit_id     TEXT NOT NULL REFERENCES units(id),
  factor_milli INTEGER NOT NULL CHECK (factor_milli > 0),          -- VR-207
  is_default_sell INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  UNIQUE (product_id, unit_id)
);
CREATE INDEX idx_packs_product ON product_packs (product_id);

CREATE TABLE product_prices (            -- PR-101 levels 3-4 in v1.0
  id TEXT PRIMARY KEY,
  product_id     TEXT NOT NULL REFERENCES products(id),
  price_level    TEXT NOT NULL CHECK (price_level IN ('RETAIL','WHOLESALE','DEALER')),
  price_centavos INTEGER NOT NULL CHECK (price_centavos >= 0),      -- VR-203
  effective_from TEXT NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT REFERENCES users(id),
  UNIQUE (product_id, price_level, effective_from)
);

-- Price resolution reads the newest row at or before "now" for a level (PR-101). The
-- index is on the way that query runs, descending, because a product accumulates one
-- row per price change forever and the current price is the only one the counter ever
-- asks for.
CREATE INDEX idx_prices_lookup ON product_prices (product_id, price_level, effective_from DESC);
