'use strict';

// The onboarding workbook — written for the store to fill in, and read back when it does.
// OPS-105 – OPS-107, and the pharmacy edition's onboarding step (SCR-001, step 6).
//
// One `.xlsx` with a sheet per kind `openingDataService.KINDS` names, generated from
// that table — the same table that validates the upload. A column added to the
// validator appears here without anybody remembering to add it, which is the reason the
// CSV templates are generated rather than kept on disk, applied one format further out.
// Until the pharmacy edition this lived in `tools/opening-template/build.js` and was
// emailed to a client; it is now served by the application and sent straight back to it.
//
// ── Why a workbook and not the CSV the app also serves ───────────────────────
//
// A client filling in a CSV opens it in Excel, and Excel makes formatting decisions for
// a person who did not ask:
//
//   `expiry_date` typed as 31/03/2027 and saved back is `31/03/2027`, which INV-202
//   refuses — the store then has a spreadsheet that looks right and a load that will
//   not run.
//
//   A barcode of 4800012345678 survives; one written 0480001234567 does not, because a
//   General cell drops the leading zero and nobody notices until a scan misses at the
//   counter.
//
//   A `quantity` of 1,250 acquires a thousands separator.
//
// A sheet whose columns are declared **text** makes none of those decisions: what is
// typed is what is stored, and what is stored is what the validator reads. And where a
// cell was retyped as a number or a date anyway, `filesFromWorkbook` reads it back as
// the digits or the date the person meant.
//
// ── No example rows on the data sheets ───────────────────────────────────────
//
// Until the workbook was read back by the application, row 3 of every sheet was an
// example to copy. Now it would be loaded: a store that left "PARA-500" in place would
// open with a product it does not stock. So the example lives in row 2, beside the
// word that says whether the column is required — "required · e.g. TAB" — and row 2 is
// recognised and skipped on the way back in. The data rows start empty.
//
// ── Written by hand, and why that is not madness ─────────────────────────────
//
// An .xlsx is a ZIP of XML, and this file writes both — the archive with `config/zip.js`
// (already deterministic) and about ninety lines of XML below. The alternative is a
// dependency, and 05_TECH_SPEC.md §2 keeps this product at four of them with no build
// step. Cells are inline strings throughout: a shared-string table would be smaller and
// is exactly the optimisation that turns a readable generator into one nobody changes.

const industries = require('../config/industries');
const storeProfileRepository = require('../repositories/storeProfileRepository');
const zip = require('../config/zip');
const csv = require('../config/csv');
const xlsx = require('../config/xlsx');
const errors = require('./errors');
const openingDataService = require('./openingDataService');

const { KINDS, KIND_NAMES } = openingDataService;

const FILE_NAME = 'pharmacy_opening_template.xlsx';
const CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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

/** Row 2's first word for a column: required, optional, or the condition. */
function requirement(kind, header) {
  const declared = KINDS[kind];
  if (declared.required.includes(header)) return 'required';
  return (CONDITIONAL[kind] || {})[header] || 'optional';
}

/** Row 2's whole cell: the requirement, and the example beside it when there is one. */
/**
 * TASK-053: the industry this workbook is being written for — the store's, or the one a
 * template emailed before installation names. Set by workbook() for the one synchronous
 * build; null reads the declared examples and the product name alone.
 */
let building = null;

function legendText(kind, header, column) {
  // TASK-053: the example is the store's kind of stock — paracetamol for a pharmacy,
  // hog feed for an agrivet — and the declared one where the industry names none.
  const own = (industries.get(building) || {}).examples;
  const example = own && own[kind] && own[kind][header] !== undefined
    ? own[kind][header]
    : (KINDS[kind].example[1] ? KINDS[kind].example[1][column] : '');
  return example ? `${requirement(kind, header)} · e.g. ${example}` : requirement(kind, header);
}

/**
 * Row 2, recognised on the way back in: every cell it has begins with one of the words.
 * Asked only of the first row under the header — a brand called "Optional Pharma" on
 * row 30 is a brand.
 */
const isLegendRow = (texts) => texts.some((t) => t.trim() !== '')
  && texts.every((t) => t.trim() === '' || /^(required|optional)\b/i.test(t.trim()));

/**
 * The sheet a client actually types into: the header, the legend, and nothing else.
 *
 * Required columns are headed one way and optional ones another, because "which of
 * these may I leave blank" is the first question anybody asks of a spreadsheet and the
 * answer belongs on it rather than in an email.
 */
