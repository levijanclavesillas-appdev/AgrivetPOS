'use strict';

// TC-UT-12 and TC-UT-14, plus the guards that keep MON-001 true.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const money = require('../../services/money');

test('TC-UT-12: 1.255 KG at ₱62.50 bills ₱78.44, rounded half-up once', () => {
  const unitPrice = money.fromPesos('62.50');
  assert.equal(unitPrice, 6250, 'pesos in, centavos everywhere after (MON-001)');

  // 6250 × 1255 / 1000 = 7843.75 centavos exactly, which rounds up to 7844.
  const line = money.mulQty(unitPrice, 1255);
  assert.equal(line, 7844);
  assert.equal(money.toDisplay(line), '₱78.44');
});

test('TC-UT-12: 1,000 such lines sum with zero drift', () => {
  const unitPrice = money.fromPesos('62.50');
  let sum = 0;
  for (let i = 0; i < 1000; i += 1) sum = money.add(sum, money.mulQty(unitPrice, 1255));

  // MON-003 rounds once per line, so 1,000 lines are exactly 1,000 × one line.
  assert.equal(sum, 7844 * 1000);
  assert.equal(money.toDisplay(sum), '₱78,440.00');

  // For contrast, and for anyone tempted to "simplify" this module: carrying the
  // unrounded 78.4375 through and rounding at the end gives ₱78,437.50 — ₱2.50 short,
  // and short by a different figure for every basket. That is the drift MON-001 and
  // MON-003 exist to make impossible.
  assert.notEqual(sum, 7843750);
});

test('TC-UT-12: the line total is exact far beyond a float\'s reach', () => {
  // 2^53 is where a double stops counting in ones. Money must not degrade there.
  const big = money.mulQty(999999999, 999999999);
  assert.equal(big, 999999998000000, 'exact, via BigInt');
  assert.throws(() => money.mulQty(9999999999999, 9999999999999), /beyond exact integer range/);
});

test('MON-003: halves round away from zero, so a reversal cancels its sale exactly', () => {
  assert.equal(money.mulQty(6250, 1255), 7844);
  assert.equal(money.mulQty(6250, -1255), -7844, 'the reversal is the exact negation');
  assert.equal(money.mulQty(6250, 1255) + money.mulQty(6250, -1255), 0);

  assert.equal(money.roundHalfUp('2.5', 0), '3');
  assert.equal(money.roundHalfUp('-2.5', 0), '-3');
  assert.equal(money.roundHalfUp('2.4', 0), '2');
});

test('roundHalfUp returns an exact decimal string, never a float', () => {
  // 78.44 is not representable as a double. Returning a number here would hand back a
  // value that is already wrong and invite it into a money path (MON-001).
  assert.equal(typeof money.roundHalfUp('78.4375', 2), 'string');
  assert.equal(money.roundHalfUp('78.4375', 2), '78.44');
  assert.equal(money.roundHalfUp('0.005', 2), '0.01');
  assert.equal(money.roundHalfUp('1', 3), '1.000');
});

test('money input rejects a sub-centavo figure rather than rounding it', () => {
  assert.equal(money.fromPesos('62.5'), 6250);
  assert.equal(money.fromPesos(62.5), 6250);
  assert.equal(money.fromPesos('-3.07'), -307);
  assert.throws(() => money.fromPesos('62.505'), /at most 2/);
  assert.throws(() => money.fromPesos('1e5'), /not a decimal value/);
  assert.throws(() => money.fromPesos('abc'), /not a decimal value/);
  assert.throws(() => money.fromPesos(Infinity), /not a finite number/);
});

test('add and sub are exact integer centavo arithmetic', () => {
  assert.equal(money.add(), 0);
  assert.equal(money.add(7844, 3300, 155), 11299);
  assert.equal(money.sub(11299, 1000), 10299);
  assert.equal(money.sub(1000, 11299), -10299);

  // The float this replaces: 0.1 + 0.2 !== 0.3. In centavos it is 10 + 20 === 30,
  // and a credit balance built from it can reach exactly zero (03 §1 preamble).
  assert.equal(money.add(10, 20), 30);
  let balance = 0;
  for (let i = 0; i < 1000; i += 1) balance = money.add(balance, 7);
  for (let i = 0; i < 1000; i += 1) balance = money.sub(balance, 7);
  assert.equal(balance, 0, 'a thousand debits and credits return to exactly zero');
});

test('percent computes a share of an amount, rounded half-up, fractions allowed', () => {
  assert.equal(money.percent(10000, 10), 1000);
  assert.equal(money.percent(10000, 12.5), 1250);
  assert.equal(money.percent(7844, 5), 392);        // 392.20 -> 392
  assert.equal(money.percent(7844, 7.5), 588);      // 588.30 -> 588
  assert.equal(money.percent(1, 50), 1);            // 0.5 -> 1, half away from zero
  assert.equal(money.percent(-1, 50), -1);
  assert.equal(money.percent(10000, 0), 0);
  assert.equal(money.percent(10000, 100), 10000);
  assert.throws(() => money.percent(10000, 'ten'), /not a decimal value/);
});

