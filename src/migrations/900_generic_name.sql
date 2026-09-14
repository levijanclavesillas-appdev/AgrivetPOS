-- 900_generic_name.sql — a product's generic name (pharmacy edition)
-- Source of truth: docs/PHARMACY_EDITION.md. Conventions in 05_TECH_SPEC.md §3.1 are binding.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).
--
-- A drugstore shelf is read by brand and asked for by generic: the customer says
-- "paracetamol", the box says "Biogesic". RA 6675 (the Generics Act) is why the generic
-- is on the box at all, and it is the name a customer, a doctor's note and a supplier's
-- price list all share. So it is a column the counter searches, not a word somebody
-- remembered to type into the description.
--
-- Nullable, and it stays nullable: a bag of cotton balls has no generic name, and every
-- product created before this file has none recorded. There is no uniqueness either —
-- twenty brands of paracetamol share one generic, which is the whole point of it.
--
-- Not indexed. Search is `LIKE '%term%'`, which no b-tree can serve; it rides the same
-- single pass over products that name, SKU and brand already take (NFR_1.3).

ALTER TABLE products ADD COLUMN generic_name TEXT;
