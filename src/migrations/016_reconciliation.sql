-- 016_reconciliation.sql — payment reconciliation (TASK-032)
-- Source of truth: 05_TECH_SPEC.md §3.4. Conventions in §3.1 are binding.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).
--
-- ── What this table is for, and what it must never become ─────────────────────
--
-- POS-206 is the honest limitation behind the whole feature: no payment API confirms a
-- GCash or QRPh transfer for this store, so `sale_tenders.status` admits exactly one
-- value — RECORDED, meaning *the cashier saw it* — and 006_sales.sql's CHECK is written
-- so that VERIFIED cannot be stored at all. A column that could say "confirmed" is one
-- a report would eventually print.
--
-- Reconciliation is what a store does instead. The wallet's statement arrives, somebody
-- reads the day's total off it, and the question is whether it matches what the POS
-- recorded. This table holds that answer and nothing else.
--
-- **RPT-105's prohibition is expressed here as an absence.** There is no column on
-- `sale_tenders` in this migration and there never will be: the recorded figure is what
-- the sales say, the sales are not edited (POS-107), and a reconciliation that adjusted
-- the recorded total would destroy the only record of a ₱50 sale a cashier recorded and
-- no customer ever paid. The variance *is* the output.
--
-- ── Why the figures are stored rather than recomputed ─────────────────────────
--
-- `recorded_centavos` and `recorded_count` are written here even though the same query
-- could derive them later, and that is deliberate: they are what the operator was shown
-- when they judged the variance and wrote the reason. A void or a late correction moves
-- the derived figure afterwards, and a reconciliation whose recorded total silently
-- changed under its own reason is a record of nothing. This is the same reasoning
-- MON-005 applies to a sale's cost snapshot, and INV-110 to a count's expected quantity.

CREATE TABLE payment_reconciliations (
  id            TEXT PRIMARY KEY,
  -- Manila calendar days, inclusive, because the operator holds a statement for "the
  -- 1st to the 7th" and not for a pair of UTC instants.
  from_date     TEXT NOT NULL,
  to_date       TEXT NOT NULL,
  -- Only the methods that settle somewhere else. CASH is reconciled at the shift close
  -- (POS-510) and is shown from there rather than counted twice; CREDIT and
  -- STORE_CREDIT settle nowhere at all, which is why neither is in this CHECK.
  method        TEXT NOT NULL CHECK (method IN ('GCASH','QRPH','OTHER')),
  -- What the POS recorded, as shown to the operator at the moment they judged it.
  recorded_centavos INTEGER NOT NULL,
  recorded_count    INTEGER NOT NULL,
  -- What the statement said actually settled.
  actual_centavos   INTEGER NOT NULL,
  -- actual − recorded. Stored rather than derived on read for the same reason the two
  -- above are: it is the figure the reason was written about.
  variance_centavos INTEGER NOT NULL,
  -- The statement, batch or settlement reference, so somebody can find the paper again.
  reference     TEXT,
  -- POS-510's shape: required beyond the configured tolerance, and null within it.
  reason        TEXT,
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL REFERENCES users(id)
);

-- The overlap check reads this: one method, ranges that intersect. Two reconciliations
-- of one week with different answers is the state the check exists to prevent.
CREATE INDEX idx_recon_method_range ON payment_reconciliations (method, from_date, to_date);
