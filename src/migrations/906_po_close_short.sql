-- 906_po_close_short.sql — an order the rest of will never come is closed short (TASK-061)
-- Source of truth: docs/PHARMACY_EDITION.md §11. Conventions in 05_TECH_SPEC.md §3.1 are binding.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).
--
-- PO-105 forbids cancelling an order once anything has arrived against it, and rightly:
-- the goods that came are real. But a supplier who delivers eight lines of ten and will
-- never send the other two left the order "Partly received" for ever, counted as stock
-- on order, with no way to say "that is all we are getting". PO-106 closes it: the order
-- becomes RECEIVED — PO-102's machine already allows PARTIALLY_RECEIVED → RECEIVED — and
-- these columns say it was closed short, when, by whom and why. What was ordered and what
-- arrived are not touched; the shortfall is their difference, read, never stored.

ALTER TABLE purchase_orders ADD COLUMN closed_short_at TEXT;
ALTER TABLE purchase_orders ADD COLUMN closed_short_by TEXT REFERENCES users(id);
ALTER TABLE purchase_orders ADD COLUMN close_reason TEXT;
