-- 015_count_by_batch.sql — counting batch-tracked stock, by batch (TASK-042)
-- Source of truth: 05_TECH_SPEC.md §3.4. Conventions in §3.1 are binding.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).
--
-- ── Why a count sheet needed a batch at all ───────────────────────────────────
--
-- TASK-029 made a batch's quantity the stock ledger's own sum (INV-201), so
-- inventoryService.post refuses a movement of a batch-tracked product that does not
-- name a batch. A stock count posts one COUNT_VARIANCE per varying product, and a
-- product-level count has nothing to name: **which batch is short is not something one
-- counted figure can say.** Three vials missing from a shelf holding two batches is
-- not a fact about the product, it is a fact about one of the two boxes, and only the
-- person at the shelf knows which.
--
-- Posting the variance against the earliest-expiring batch was considered and
-- rejected. Shrinkage is not FEFO — a box knocked behind the fridge is whichever box
-- was knocked behind the fridge — and a count that invented the answer would produce a
-- batch balance that reconciles perfectly and is wrong. INV-206's recall reads those
-- balances, and it is read to decide who to telephone.
--
-- So TASK-029 left batch-tracked products off the sheet and said how many it left off.
-- This migration is the rest of that sentence: the counting unit becomes the **batch**,
-- because that is what is printed on the box in the counter's hand.
--
-- ── Why the table is rebuilt rather than altered ──────────────────────────────
--
-- `stock_count_lines` carried `UNIQUE (session_id, product_id)`, which is exactly the
-- constraint that makes two lines for one product impossible. SQLite cannot drop a
-- table constraint, so the table is rebuilt — the only rebuild in this schema's
-- history, and it is safe here for a reason worth stating: **nothing references
-- `stock_count_lines`.** It is a child of sessions, products and movements and a parent
-- of nothing, so no foreign key anywhere points at the rows being copied.
--
-- Uniqueness comes back as an expression index rather than a table constraint, because
-- SQLite treats NULLs as distinct in a UNIQUE constraint: `(session, product, NULL)`
-- twice would not collide, and every non-batch product would quietly lose the guarantee
-- it had before this file. `COALESCE(batch_id, '')` gives one line per product for
-- untracked stock and one line per batch for tracked, which is the rule in one index.

CREATE TABLE stock_count_lines_new (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES stock_count_sessions(id),
  product_id    TEXT NOT NULL REFERENCES products(id),
  -- INV-201: the batch this line counts, or NULL for a product counted as a product.
  -- Nullable, and it must stay nullable — a product that is not batch-tracked is
  -- counted exactly as it was before this file, and every line written between
  -- TASK-022 and now carries NULL correctly.
  batch_id      TEXT REFERENCES product_batches(id),
  product_name_snapshot TEXT NOT NULL,
  -- MON-005 again, one level down: a batch number is the supplier's own label and the
  -- batch row could be deactivated later. What this count counted is what it says.
  batch_no_snapshot TEXT,
  -- INV-110's freeze. Written once, at open, and read by every variance from then on.
  -- For a batch line this is that batch's balance at the freeze, not the product's.
  expected_milli INTEGER NOT NULL,
  -- MON-004 at the moment of the freeze. For a batch line it is **the batch's own
  -- cost**, which is what a sale of it would have snapshotted — valuing a batch
  -- variance at the product's moving average would price the loss at stock the store
  -- did not lose.
  avg_cost_centavos INTEGER NOT NULL,
  -- NULL until counted, and NULL is **not** zero. See 012_stock_counts.sql.
  counted_milli INTEGER,
  counted_at    TEXT,
  counted_by    TEXT REFERENCES users(id),
  note          TEXT,
  movement_id   TEXT REFERENCES inventory_movements(id)
);

INSERT INTO stock_count_lines_new
  (id, session_id, product_id, batch_id, product_name_snapshot, batch_no_snapshot,
   expected_milli, avg_cost_centavos, counted_milli, counted_at, counted_by, note, movement_id)
SELECT
  id, session_id, product_id, NULL, product_name_snapshot, NULL,
  expected_milli, avg_cost_centavos, counted_milli, counted_at, counted_by, note, movement_id
  FROM stock_count_lines;

DROP TABLE stock_count_lines;
ALTER TABLE stock_count_lines_new RENAME TO stock_count_lines;

CREATE INDEX idx_countlines_product ON stock_count_lines (product_id);
-- One line per product for untracked stock, one per batch for tracked. The COALESCE is
-- the whole rule: without it SQLite's distinct-NULLs would let a product-level line be
-- written twice.
CREATE UNIQUE INDEX idx_countlines_unique
  ON stock_count_lines (session_id, product_id, COALESCE(batch_id, ''));
CREATE INDEX idx_countlines_batch ON stock_count_lines (batch_id);
