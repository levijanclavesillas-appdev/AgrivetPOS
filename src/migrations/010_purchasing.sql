-- 010_purchasing.sql — suppliers, purchase orders and goods receipts
-- Source of truth: 05_TECH_SPEC.md §3.4. Conventions in §3.1 are binding.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).
--
-- PO-103 is the shape of this migration, and it is a shape defined by what is *not*
-- here: no column on purchase_orders or purchase_order_items touches stock, and no
-- service writes an inventory movement from either. A purchase order is a statement of
-- intent to a supplier. Only a goods receipt moves stock, because INV-101 has meant
-- "what is on the shelf" since TASK-007, and a system where ordering changes on hand is
-- a system whose stock figure means "what we expect" instead.
--
-- PO-202 is the second: goods_receipt_items carries received and damaged separately,
-- and the movement is posted for the difference. Fifty sacks with three split is
-- forty-seven sacks of stock and a number the store can take to the supplier.

CREATE TABLE suppliers (
  id          TEXT PRIMARY KEY,
  code        TEXT UNIQUE COLLATE NOCASE,
  -- VR-401: required and unique. NOCASE because "B-MEG Feeds" and "b-meg feeds" are
  -- one supplier, and a store that ends up with both has two purchase histories for
  -- the same account and no way to see either whole.
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  contact_person TEXT,
  contact_no  TEXT,
  email       TEXT,
  address     TEXT,
  -- Payment terms in days. 0 is cash on delivery, which is most counter purchases.
  terms_days  INTEGER NOT NULL DEFAULT 0 CHECK (terms_days >= 0),
  notes       TEXT,
  -- Convention 6, and VR-304's reasoning applied to the other side of the ledger: a
  -- supplier who has delivered is history. There is no DELETE path in the repository.
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL REFERENCES users(id),
  updated_at  TEXT,
  updated_by  TEXT REFERENCES users(id)
);

