'use strict';

// TAX-001–TAX-003 — the three-mode engine, tested as the pure computation it is.
//
// TC-UT-17, TC-UT-18 and TC-UT-19 all live here. They need no database because the
// engine takes the mode as an input: the whole point of TAX-003 populating tax_class
// in every mode is that switching a store between them is a settings change, and an
// engine that had to be told by a store profile could not be tested for all three in
// one file.

const test = require('node:test');
const assert = require('node:assert/strict');
const taxService = require('../../services/taxService');

const line = (amountCentavos, taxClass = 'VATABLE') => ({ amountCentavos, taxClass });

// ── TC-UT-17 — NONE and NON_VAT ─────────────────────────────────────────────

test('TC-UT-17: NONE and NON_VAT compute zero tax and print no VAT block', () => {
  for (const taxMode of ['NONE', 'NON_VAT']) {
    const result = taxService.computeTax({
      taxMode,
      lines: [line(112000), line(50000, 'VAT_EXEMPT'), line(7844)],
    });

    assert.equal(result.computes_tax, false, taxMode);
    assert.equal(result.total_vat_centavos, 0, `${taxMode}: TAX-002 computes no tax`);

    // Every sale line records tax_amount_centavos = 0 — the rule's own wording.
    for (const l of result.lines) {
      assert.equal(l.vat_centavos, 0, taxMode);
      assert.equal(l.net_centavos, l.amount_centavos, `${taxMode}: the selling price is the final price`);
    }

    // "no tax is computed, split or printed": there is no block to print.
    assert.equal(result.summary, null, `${taxMode}: no VAT block`);
    assert.equal(result.total_centavos, 112000 + 50000 + 7844);
  }
});

test('TC-UT-17: the tax class is still carried in a non-VAT mode (TAX-003)', () => {
  // The column is populated in all three modes so that a mode change is configuration,
  // not a migration that has to invent a class per product.
  const result = taxService.computeTax({
    taxMode: 'NON_VAT',
    lines: [line(1000, 'VATABLE'), line(1000, 'VAT_EXEMPT'), line(1000, 'ZERO_RATED')],
  });
  assert.deepEqual(result.lines.map((l) => l.tax_class), ['VATABLE', 'VAT_EXEMPT', 'ZERO_RATED']);
});

// ── TC-UT-18 — VAT decomposition ────────────────────────────────────────────

test('TC-UT-18: VAT mode decomposes an inclusive ₱1,120 VATable line to ₱1,000 and ₱120', () => {
  const result = taxService.computeTax({ taxMode: 'VAT', lines: [line(112000)] });

  assert.equal(result.computes_tax, true);
  assert.equal(result.lines[0].net_centavos, 100000, 'net = round(P / 1.12)');
  assert.equal(result.lines[0].vat_centavos, 12000, 'vat = P − net');
  assert.equal(result.total_centavos, 112000);
});

test('TC-UT-18: net and VAT always sum back to the inclusive amount', () => {
  // vat = P − net rather than a second rounded division. Two independently rounded
  // halves do not always sum to the whole, and a receipt whose parts miss the total by
  // a centavo is a defect the customer can see.
  for (const amount of [1, 7, 99, 100, 6250, 7844, 112000, 123457, 999999, 100000001]) {
    const { net_centavos: net, vat_centavos: vat } = taxService.decomposeLine(amount, 'VATABLE');
    assert.equal(net + vat, amount, `${amount} decomposes without loss`);
    assert.ok(vat >= 0, `${amount}: VAT is never negative`);
  }
});

test('TC-UT-18: the decomposition rounds half-up, once', () => {
  // ₱78.44 inclusive: 7844 × 100 / 112 = 7003.57…, which rounds to 7004.
  const { net_centavos: net, vat_centavos: vat } = taxService.decomposeLine(7844, 'VATABLE');
  assert.equal(net, 7004);
  assert.equal(vat, 840);

  // A centavo either side of a .5 boundary, to prove the direction.
  assert.equal(taxService.decomposeLine(56, 'VATABLE').net_centavos, 50);
  assert.equal(taxService.decomposeLine(57, 'VATABLE').net_centavos, 51);
});

test('exempt and zero-rated lines yield no VAT, and keep their whole amount as net', () => {
  for (const taxClass of ['VAT_EXEMPT', 'ZERO_RATED']) {
    const { net_centavos: net, vat_centavos: vat } = taxService.decomposeLine(112000, taxClass);
    assert.equal(vat, 0, taxClass);
    assert.equal(net, 112000, taxClass);
  }
});

