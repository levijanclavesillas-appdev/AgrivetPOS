# TASK-052 — A picture of each product

**Priority:** **P2** · **Blocks release:** no · **Branch:** `pharmacy` · **Rules:**
`IMG-001`–`IMG-002` (`PHARMACY_EDITION.md` §7) · **Requirement:** `04_UX_SPEC.md` §3 (`SCR-201`,
`SCR-202`, `SCR-301`)

---

## Objective

Show each product's picture wherever a person picks a product: in the catalogue list, on the
product editor, and in the counter's search.

## Context

The client asked, once Google sign-in worked:

> can we integrate product image on catalog?

A drugstore shelf is read by the box. Twenty brands of paracetamol share one generic name, and
the one the customer means is "the one with the yellow stripe". The generic name (`TASK-046`)
lets the counter find all of them; a picture lets the cashier tell them apart.

## Decisions (made in the build; the client can change any of them)

| # | Decision | Why |
| :-: | :--- | :--- |
| D-1 | **One picture per product**, replaced in place | What the counter needs is recognition, not a gallery |
| D-2 | **In the database**, not beside it | A backup, a restore and an export carry the pictures with nothing else to copy, and a product never points at a file that is gone |
| D-3 | **Shrunk by the POS before it is sent**: 640 px on the long side, and a 128 px thumbnail, JPEG on white | The server has no image library, and none is added — a native one would have to be built for Windows and for nodejs-mobile both. A phone's 12-megapixel photo never crosses the API |
| D-4 | **Checked by the server by its first bytes**: JPEG, PNG or WebP; at most 600 KB and 64 KB. Never SVG | An SVG is a document that can carry script |
| D-5 | **Anyone who reads the catalogue sees it; whoever edits the product sets it** (`TX-410`) | The cashier is who needs it most, and has no business changing it |
| D-6 | **Saved as soon as it is chosen**, not with the form | A photo taken at the shelf should not wait on somebody pressing Save. For a new product it is held and sent once the product exists |
| D-7 | **On Android, the camera or the gallery** | The photo is usually taken at the shelf, on the tablet or phone the store already has |

## As built

| Piece | Where |
| :--- | :--- |
| Table `product_images` (one row per product; the short columns first, the BLOBs last, so the list's join never reads a picture) | `src/migrations/902_product_images.sql` |
| `GET /products/:id/image[?size=thumb]` (`TX-422`, cached for good by version), `PUT` and `DELETE` (`TX-410`) | `src/routes/products.js`, `productImageService`, `productImageRepository` |
| `image_version` on every product payload — the first 16 hex of the picture's SHA-256 | `productRepository` (join), `productService.toPublic` |
| Audit `PRODUCT_IMAGE_SET` / `PRODUCT_IMAGE_REMOVED`, by version, never bytes, in the same transaction as the write | `auditService`, `productImageService` |
| Export and import: BLOB columns travel as base64 (`dataRepository.blobColumnsOf`) | `exportService`, `importService.fromArchive` |
| Fetch with the token, show from a blob (`SEC-7`); a bounded cache of object URLs; shrink on a canvas | `public/js/shell/pictures.js`, `api.blob`; CSP `img-src … blob:` |
| Editor: the picture at the top of Identity — Add, Replace, Remove | `public/js/catalogue/editor.js` |
| Thumbnail beside the name in the list and in the counter's search | `catalogue/list.js`, `pos/view.js` |
| Android: `image/*` opens a chooser with the camera and the gallery; the camera writes through a small provider of the app's own, with no AndroidX | `MainActivity.choosePicture`, `PhotoProvider.java`, the manifest's `<queries>` and `<provider>` |

## Tests

| Case | Asserts |
| :--- | :--- |
| `product-images.test.js` (9) | No picture → 404 and `image_version` null; a JPEG stored and its version on the list; bytes back unchanged, each size, to a cashier, with `nosniff` and an immutable cache; SVG, mixed formats and non-base64 refused (`IMG-001`); an oversized thumbnail refused with what to do; a cashier refused and stock staff allowed (`IMG-002`); the trail by version; the picture out through an export and back through an import as a BLOB; text where a picture should be refused |
| Walked in Electron at 1366×768 and 390×844 | A 4000×3000 photo through the real `shrink` and upload (10 KB and 2 KB for that test image); the list, the editor and the counter's search with two pictured products and one without; no sideways overflow |

**Status — 2026-09-14:** built on the `pharmacy` branch. The Android camera path builds but has
not been run on a device (this host cannot run an emulator). **Not in scope:** pictures in the
opening workbook (added per product instead), on receipts, and on the low-stock list (which shows
the empty frame).
