'use strict';

// The onboarding workbook — `src/services/openingWorkbookService.js`, served at
// GET /data/opening/workbook and written to disk by `tools/opening-template/build.js`.
//
// A client may fill this in before the shop has a system to look at, so nobody sees a
// bad column until the cutover morning. Three things are therefore worth asserting here
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
//
// **The data rows start empty.** Since the pharmacy edition the workbook is read back
// by the application, so an example row left in place would be loaded — a store that
// never deleted "PARA-500" would open with a product it does not stock. The example
// lives in the legend, row 2, which the reader recognises and skips.

const test = require('node:test');
const assert = require('node:assert/strict');
const zip = require('../../config/zip');
const openingDataService = require('../../services/openingDataService');
const { workbook, SHEETS, filesFromWorkbook, isLegendRow } = require('../../services/openingWorkbookService');
const tool = require('../../../tools/opening-template/build');

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

  // Sheet 1 is the read-me; the rest are KINDS in its own order, which is the load
  // order — the lists everything points at first, then what points at them.
  assert.equal(SHEETS[0].kind, undefined);
  assert.deepEqual(SHEETS.slice(1).map((sheet) => sheet.kind), openingDataService.KIND_NAMES);

  SHEETS.slice(1).forEach((entry, offset) => {
    const { kind } = entry;
    const sheet = files[`xl/worksheets/sheet${offset + 2}.xml`];
    const declared = openingDataService.KINDS[kind];
    const [headers] = declared.example;

    assert.equal(entry.name, declared.sheet, `${kind}: the tab is not named what the reader looks for`);
    assert.deepEqual(rowOf(sheet, 1), headers, `${kind}: the header row is not the validator's`);

    // Nothing in `required` or `optional` may be absent from the sheet — that is the
    // check that makes "generated from the table" true rather than merely intended.
    for (const column of [...declared.required, ...declared.optional]) {
      assert.ok(headers.includes(column), `${kind}: ${column} is not on the sheet`);
    }

    // Row 2 answers the first question anybody asks of a spreadsheet, on the sheet
    // rather than in an email — and where the answer is "it depends", it says on what.
    // The validator's first example follows it, so the shape of a good row is beside
    // the column rather than in a row that would be loaded.
    rowOf(sheet, 2).forEach((legend, column) => {
      const header = headers[column];
      const [word, example] = legend.split(' · e.g. ');
      if (declared.required.includes(header)) {
        assert.equal(word, 'required', `${kind}: ${header} is required and does not say so`);
      } else {
        assert.ok(
          word === 'optional' || /^required if /.test(word),
          `${kind}: ${header} reads "${word}" — optional, or required on a stated condition`
        );
      }
      assert.equal(example ?? '', declared.example[1][column], `${kind}: ${header}'s example is not the validator's`);
    });

    // Nothing below the legend. Row 3 is the store's first row of its own data.
    assert.equal(rowOf(sheet, 3), null, `${kind}: the sheet carries a row that would be loaded`);
  });
});

test('a blank workbook read back is no files at all, not files of zero rows', () => {
  // The legend is recognised and skipped on the way in, so the template as downloaded
  // is the same as sending nothing — and the validator says "send at least one file"
  // rather than loading nine example rows.
  const files = filesFromWorkbook(workbook());
  assert.deepEqual(Object.keys(files), openingDataService.KIND_NAMES);
  for (const kind of openingDataService.KIND_NAMES) assert.equal(files[kind], null, kind);
  assert.equal(openingDataService.validate(files).ok, false);
});

test('the legend is recognised by its words and nothing else', () => {
  assert.equal(isLegendRow(['required · e.g. PARA-500', 'optional', '']), true);
  assert.equal(isLegendRow(['required if batch-tracked', 'Optional']), true);
  // A product somebody named "Optional Extras" in column B is still data, because
  // column A is a SKU and not one of the words.
  assert.equal(isLegendRow(['OPT-1', 'Optional Extras']), false);
  assert.equal(isLegendRow(['', '', '']), false);
});

test('the batch columns TASK-029 added are on the workbook without anybody adding them', () => {
  const files = parts();
  const at = (kind) => `xl/worksheets/sheet${openingDataService.KIND_NAMES.indexOf(kind) + 2}.xml`;
  const products = rowOf(files[at('products')], 1);
  const stock = rowOf(files[at('stock')], 1);
  const legend = rowOf(files[at('stock')], 2);

  for (const column of ['batch_tracked', 'generic_name', 'senior_pwd']) {
    assert.ok(products.includes(column), `${column} is not on the products sheet`);
  }
  for (const column of ['batch_no', 'expiry_date', 'supplier']) {
    assert.ok(stock.includes(column), `${column} is not on the opening stock sheet`);
    // INV-202 does not make these optional; it makes them required for the goods that
    // carry a batch. "Optional" beside expiry_date is how a client leaves the vaccine's
    // date blank and finds out on cutover morning.
    assert.match(legend[stock.indexOf(column)], /^required if batch-tracked\b/);
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

test('the same workbook twice is the same bytes, and the tool writes the one the app serves', () => {
  // zipMany is deterministic by construction (OPS-101's reasoning), and that carries
  // here: a template regenerated for the next client is diffable against the last one,
  // so "has the shape changed?" is a question somebody can actually answer.
  assert.ok(workbook().equals(workbook()));
  assert.ok(tool.workbook().equals(workbook()));
});

test('TASK-053: the examples and the title are the industry\'s — paracetamol or hog feed', () => {
  const text = (industry) => zip.unzipMany(workbook({ industry }))
    .map((entry) => entry.content.toString('utf8')).join('\n');
  const pharmacy = text('PHARMACY');
  const agrivet = text('AGRIVET');

  assert.match(pharmacy, /Opening data for Chachi POS \(Pharmacy\)/);
  assert.match(pharmacy, /e\.g\. PARA-500/);
  assert.match(agrivet, /Opening data for Chachi POS \(Agrivet\)/);
  assert.match(agrivet, /e\.g\. HG-50/);
  assert.match(agrivet, /e\.g\. SACK/, 'a pack is a sack');
  assert.doesNotMatch(agrivet, /PARA-500/);
  // The columns are the same product's, whatever the industry.
  assert.deepEqual(filesFromWorkbook(workbook({ industry: 'AGRIVET' })), filesFromWorkbook(workbook({ industry: 'PHARMACY' })));
});
