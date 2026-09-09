-- 013_negotiated_pricing.sql — PR-101's top two levels
-- Source of truth: 05_TECH_SPEC.md §3.4. Conventions in §3.1 are binding.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).
--
-- PR-101 names four price levels and 002_catalog.sql built the bottom two, with its
-- own comment saying so: "PR-101 levels 3-4 in v1.0". These are levels 1 and 2, and
-- the resolver has been walking past them returning null since TASK-009.
--
-- **The two tables differ in one way, and the difference is deliberate.**
--
-- `customer_prices` is an append-only history, like `product_prices`: a price is not
-- edited, a row with a later `effective_from` supersedes it, and the old one stays so
-- that a receipt from March can still be explained.
--
-- `product_quantity_breaks` holds the **current set** and is replaced when it changes.
-- An append-only band table cannot express the one state a band set genuinely reaches
-- and a price never does: **no bands at all**. Writing an empty generation writes no
-- rows, so "remove the breaks" would leave the previous set in force — which is not a
-- subtle failure, it is the feature not working. So a revision deletes the level's rows
-- and writes the new ones in one transaction, and the history lives where it is more
-- useful anyway: AUD-601's trail already records the whole before-and-after set on
-- every change. Nothing depends on the old rows, because MON-005 snapshots the resolved
-- price onto the sale line at the moment of sale.
--
-- PR-103 is absolute and needs no column to say so: a customer price is level 1, and
-- the resolver stops at the first level that answers. What it *is* still subject to is
-- PR-202's category ceiling and PR-105's below-cost check — a negotiated price is not a
-- licence to sell below cost unnoticed, and neither of those lives here.

CREATE TABLE customer_prices (           -- PR-101 level 1 · PR-103
  id             TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL REFERENCES customers(id),
  product_id     TEXT NOT NULL REFERENCES products(id),
  price_centavos INTEGER NOT NULL CHECK (price_centavos >= 0),      -- VR-203
  -- Superseded by a later row rather than updated, exactly as product_prices is. The
  -- UNIQUE is on the triple, so agreeing a new price today and another next month is
  -- two rows and one history.
  effective_from TEXT NOT NULL,
  -- What was agreed, in the words of whoever agreed it. A negotiated price with no
  -- account of why is the row nobody can defend a year later, and the store's
  -- negotiations are verbal.
  note           TEXT,
  created_at     TEXT NOT NULL,
  created_by     TEXT NOT NULL REFERENCES users(id),
  UNIQUE (customer_id, product_id, effective_from)
);
CREATE INDEX idx_custprice_lookup ON customer_prices (customer_id, product_id, effective_from);
CREATE INDEX idx_custprice_product ON customer_prices (product_id);

CREATE TABLE product_quantity_breaks (   -- PR-101 level 2 · PR-104
  id             TEXT PRIMARY KEY,
  product_id     TEXT NOT NULL REFERENCES products(id),
  -- PR-104: "per product per price level". A wholesale customer's breaks are not a
  -- retail customer's, and the level is part of the key rather than a filter.
  price_level    TEXT NOT NULL CHECK (price_level IN ('RETAIL','WHOLESALE','DEALER')),
  -- MON-002, in base units. A band starting at zero would be the level price wearing a
  -- different name, so the CHECK requires a positive threshold.
  min_qty_milli  INTEGER NOT NULL CHECK (min_qty_milli > 0),
  price_centavos INTEGER NOT NULL CHECK (price_centavos >= 0),
  -- When this set was defined. Metadata, not a generation key: the table holds the
  -- current set and nothing else, so there is no older generation to select past.
  defined_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  created_by     TEXT NOT NULL REFERENCES users(id),
  -- Two bands cannot start at the same quantity, which is as much as a UNIQUE can say.
  -- The rest of PR-104 — that bands ascend and do not overlap, and that each is
  -- cheaper than the one below — is a property of the *set* and is enforced where a
  -- set is written, in productService. A constraint that checked rows one at a time
  -- would pass a set that contradicted itself.
  UNIQUE (product_id, price_level, min_qty_milli)
);
CREATE INDEX idx_qtybreak_lookup ON product_quantity_breaks (product_id, price_level);
