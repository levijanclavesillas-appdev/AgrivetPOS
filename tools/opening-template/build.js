'use strict';

// The opening-load workbook, for a store that is about to be onboarded.
//
//   node tools/opening-template/build.js [path]
//
// One `.xlsx` with a sheet per file `OPS-105` names, generated from
// `openingDataService.KINDS` — the same table that validates the upload. A column added
// to the validator appears here without anybody remembering to add it, which is the
// reason the CSV templates are generated rather than kept on disk, applied one format
// further out.
//
// ── Why a workbook and not the CSV the app already serves ────────────────────
//
// The CSV template is correct and an operator can fill it in. A **client** filling it
// in is a different proposition, and Excel is what they will open it with:
//
//   `expiry_date` typed as 31/03/2027 and saved back is `31/03/2027`, which INV-202
//   refuses — the store then has a spreadsheet that looks right and a load that will
//   not run.
//
//   A barcode of 4800012345678 survives; one written 0480001234567 does not, because a
//   General cell drops the leading zero and nobody notices until a scan misses at the
//   counter.
//
//   A `quantity` of 1,250 acquires a thousands separator, and `parseQuantity` is right
//   to refuse it.
//
// Every one of those is a formatting decision Excel makes for a person who did not ask.
// A sheet whose columns are declared **text** makes none of them: what is typed is what
// is stored, and what is stored is what the validator reads.
//
// ── Written by hand, and why that is not madness ─────────────────────────────
//
// An .xlsx is a ZIP of XML, and this file writes both — the archive with `config/zip.js`
// (the product's own writer, already deterministic) and about ninety lines of XML below.
// The alternative is a dependency, and 05_TECH_SPEC.md §2 keeps this product at four of
// them with no build step. A template generator is not the thing to spend the fifth on.
//
// Cells are inline strings throughout. A shared-string table would be smaller and is
// exactly the sort of optimisation that turns a readable generator into one nobody
// dares change.

const fs = require('fs');
const path = require('path');
const zip = require('../../src/config/zip');
const openingDataService = require('../../src/services/openingDataService');

const OUT = path.join(__dirname, '..', '..', 'dist', 'agrivet_opening_template.xlsx');

/** XML text, escaped. A store called "Sy & Sons" is not a parse error. */
const xml = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** A1, B1 … AA1. Spreadsheet columns, which are base-26 with no zero. */
function ref(columnIndex, rowNumber) {
  let n = columnIndex + 1;
  let name = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    n = Math.floor((n - 1) / 26);
  }
  return `${name}${rowNumber}`;
}

// Style indexes, in the order they are written into styles.xml below.
const S = { TEXT: 1, HEADER: 2, TITLE: 3, PROSE: 4, HEADER_OPTIONAL: 5 };

const cell = (columnIndex, rowNumber, value, style = S.TEXT) => (value === null || value === undefined || value === ''
  ? `<c r="${ref(columnIndex, rowNumber)}" s="${style}"/>`
  : `<c r="${ref(columnIndex, rowNumber)}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`);

