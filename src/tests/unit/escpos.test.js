'use strict';

// The ESC/POS encoder and the column arithmetic, tested without a printer.
//
// 58 mm and 80 mm paper is exactly the thing a developer cannot eyeball, so every
// layout helper is asserted character by character here. A line one character too long
// does not error on a thermal head — it wraps mid-figure, and ₱1,234.56 becomes ₱1,234
// on one line and .56 on the next.

const test = require('node:test');
const assert = require('node:assert/strict');
const escpos = require('../../services/escpos');

test('the two widths are the two paper sizes, and nothing else', () => {
  // A 40-column thermal head does not exist.
  assert.deepEqual(Object.keys(escpos.WIDTHS), ['32', '48']);
  assert.equal(escpos.assertWidth(32), 32);
  assert.equal(escpos.assertWidth('48'), 48);
  assert.throws(() => escpos.assertWidth(40), RangeError);
  assert.throws(() => escpos.assertWidth(80), RangeError);
});

test('leftRight fills the line exactly, and the figure never loses a digit', () => {
  assert.equal(escpos.leftRight('Total', '1,234.56', 32), 'Total                   1,234.56');
  assert.equal(escpos.leftRight('Total', '1,234.56', 32).length, 32);

  // The label is truncated, never the amount: a shortened product name is an
  // abbreviation, a shortened peso figure is a wrong number on paper a customer keeps.
  const long = escpos.leftRight('An extremely long product name indeed', '1,234.56', 32);
  assert.equal(long.length, 32);
  assert.ok(long.endsWith('1,234.56'));
});

test('centre and rightAlign land where they say', () => {
  assert.equal(escpos.centre('TOTAL', 32), '             TOTAL');
  assert.equal(escpos.rightAlign('1.00', 32).length, 32);
  assert.equal(escpos.divider(32).length, 32);
  assert.equal(escpos.divider(48, '=').length, 48);
});

test('wrap breaks on words, and breaks a word only when it must', () => {
  assert.deepEqual(escpos.wrap('Poblacion, Sultan Kudarat', 32), ['Poblacion, Sultan Kudarat']);
  assert.deepEqual(
    escpos.wrap('Two hundred pesos missing after the afternoon rush', 20),
    ['Two hundred pesos', 'missing after the', 'afternoon rush']
  );
  assert.deepEqual(escpos.wrap('Supercalifragilistic', 10), ['Supercalif', 'ragilistic']);
  assert.ok(escpos.wrap('Two hundred pesos missing after the afternoon rush', 20)
    .every((line) => line.length <= 20));
});

test('an item line is two lines on 58 mm and one on 80 mm', () => {
  const item = { name: 'Hog Grower Pellets', qtyDisplay: '1.255 KG', unitPrice: '62.50', lineTotal: '78.44' };

  const narrow = escpos.itemLines(item, 32);
  assert.equal(narrow.length, 2, 'the name needs its own line on 58 mm');
  assert.equal(narrow[0], 'Hog Grower Pellets');
  assert.ok(narrow[1].endsWith('78.44'));
  assert.ok(narrow.every((line) => line.length <= 32));

  const wide = escpos.itemLines(item, 48);
  assert.equal(wide.length, 1, 'it fits on one line on 80 mm');
  assert.ok(wide[0].includes('Hog Grower Pellets'));
  assert.ok(wide[0].endsWith('78.44'));
  assert.ok(wide[0].length <= 48);
});

// ── Encoding ────────────────────────────────────────────────────────────────

test('the drawer pulse is INT-2 verbatim', () => {
  // 0x1B 0x70 0x00 0x19 0xFA — the spec gives the bytes, and a drawer that does not
  // open is a counter that cannot take cash.
  assert.deepEqual([...escpos.CMD.DRAWER_PULSE], [0x1b, 0x70, 0x00, 0x19, 0xfa]);
  const pulse = escpos.drawerPulse();
  assert.deepEqual([...pulse.subarray(-5)], [0x1b, 0x70, 0x00, 0x19, 0xfa]);
});

test('a document is initialised, fed and cut', () => {
  const bytes = escpos.encode('TOTAL 100.00');

  assert.deepEqual([...bytes.subarray(0, 2)], [0x1b, 0x40], 'ESC @ resets the printer first');
  assert.ok(bytes.includes(Buffer.from('TOTAL 100.00', 'latin1')));
  assert.deepEqual([...bytes.subarray(-4)], [0x1d, 0x56, 0x42, 0x00], 'GS V B 0 — partial cut');

  const uncut = escpos.encode('x', { cut: false, feed: 1 });
  assert.notDeepEqual([...uncut.subarray(-4)], [0x1d, 0x56, 0x42, 0x00]);
});

test('the peso sign is transliterated, not sent raw', () => {
  // CP437 has no ₱. Sent raw it prints as a box or a random glyph on paper the customer
  // is holding; "PHP" is unambiguous and prints on every thermal head.
  assert.equal(escpos.transliterate('₱1,234.56'), 'PHP 1,234.56');
  assert.equal(escpos.transliterate('a — b'), 'a - b');
  assert.equal(escpos.transliterate('it’s'), "it's");

  // Anything else outside printable ASCII becomes a visible question mark rather than
  // a silently wrong glyph.
  assert.equal(escpos.transliterate('café'), 'caf?');
  assert.equal(escpos.encode('₱100').includes(Buffer.from('PHP 100', 'latin1')), true);
});

test('newlines survive transliteration, so a composed document keeps its lines', () => {
  const text = 'Line one\nLine two\nLine three';
  assert.equal(escpos.transliterate(text), text);
  assert.equal(escpos.encode(text).toString('latin1').includes('Line one\nLine two'), true);
});
