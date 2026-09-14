'use strict';

// A minimal .xlsx reader, for the onboarding workbook (OPS-105).
//
// The store fills in the workbook this product hands it (`openingWorkbookService`) and
// sends it back. Asking them to "save each tab as CSV UTF-8" first is three chances to
// pick the wrong CSV flavour, lose a leading zero or send the Read me tab — and the
// person doing it is a pharmacy owner on cutover week, not a clerk who has done it
// before. So the workbook comes back as it is, and this file reads it.
//
// Written here rather than taken as a dependency for the reason `zip.js` gives: the
// container is `zip.unzipMany`, the rest is four small XML parts, and this project runs
// on four runtime dependencies. **Reading only.** Writing is the template service's,
// with its own deliberately tiny writer.
//
// **What it has to survive is whatever Excel, LibreOffice or Google Sheets writes on
// save**, not what our own writer wrote. Those differ in exactly the places this handles:
//
//   - strings in a shared-string table (`t="s"`) rather than inline (`t="inlineStr"`),
//     sometimes as rich-text runs, sometimes with phonetic runs that are not the text;
//   - numbers typed into a General cell, stored as `<v>4.5</v>` or `<v>4.8000123456789E12</v>`;
//   - dates as serial numbers, which only the caller knows to be dates;
//   - formula cells, whose cached value is the answer;
//   - rows and cells omitted when empty, and `r` attributes some writers leave out;
//   - an XML namespace prefix on every element (`<x:c>`), which the OpenXML SDK writes.
//
// The tests read a fixture written by ExcelJS — an implementation that shares no code
// and no author with this one — for the same reason zip.js is checked with Python.
//
// Scope: values only. No styles, no merged cells, no formulas evaluated. Dates stay
// serial numbers; the 1904 flag (old Mac Excel) is read and reported, and the caller that
// knows which columns are dates shifts them.

const zip = require('./zip');

/** XML entities, including numeric ones. The five named ones are all OOXML uses. */
function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity) => {
    const e = entity.toLowerCase();
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const code = e.startsWith('#x') ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
  });
}