function sheetXml(rows, { widths = [], freezeRow = 0 } = {}) {
  const cols = widths.length === 0 ? '' : `<cols>${widths
    .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1" style="${S.TEXT}"/>`)
    .join('')}</cols>`;

  // The header stays put while a client scrolls down four hundred products. Without it
  // they are typing into column G with no idea what column G is.
  const pane = freezeRow === 0 ? '' :
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${freezeRow}" topLeftCell="A${freezeRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`;

  const body = rows.map((cells, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const painted = cells.map((entry, columnIndex) => (entry && typeof entry === 'object'
      ? cell(columnIndex, rowNumber, entry.value, entry.style)
      : cell(columnIndex, rowNumber, entry)));
    return `<row r="${rowNumber}">${painted.join('')}</row>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `${pane}${cols}<sheetData>${body}</sheetData></worksheet>`;
}

/**
 * Columns that are optional in the header and required in the row, and what decides it.
 *
 * `INV-202` does not make a batch number optional — it makes it required for the goods
 * that carry one. A legend reading "optional" beside `expiry_date` is how a client
 * leaves the vaccine's date blank and finds out on cutover morning; the honest word is
 * the condition.
 */
const CONDITIONAL = Object.freeze({
  stock: {
    batch_no: 'required if batch-tracked',
    expiry_date: 'required if batch-tracked',
    supplier: 'required if batch-tracked',
  },
});

/**
 * The sheet a client actually types into.
 *
 * Required columns are headed one way and optional ones another, because "which of
 * these may I leave blank" is the first question anybody asks of a spreadsheet and the
 * answer belongs on it rather than in an email.
 */
function dataSheet(kind) {
  const declared = openingDataService.KINDS[kind];
  const [headers, ...examples] = declared.example;

  const headerRow = headers.map((header) => ({
    value: header,
    style: declared.required.includes(header) ? S.HEADER : S.HEADER_OPTIONAL,
  }));

  const conditional = CONDITIONAL[kind] || {};
  const legend = headers.map((header) => ({
    value: declared.required.includes(header)
      ? 'required'
      : (conditional[header] || 'optional'),
    style: S.PROSE,
  }));

  // The examples are the validator's own, so a client copying the shape of row 3 is
  // copying something that has passed the checks it is about to face.
  const rows = [headerRow, legend, ...examples];
  const widths = headers.map((header) => Math.max(12, Math.min(28, header.length + 6)));
  return sheetXml(rows, { widths, freezeRow: 2 });
}

/**
 * The sheet nobody asked for and everybody needs.
 *
 * A client handed three tabs of columns will ask four questions, and these are they:
 * what goes in each file, what will be refused and why, what to do about the things the
 * store has to create first, and how to get it back to the shop.
 */
function readMe() {
  const P = (text) => [{ value: text, style: S.PROSE }];
  const H = (text) => [{ value: text, style: S.TITLE }];

  const rows = [
    H('Opening data for Chachi Agrivet POS'),
    P('Three tabs. Fill in what the store has today; leave a tab empty if it has none of that.'),
    [],
    H('Products — everything the shop sells'),
    P('One row per product. A product with no stock still goes here.'),
    P('Category and base unit must already exist in the system — the shop creates those first, in'),
    P('Products → New product. The load will not invent a category, because a category carries its own'),
    P('discount ceiling and is not something to guess from a spreadsheet.'),
    P('batch_tracked: write yes for goods sold by expiry date — vaccines, medicines. Leave blank for feed.'),
    [],
    H('Opening stock — what is on the shelf at cutover'),
    P('One row per product that has stock. A product the store has none of is simply left out.'),
    P('unit_cost is required and cannot be filled in later: every sale keeps the cost that applied when'),
    P('it was made, so a wrong opening cost is wrong in every profit figure the store ever reports.'),
    P('For a batch_tracked product, batch_no, expiry_date and supplier are required — that is what a'),
    P('recall notice is matched on. Write the date as 2027-03-31, year first.'),
    P('An expiry date already in the past will load, with a warning. It cannot be sold, and it is real.'),
    [],
    H('Credit balances — what customers owed when the notebook was closed'),
    P('One row per customer with a balance. A customer who owes nothing does not need a row.'),
    [],
    H('What happens next'),
    P('1. Fill in the tabs.'),
    P('2. Save each tab as its own CSV: File → Save As → CSV UTF-8 (Comma delimited).'),
    P('3. The shop opens Admin → Data transfer, loads the three files and presses Check.'),
    P('4. Every bad row is listed by its line number, and nothing is written until it is clean.'),
    P('   That check can be run as many times as it takes. It writes nothing at all.'),
    [],
    H('Two things to know before typing'),
    P('Do not reformat the columns. They are set to Text on purpose: it is what keeps 2027-03-31 from'),
    P('becoming 31/03/2027, and a barcode from losing a leading zero.'),
    P('Do not add, rename or reorder columns. The shop’s system reads them by name.'),
  ];

  return sheetXml(rows, { widths: [110] });
}

const SHEETS = [
  { name: 'Read me', xmlOf: readMe },
  { name: 'Products', xmlOf: () => dataSheet('products') },
  { name: 'Opening stock', xmlOf: () => dataSheet('stock') },
  { name: 'Credit balances', xmlOf: () => dataSheet('balances') },
];

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<numFmts count="1"><numFmt numFmtId="164" formatCode="@"/></numFmts>`
    + `<fonts count="4">`
    + `<font><sz val="11"/><name val="Calibri"/></font>`
    + `<font><b/><sz val="11"/><name val="Calibri"/></font>`
    + `<font><b/><sz val="13"/><color rgb="FF1F5C3D"/><name val="Calibri"/></font>`
    + `<font><sz val="11"/><color rgb="FF6B6B6B"/><name val="Calibri"/></font>`
    + `</fonts>`
    + `<fills count="4">`
    + `<fill><patternFill patternType="none"/></fill>`
    + `<fill><patternFill patternType="gray125"/></fill>`
    + `<fill><patternFill patternType="solid"><fgColor rgb="FFDDE8E1"/><bgColor indexed="64"/></patternFill></fill>`
    + `<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill>`
    + `</fills>`
    + `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`
    + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
    // Every style carries numFmtId 164 — "@", text. That single attribute is what stops
    // Excel reading a date, a leading zero or a thousands separator into what somebody
    // typed, which is the whole reason this file exists rather than a CSV.
    + `<cellXfs count="6">`
    + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
    + `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`
    + `<xf numFmtId="164" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>`
    + `<xf numFmtId="164" fontId="2" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>`
    + `<xf numFmtId="164" fontId="3" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>`
    + `<xf numFmtId="164" fontId="1" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>`
    + `</cellXfs>`
    + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>`
    + `</styleSheet>`;
}

/** The workbook, as bytes. Deterministic, because `zipMany` is (OPS-101's reasoning). */
function workbook() {
  const sheets = SHEETS.map((sheet, index) => ({
    ...sheet,
    id: index + 1,
    file: `xl/worksheets/sheet${index + 1}.xml`,
  }));

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
    + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
    + sheets.map((s) => `<Override PartName="/${s.file}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + `</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
    + `</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" `
    + `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheets>${sheets.map((s) => `<sheet name="${xml(s.name)}" sheetId="${s.id}" r:id="rId${s.id}"/>`).join('')}</sheets>`
    + `</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + sheets.map((s) => `<Relationship Id="rId${s.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${s.id}.xml"/>`).join('')
    + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + `</Relationships>`;

  return zip.zipMany([
    { name: '[Content_Types].xml', content: contentTypes },
    { name: '_rels/.rels', content: rootRels },
    { name: 'xl/workbook.xml', content: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', content: workbookRels },
    { name: 'xl/styles.xml', content: stylesXml() },
    ...sheets.map((s) => ({ name: s.file, content: s.xmlOf() })),
  ]);
}

module.exports = { workbook, SHEETS };

if (require.main === module) {
  const out = process.argv[2] || OUT;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, workbook());
  process.stdout.write(`${out}\n`);
}
