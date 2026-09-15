-- 905_pack_barcodes.sql — a barcode can be on a pack: scanning the box adds a box (TASK-055)
-- Source of truth: docs/PHARMACY_EDITION.md §10. Conventions in 05_TECH_SPEC.md §3.1 are binding.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).
--
-- A barcode belonged to a product, so the code printed on a box of a hundred tablets
-- added one tablet at the counter, and the cashier had to notice and press F3 — or the
-- customer walked out with a box for the price of a tablet. The box's code is a fact
-- about the box: `pack_unit_id` names which of the product's packs it is printed on,
-- and NULL is the product's base unit, as every barcode before this file was.
--
-- The unit, not the pack's id: a pack is (product, unit), unique (002's product_packs),
-- and the unit is what the cart line already carries (`packUnitId`). productService
-- refuses to remove a pack while a barcode names it, so the pair cannot dangle.

ALTER TABLE product_barcodes ADD COLUMN pack_unit_id TEXT REFERENCES units(id);
