'use strict';

// RFC 4180, both directions.
//
// The product has written CSV since TASK-016 — the report exports — with a `csvCell`
// that lives in `reportService`. TASK-026 needs to **read** it, and a reader written
// against a different understanding of the format from the writer is how a store ends
// up with an export it cannot re-import. So both halves are here, and the writer is
// the one the reports already use.
//
// ## What "RFC 4180" is actually taken to mean here
//
// The specification is short and the disagreements are all at the edges, so this file
// states the choices rather than leaving them to be inferred:
//
//   • **Quotes are doubled inside a quoted field**, and that is the only escape. A
//     backslash is a backslash.
//   • **A field may contain a newline** if it is quoted. A store's address does, and a
//     parser that split on `\n` before parsing quotes would cut it in half.
//   • **CRLF and LF are both line endings**, because the file was made in Excel on
//     Windows and edited in something else. A lone CR is not.
//   • **Leading and trailing whitespace outside quotes is kept**, not trimmed. Trimming
//     is a decision about data and belongs to whoever knows what the column means; a
//     parser that helpfully trimmed would make `" 001"` and `"001"` the same SKU.
//   • **A BOM is removed** if the file starts with one, because Excel writes one and
//     the first column would otherwise never match its own header.
//
// Writing always quotes every field. It is two bytes per field more than the minimum
// and removes the entire class of question about when a field needs quoting.

const BOM = '﻿';

/**
 * One field, quoted.
 *
 * Every field, unconditionally: a number that has never needed quoting still gets it,
 * because "when does this need quotes" is a question with a long tail — a leading zero,
 * a comma in a name, a value that Excel would read as a date — and answering it once
 * per field is cheaper than answering it correctly.
 */
function cell(value) {
  if (value === null || value === undefined) return '""';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

const row = (cells) => cells.map(cell).join(',');

/** A whole file, CRLF-terminated, which is what RFC 4180 specifies and Excel expects. */
const stringify = (rows) => `${rows.map(row).join('\r\n')}\r\n`;

/**
 * Parse a CSV file into records — `{ line, fields }`, fields being raw strings.
 *
 * A single pass over the characters rather than a split-then-fix, because the two
 * things that make CSV awkward — a comma inside a quoted field, a newline inside one —
 * are both invisible to any amount of splitting. State is: inside a quoted field or
 * not, and if inside, whether the last character was a quote.
 *
 * Returns raw strings. Every conversion — to a number, to a date, to a unit — belongs
 * to the caller, which is the only party that knows what the column means.
 */
function records(text) {
  const input = typeof text === 'string' ? text : String(text || '');
  const source = input.startsWith(BOM) ? input.slice(BOM.length) : input;

  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  let sawAny = false;
  // The spreadsheet's own row number, counted as records are closed rather than as
  // newlines go past. Those are not the same count, in both directions: a quoted
  // field may contain newlines and is still one row, and a blank line is a row the
  // operator can see even though it carries no data. Counting here — before the
  // blank ones are dropped — is what makes a reported line number the one the
  // operator can scroll to.
  let line = 0;

  const endField = () => { record.push(field); field = ''; sawAny = true; };
  const endRecord = () => {
    endField();
    line += 1;
    rows.push({ line, fields: record });
    record = [];
    sawAny = false;
  };

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];

    if (inQuotes) {
      if (char !== '"') { field += char; continue; }
      // A doubled quote is a literal one; a single quote closes the field.
      if (source[i + 1] === '"') { field += '"'; i += 1; continue; }
      inQuotes = false;
      continue;
    }

    if (char === '"' && field === '') { inQuotes = true; continue; }
    if (char === ',') { endField(); continue; }
    if (char === '\r' && source[i + 1] === '\n') { endRecord(); i += 1; continue; }
    if (char === '\n') { endRecord(); continue; }
    // A quote in the middle of an unquoted field is a literal character. Excel writes
    // this and refusing it would reject files the store can actually produce.
    field += char;
  }

  // The last record, where the file does not end in a newline.
  if (field !== '' || record.length > 0 || sawAny) endRecord();

  // A trailing newline produces one empty record, which is not a row of data. So does
  // a blank line in the middle, and dropping those is the one piece of tidying this
  // parser does — a spreadsheet saved with a stray return should not fail validation
  // on a row nobody typed. Their line numbers are already spent, which is the point:
  // the rows after them keep the numbers the operator sees.
  return rows.filter((r) => !(r.fields.length === 1 && r.fields[0] === ''));
}

/** The rows as plain arrays, for callers that do not care what line anything was on. */
const parse = (text) => records(text).map((r) => r.fields);

/**
 * Parse into objects keyed by the header row, with the file's line number kept.
 *
 * `OPS-105` asks for rejected rows to be reported **with line numbers**, and a line
 * number computed later from an array index is off by one the moment a blank line is
 * dropped. So it is carried from here, where the file is still the file: `line` is
 * what the operator's spreadsheet calls that row.
 *
 * Headers are matched case-insensitively with spaces and underscores treated alike, so
 * "Unit Cost", "unit_cost" and "unit cost" are one column. The store wrote the
 * spreadsheet; the product should not be fussy about how.
 */
function parseWithHeader(text) {
  const rows = records(text);
  if (rows.length === 0) return { headers: [], headerLine: 1, rows: [] };

  const headers = rows[0].fields.map((h) => normaliseHeader(h));
  const out = [];

  for (let i = 1; i < rows.length; i += 1) {
    const record = {};
    for (let c = 0; c < headers.length; c += 1) record[headers[c]] = rows[i].fields[c] ?? '';
    out.push({ line: rows[i].line, values: record, raw: rows[i].fields });
  }

  return { headers, headerLine: rows[0].line, rows: out };
}

const normaliseHeader = (header) => String(header || '')
  .trim()
  .toLowerCase()
  .replace(/\s+/g, '_')
  .replace(/[^a-z0-9_]/g, '');

module.exports = { cell, row, stringify, parse, records, parseWithHeader, normaliseHeader, BOM };
