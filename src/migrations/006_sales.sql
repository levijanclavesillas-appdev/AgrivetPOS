-- 006_sales.sql — the sale, its lines, its tenders and its discounts
-- Source of truth: 05_TECH_SPEC.md §3.4. Conventions in §3.1 are binding.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).
--
-- This is the keystone table. INV-107 is why it and its children exist in one
-- migration and are written in one transaction: the sale, its lines, its tenders, its
-- inventory movements and its credit transaction commit together or not at all.
--
-- MON-005 is why sale_items carries so many _snapshot columns. Every figure a report
-- will ever need is frozen at the instant of sale — price, cost, discount, tax class,
-- and the product's own name. No report joins to the live product record for a
-- historical figure, because a product renamed or repriced next month must not
-- retroactively change what a sale last March was worth.

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

-- POS-108: the daily sequence is derived from this table inside the sale's own
-- transaction, so a rollback frees the number again. There is no counter table to
-- drift out of step with the rows it counts.
CREATE INDEX idx_sales_no ON sales (sale_no);

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
  -- POS-206: RECORDED means "the cashier saw it". The CHECK admits no other value, so
  -- there is no way to write VERIFIED — no payment API confirms these, and a column
  -- that could say "confirmed" is one a report would eventually print.
  status   TEXT NOT NULL DEFAULT 'RECORDED' CHECK (status IN ('RECORDED')),
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
CREATE INDEX idx_discounts_sale ON sale_discounts (sale_id);
