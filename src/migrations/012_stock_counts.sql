-- 012_stock_counts.sql — the stocktake
-- Source of truth: 05_TECH_SPEC.md §3.4. Conventions in §3.1 are binding.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).
--
-- INV-110 is the shape of this migration, and it is one column: `expected_milli` on
-- `stock_count_lines`, **frozen when the session opens and never re-read**. Without
-- it, a store that counts for three hours while trading measures its variance against
-- a figure that moved while somebody walked the aisle, and finds discrepancies it
-- created by counting slowly. With it, the variance is against what the system
-- believed when the counting began — the only figure a count can honestly be compared
-- against.
--
-- `avg_cost_centavos` is frozen beside it for the same reason (MON-004, MON-005): the
-- variance report values the difference at the cost that applied when the count was
-- taken, not at whatever a delivery has since moved the average to.
--
-- **`counted_milli` is NULL until somebody counts it, and NULL is not zero.** That
-- distinction is the most dangerous one in this file. A store counting four hundred
-- products may genuinely not reach them all, and a schema that defaulted the column to
-- 0 would write off the entire uncounted remainder of the shop as shrinkage the moment
-- somebody posted. So the column is nullable, has no default, and INV-111's "one
-- movement per varying product" is read as "per *counted* product that varies".
--
-- INV-111 is why `movement_id` is on the line and nullable: a product that matched
-- posts nothing and carries NULL for ever, which is the difference between "counted,
-- correct" and "never counted" being legible a year later.

CREATE TABLE stock_count_sessions (
  id            TEXT PRIMARY KEY,
  count_no      TEXT NOT NULL UNIQUE,               -- SC-YYYYMMDD-NNNNNN (VR-103)
  -- The scope, fixed at open. A count of one category is the ordinary case — a shop
  -- counts the feed shed on Tuesday and the vet cabinet on Thursday — and the whole
  -- shop is the annual one.
  scope         TEXT NOT NULL DEFAULT 'ALL' CHECK (scope IN ('ALL','CATEGORY')),
  category_id   TEXT REFERENCES categories(id),
  -- The machine. Lines are editable in OPEN and in no other status; APPROVED is
  -- INV-112's second pair of eyes having looked; POSTED is immutable.
  status        TEXT NOT NULL DEFAULT 'OPEN'
                  CHECK (status IN ('OPEN','APPROVED','POSTED','CANCELLED')),
  notes         TEXT,
  -- INV-110: the moment the expected quantities were frozen, and the one INV-113
  -- measures staleness from.
  opened_at     TEXT NOT NULL,
  opened_by     TEXT NOT NULL REFERENCES users(id),
  approved_at   TEXT,
  approved_by   TEXT REFERENCES users(id),
  -- INV-112 is waived where the store has one active user, because the rule cannot be
  -- met and pretending otherwise would stop a one-person shop counting at all. Stored
  -- rather than inferred from a user count that will have changed by the time anybody
  -- reads this row: "nobody else was available" and "nobody bothered" must not read
  -- alike a year later.
  approval_waived INTEGER NOT NULL DEFAULT 0,
  posted_at     TEXT,
  posted_by     TEXT REFERENCES users(id),
  -- INV-113, recorded rather than derived from the dates. The window is a setting, and
  -- a report read next year must say whether this count was stale *then*.
  was_stale     INTEGER NOT NULL DEFAULT 0,
  stale_approved_by TEXT REFERENCES users(id),
  cancelled_at  TEXT,
  cancelled_by  TEXT REFERENCES users(id),
  cancel_reason TEXT,
  -- The totals the owner actually asks for, written at posting so the report of an old
  -- count states what it found rather than recomputing it against today's costs.
  counted_products    INTEGER,
  varying_products    INTEGER,
  variance_value_centavos INTEGER,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_count_status ON stock_count_sessions (status);
CREATE INDEX idx_count_opened ON stock_count_sessions (opened_at);

CREATE TABLE stock_count_lines (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES stock_count_sessions(id),
  product_id    TEXT NOT NULL REFERENCES products(id),
  -- MON-005: a product renamed next month must not change what this count says was on
  -- the shelf.
  product_name_snapshot TEXT NOT NULL,
  -- INV-110's freeze. Written once, at open, and read by every variance from then on.
  expected_milli INTEGER NOT NULL,
  -- MON-004 at the moment of the freeze, so the value of the variance is what it was
  -- worth when it was found.
  avg_cost_centavos INTEGER NOT NULL,
  -- NULL until counted, and NULL is **not** zero. See the note at the head of the file.
  counted_milli INTEGER,
  counted_at    TEXT,
  counted_by    TEXT REFERENCES users(id),
  note          TEXT,
  -- INV-111: NULL where the product matched, or was never counted. Two products with
  -- no movement, for two different reasons, and the pair of columns is what keeps them
  -- distinguishable.
  movement_id   TEXT REFERENCES inventory_movements(id),
  UNIQUE (session_id, product_id)
);
CREATE INDEX idx_countlines_product ON stock_count_lines (product_id);
