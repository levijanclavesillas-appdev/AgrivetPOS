'use strict';

// TC-UT-11 and TC-UT-13 — pack conversion (UOM-002) and the rejected fourth decimal
// (MON-002).

const test = require('node:test');
const assert = require('node:assert/strict');
const quantity = require('../../services/quantity');

test('TC-UT-11: one sack of factor 50,000 leaves 450.000 KG of 500.000 KG', () => {
  const onHand = quantity.parse('500');            // 500.000 KG, held in the base unit
  const oneSack = quantity.toBaseUnits(quantity.parse('1'), 50000);

  assert.equal(oneSack, 50000, 'a sack is 50.000 KG of base stock (UOM-002)');
  assert.equal(onHand - oneSack, 450000);
  assert.equal(quantity.format(onHand - oneSack, 'KG'), '450 KG');
});

test('TC-UT-11: packs and kilos of one product settle in the same base figure', () => {
  // legacy/README.md contradiction 3: "10 sacks" and "500 KG" were both presented as
  // the inventory figure. There is one figure, and it is the base unit (UOM-001).
  const start = quantity.parse('500');
  const afterTwoSacks = start - quantity.toBaseUnits(quantity.parse('2'), 50000);
  const afterLooseKilos = afterTwoSacks - quantity.parse('1.255');

  assert.equal(afterTwoSacks, 400000);
  assert.equal(afterLooseKilos, 398745);
  assert.equal(quantity.format(afterLooseKilos, 'KG'), '398.745 KG');
});

test('TC-UT-11: a fractional pack converts exactly', () => {
  assert.equal(quantity.toBaseUnits(quantity.parse('0.5'), 50000), 25000, 'half a sack is 25 KG');
  assert.equal(quantity.toBaseUnits(quantity.parse('2.5'), 50000), 125000);
  assert.equal(quantity.fromBaseUnits(125000, 50000), 2500, '125 KG is 2.5 sacks');
});

test('TC-UT-11: the pack conversion round-trips, and its inexact direction is display only', () => {
  assert.equal(quantity.fromBaseUnits(quantity.toBaseUnits(3000, 50000), 50000), 3000);

  // 1.000 KG of a 3 KG pack is a third of a pack. The base figure stays authoritative;
  // the pack view rounds for display and is never posted (UOM-001).
  assert.equal(quantity.fromBaseUnits(1000, 3000), 333);
  assert.equal(quantity.isWholePacks(1000, 3000), false);
  assert.equal(quantity.isWholePacks(9000, 3000), true);
});

test('TC-UT-13: a fourth decimal place is rejected, never truncated', () => {
  assert.equal(quantity.parse('1.255'), 1255);
  assert.throws(() => quantity.parse('1.2555'), /at most 3/);
  assert.throws(() => quantity.parse('0.0001'), /at most 3/);

  // The failure mode this guards: silently posting 1.255 for an entered 1.2555 puts a
  // quantity nobody typed into the ledger every stock figure reconciles to (INV-101).
  let message = '';
  try { quantity.parse('1.2555'); } catch (err) { message = err.message; }
  assert.match(message, /rejected rather than rounded/);
});

test('MON-002: quantities parse and render as thousandths of the base unit', () => {
  assert.equal(quantity.parse('1.255'), 1255);
  assert.equal(quantity.parse(1.255), 1255);
  assert.equal(quantity.parse('0.5'), 500);
  assert.equal(quantity.parse('-2'), -2000);
  assert.equal(quantity.parse('500'), 500000);

  assert.equal(quantity.toDecimalString(1255), '1.255');
  assert.equal(quantity.toDecimalString(50000), '50');
  assert.equal(quantity.toDecimalString(1255, { decimals: 3 }), '1.255');
  assert.equal(quantity.toDecimalString(50000, { decimals: 3 }), '50.000');
  assert.equal(quantity.toDecimalString(-1255), '-1.255');
});

test('a quantity is never displayed without its unit (UOM-005)', () => {
  assert.equal(quantity.format(1255, 'KG'), '1.255 KG');
  assert.equal(quantity.format(2000, 'sack'), '2 sack');
  assert.throws(() => quantity.format(1255, ''), /never displayed without its unit/);
  assert.throws(() => quantity.format(1255), /never displayed without its unit/);
});

test('a non-integer or non-positive pack factor is refused', () => {
  assert.throws(() => quantity.toBaseUnits(1000, 0), /positive quantity/);
  assert.throws(() => quantity.toBaseUnits(1000, -50000), /positive quantity/);
  assert.throws(() => quantity.toBaseUnits(1.5, 50000), /integer thousandths/);
});