CREATE TABLE purchase_orders (
  id           TEXT PRIMARY KEY,
  po_no        TEXT NOT NULL UNIQUE,                 -- PO-YYYYMMDD-NNNNNN (VR-103)
  supplier_id  TEXT NOT NULL REFERENCES suppliers(id),
  -- PO-102's machine, and no other value is representable. CANCELLED is reachable
  -- from DRAFT and PENDING only; the service enforces which transitions are legal,
  -- and the CHECK enforces that nothing outside the machine is ever stored.
  status       TEXT NOT NULL DEFAULT 'DRAFT'
                 CHECK (status IN ('DRAFT','PENDING','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
  -- PO-104: a PENDING order is amended by a new revision, not overwritten. The
  -- supplier has been told a number, so the number stays and the revision moves with
  -- it — "PO-20260908-000014 rev 2" is a sentence both sides of a phone call can use.
  -- The superseded lines are not lost: AUD-601 records both values on every amendment,
  -- so the trail holds each revision's lines against the order's own entity id.
  revision     INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  ordered_at   TEXT,                                 -- set when it leaves DRAFT
  expected_at  TEXT,                                 -- the date the store was promised
  reference_no TEXT,                                 -- the supplier's own order number
  notes        TEXT,
  total_centavos INTEGER NOT NULL DEFAULT 0,         -- MON-001, the ordered value
  submitted_at TEXT, submitted_by TEXT REFERENCES users(id),
  cancelled_at TEXT, cancelled_by TEXT REFERENCES users(id), cancel_reason TEXT,
  completed_at TEXT,
  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL REFERENCES users(id),
  updated_at   TEXT,
  updated_by   TEXT REFERENCES users(id)
);
CREATE INDEX idx_po_supplier ON purchase_orders (supplier_id, ordered_at);
CREATE INDEX idx_po_status   ON purchase_orders (status);

CREATE TABLE purchase_order_items (
  id          TEXT PRIMARY KEY,
  po_id       TEXT NOT NULL REFERENCES purchase_orders(id),
  line_no     INTEGER NOT NULL,
  product_id  TEXT NOT NULL REFERENCES products(id),
  -- The name as it was when the order was raised, for the same reason sale_items
  -- carries one (MON-005): a product renamed next month must not silently re-label an
  -- order the supplier is holding a printed copy of.
  product_name_snapshot TEXT NOT NULL,
  qty_milli   INTEGER NOT NULL CHECK (qty_milli > 0),      -- MON-002, base unit
  -- UOM-002: what the buyer actually ordered, kept so the screen can say "50 SACK"
  -- rather than "2,500 KG". The ledger figure stays the base-unit one above.
  order_unit_id TEXT REFERENCES units(id),
  order_pack_factor_milli INTEGER NOT NULL DEFAULT 1000 CHECK (order_pack_factor_milli > 0),
  -- Per base unit, as every other cost in this schema is (MON-001, INV-106).
  unit_cost_centavos INTEGER NOT NULL CHECK (unit_cost_centavos >= 0),
  line_total_centavos INTEGER NOT NULL,                    -- MON-003, rounded once
  notes       TEXT,
  UNIQUE (po_id, line_no)
);
CREATE INDEX idx_poitems_product ON purchase_order_items (product_id);

CREATE TABLE goods_receipts (
  id           TEXT PRIMARY KEY,
  gr_no        TEXT NOT NULL UNIQUE,                 -- GR-YYYYMMDD-NNNNNN (VR-103)
  -- PO-207: NULL is the counter purchase, and it is a normal case rather than an
  -- exception. The supplier is not nullable either way — a delivery from nobody is not
  -- a record of anything, and every cost figure this table sets is read for ever.
  po_id        TEXT REFERENCES purchase_orders(id),
  supplier_id  TEXT NOT NULL REFERENCES suppliers(id),
  supplier_dr_no TEXT,                               -- the delivery receipt in the van
  invoice_no   TEXT,
  -- PO-206: a posted receipt is immutable. There is exactly one status, so there is no
  -- draft to edit and no way to write anything else — the correction is an adjustment
  -- or a supplier return, which is the same reasoning POS-206 applies to a tender.
  status       TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED')),
  total_centavos INTEGER NOT NULL DEFAULT 0,         -- the sound received value
  -- PO-204 / PO-205, flagged on the receipt itself so the exception is visible in the
  -- list rather than only in the audit trail somebody has to go looking for.
  has_over_receipt  INTEGER NOT NULL DEFAULT 0,
  has_cost_variance INTEGER NOT NULL DEFAULT 0,
  -- AUD-603's second actor. One column, because a receipt is authorised once by one
  -- person however many of its lines needed it.
  approved_by  TEXT REFERENCES users(id),
  approval_reason TEXT,
  notes        TEXT,
  received_at  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL REFERENCES users(id)
);
CREATE INDEX idx_gr_supplier ON goods_receipts (supplier_id, received_at);
CREATE INDEX idx_gr_po       ON goods_receipts (po_id);
CREATE INDEX idx_gr_date     ON goods_receipts (received_at);

CREATE TABLE goods_receipt_items (
  id          TEXT PRIMARY KEY,
  gr_id       TEXT NOT NULL REFERENCES goods_receipts(id),
  line_no     INTEGER NOT NULL,
  po_item_id  TEXT REFERENCES purchase_order_items(id),   -- NULL on a direct receipt
  product_id  TEXT NOT NULL REFERENCES products(id),
  product_name_snapshot TEXT NOT NULL,
  -- PO-201's four figures. `ordered_qty_milli` is a snapshot of the PO line at the
  -- moment of receipt, so a later revision cannot retroactively change what this
  -- delivery was measured against; it is 0 on a direct receipt, which has no order.
  ordered_qty_milli  INTEGER NOT NULL DEFAULT 0,
  -- What the van actually brought. PO-202: `damaged_qty_milli` is a *part* of it, not
  -- a separate arrival, so the sound quantity is the difference and the CHECK makes
  -- "damaged more than arrived" unrepresentable rather than merely unlikely.
  received_qty_milli INTEGER NOT NULL CHECK (received_qty_milli > 0),
  damaged_qty_milli  INTEGER NOT NULL DEFAULT 0 CHECK (damaged_qty_milli >= 0),
  sound_qty_milli    INTEGER NOT NULL CHECK (sound_qty_milli >= 0),
  receive_unit_id    TEXT REFERENCES units(id),
  receive_pack_factor_milli INTEGER NOT NULL DEFAULT 1000 CHECK (receive_pack_factor_milli > 0),
  -- PO-203: the cost the average moves at is this one, the actual. The ordered cost is
  -- kept beside it so PO-205's variance is answerable from the row for ever, rather
  -- than by re-deriving it from a purchase order that has since been revised.
  unit_cost_centavos INTEGER NOT NULL CHECK (unit_cost_centavos >= 0),
  ordered_unit_cost_centavos INTEGER,
  cost_variance_bp   INTEGER,
  line_total_centavos INTEGER NOT NULL,                    -- MON-003, the sound value
  is_over_receipt    INTEGER NOT NULL DEFAULT 0,           -- PO-204
  is_cost_variance   INTEGER NOT NULL DEFAULT 0,           -- PO-205
  -- INV-206, v1.2. Nullable now: the columns exist so that batch-tracked receiving is
  -- a service change rather than a migration against a table with live rows in it.
  batch_no    TEXT,
  expiry_date TEXT,
  -- The RECEIPT movement this line posted (INV-102), so the ledger row and the
  -- delivery it came from find each other in one hop. NULL when sound is zero: a line
  -- that arrived entirely broken is recorded and posts nothing (PO-202).
  movement_id TEXT REFERENCES inventory_movements(id),
  damage_note TEXT,
  UNIQUE (gr_id, line_no),
  CHECK (damaged_qty_milli <= received_qty_milli),
  CHECK (sound_qty_milli = received_qty_milli - damaged_qty_milli)
);
CREATE INDEX idx_gritems_product ON goods_receipt_items (product_id);
CREATE INDEX idx_gritems_poitem  ON goods_receipt_items (po_item_id);