function dataSheet(kind) {
  const declared = KINDS[kind];
  const [headers] = declared.example;

  const headerRow = headers.map((header) => ({
    value: header,
    style: declared.required.includes(header) ? S.HEADER : S.HEADER_OPTIONAL,
  }));
  const legend = headers.map((header, column) => ({ value: legendText(kind, header, column), style: S.PROSE }));

  const widths = headers.map((header, column) => Math.max(
    12, Math.min(36, Math.max(header.length, legendText(kind, header, column).length) + 3)
  ));
  return sheetXml([headerRow, legend], { widths, freezeRow: 2 });
}

/**
 * The sheet nobody asked for and everybody needs.
 *
 * A client handed nine tabs of columns will ask the same few questions, and these are
 * they: which tab first, what will be refused and why, and how to get it back.
 */
function readMe() {
  const P = (text) => [{ value: text, style: S.PROSE }];
  const H = (text) => [{ value: text, style: S.TITLE }];
  // TASK-053: the examples in the prose are the store's kind of stock.
  const say = (industries.get(building) || industries.INDUSTRIES.PHARMACY).readme;

  const rows = [
    H(`Opening data for ${industries.displayName(building)}`),
    P('Fill in what the store has today, tab by tab. Leave a tab empty if it has none of that.'),
    P('Row 1 of every tab is the column name — do not change it. Row 2 says whether the column is'),
    P('required and shows an example. Type your own data from row 3 down.'),
    [],
    H('1. Categories, Units, Brands, Suppliers — the lists everything else points at'),
    P(`Categories: how the shelves are grouped — ${say.categories}.`),
    P(`Units: what things are counted and sold in — ${say.units}. Write yes under fractions`),
    P(say.fractions),
    P('Brands: optional. Suppliers: who you buy from; the code is a short name the stock tab can use.'),
    P('Anything the store already has is left as it is, so sending this workbook twice is safe.'),
    [],
    H('2. Products — everything the shop sells'),
    P('One row per product. A product with no stock still goes here. Its category, base_unit and brand'),
    P('must be on the tabs above, or already in the system, spelled the same way.'),
    P(say.generic),
    ...say.batch.map(P),
    ...say.senior.map(P),
    [],
    H('3. Packs — selling one product in more than one size'),
    P(say.pack),
    P('counted in its base unit; the pack is a way of selling several at once.'),
    [],
    H('4. Opening stock — what is on the shelf at cutover'),
    P('One row per product that has stock. A product the store has none of is simply left out.'),
    P('unit_cost is required and cannot be filled in later: every sale keeps the cost that applied when'),
    P('it was made, so a wrong opening cost is wrong in every profit figure the store ever reports.'),
    P('For a batch_tracked product, batch_no, expiry_date and supplier are required — that is what a'),
    P('recall notice is matched on. Write the date as 2027-03-31, year first.'),
    P('An expiry date already in the past will load, with a warning. It cannot be sold, and it is real.'),
    [],
    H('5. Credit balances — what customers owed when the notebook was closed'),
    P('One row per customer with a balance. A customer who owes nothing does not need a row.'),
    [],
    H('What happens next'),
    P('1. Save the workbook as it is — Excel Workbook (.xlsx). No need to save each tab as CSV.'),
    P('2. In the application, choose it and press Check. Every problem is listed with its tab and row'),
    P('   number, and nothing is written. Check as many times as it takes.'),
    P('3. When the check is clean, press Load. A backup is taken first, and the whole workbook loads as'),
    P('   one step — it either all goes in or none of it does.'),
    [],
    H('Two things to know before typing'),
    P('Do not reformat the columns. They are set to Text on purpose: it is what keeps 2027-03-31 from'),
    P('becoming 31/03/2027, and a barcode from losing a leading zero.'),
    P('Do not rename the tabs or the columns. The system reads them by name.'),
  ];

  return sheetXml(rows, { widths: [110] });
}

