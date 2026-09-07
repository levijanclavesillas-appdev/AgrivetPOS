'use strict';

// The catalog's pure validation: SKU, name, tax class and — the one that matters —
// VR-205's weight-embedded barcode.

const test = require('node:test');
const assert = require('node:assert/strict');
const productService = require('../../services/productService');

// ── VR-205: the weight-embedded barcode ─────────────────────────────────────

test('a weight-embedded barcode is rejected with a message, not misread', () => {
  // GS1 reserves prefixes 02 and 20–29 for restricted distribution and variable
  // measure items — the label a deli or feed scale prints, where digits that look like
  // part of the item number are a weight. Read as a plain code, every weighing of the
  // same product scans as a different product and the catalog fills with one-off items
  // nobody created. VR-205 requires the refusal to say so.
  for (const code of ['0212345678903', '2012345678909', '2512345678901', '2912345678907']) {
    const result = productService.classifyBarcode(code);
    assert.equal(result.ok, false, code);
    assert.equal(result.variableMeasure, true, code);
    assert.equal(result.ruleId, 'VR-205');
    assert.match(result.reason, /weight/i, 'the message says what kind of code it is');
    assert.match(result.reason, /search for it by name|product's own barcode/i, 'and what to do instead');

    assert.throws(() => productService.validateBarcode(code), (err) => err.status === 400 && err.ruleId === 'VR-205');
  }
});

test('an ordinary barcode is accepted, including 13 digits that are not variable measure', () => {
  for (const code of ['4800016641206', '8901234567894', 'SKU-001', '01234567']) {
    const result = productService.classifyBarcode(code);
    assert.equal(result.ok, true, code);
    assert.equal(result.barcode, code);
  }

  // A 12-digit code starting 02 is a UPC-A, not the 13-digit EAN the prefix rule is
  // about — refusing it would reject real products.
  assert.equal(productService.classifyBarcode('021234567890').ok, true);
});

test('a barcode is trimmed of whitespace and bounded in length and alphabet', () => {
  assert.equal(productService.validateBarcode('  4800016641206 '), '4800016641206');
  assert.equal(productService.validateBarcode('48000 16641206'), '4800016641206', 'a scanner may split');

  assert.throws(() => productService.validateBarcode('12'), (e) => e.ruleId === 'VR-205');
  assert.throws(() => productService.validateBarcode('has spaces and $ymbols!'), (e) => e.ruleId === 'VR-205');
  assert.throws(() => productService.validateBarcode(null), (e) => e.ruleId === 'VR-205');
});

// ── VR-201, VR-202, VR-208 ──────────────────────────────────────────────────

test('a SKU is required, trimmed and upper-cased (VR-201)', () => {
  assert.equal(productService.validateSku('  feed-b-meg-50 '), 'FEED-B-MEG-50');
  assert.equal(productService.validateSku('A1'), 'A1');

  assert.throws(() => productService.validateSku(''), (e) => e.ruleId === 'VR-201');
  assert.throws(() => productService.validateSku('   '), (e) => e.ruleId === 'VR-201');
  assert.throws(() => productService.validateSku('-leading-dash'), (e) => e.ruleId === 'VR-201');
  assert.throws(() => productService.validateSku('has space'), (e) => e.ruleId === 'VR-201');
});

test('a product name is 2 to 120 characters (VR-202)', () => {
  assert.equal(productService.validateName('  Hog Grower  '), 'Hog Grower');
  assert.throws(() => productService.validateName('X'), (e) => e.ruleId === 'VR-202');
  assert.throws(() => productService.validateName(''), (e) => e.ruleId === 'VR-202');
  // 121 characters is trimmed to 120 by the field cap, so the refusal is on the short
  // end only — a long name is a typo the operator can see, not a rule violation.
  assert.equal(productService.validateName('x'.repeat(200)).length, 120);
});

test('tax_class is required in every tax mode and defaults to VATABLE (VR-208, TAX-003)', () => {
  // The column is populated in NONE and NON_VAT too, so switching tax mode is
  // configuration rather than a migration that has to invent a class per product.
  assert.equal(productService.validateTaxClass(undefined), 'VATABLE');
  assert.equal(productService.validateTaxClass('vat_exempt'), 'VAT_EXEMPT');
  assert.deepEqual([...productService.TAX_CLASSES], ['VATABLE', 'VAT_EXEMPT', 'ZERO_RATED']);
  assert.throws(() => productService.validateTaxClass('EXEMPT'), (e) => e.ruleId === 'VR-208');
});

test('the price levels are PR-101 levels 3 and 4, no more', () => {
  // Levels 1 and 2 — a customer-specific price and a quantity break — are v1.1 and
  // belong to TASK-009. Registering them here would imply a resolution this build
  // does not perform.
  assert.deepEqual([...productService.PRICE_LEVELS], ['RETAIL', 'WHOLESALE', 'DEALER']);
});
