'use strict';

// TC-UT-100 — the CSV reader, against the writer the reports already use (OPS-105).
//
// `TASK-026` reads spreadsheets a store made, and every case below is a file a store
// can actually produce: Excel's BOM, CRLF from Windows and LF from everything else, a
// comma inside a quoted name, an address with a newline in it, a stray blank row from
// a stray return.
//
// **The line numbers are the point of the file.** `OPS-105` promises a rejected row is
// reported with the row number the operator can scroll to, and against a 500-row
// catalogue a number that is off by one is worse than no number at all — it sends
// somebody to correct a row that was already right. So the counting is asserted
// directly, in both the directions it can go wrong: a blank line spends a row number
// without carrying data, and a quoted field with a newline in it does not spend one.
//
// The round trip is asserted too, because the writer and the reader disagreeing is how
// a store ends up with an export it cannot re-import.

const test = require('node:test');
const assert = require('node:assert/strict');
const csv = require('../../config/csv');

// ── Writing ─────────────────────────────────────────────────────────────────

test('TC-UT-100: every field is quoted, and an embedded quote is doubled', () => {
  assert.equal(csv.row(['A', 1, null]), '"A","1",""');
  assert.equal(csv.row(['say "hi"']), '"say ""hi"""');
  // CRLF, which is what RFC 4180 specifies and what Excel expects.
  assert.equal(csv.stringify([['a'], ['b']]), '"a"\r\n"b"\r\n');
});

// ── Reading ─────────────────────────────────────────────────────────────────

test('TC-UT-100: a quoted field may hold a comma, a quote and a newline', () => {
  const rows = csv.parse('"Reyes, Juan","said ""no""","Purok 4\nSan Isidro"\r\n');
  assert.deepEqual(rows, [['Reyes, Juan', 'said "no"', 'Purok 4\nSan Isidro']]);
});

test('TC-UT-100: CRLF and LF are both line endings, and a BOM is dropped', () => {
  assert.deepEqual(csv.parse('a,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(csv.parse('a,b\nc,d\n'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(csv.parse(`${csv.BOM}sku,name\r\n`), [['sku', 'name']]);
  // The last row need not be terminated — a file saved without a trailing newline is
  // still a file, and losing its final row would lose a product.
  assert.deepEqual(csv.parse('a,b\r\nc,d'), [['a', 'b'], ['c', 'd']]);
});

test('TC-UT-100: whitespace outside quotes is kept, not trimmed', () => {
  // Trimming is a decision about what a column means and belongs to whoever knows.
  // A parser that trimmed would make " 001" and "001" the same SKU.
  assert.deepEqual(csv.parse(' 001 ,x\r\n'), [[' 001 ', 'x']]);
});

test('TC-UT-100: an empty file parses to nothing rather than to one empty row', () => {
  assert.deepEqual(csv.parse(''), []);
  assert.deepEqual(csv.parse('\r\n'), []);
  assert.deepEqual(csv.parseWithHeader('').rows, []);
});

// ── The line numbers OPS-105 reports rejections with ────────────────────────

test('TC-UT-100: a blank row spends its line number, so later rows keep theirs', () => {
  // The operator's spreadsheet shows a blank row 3 and B on row 4. A parser that
  // dropped the blank before numbering would report B as row 3 and send somebody to
  // correct the wrong line of a 500-row file.
  const table = csv.parseWithHeader('sku,qty\r\nA,1\r\n\r\nB,2\r\n');
  assert.deepEqual(table.rows.map((r) => [r.line, r.values.sku]), [[2, 'A'], [4, 'B']]);
});

test('TC-UT-100: a newline inside a quoted field does not spend a line number', () => {
  // The other direction: this is one spreadsheet row however many lines the file
  // takes to write it, and the row after it is row 3.
  const table = csv.parseWithHeader('sku,address\r\n"A","Purok 4\nSan Isidro"\r\n"B","x"\r\n');
  assert.deepEqual(table.rows.map((r) => [r.line, r.values.sku]), [[2, 'A'], [3, 'B']]);
  assert.equal(table.rows[0].values.address, 'Purok 4\nSan Isidro');
});

test('TC-UT-100: the header line is reported too, so a bad header points somewhere', () => {
  assert.equal(csv.parseWithHeader('sku,qty\r\nA,1\r\n').headerLine, 1);
  // A file that opens with a blank row still has a findable header.
  const shifted = csv.parseWithHeader('\r\nsku,qty\r\nA,1\r\n');
  assert.equal(shifted.headerLine, 2);
  assert.deepEqual(shifted.rows.map((r) => r.line), [3]);
});

// ── Headers ─────────────────────────────────────────────────────────────────

test('TC-UT-100: a header is matched however the store capitalised or spaced it', () => {
  const table = csv.parseWithHeader('SKU,Unit Cost,unit_cost_2\r\nA,39.00,1\r\n');
  assert.deepEqual(table.headers, ['sku', 'unit_cost', 'unit_cost_2']);
  assert.equal(table.rows[0].values.unit_cost, '39.00');
});

test('TC-UT-100: a short row reads as empty cells, not as undefined', () => {
  // A spreadsheet that stopped writing commas at the last filled cell is common, and
  // the validator's "is this blank?" checks must see a string.
  const table = csv.parseWithHeader('sku,name,note\r\nA,Feed\r\n');
  assert.equal(table.rows[0].values.note, '');
});

// ── The round trip ──────────────────────────────────────────────────────────

test('TC-UT-100: anything the writer writes, the reader reads back unchanged', () => {
  const original = [
    ['sku', 'name', 'note'],
    ['HG-50', 'Hog Grower, 50kg', 'said "fine"'],
    ['VET-1', 'Amoxicillin', 'Purok 4\nSan Isidro'],
    ['  01', '', '₱1,250.50'],
  ];
  assert.deepEqual(csv.parse(csv.stringify(original)), original);
});