const SHEETS = Object.freeze([
  { name: 'Read me', xmlOf: readMe },
  ...KIND_NAMES.map((kind) => ({ name: KINDS[kind].sheet, kind, xmlOf: () => dataSheet(kind) })),
]);

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<numFmts count="1"><numFmt numFmtId="164" formatCode="@"/></numFmts>`
    + `<fonts count="4">`
    + `<font><sz val="11"/><name val="Calibri"/></font>`
    + `<font><b/><sz val="11"/><name val="Calibri"/></font>`
    + `<font><b/><sz val="13"/><color rgb="FF1D4ED8"/><name val="Calibri"/></font>`
    + `<font><sz val="11"/><color rgb="FF6B6B6B"/><name val="Calibri"/></font>`
    + `</fonts>`
    + `<fills count="4">`
    + `<fill><patternFill patternType="none"/></fill>`
    + `<fill><patternFill patternType="gray125"/></fill>`
    + `<fill><patternFill patternType="solid"><fgColor rgb="FFDBEAFE"/><bgColor indexed="64"/></patternFill></fill>`
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

/**
 * The workbook, as bytes. Deterministic, because `zipMany` is (OPS-101's reasoning).
 * Written for the store's industry, or for `industry` where one is named (the tool).
 */
function workbook({ industry } = {}) {
  building = industry !== undefined ? industry : storeProfileRepository.industry();
  try {
    return build();
  } finally {
    building = null;
  }
}

function build() {
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

// ── Reading it back ─────────────────────────────────────────────────────────

/** Columns whose numeric cells are Excel date serials — the only kind a date is typed into. */
const DATE_COLUMNS = new Set(['expiry_date']);

/**
 * One sheet as the CSV text `openingDataService` already validates.
 *
 * Converted rather than validated separately, so there is still exactly one judge of
 * a row (`validate`) whichever way the row arrived. **Each sheet row becomes the CSV
 * line with the same number** — blank lines where the sheet has a gap, the legend, or
 * an empty row — because `csv.records` counts blank lines and drops them, so a problem
 * is reported against the row number the store sees down the left edge of Excel.
 *
 * Null for a sheet with nothing under its header, so an untouched tab is the same as a
 * file not sent, rather than a file of zero rows.
 */
function sheetToCsv(sheet, date1904) {
  const lines = [];
  let header = null;
  let firstUnderHeader = true;
  let dataRows = 0;

  for (const row of sheet.rows) {
    // A newline inside a cell would start a second CSV line and move every row number
    // after it by one. Nothing a row carries needs one.
    const texts = row.cells.map((c) => c.text.replace(/\r\n|\r|\n/g, ' '));
    if (texts.every((t) => t.trim() === '')) continue;

    if (header === null) {
      header = texts.map(csv.normaliseHeader);
      lines[row.number - 1] = csv.row(texts);
      continue;
    }
    const legend = firstUnderHeader && isLegendRow(texts);
    firstUnderHeader = false;
    if (legend) continue;

    row.cells.forEach((c, column) => {
      if (c.numeric && DATE_COLUMNS.has(header[column])) {
        texts[column] = xlsx.serialToIsoDate(Number(c.text) + (date1904 ? 1462 : 0)) || texts[column];
      }
    });
    lines[row.number - 1] = csv.row(texts);
    dataRows += 1;
  }

  if (header === null || dataRows === 0) return null;
  return `${Array.from({ length: lines.length }, (_, i) => lines[i] ?? '').join('\r\n')}\r\n`;
}

/**
 * The uploaded workbook, as `{ categories, units, …, balances }` of CSV text or null —
 * the shape `openingDataService.validate` and `run` take.
 *
 * Sheets are found by name, case-insensitively, and by the kind's own name as well
 * ("Stock" for "Opening stock"), because a tab somebody renamed is a tab they still
 * meant. The Read me and any sheet this does not know are ignored.
 */
function filesFromWorkbook(buffer) {
  let book;
  try {
    book = xlsx.readWorkbook(buffer);
  } catch (err) {
    if (err instanceof xlsx.NotAWorkbookError) throw errors.badRequest(err.message, { ruleId: 'OPS-105' });
    throw err;
  }

  const byName = new Map(book.sheets.map((s) => [s.name.trim().toLowerCase(), s]));
  const files = {};
  for (const kind of KIND_NAMES) {
    const sheet = byName.get(KINDS[kind].sheet.toLowerCase())
      || byName.get(kind)
      || byName.get(KINDS[kind].label.toLowerCase());
    files[kind] = sheet ? sheetToCsv(sheet, book.date1904) : null;
  }

  if (!KIND_NAMES.some((kind) => byName.has(KINDS[kind].sheet.toLowerCase()) || byName.has(kind))) {
    throw errors.badRequest(
      `This workbook has none of the tabs the load reads (${KIND_NAMES.map((k) => KINDS[k].sheet).join(', ')}). `
      + 'Start from the template, and keep its tab names.',
      { ruleId: 'OPS-105' }
    );
  }
  return files;
}

module.exports = { workbook, SHEETS, FILE_NAME, CONTENT_TYPE, filesFromWorkbook, isLegendRow, legendText };
