-- 902_product_images.sql — a photo of each product (pharmacy edition, TASK-052)
-- Source of truth: docs/PHARMACY_EDITION.md §7. Conventions in 05_TECH_SPEC.md §3.1 are binding.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).
--
-- A drugstore counter is read by the box: twenty brands of paracetamol, and the one the
-- customer means is the one with the yellow stripe. One picture per product, in the
-- database rather than beside it, so every backup and every restore carries it without
-- a second thing to copy (OPS-001) and a product never points at a file that is gone.
--
-- **Two sizes, both made by the renderer before upload (IMG-001).** The server has no
-- image library and none is added: a native one would have to be built for Windows and
-- for nodejs-mobile both. The POS scales the photo on a canvas — at most 640 px on the
-- long side for the editor, 128 px for lists — and the server checks what arrives.
--
-- **The small columns come first and the pictures last**, deliberately. The product
-- list joins this table for `sha256` alone; SQLite reads a row's columns in order, and a
-- column stored after a large BLOB is reached only by walking the BLOB's overflow pages.
--
-- Keyed on the product: at most one picture each, replaced in place. No foreign key
-- cascade is needed because a product is never deleted (VR-206).

CREATE TABLE product_images (
  product_id   TEXT PRIMARY KEY REFERENCES products(id),
  sha256       TEXT NOT NULL,                                    -- of `image`; the renderer caches by it
  mime         TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),  -- IMG-001
  image_bytes  INTEGER NOT NULL,
  thumb_bytes  INTEGER NOT NULL,
  updated_at   TEXT NOT NULL,
  updated_by   TEXT REFERENCES users(id),
  thumb        BLOB NOT NULL,
  image        BLOB NOT NULL
);