// Every element name may carry a namespace prefix. `P` is that optional prefix.
const P = '(?:[A-Za-z_][\\w.-]*:)?';
const elements = (xml, name) => xml.match(new RegExp(`<${P}${name}\\b[^>]*?(?:/>|>[\\s\\S]*?</${P}${name}>)`, 'g')) || [];
const attr = (tag, name) => {
  const m = new RegExp(`\\s${P}${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  return m ? decode(m[2] ?? m[3]) : null;
};
const openTag = (element) => element.slice(0, element.indexOf('>') + 1);

/**
 * The text of a string item: `<t>` directly, or every run's `<t>` joined — but never a
 * `<rPh>` phonetic run, which is a reading aid for East Asian text and not the value.
 */
function textOf(item) {
  const withoutPhonetic = item.replace(new RegExp(`<${P}rPh\\b[\\s\\S]*?</${P}rPh>`, 'g'), '');
  return elements(withoutPhonetic, 't')
    .map((t) => (t.endsWith('/>') ? '' : decode(t.slice(t.indexOf('>') + 1, t.lastIndexOf('<')))))
    .join('');
}

/** "AB12" → 27 (zero-based column). */
function columnIndex(ref) {
  const letters = /^[A-Z]+/i.exec(ref || '');
  if (!letters) return null;
  let n = 0;
  for (const ch of letters[0].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * A number as the digits a person typed, not as JavaScript prints a double.
 *
 * `4.8000123456789E12` is a barcode, and `String(4800012345678.9)` or an exponent would
 * be a different barcode. Integers that a double holds exactly print in full; anything
 * else keeps the writer's own shortest form.
 */
function numberText(raw) {
  const trimmed = raw.trim();
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return trimmed;
  if (Number.isInteger(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER) return BigInt(n).toString();
  // A typed 4.55 is stored by some writers as 4.5499999999999998 — the double nearest
  // to it, printed to seventeen digits. Fifteen significant digits is what a person can
  // type into a cell, so rounding there gives back what they typed.
  return String(Number(n.toPrecision(15)));
}

function cellValue(cell, shared) {
  const tag = openTag(cell);
  const type = attr(tag, 't') || 'n';
  if (cell.endsWith('/>') && !cell.includes('</')) return { text: '', numeric: false };

  if (type === 'inlineStr') {
    const is = elements(cell, 'is')[0];
    return { text: is ? textOf(is) : '', numeric: false };
  }

  const v = elements(cell, 'v')[0];
  const raw = v && !v.endsWith('/>') ? decode(v.slice(v.indexOf('>') + 1, v.lastIndexOf('<'))) : '';

  if (type === 's') {
    const index = Number.parseInt(raw, 10);
    return { text: Number.isInteger(index) && shared[index] !== undefined ? shared[index] : '', numeric: false };
  }
  if (type === 'b') return { text: raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw, numeric: false };
  if (type === 'e') return { text: '', numeric: false, error: raw };
  if (type === 'str') return { text: raw, numeric: false };
  // `d` is an ISO 8601 date, written by some tools in strict mode.
  if (type === 'd') return { text: raw.slice(0, 10), numeric: false };
  return { text: raw === '' ? '' : numberText(raw), numeric: raw !== '' };
}

/**
 * Sheet rows as arrays of cells, indexed by the sheet's own row numbers.
 *
 * Returned as `{ number, cells: [{ text, numeric }] }` — the row number is the one the
 * store sees down the left edge of Excel, and it is carried through untouched, because
 * a problem reported against any other number is a problem nobody can find.
 */
function readRows(sheetXml, shared) {
  const rows = [];
  let nextRow = 1;
  for (const row of elements(sheetXml, 'row')) {
    const number = Number.parseInt(attr(openTag(row), 'r') || '', 10) || nextRow;
    nextRow = number + 1;
    const cells = [];
    let nextColumn = 0;
    const body = row.endsWith('/>') && !row.includes('</') ? '' : row;
    for (const cell of elements(body, 'c')) {
      const index = columnIndex(attr(openTag(cell), 'r'));
      const column = index === null ? nextColumn : index;
      nextColumn = column + 1;
      cells[column] = cellValue(cell, shared);
    }
    for (let i = 0; i < cells.length; i += 1) if (!cells[i]) cells[i] = { text: '', numeric: false };
    rows.push({ number, cells });
  }
  return rows;
}

/** A part's path, resolved against the part that referred to it (OPC's rule). */
function resolveTarget(target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = `xl/${target}`.split('/');
  const out = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part !== '.' && part !== '') out.push(part);
  }
  return out.join('/');
}

class NotAWorkbookError extends Error {}

/**
 * Every sheet in the workbook, in tab order, as `{ name, rows }`.
 *
 * Throws `NotAWorkbookError` with a sentence for anything that is not a readable .xlsx —
 * an .xls from Excel 2003, a CSV renamed, a truncated upload — because "unexpected token
 * at offset 0" is not something a pharmacy owner can act on.
 */
function readWorkbook(buffer) {
  let entries;
  try {
    entries = zip.unzipMany(buffer);
  } catch (err) {
    throw new NotAWorkbookError(
      'This file is not an Excel workbook (.xlsx). If it came from an older Excel, open it '
      + 'and use File → Save As → Excel Workbook (.xlsx).'
    );
  }
  const part = new Map(entries.map((e) => [e.name.replace(/^\//, ''), e.content.toString('utf8')]));

  const workbookXml = part.get('xl/workbook.xml');
  if (!workbookXml) throw new NotAWorkbookError('This file is a zip archive but not an Excel workbook.');

  const date1904 = /date1904\s*=\s*["'](1|true)["']/i.test(workbookXml);

  const rels = new Map(elements(part.get('xl/_rels/workbook.xml.rels') || '', 'Relationship')
    .map((r) => [attr(openTag(r), 'Id'), attr(openTag(r), 'Target')]));

  const shared = elements(part.get('xl/sharedStrings.xml') || '', 'si').map(textOf);

  const sheets = elements(workbookXml, 'sheet').map((s) => {
    const tag = openTag(s);
    const target = rels.get(attr(tag, 'id'));
    const xml = target ? part.get(resolveTarget(target)) : null;
    return { name: attr(tag, 'name') || '', rows: xml ? readRows(xml, shared) : [] };
  });

  return { sheets, date1904 };
}

/**
 * An Excel date serial as YYYY-MM-DD, in the 1900 system.
 *
 * Day 60 is Excel's famous 29 February 1900, which never happened; counting from
 * 30 December 1899 absorbs it for every date after March 1900, which is every expiry
 * date a pharmacy will ever type.
 */
function serialToIsoDate(serial) {
  const days = Math.floor(Number(serial));
  if (!Number.isFinite(days)) return null;
  return new Date(Date.UTC(1899, 11, 30) + days * 86400000).toISOString().slice(0, 10);
}

module.exports = { readWorkbook, serialToIsoDate, NotAWorkbookError, columnIndex, decode };
