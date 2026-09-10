-- 014_batches.sql — batches, expiry and FEFO (TASK-029)
-- Source of truth: 05_TECH_SPEC.md §3.4. Conventions in §3.1 are binding.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).
--
-- Four seams left open since v1.0 close here, and the comments that left them open
-- said this file would be the one to use them:
--
--   products.is_batch_tracked      002_catalog.sql,  marked "v1.2", read by exactly
--                                  one thing (POS-304's write-off default)
--   goods_receipt_items.batch_no   010_purchasing.sql, nullable so that batch-tracked
--   goods_receipt_items.expiry_date  receiving would be a service change rather than
--                                  a migration against a table with live rows
--   sale_items.batch_id            006_sales.sql, marked "v1.2, INV-206", written
--                                  NULL on every line ever sold
--
-- ── INV-201 is one ledger, not two ─────────────────────────────────────────────
--
-- "The sum of batch quantities equals the product on-hand figure" is a rule that is
-- either true by construction or false eventually. So there is no qty column on
-- product_batches. `inventory_movements` gains `batch_id`, and a batch's quantity is
-- the same SUM(qty_milli) that INV-101 already derives, grouped one column finer.
-- The two figures cannot disagree because they are the same sum.
--
-- The `inventory` projection stays exactly as it is: a per-product cache written only
-- by inventoryService.post and checked by inventoryRepository.reconciliationBreaks.
-- A per-batch projection beside it would be a second thing to drift, and a batch is
-- read in tens per product rather than in thousands, so the group-by is cheap.
--
-- ── One line, many batches ─────────────────────────────────────────────────────
--
-- Ten sacks where the oldest batch holds six is the ordinary case, not the corner:
-- INV-204 takes six from one batch and four from the next. That is two movements —
-- each row carries one batch_id — but it is still **one sale line**. The cashier sold
-- ten sacks, the receipt says ten sacks, and POS-301's return ceiling is ten.
--
-- So `sale_item_batches` carries the per-batch detail INV-206's recall needs, and
-- **sale_items.batch_id is withdrawn in place** — left NULL for ever, the way a
-- withdrawn rule is marked withdrawn rather than deleted. It cannot be dropped
-- (forward-only, live rows) and it must not be populated: a line that recorded its
-- batch in two places is a line whose two records can disagree, which is the reasoning
-- POS-206 applies to sale_tenders.status.
--
-- ── INV-205 is a refusal, and there is no override ─────────────────────────────
--
-- The rule permits an owner override "only where the store's own policy allows it".
-- This store's policy does not, so no override is built: there is no authorising
-- column here, no approver, and no way to record a sale of expired stock — because a
-- switch nobody may use is a switch somebody will. Expired stock leaves by an EXPIRY
-- movement, which INV-103 has declared since 003_inventory.sql.
--
-- If that policy changes, the override arrives as AUD-603's two-actor form in its own
-- migration and its own task. Adding it later costs less than removing it.

-- ── Batches (INV-202) ─────────────────────────────────────────────────────────

CREATE TABLE product_batches (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products(id),
  -- The supplier's own label off the sack or the vial. Not generated: a batch number
  -- the store invented is a batch number the manufacturer's recall notice will not
  -- match, and matching that notice is the entire point of INV-206.
  batch_no    TEXT NOT NULL,
  -- INV-202 names the supplier as part of a batch's identity. NOT NULL for the same
  -- reason goods_receipts.supplier_id is: a batch from nobody is not a record of
  -- anything, and it is read for ever.
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  -- Date-only, in Manila days. An expiry is printed on a box as a date and compared
  -- against a date; giving it a time of day would invent a precision the box does not
  -- have and make INV-203's boundary depend on the hour a report was run.
  expiry_date TEXT NOT NULL,
  received_date TEXT NOT NULL,
  -- MON-004: what this batch cost, per base unit. This is the figure a batch-tracked
  -- sale line snapshots instead of products.avg_cost_centavos — the whole of the
  -- costing change, in one column.
  unit_cost_centavos INTEGER NOT NULL CHECK (unit_cost_centavos >= 0),
  -- Where it came from, so a batch and the delivery that brought it find each other in
  -- one hop, as goods_receipt_items.movement_id already does for the ledger. NULL for
  -- a batch created by the opening load, which has no receipt behind it.
  gr_item_id  TEXT REFERENCES goods_receipt_items(id),
  -- INV-203 is derived at read time and there is deliberately no status column here.
  -- A stored one is a column a missed job leaves stale, which is the reasoning CR-107
  -- already applies to ageing.
  notes       TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT, updated_by TEXT REFERENCES users(id),
  -- INV-202: unique per product, not globally. Two manufacturers use "A-2291" in the
  -- same year and neither is wrong.
  UNIQUE (product_id, batch_no)
);

-- FEFO's read path (INV-204): the non-expired batches of one product, earliest expiry
-- first. This index is the ordering, so the allocator never sorts.
CREATE INDEX idx_batches_fefo    ON product_batches (product_id, expiry_date);
-- INV-203's near-expiry sweep and OPS-007's alert read every product at once.
CREATE INDEX idx_batches_expiry  ON product_batches (expiry_date);

-- ── The ledger learns which batch (INV-201) ───────────────────────────────────
--
-- Nullable, and it must stay nullable: a non-batch-tracked product moves exactly as it
-- did before this file, and every movement written between TASK-007 and now carries
-- NULL correctly. The service is what enforces "a batch-tracked product's movement
-- names its batch" — a CHECK here cannot see products.is_batch_tracked.
ALTER TABLE inventory_movements ADD COLUMN batch_id TEXT REFERENCES product_batches(id);

-- The batch balance INV-201 derives, and the recall's other half.
CREATE INDEX idx_move_batch ON inventory_movements (batch_id, occurred_at);

-- ── What a sale line took, per batch (INV-206) ────────────────────────────────

CREATE TABLE sale_item_batches (
  id           TEXT PRIMARY KEY,
  sale_item_id TEXT NOT NULL REFERENCES sale_items(id),
  batch_id     TEXT NOT NULL REFERENCES product_batches(id),
  -- Positive: what this batch gave to this line. The line's own qty_milli is the sum
  -- of these, and TC-INT-107 is what says so.
  qty_milli    INTEGER NOT NULL CHECK (qty_milli > 0),
  -- MON-005: snapshotted per batch, because the line's own unit_cost_centavos is the
  -- weighted average of these and cannot be taken back apart afterwards. RPT-104 reads
  -- the line; a recall and a margin query on one batch read these.
  unit_cost_centavos INTEGER NOT NULL CHECK (unit_cost_centavos >= 0),
  -- The SALE movement this consumption posted, so the line, the batch and the ledger
  -- row are one hop from each other in every direction.
  movement_id  TEXT REFERENCES inventory_movements(id),
  created_at   TEXT NOT NULL,
  UNIQUE (sale_item_id, batch_id)
);

CREATE INDEX idx_sib_batch ON sale_item_batches (batch_id);
