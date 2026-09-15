-- 904_store_industry.sql — one application, the store's industry chosen at setup (TASK-053)
-- Source of truth: docs/PHARMACY_EDITION.md §9 and src/config/industries.js. Conventions in
-- 05_TECH_SPEC.md §3.1 are binding.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).
--
-- Chachi Agrivet POS and Chachi Pharmacy POS were two products on two branches. A Play
-- Store listing is one app, so they are now one — Chachi POS — and what kind of store it
-- is becomes a fact about the store, recorded by the setup wizard and fixed from then on.
--
-- The CHECK names every industry on the roadmap, including the two not offered yet, so
-- that offering one later is a line in industries.js rather than a table rebuild (a
-- CHECK cannot be altered in SQLite). The service refuses an industry not yet available.
--
-- A database set up before this file ran was set up by a pharmacy build — the only one
-- this migration ships in — so that is what it is recorded as.

ALTER TABLE store_profile ADD COLUMN industry TEXT NOT NULL DEFAULT 'PHARMACY'
  CHECK (industry IN ('PHARMACY', 'AGRIVET', 'MOTORCYCLE', 'RETAIL'));
