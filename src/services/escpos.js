'use strict';

// INT-1 / INT-2 — the ESC/POS byte language, and the column arithmetic a thermal
// receipt is laid out in.
//
// Pure. It builds buffers and strings from arguments; it opens no socket, reads no
// setting and knows nothing about a sale. printService composes documents out of it and
// sends them, which is what lets every layout be asserted character by character in a
// test with no printer attached — and 58 mm and 80 mm paper is exactly the thing a
// developer cannot eyeball.
//
// The two widths are fixed by the hardware, not chosen: a 58 mm head prints 32
// characters of Font A and an 80 mm head prints 48. They are the only two values
// `receipt_width_columns` may take.

const WIDTHS = Object.freeze({ 32: '58 mm', 48: '80 mm' });
const DEFAULT_WIDTH = 32;

const ESC = 0x1b;
const GS = 0x1d;

/** The commands this product uses. Every one is in the ESC/POS common command set. */
const CMD = Object.freeze({
  INIT: Buffer.from([ESC, 0x40]),                    // ESC @  — reset
  ALIGN_LEFT: Buffer.from([ESC, 0x61, 0x00]),
  ALIGN_CENTER: Buffer.from([ESC, 0x61, 0x01]),
  ALIGN_RIGHT: Buffer.from([ESC, 0x61, 0x02]),
  BOLD_ON: Buffer.from([ESC, 0x45, 0x01]),
  BOLD_OFF: Buffer.from([ESC, 0x45, 0x00]),
  DOUBLE_HEIGHT: Buffer.from([GS, 0x21, 0x01]),
  NORMAL_SIZE: Buffer.from([GS, 0x21, 0x00]),
  FEED: Buffer.from([0x0a]),
  CUT: Buffer.from([GS, 0x56, 0x42, 0x00]),          // GS V B 0 — partial cut, feed
  // INT-2's drawer pulse, verbatim from the spec: ESC p 0 25 250.
  DRAWER_PULSE: Buffer.from([ESC, 0x70, 0x00, 0x19, 0xfa]),
});

function assertWidth(columns) {
  if (!Object.prototype.hasOwnProperty.call(WIDTHS, String(columns))) {
    throw new RangeError(
      `a receipt is ${Object.keys(WIDTHS).join(' or ')} columns (58 mm or 80 mm), got ${columns}`
    );
  }
  return Number(columns);
}

// ── Layout ──────────────────────────────────────────────────────────────────

/**
 * A thermal head prints a fixed number of characters per line and silently wraps
 * anything longer, mid-word, in the middle of a figure. So every line this product
 * prints is composed to width here rather than trusted to fit.
 */
function truncate(text, columns) {
  const value = String(text ?? '');
  return value.length <= columns ? value : value.slice(0, columns);
}

function centre(text, columns) {
  const value = truncate(text, columns);
  const pad = Math.max(0, Math.floor((columns - value.length) / 2));
  return ' '.repeat(pad) + value;
}

function rightAlign(text, columns) {
  const value = truncate(text, columns);
  return ' '.repeat(Math.max(0, columns - value.length)) + value;
}

/**
 * A label on the left and a figure on the right, which is most of a receipt.
 *
 * The figure wins when the line is too narrow: a truncated peso amount is a wrong
 * number on a document a customer keeps, and a truncated product name is only an
 * abbreviation.
 */
function leftRight(left, right, columns) {
  const value = String(right ?? '');
  const room = Math.max(0, columns - value.length - 1);
  const label = truncate(left, room);
  return `${label}${' '.repeat(Math.max(1, columns - label.length - value.length))}${value}`;
}

/** Wrap on word boundaries, breaking a word only when it is longer than the line. */
function wrap(text, columns) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const lines = [];
  let current = '';

  for (const word of words) {
    if (word.length > columns) {
      if (current) { lines.push(current); current = ''; }
      for (let i = 0; i < word.length; i += columns) lines.push(word.slice(i, i + columns));
      continue;
    }
    if (!current) current = word;
    else if (current.length + 1 + word.length <= columns) current += ` ${word}`;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines;
}

const divider = (columns, character = '-') => character.repeat(columns);

/**
 * A quantity-and-price line, which needs three columns on 32 and reads better as two
 * lines there: the name on its own, then the arithmetic indented under it.
 *
 * On 48 columns it fits on one. The difference is why the width is a parameter of every
 * renderer rather than a global.
 */
function itemLines({ name, qtyDisplay, unitPrice, lineTotal }, columns) {
  const arithmetic = `${qtyDisplay} x ${unitPrice}`;
  if (columns >= 48) {
    const room = columns - arithmetic.length - lineTotal.length - 2;
    return [`${truncate(name, room).padEnd(room)} ${arithmetic} ${lineTotal}`];
  }
  return [truncate(name, columns), leftRight(`  ${arithmetic}`, lineTotal, columns)];
}

// ── Encoding ────────────────────────────────────────────────────────────────

/**
 * Render composed text to an ESC/POS byte stream.
 *
 * The text is what the preview shows and what a test asserts; the bytes are what the
 * printer receives. They are produced from the same string, so a receipt that reads
 * right on screen cannot print differently — which is the failure a separate preview
 * renderer always eventually produces.
 *
 * Encoded as CP437, the default code page of every thermal printer this product will
 * meet. The peso sign is not in it, so it is transliterated rather than sent as a byte
 * the printer would render as something else entirely.
 */
function encode(text, { cut = true, feed = 4 } = {}) {
  const body = Buffer.from(transliterate(text), 'latin1');
  return Buffer.concat([
    CMD.INIT,
    CMD.ALIGN_LEFT,
    body,
    Buffer.alloc(feed, 0x0a),
    ...(cut ? [CMD.CUT] : []),
  ]);
}

/**
 * Characters a CP437 thermal head cannot print, mapped to what it can.
 *
 * "₱" is the important one: sent raw it becomes a box or a random glyph on the paper a
 * customer is holding. "PHP" is unambiguous and prints everywhere. The em dash and
 * curly quotes are here because they arrive from copy in the templates.
 */
const SUBSTITUTIONS = Object.freeze([
  [/₱/g, 'PHP '],
  [/[—–]/g, '-'],
  [/[’‘]/g, "'"],
  [/[“”]/g, '"'],
  [/·/g, '-'],
]);

function transliterate(text) {
  let value = String(text ?? '');
  for (const [pattern, replacement] of SUBSTITUTIONS) value = value.replace(pattern, replacement);
  // Anything still outside printable ASCII would be a guess; a question mark is a
  // visible "this did not print" rather than a silent wrong glyph.
  return value.replace(/[^\x20-\x7e\n\r]/g, '?');
}

/** The drawer pulse on its own, for a till movement with no document (POS-507). */
function drawerPulse() {
  return Buffer.concat([CMD.INIT, CMD.DRAWER_PULSE]);
}

module.exports = {
  WIDTHS, DEFAULT_WIDTH, CMD,
  assertWidth, truncate, centre, rightAlign, leftRight, wrap, divider, itemLines,
  encode, transliterate, drawerPulse,
};
