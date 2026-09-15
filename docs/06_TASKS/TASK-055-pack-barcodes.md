# TASK-055 — The barcode on a box sells a box

**Priority:** **P1** · **Rules:** `VR-205`, `UOM-002` · **Source of truth:** `PHARMACY_EDITION.md` §10

## What was wrong

A barcode belonged to the product, not to a pack. Scanning the code printed on a box of 100
tablets added **one tablet**; the cashier had to notice and change the line with F3, or the
customer left with a box for the price of a tablet.

## As built

| Piece | Where |
| :--- | :--- |
| `product_barcodes.pack_unit_id` — which pack a code is printed on; NULL is the base unit | `905_pack_barcodes.sql` |
| Attach with `packUnitId`, refused for a pack the product lacks; audited with the pack | `productService.attachBarcode(Within)`, `POST /products/:id/barcodes` |
| A scan answers with the pack; the counter adds one of it | `productService.findByBarcode`, `pos/view.js` |
| Barcodes listed with what one scan adds; *Printed on* when adding | `catalogue/editor.js` |
| A pack with a barcode on it cannot be removed | `productService.removePack` |
| Packs tab `barcode` column, checked against the store, the Products tab and itself | `openingDataService`, workbook examples and Read me |
| Export/import carries the column; import checks its unit exists | `importService.REFERENCES` |

## Tests

`sales.test.js`: a loose code and a sack code on one product; a code refused for a pack the product
lacks; the scan answers with the pack; one sack sells as 50 kg; a pack with a code cannot be
removed until the code is. `opening-workbook.test.js`: a pack's code loads onto the pack; the same
code on the Products and Packs tabs is refused at the check. `renderer.test.js`: the counter passes
the pack; the editor asks what a code is printed on. Walked in the renderer: PAR-500's box code
attached as *1 BOX = 100 TAB*, and a scan at the counter added *1 BOX (100 TAB)*.
