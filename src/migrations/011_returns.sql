-- 011_returns.sql — sales returns
-- Source of truth: 05_TECH_SPEC.md §3.4. Conventions in §3.1 are binding.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).
--
-- POS-107 says a completed sale is immutable, and this migration does not contradict
-- it: a return is a *new document* that cites the sale, exactly as a void will be. The
-- two columns on the sale that a return does move — `sale_items.returned_qty_milli` and
-- `sales.status` — already exist and were put there for this, and the repository gets
-- two narrowly named setters rather than a general update path.
--
-- POS-303 is the shape of `sale_return_items`: the disposition is per line, and it is
-- recorded next to what the rule *said* it should be. `default_disposition` is not
-- redundant with `disposition` — POS-304 makes a medicine default to write-off, and
-- the pair of columns is what distinguishes "restocked, as normal" from "restocked
-- against the default, and here is who authorised it".
--
-- POS-305's precedence is three columns rather than one method, because a single
-- refund can be split: a customer who owes ₱300 and returns ₱500 of goods has ₱300
-- taken off the balance and ₱200 handed back. A `method` column would have to pick one
-- and lose the other.

CREATE TABLE sale_returns (
  id            TEXT PRIMARY KEY,
  return_no     TEXT NOT NULL UNIQUE,             -- RET-YYYYMMDD-NNNNNN (VR-103)
  sale_id       TEXT NOT NULL REFERENCES sales(id),
  customer_id   TEXT REFERENCES customers(id),    -- NULL = the walk-in who bought it
  -- POS-509 already reads `refund_cash_centavos` off this table by shift, and has
  -- since TASK-013: the expected-cash arithmetic reserved a `refunds` term before
  -- there was anything to put in it.
  shift_id      TEXT NOT NULL REFERENCES cashier_shifts(id),
  -- POS-206's reasoning applied to a return: one status, so there is no draft to edit
  -- and no way to write anything else. A return that was wrong is corrected by an
  -- adjustment, never by rewriting the document that moved the stock.
  status        TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED')),
  reason        TEXT NOT NULL,                    -- POS-302, from the configured list
  notes         TEXT,                             -- free text alongside, never instead
  total_centavos INTEGER NOT NULL CHECK (total_centavos > 0),
  -- POS-305's three destinations. They sum to the total by construction, and the CHECK
  -- is what makes that a property of the table rather than a promise in a service.
  refund_credit_centavos       INTEGER NOT NULL DEFAULT 0 CHECK (refund_credit_centavos >= 0),
  refund_cash_centavos         INTEGER NOT NULL DEFAULT 0 CHECK (refund_cash_centavos >= 0),
  refund_store_credit_centavos INTEGER NOT NULL DEFAULT 0 CHECK (refund_store_credit_centavos >= 0),
  credit_txn_id TEXT REFERENCES customer_credit_transactions(id),   -- POS-306
  -- POS-307: recorded rather than inferred from the dates, because the window is a
  -- setting and a report read next year must say whether it was late *then*.
  beyond_window INTEGER NOT NULL DEFAULT 0,
  approved_by   TEXT REFERENCES users(id),        -- POS-304 or POS-307's authoriser
  approval_reason TEXT,
  occurred_at   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL REFERENCES users(id),
  CHECK (refund_credit_centavos + refund_cash_centavos + refund_store_credit_centavos
         = total_centavos)
);
CREATE INDEX idx_returns_sale  ON sale_returns (sale_id);
CREATE INDEX idx_returns_shift ON sale_returns (shift_id);
CREATE INDEX idx_returns_date  ON sale_returns (occurred_at);
CREATE INDEX idx_returns_cust  ON sale_returns (customer_id);

CREATE TABLE sale_return_items (
  id            TEXT PRIMARY KEY,
  return_id     TEXT NOT NULL REFERENCES sale_returns(id),
  line_no       INTEGER NOT NULL,
  sale_item_id  TEXT NOT NULL REFERENCES sale_items(id),
  product_id    TEXT NOT NULL REFERENCES products(id),
  product_name_snapshot TEXT NOT NULL,
  qty_milli     INTEGER NOT NULL CHECK (qty_milli > 0),   -- MON-002, base unit
  -- Snapshots taken from the sale line, not from the product: MON-005's reasoning is
  -- that a return is measured against what was actually charged and what it actually
  -- cost, and both of those are frozen on the sale.
  unit_price_centavos INTEGER NOT NULL,
  unit_cost_centavos  INTEGER NOT NULL,
  tax_centavos        INTEGER NOT NULL DEFAULT 0,
  line_total_centavos INTEGER NOT NULL CHECK (line_total_centavos >= 0),
  -- POS-303 / POS-304. `default_disposition` is what the rule said before anybody
  -- chose; the pair is what makes a restocked medicine visible as an exception.
  disposition   TEXT NOT NULL CHECK (disposition IN ('RESTOCK','WRITE_OFF')),
  default_disposition TEXT NOT NULL CHECK (default_disposition IN ('RESTOCK','WRITE_OFF')),
  restock_approved_by TEXT REFERENCES users(id),
  -- POS-303: a restock is one movement in; a write-off is that movement followed by a
  -- DAMAGE out, so the ledger records both that the goods came back and that they are
  -- not saleable. Two columns because they are two rows.
  return_movement_id    TEXT REFERENCES inventory_movements(id),
  write_off_movement_id TEXT REFERENCES inventory_movements(id),
  UNIQUE (return_id, line_no)
);
CREATE INDEX idx_returnitems_product ON sale_return_items (product_id);
CREATE INDEX idx_returnitems_saleitem ON sale_return_items (sale_item_id);
