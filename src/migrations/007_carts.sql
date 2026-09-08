-- 007_carts.sql — the in-progress cart and the parked ones
-- Conventions in 05_TECH_SPEC.md §3.1 are binding.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).
--
-- **This table is a decision TASK-015 required and did not make.** §3.4 has no table
-- for a cart, and the task named the alternative: persist to the renderer's storage.
-- That fails POS-105's own words — an in-progress cart survives "an application
-- restart" — because localStorage is per browser profile and per machine, and a
-- reinstall, a Windows profile change or a second terminal in v1.3 all lose it. The
-- cashier would find an empty screen and a customer waiting.
--
-- So the cart lives here, and §3.4 has been amended to say so.
--
-- One row per cart, holding its lines as JSON rather than as a child table. That is
-- deliberate and is the one place in this schema where JSON is the right shape: a cart
-- is not a business record. Nothing reports on it, nothing reconciles to it, no rule
-- constrains it, and the instant it becomes real it is a sale with its own rows
-- (POS-107). A cart_items table would invite exactly the reporting that must read
-- sale_items instead.

CREATE TABLE carts (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),          -- POS-105: the same user
  shift_id    TEXT NOT NULL REFERENCES cashier_shifts(id), -- POS-105: the same shift
  customer_id TEXT REFERENCES customers(id),               -- POS-103: NULL = walk-in
  status      TEXT NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE','PARKED','RESUMED','EXPIRED','COMPLETED')),
  label       TEXT,                                        -- what the cashier called it
  -- The lines, and any transaction discount, as JSON. Prices are NOT stored: they are
  -- re-resolved on every read and at the sale (§4.1 step 2), so a cart parked before a
  -- price change resumes at the price in force when it is sold, not the one it was
  -- built at.
  payload     TEXT NOT NULL,
  line_count  INTEGER NOT NULL DEFAULT 0,
  parked_at   TEXT,
  resumed_at  TEXT,
  expired_at  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- POS-105 asks one question on every load: "does this user have a cart on this shift".
CREATE INDEX idx_carts_user_shift ON carts (user_id, shift_id, status);

-- POS-106: parked carts expire at shift close, which asks the same question by shift.
CREATE INDEX idx_carts_shift ON carts (shift_id, status);