test('TC-UT-14: a transaction discount apportions to the centavo, remainder on the largest line', () => {
  // 100 centavos over 333 + 333 + 334: each proportional share is 33.3, 33.3, 33.4.
  const shares = money.apportionDiscount([333, 333, 334], 100);

  assert.equal(money.add(...shares), 100, 'the parts sum to the whole exactly (MON-006)');
  assert.deepEqual(shares, [33, 33, 34], 'the remainder landed on the largest line');
});

test('TC-UT-14: a tie for the largest line resolves to the earliest, so a reprint matches', () => {
  const shares = money.apportionDiscount([100, 100, 100], 10);
  assert.equal(money.add(...shares), 10);
  assert.deepEqual(shares, [4, 3, 3]);
});

test('TC-UT-14: no discount over any basket ever loses or invents a centavo', () => {
  const baskets = [
    [333, 333, 334], [100, 100, 100], [1, 1, 1, 1, 1, 1, 1], [7844, 3300, 155],
    [1], [999999, 1], [50, 50, 50, 50, 50, 50, 50, 50, 50, 51],
  ];
  for (const lines of baskets) {
    const total = money.add(...lines);
    for (let discount = 0; discount <= Math.min(total, 400); discount += 1) {
      const shares = money.apportionDiscount(lines, discount);
      assert.equal(money.add(...shares), discount, `lines ${lines} discount ${discount}`);
      assert.equal(shares.length, lines.length);
    }
  }
});

test('TC-UT-14: a discount across lines totalling zero is refused, not divided by zero', () => {
  assert.deepEqual(money.apportionDiscount([0, 0], 0), [0, 0]);
  assert.throws(() => money.apportionDiscount([0, 0], 100), /totalling zero/);
  assert.throws(() => money.apportionDiscount([], 0), /at least one line/);
});

test('computeLineTotal follows MON-003\'s order and exposes every intermediate', () => {
  const line = money.computeLineTotal({ unitPrice: 6250, qtyMilli: 1255, lineDiscount: 44 });
  assert.deepEqual(line, { gross: 7844, discount: 44, net: 7800 });

  // PR-205: a discount may not drive a line negative, and this is the function that
  // would otherwise produce the negative figure.
  assert.throws(
    () => money.computeLineTotal({ unitPrice: 6250, qtyMilli: 1255, lineDiscount: 7845 }),
    /may not drive a line negative/
  );
});

test('MON-008: cash rounding is off by default and only rounds when a store asks', () => {
  assert.equal(money.applyCashRounding(7844), 7844, 'default 1 centavo = no rounding');
  assert.equal(money.applyCashRounding(7844, 1), 7844);
  assert.equal(money.applyCashRounding(7844, 5), 7845);
  assert.equal(money.applyCashRounding(7842, 5), 7840);
  assert.equal(money.applyCashRounding(7844, 25), 7850);
  assert.throws(() => money.applyCashRounding(7844, 0), /positive integer/);
});

test('a non-integer centavo value is refused wherever it is offered', () => {
  assert.throws(() => money.add(1.5, 2), /integer number of centavos/);
  assert.throws(() => money.sub(1.5, 2), /integer number of centavos/);
  assert.throws(() => money.toDisplay(78.44), /integer number of centavos/);
  assert.throws(() => money.mulQty(6250, 1.5), /integer thousandths/);
});

test('no floating-point arithmetic on a money path (MON-001, 05_TECH_SPEC.md §8.4)', () => {
  // The acceptance criterion of TASK-002, as a guard rather than a habit: a grep for
  // parseFloat, Number( or / 100 on a money path returns nothing outside the one
  // guarded BigInt -> Number conversion.
  const files = ['money.js', 'quantity.js', 'costing.js'];
  const offenders = [];
  let numberCalls = 0;

  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'services', file), 'utf8');
    source.split('\n').forEach((text, i) => {
      const at = `services/${file}:${i + 1}`;
      if (/\bparse(Float|Int)\s*\(/.test(text)) offenders.push(`${at} parseFloat/parseInt`);
      if (/\/\s*100\b(?!n)/.test(text)) offenders.push(`${at} division by 100`);
      if (/\bNumber\s*\(/.test(text)) numberCalls += 1;
    });
  }

  assert.deepEqual(offenders, [], offenders.join('\n'));
  assert.equal(
    numberCalls, 1,
    'the only permitted Number() call is the range-checked BigInt conversion in ' +
    'toSafeNumber; a new one needs justifying here before it is written'
  );
});
