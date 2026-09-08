-- 005_shifts.sql — the cashier shift, till movements, and the closing tables
-- Source of truth: 05_TECH_SPEC.md §3.4. Conventions in §3.1 are binding.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).
--
-- POS-501 — "no shift, no money" — is what this migration exists for. Every movement
-- of money belongs to a shift, so that at close there is one expected figure per
-- payment method to check the drawer against. A sale with no shift cannot be
-- attributed to a drawer, and a store that discovers that after a month of trading has
-- a month of unattributable cash.
--
-- legacy/PRD_v1.1.md §62 never said whether a shift belongs to a user or a terminal.
-- It belongs to the **user** (POS-502): the drawer is counted by a person, and a
-- terminal-owned shift cannot answer "whose till was short".
--
-- cashier_closings and closing_method_lines are created here and written by TASK-013.
-- They are in this migration rather than that one because a closing references a shift
-- and the pair is one subject; the table existing empty costs nothing.

CREATE TABLE cashier_shifts (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id),
  opened_at           TEXT NOT NULL,
  opening_float_centavos INTEGER NOT NULL DEFAULT 0,   -- POS-503
  closed_at           TEXT,
  status              TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED'))
);
CREATE INDEX idx_shift_open ON cashier_shifts (user_id, status);

CREATE TABLE till_movements (            -- POS-504..506
  id TEXT PRIMARY KEY,
  shift_id   TEXT NOT NULL REFERENCES cashier_shifts(id),
  direction  TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  amount_centavos INTEGER NOT NULL CHECK (amount_centavos > 0),
  reason     TEXT NOT NULL,
  notes      TEXT,
  occurred_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id)
);

-- POS-509's arithmetic sums till movements for one shift; the closing report is the
-- only reader and it always asks by shift.
CREATE INDEX idx_till_shift ON till_movements (shift_id, occurred_at);

CREATE TABLE cashier_closings (          -- POS-509..511
  id TEXT PRIMARY KEY,
  shift_id  TEXT NOT NULL UNIQUE REFERENCES cashier_shifts(id),
  expected_cash_centavos INTEGER NOT NULL,
  actual_cash_centavos   INTEGER NOT NULL,
  variance_centavos      INTEGER NOT NULL,
  variance_reason        TEXT,           -- required beyond tolerance
  closed_at  TEXT NOT NULL,
  closed_by  TEXT NOT NULL REFERENCES users(id)
);

CREATE TABLE closing_method_lines (      -- POS-510: variance per method
  id TEXT PRIMARY KEY,
  closing_id TEXT NOT NULL REFERENCES cashier_closings(id),
  method     TEXT NOT NULL,
  expected_centavos INTEGER NOT NULL,
  actual_centavos   INTEGER NOT NULL,
  variance_centavos INTEGER NOT NULL
);
CREATE INDEX idx_closing_lines ON closing_method_lines (closing_id);
