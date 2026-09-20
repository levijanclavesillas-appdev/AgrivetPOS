-- 910_restock.sql — what to buy, asked for and approved (TASK-072)
-- Source of truth: docs/06_TASKS/TASK-072-restocking-requests.md. Conventions in
-- 05_TECH_SPEC.md §3.1 are binding.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).
--
-- Everything needed to answer *what is low* was already here — INV-109 computes it at
-- read time and inventoryRepository.lowStock() serves it — and nothing answered *what to
-- buy*. The difference between the two is this file: a list on a screen dies when the
-- screen closes, and a buyer who cannot keep one keys the same products into SCR-802
-- again, once per supplier, from memory.
--
-- PO-107: **a restocking request moves no stock and commits the store to nothing.** It is
-- neither an order nor a receipt. Only a purchase order commits and only a goods receipt
-- moves stock, exactly as PO-103 says, and nothing in this file references
-- inventory_movements.
--
-- PO-108: an approved request becomes one DRAFT purchase order per distinct supplier, in
-- one transaction. `restock_request_items.po_id` and `.po_item_id` are how a line says
-- which order carried it, and `purchase_orders` is reached from the request rather than
-- the other way round so that an order raised by hand at SCR-802 — still the ordinary
-- case — carries no restock column it would always leave null.

CREATE TABLE restock_requests (
  id          TEXT PRIMARY KEY,
  rr_no       TEXT NOT NULL UNIQUE,                  -- RR-YYYYMMDD-NNNNNN (VR-103)

  -- The statuses mirror PO-102's shape because the buyer already reads that one.
  -- ORDERED is reached only by the conversion, never by hand.
  status      TEXT NOT NULL DEFAULT 'DRAFT'
                CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','ORDERED','CANCELLED')),

  note        TEXT,

  -- AUD-603: the requester and the approver are distinct actors, and both are kept.
  requested_at TEXT NOT NULL,
  requested_by TEXT REFERENCES users(id),
  submitted_at TEXT,
  submitted_by TEXT REFERENCES users(id),
  decided_at   TEXT,
  decided_by   TEXT REFERENCES users(id),

  -- A rejection carries its reason (AUD-601). An approval does not need one.
  decision_reason TEXT,

  -- 1 where the store had exactly one active user at the moment of approval, so there
  -- was no second person to ask. Recorded rather than hidden: INV-112 takes the same
  -- view of a stock count nobody could double-check. This is a fact about the store's
  -- staffing on the day, not a setting somebody switched off to skip the approver.
  self_approved INTEGER NOT NULL DEFAULT 0 CHECK (self_approved IN (0, 1)),

  converted_at TEXT,
  cancelled_at TEXT,
  cancelled_by TEXT REFERENCES users(id),
  cancel_reason TEXT,

  created_at  TEXT NOT NULL,
  created_by  TEXT REFERENCES users(id),
  updated_at  TEXT,
  updated_by  TEXT REFERENCES users(id)
);
CREATE INDEX idx_rr_status ON restock_requests (status, requested_at);

CREATE TABLE restock_request_items (
  id          TEXT PRIMARY KEY,
  request_id  TEXT NOT NULL REFERENCES restock_requests(id),
  line_no     INTEGER NOT NULL,
  product_id  TEXT NOT NULL REFERENCES products(id),

  -- MON-005's reasoning, as purchase_order_items:78 applies it: a product renamed next
  -- month must not silently re-label a request somebody approved last month.
  product_name_snapshot TEXT NOT NULL,

  -- Base unit, thousandths (MON-002, UOM-005). The quantity actually asked for — the
  -- figure the buyer left in the box, never the derived suggestion.
  qty_milli   INTEGER NOT NULL CHECK (qty_milli > 0),

  -- What the screen worked out, and the three figures it worked it out from, kept as
  -- they stood when the request was raised. A request read in three months is a
  -- question about a shelf that has moved since; without these the row cannot say why
  -- it asked for forty. suggested_qty_milli may legitimately differ from qty_milli —
  -- that difference is the buyer's judgement and is the point of keeping both.
  suggested_qty_milli INTEGER CHECK (suggested_qty_milli IS NULL OR suggested_qty_milli >= 0),
  on_hand_milli       INTEGER,
  on_order_milli      INTEGER,
  min_stock_milli     INTEGER,

  -- Derived from the last receipt of this product when the line was raised, and freely
  -- changed by the buyer. Nullable because a product nobody has ever received has no
  -- supplier to derive one from, and a line with none is carried and reported rather
  -- than dropped — it simply cannot be converted until somebody names one.
  supplier_id TEXT REFERENCES suppliers(id),

  -- Per base unit, as every other cost in this schema is (MON-001, INV-106). The
  -- opening figure for the order line; nullable for the same reason as supplier_id.
  unit_cost_centavos INTEGER CHECK (unit_cost_centavos IS NULL OR unit_cost_centavos >= 0),

  -- Per-line approval: a request for eleven things the owner will pay for nine of is
  -- the ordinary case. NULL while undecided.
  is_approved INTEGER CHECK (is_approved IS NULL OR is_approved IN (0, 1)),

  -- PO-108: which order carried this line, written by the conversion.
  po_id       TEXT REFERENCES purchase_orders(id),
  po_item_id  TEXT REFERENCES purchase_order_items(id),

  -- Why this product is on the list: what the screen derived it from, or that a person
  -- put it there. BELOW_MINIMUM and OUT_OF_STOCK are the two derivations; ADDED is the
  -- wormer a customer asked for, which no arithmetic over min_stock_milli would ever
  -- produce.
  source      TEXT NOT NULL DEFAULT 'ADDED'
                CHECK (source IN ('BELOW_MINIMUM','OUT_OF_STOCK','ADDED')),

  notes       TEXT,
  UNIQUE (request_id, line_no)
);
CREATE INDEX idx_rritems_request ON restock_request_items (request_id);
CREATE INDEX idx_rritems_product ON restock_request_items (product_id);
-- "Is this product already on an open request?" — asked once per row when the list is
-- built, so that a product asked for on Monday is not asked for again on Thursday. Same
-- reasoning as idx_poitems_product, which answers the same question about orders.
CREATE INDEX idx_rritems_supplier ON restock_request_items (supplier_id);
