'use strict';

// The onboarding workbook — `tools/opening-template/build.js`.
//
// A client fills this in before the shop has a system to look at, so nobody sees a bad
// column until the cutover morning. Two things are therefore worth asserting here
// rather than discovering there.
//
// **Its columns are the validator's.** The workbook is generated from
// `openingDataService.KINDS`, and this file checks that it still is — a column added to
// the validator and missing from the template would produce a spreadsheet that fails
// its own load, which is exactly the failure the CSV templates were generated to
// prevent. `batch_tracked` and the three batch columns arrived that way during
// `TASK-029` and reached the workbook without anybody editing it.
//
// **Every cell is text.** That single style attribute is the whole reason this is a
// workbook and not the CSV the app already serves: an Excel cell left General turns
// 2027-03-31 into 31/03/2027, drops the leading zero off a barcode, and puts a
// thousands separator in a quantity — three refusals a client cannot diagnose.

const test = require('node:test');
const assert = require('node:assert/strict');
const zip = require('../../config/zip');
const openingDataService = require('../../services/openingDataService');
const { workbook, SHEETS } = require('../../../tools/opening-template/build');

const parts = () => Object.fromEntries(
  zip.unzipMany(workbook()).map((entry) => [entry.name, entry.content.toString('utf8')])
);

/** The inline strings of one row, in order. A crude read, and enough to check a header. */
const rowOf = (sheetXml, rowNumber) => {
  const row = new RegExp(`<row r="${rowNumber}">(.*?)</row>`).exec(sheetXml);
  if (!row) return null;
  return [...row[1].matchAll(/<t xml:space="preserve">(.*?)<\/t>|<c [^>]*\/>/g)]
    .map((m) => (m[1] === undefined ? '' : m[1]));
};

test('the workbook is a readable OPC package, with a sheet per file OPS-105 names', () => {
  const files = parts();

  for (const required of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels', 'xl/styles.xml']) {
    assert.ok(files[required], `${required} is missing`);
  }

  // Every sheet is declared, related and present. Excel refuses the file outright if
  // any one of the three is missing, with a message that says nothing useful.
  SHEETS.forEach((sheet, index) => {
    const file = `xl/worksheets/sheet${index + 1}.xml`;
    assert.ok(files[file], `${file} is missing`);
    assert.match(files['xl/workbook.xml'], new RegExp(`name="${sheet.name}"[^>]*r:id="rId${index + 1}"`));
    assert.match(files['xl/_rels/workbook.xml.rels'],
      new RegExp(`Id="rId${index + 1}"[^>]*Target="worksheets/sheet${index + 1}.xml"`));
    assert.match(files['[Content_Types].xml'], new RegExp(`PartName="/${file}"`));
  });
});

test('every sheet carries the validator’s own columns, in its own order', () => {
  const files = parts();

  // The mapping is positional and deliberate: sheet 1 is the read-me, and the three
  // data sheets follow the order a cutover fills them in.
  for (const [index, kind] of ['products', 'stock', 'balances'].entries()) {
    const sheet = files[`xl/worksheets/sheet${index + 2}.xml`];
    const declared = openingDataService.KINDS[kind];
    const [headers] = declared.example;

    assert.deepEqual(rowOf(sheet, 1), headers, `${kind}: the header row is not the validator's`);

    // Nothing in `required` or `optional` may be absent from the sheet — that is the
    // check that makes "generated from the table" true rather than merely intended.
    for (const column of [...declared.required, ...declared.optional]) {
      assert.ok(headers.includes(column), `${kind}: ${column} is not on the sheet`);
    }

    // Row 2 answers the first question anybody asks of a spreadsheet, on the sheet
    // rather than in an email — and where the answer is "it depends", it says on what.
    rowOf(sheet, 2).forEach((word, column) => {
      const header = headers[column];
      if (declared.required.includes(header)) {
        assert.equal(word, 'required', `${kind}: ${header} is required and does not say so`);
      } else {
        assert.ok(
          word === 'optional' || /^required if /.test(word),
          `${kind}: ${header} reads "${word}" — optional, or required on a stated condition`
        );
      }
    });

    // And the examples are the validator's, so a client copying the shape of the row
    // below the legend is copying something that has passed the checks it will face.
    assert.deepEqual(rowOf(sheet, 3), declared.example[1]);
  }
});

test('the batch columns TASK-029 added are on the workbook without anybody adding them', () => {
  const files = parts();
  const products = rowOf(files['xl/worksheets/sheet2.xml'], 1);
  const stock = rowOf(files['xl/worksheets/sheet3.xml'], 1);
  const legend = rowOf(files['xl/worksheets/sheet3.xml'], 2);

  assert.ok(products.includes('batch_tracked'));
  for (const column of ['batch_no', 'expiry_date', 'supplier']) {
    assert.ok(stock.includes(column), `${column} is not on the opening stock sheet`);
    // INV-202 does not make these optional; it makes them required for the goods that
    // carry a batch. "Optional" beside expiry_date is how a client leaves the vaccine's
    // date blank and finds out on cutover morning.
    assert.equal(legend[stock.indexOf(column)], 'required if batch-tracked');
  }
});

test('every cell is text, which is the whole reason this is not a CSV', () => {
  const files = parts();

  // numFmtId 164 is "@" — text — and every cell style in the sheet references a format
  // that carries it. A General cell is where 2027-03-31 becomes 31/03/2027.
  assert.match(files['xl/styles.xml'], /<numFmt numFmtId="164" formatCode="@"\/>/);
  const formats = [...files['xl/styles.xml'].matchAll(/<xf numFmtId="(\d+)"[^>]*xfId="0"/g)]
    .map((m) => m[1]);
  assert.deepEqual(formats.slice(1), ['164', '164', '164', '164', '164'],
    'every style but the base one is text');

  for (const [index] of SHEETS.entries()) {
    const sheet = files[`xl/worksheets/sheet${index + 1}.xml`];
    const styled = [...sheet.matchAll(/<c r="[A-Z]+\d+" s="(\d+)"/g)].map((m) => m[1]);
    assert.ok(styled.length > 0, 'the sheet has cells');
    assert.equal(styled.includes('0'), false, 'no cell falls back to the General style');
  }
});

test('the same workbook twice is the same bytes', () => {
  // zipMany is deterministic by construction (OPS-101's reasoning), and that carries
  // here: a template regenerated for the next client is diffable against the last one,
  // so "has the shape changed?" is a question somebody can actually answer.
  assert.ok(workbook().equals(workbook()));
});