// ── TC-UT-19 — per line, never in aggregate ─────────────────────────────────

test('TC-UT-19: a mixed basket decomposes per line, not in aggregate', () => {
  // Feed is VATable, an exempt item is not. Decomposing the ₱1,620 basket total would
  // charge VAT on the exempt line — the failure this case exists to catch.
  const result = taxService.computeTax({
    taxMode: 'VAT',
    lines: [line(112000, 'VATABLE'), line(50000, 'VAT_EXEMPT')],
  });

  assert.equal(result.lines[0].vat_centavos, 12000, 'the VATable line carries all the VAT');
  assert.equal(result.lines[1].vat_centavos, 0, 'the exempt line carries none');
  assert.equal(result.total_vat_centavos, 12000);

  // In aggregate, ₱1,620 inclusive would decompose to ₱144.64 of VAT. Asserted as the
  // wrong answer so the test says what it is guarding against.
  const aggregate = taxService.decomposeLine(162000, 'VATABLE');
  assert.notEqual(result.total_vat_centavos, aggregate.vat_centavos);
  assert.equal(aggregate.vat_centavos, 17357, 'what decomposing the basket would have given');
});

test('TC-UT-19: per-line rounding differs from one rounding of the sum', () => {
  // Three lines that each round the same way individually and a different way together.
  const amounts = [7844, 7844, 7844];
  const perLine = taxService.computeTax({
    taxMode: 'VAT', lines: amounts.map((a) => line(a)),
  });

  const sumOfParts = perLine.lines.reduce((sum, l) => sum + l.net_centavos, 0);
  const oneRounding = taxService.decomposeLine(amounts.reduce((a, b) => a + b, 0), 'VATABLE').net_centavos;

  assert.equal(sumOfParts, 21012, 'three lines at 7004');
  assert.equal(oneRounding, 21011, 'and 23532 in one go is a centavo different');
  assert.notEqual(sumOfParts, oneRounding, 'TAX-003 requires the per-line answer');
});

// ── TAX-007's printed block ─────────────────────────────────────────────────

test('the VAT summary buckets by class and sums to the VAT charged (TAX-007)', () => {
  const result = taxService.computeTax({
    taxMode: 'VAT',
    lines: [
      line(112000, 'VATABLE'),
      line(56000, 'VATABLE'),
      line(50000, 'VAT_EXEMPT'),
      line(20000, 'ZERO_RATED'),
    ],
  });

  const summary = result.summary;
  assert.equal(summary.vat_rate, '12%');
  assert.equal(summary.vatable_sales_centavos, 100000 + 50000, 'net of VAT, as the block states');
  assert.equal(summary.vat_exempt_sales_centavos, 50000);
  assert.equal(summary.zero_rated_sales_centavos, 20000);
  assert.equal(summary.vat_amount_centavos, 12000 + 6000);
  assert.equal(summary.vat_amount_centavos, result.total_vat_centavos, 'the block and the total agree');

  // The whole basket still reconciles: every peso is in exactly one bucket.
  assert.equal(
    summary.vatable_sales_centavos + summary.vat_exempt_sales_centavos
      + summary.zero_rated_sales_centavos + summary.vat_amount_centavos,
    result.total_centavos
  );
});

// ── Guards ──────────────────────────────────────────────────────────────────

test('the mode and the class are checked, and the VAT rate is not a setting', () => {
  assert.deepEqual([...taxService.MODES], ['NONE', 'NON_VAT', 'VAT']);
  assert.deepEqual([...taxService.CLASSES], ['VATABLE', 'VAT_EXEMPT', 'ZERO_RATED']);

  assert.throws(() => taxService.computeTax({ taxMode: 'PERCENTAGE', lines: [] }), RangeError);
  assert.throws(() => taxService.decomposeLine(100, 'EXEMPT'), RangeError);

  // The rate is statute, not an operator preference. A store that could type a
  // different one would be filing wrong figures with a straight face.
  const settingsService = require('../../services/settingsService');
  assert.equal(Object.keys(settingsService.REGISTRY).some((k) => /vat|tax_rate/i.test(k)), false);
});

test('the engine is pure: no database, no session, no writes', () => {
  // Asserted by reading the source rather than by mocking, for TC-UT-99's reason: the
  // property is about what the file imports, and a mock would prove only that this
  // call did not happen to touch one.
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'services', 'taxService.js'), 'utf8');

  for (const forbidden of ['config/database', 'repositories/', 'db.transaction', 'req.session']) {
    assert.equal(source.includes(forbidden), false, `taxService must not reference ${forbidden}`);
  }
});
