-- 909_wholesale_retail.sql — a sari-sari store, grocery or distributor (TASK-070)
-- Source of truth: docs/PHARMACY_EDITION.md §14 and src/config/industries.js. Conventions in
-- 05_TECH_SPEC.md §3.1 are binding.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).
--
-- store_profile already admits RETAIL (908 listed it for this day). What the store type
-- needs that no store could do before:
--
--   * `product_pack_prices` (PR-108): a case of 24 has a price of its own, per price level,
--     dated like product_prices. Where a pack has none, it sells at its contents × the
--     unit price, as before.
--   * `sale_items.priced_per_pack`: 1 where the line was charged a pack's own price. Its
--     `unit_price_centavos` is then the price of one pack, and the line's gross is that
--     price × the number of packs, not × the base quantity.
--   * `units.step_milli`: the smallest quantity sold by amount ("₱20 of rice") rounds down
--     to. NULL is a thousandth of the unit.
--   * `quick_keys` (POS-113): the store's own buttons at the counter.

CREATE TABLE product_pack_prices (
  id             TEXT PRIMARY KEY,
  product_id     TEXT NOT NULL REFERENCES products(id),
  unit_id        TEXT NOT NULL REFERENCES units(id),
  price_level    TEXT NOT NULL CHECK (price_level IN ('RETAIL','WHOLESALE','DEALER')),
  -- NULL: from this date the pack has no price of its own at this level (it was cleared).
  price_centavos INTEGER CHECK (price_centavos IS NULL OR price_centavos >= 0),
  effective_from TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  created_by     TEXT REFERENCES users(id),
  UNIQUE (product_id, unit_id, price_level, effective_from)
);
CREATE INDEX idx_pack_prices_lookup ON product_pack_prices (product_id, unit_id, price_level, effective_from DESC);

ALTER TABLE sale_items ADD COLUMN priced_per_pack INTEGER NOT NULL DEFAULT 0 CHECK (priced_per_pack IN (0, 1));

ALTER TABLE units ADD COLUMN step_milli INTEGER CHECK (step_milli IS NULL OR step_milli > 0);

CREATE TABLE quick_keys (
  id           TEXT PRIMARY KEY,
  position     INTEGER NOT NULL UNIQUE CHECK (position BETWEEN 1 AND 24),
  product_id   TEXT NOT NULL REFERENCES products(id),
  -- A pack of the product, or NULL for its base unit.
  pack_unit_id TEXT REFERENCES units(id),
  -- What the button says, where the product's name is too long for it.
  label        TEXT,
  created_at   TEXT NOT NULL,
  created_by   TEXT REFERENCES users(id)
);
