-- 003_inventory.sql — the movement ledger and the materialised on-hand figure
-- Source of truth: 05_TECH_SPEC.md §3.4. Conventions in §3.1 are binding.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).
--
-- INV-101 is the shape of this migration: `inventory` is a *materialised* running
-- balance, not an independent counter. It is written only by the movement service,
-- only inside the transaction that writes the movement, and it must reconcile to
-- SUM(inventory_movements.qty_milli) at any moment. TC-INT-20 asserts exactly that
-- after the full trading day, and is a permanent regression guard (07_TEST_PLAN §7).
--
-- legacy/PRD_v1.1.md §19's STOCK_TRANSFER type is deliberately absent: there is no
-- location entity before v1.3 (02_PRD.md §7), and a transfer between nowhere and
-- nowhere is not a movement.

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

-- The ledger view (requirement 8) reads one product newest-first, and TC-INT-20
-- reconciles by product. Both run on (product_id, occurred_at) above; the id tiebreak
-- is applied in the query rather than the index because UUIDv7 already orders by
-- creation time within the same millisecond (VR-101).

-- A movement that corrects another is found from the original, not only the other way
-- round: the ledger view has to show "this was corrected by …" beside a row an
-- operator is questioning, and without this that is a scan.
CREATE INDEX idx_move_corrects ON inventory_movements (corrects_movement_id);
