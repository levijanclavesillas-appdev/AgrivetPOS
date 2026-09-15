-- 903_batch_recall.sql — a recalled batch is held: it cannot be sold (pharmacy edition)
-- Source of truth: docs/PHARMACY_EDITION.md §8, rule INV-208. Conventions in 05_TECH_SPEC.md
-- §3.1 are binding.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).
--
-- INV-206's recall was a list of people: given a batch, who bought it. Nothing held the
-- batch itself, so the counter's FEFO allocator went on selling a recalled lot to the
-- next customer while somebody rang the last one. A drugstore that has a manufacturer's
-- notice in its hand must be able to stop the sale of that lot at once.
--
-- **State, deliberately, where expiry is not.** INV-203 derives expiry from a date and
-- stores nothing; a recall is not arithmetic, it is somebody's decision on a day, for a
-- reason, and those are three things to keep. NULL `recalled_at` is a batch that is not
-- on recall. Lifting a recall sets it back to NULL; the audit trail keeps both events.

ALTER TABLE product_batches ADD COLUMN recalled_at   TEXT;
ALTER TABLE product_batches ADD COLUMN recalled_by   TEXT REFERENCES users(id);
ALTER TABLE product_batches ADD COLUMN recall_reason TEXT;
