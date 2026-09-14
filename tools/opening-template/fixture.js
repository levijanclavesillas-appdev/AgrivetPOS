'use strict';

// The filled-in workbook `src/tests/integration/opening-workbook.test.js` reads.
//
//   NODE_PATH=/path/to/node_modules node tools/opening-template/fixture.js
//
// Needs ExcelJS, which is **not** a dependency of this product and is not installed by
// `npm install` — put it anywhere (`npm install exceljs@4.4.0` in a scratch folder) and
// point NODE_PATH at it. The output is committed, so the suite never needs it.
//
// Why a second implementation writes the fixture: `src/config/xlsx.js` has to read what
// a spreadsheet application writes on save, not what our own writer wrote. ExcelJS
// shares no code and no author with either, and writes the way Excel does in every
// place that matters — a shared-string table instead of inline strings, numbers typed
// into a Text column stored as numbers anyway, a date as a serial, a formula with its
// cached result. So this opens the template exactly as a store would, types into it the
// way a person does, and saves it.

const fs = require('fs');
const path = require('path');
// eslint-disable-next-line import/no-unresolved
const ExcelJS = require('exceljs');
const { workbook } = require('../../src/services/openingWorkbookService');

const OUT = path.join(__dirname, '..', '..', 'src', 'tests', 'fixtures', 'opening-workbook.xlsx');

/** Rows from row 3 down, as a person fills them in. `undefined` leaves a cell alone. */
function fill(sheet, rows, { from = 3 } = {}) {
  rows.forEach((values, offset) => {
    if (values === null) return; // a row somebody skipped
    values.forEach((value, column) => {
      if (value === undefined || value === '') return;
      sheet.getRow(from + offset).getCell(column + 1).value = value;
    });
  });
}

async function main() {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(workbook());

  fill(book.getWorksheet('Categories'), [
    ['Medicines'],
    ['Vitamins'],
    // A ceiling typed as a number, into a Text column — Excel stores 10, not "10".
    ['Personal Care', 10],
  ]);

  fill(book.getWorksheet('Units'), [
    ['TAB', 'Tablet'],
    ['CAP', 'Capsule'],
    ['BOX', 'Box'],
    ['PC', 'Piece'],
    ['BOT', 'Bottle'],
    ['ML', 'Millilitre', 'yes'],
  ]);

  fill(book.getWorksheet('Brands'), [
    ['Sample Pharma'],
    // "Optional" at the start of a real row, on a one-column sheet — data, not a legend.
    ['Optional Health'],
  ]);

  fill(book.getWorksheet('Suppliers'), [
    ['Mindanao Pharma Supply', 'MPS', 'Ana Cruz', '09171234567', 30, 'Koronadal City'],
  ]);

  fill(book.getWorksheet('Products'), [
    // Prices and a barcode typed as numbers. 4800012345678 is a thirteen-digit double,
    // written by some tools as 4.800012345678E12.
    ['PARA-500', 'Paracetamol 500mg tablet', 'Medicines', 'TAB', 4.5, 'Paracetamol', 'Sample Pharma', '', '', 'VATABLE', 200, 4800012345678, 'yes', 'yes'],
    ['ASC-500', 'Ascorbic Acid 500mg capsule', 'Vitamins', 'CAP', 6, 'Ascorbic acid', 'Optional Health', '', '', 'VATABLE', 100, '', 'yes', 'yes'],
    // A leading-zero barcode typed as text, which is what the Text column is for.
    ['COTTON-50', 'Cotton balls 50s', 'Personal Care', 'PC', '35.00', '', '', '', '', 'VATABLE', 10, '0480001234567', '', ''],
    null,
    // 4.55 is the price a double cannot hold exactly — stored as 4.5499999999999998.
    ['LAG-60', 'Lagundi syrup 60 mL', 'Medicines', 'BOT', 4.55, 'Vitex negundo', 'Sample Pharma', '', '', 'VATABLE', 12, '', 'yes', 'yes'],
  ]);

  fill(book.getWorksheet('Packs'), [
    ['PARA-500', 'BOX', 100, 'yes'],
    ['ASC-500', 'BOX', 100],
  ]);

  fill(book.getWorksheet('Opening stock'), [
    // A real date cell — a serial with a date format — and a supplier by code.
    ['PARA-500', 1000, 2.8, 'Counted 1 Sep', 'P24091', new Date(Date.UTC(2027, 7, 31)), 'MPS'],
    ['ASC-500', 1250, 3.6, '', 'AC2291', '2027-03-31', 'Mindanao Pharma Supply'],
    null,
    // A cost somebody worked out in the cell: the cached result is the value.
    ['COTTON-50', 24, { formula: '11*2', result: 22 }],
    ['LAG-60', 30, 32.5, '', 'L77', new Date(Date.UTC(2028, 0, 15)), 'MPS'],
  ]);

  fill(book.getWorksheet('Credit balances'), [
    ['Barangay Health Center', 12500, 'BHC', '09171234567', 50000, 30, 'From the blue notebook'],
    ['Aling Nena', 850.5, '', '', 5000, 15],
  ]);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await book.xlsx.writeFile(OUT);
  process.stdout.write(`${OUT}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exitCode = 1;
});
