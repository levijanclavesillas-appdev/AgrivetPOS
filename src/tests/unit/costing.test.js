'use strict';

// TC-UT-15 and TC-UT-16 — moving weighted average (MON-004) and the rule that it
// moves on the way in and never on the way out (INV-106).

const test = require('node:test');
const assert = require('node:assert/strict');
const costing = require('../../services/costing');
const money = require('../../services/money');
const quantity = require('../../services/quantity');

const KG = (n) => quantity.parse(String(n));
const P = (n) => money.fromPesos(String(n));

test('TC-UT-15: moving average after two receipts at different costs', () => {
  // 100 KG at ₱30.00, then 50 KG at ₱36.00.
  //   (100 × 3000 + 50 × 3600) / 150 = 480,000 / 150 = 3200 centavos.
  const avg = costing.computeMovingAverage(KG(100), P('30.00'), KG(50), P('36.00'));

  assert.equal(avg, 3200);
  assert.equal(money.toDisplay(avg), '₱32.00');
});

test('TC-UT-15: the first receipt into empty stock sets the average outright', () => {
  assert.equal(costing.computeMovingAverage(0, 0, KG(40), P('25.50')), 2550);
});

test('TC-UT-15: the average rounds half-up, once, to the centavo', () => {
  // (3 × 1000 + 1 × 1001) / 4 = 1000.25 -> 1000.
  assert.equal(costing.computeMovingAverage(KG(3), P('10.00'), KG(1), P('10.01')), 1000);
  // (1 × 1000 + 1 × 1001) / 2 = 1000.5 -> 1001, half away from zero.
  assert.equal(costing.computeMovingAverage(KG(1), P('10.00'), KG(1), P('10.01')), 1001);
});

test('TC-UT-15: a receipt of a fractional quantity is exact', () => {
  // Weighted in thousandths throughout, so the fractional kilo carries its exact share:
  //   (10,000 × 5000 + 1,255 × 6250) / 11,255 = 57,843,750 / 11,255 = 5139.38... -> 5139
  const avg = costing.computeMovingAverage(KG(10), P('50.00'), quantity.parse('1.255'), P('62.50'));
  assert.equal(avg, 5139);
});

test('TC-UT-15: a decrease is not a receipt, and asking for one is an error', () => {
  assert.throws(() => costing.computeMovingAverage(KG(100), P('30.00'), KG(-10), P('30.00')),
    /recomputed on a stock increase/);
  assert.throws(() => costing.computeMovingAverage(KG(100), P('30.00'), 0, P('30.00')),
    /recomputed on a stock increase/);
});

test('TC-UT-16: sale, damage and negative adjustment leave the average cost unchanged', () => {
  let state = { qtyOnHandMilli: KG(150), avgCostCentavos: P('32.00') };

  const decreases = [
    { type: 'SALE', qtyMilli: -KG(20) },
    { type: 'DAMAGE', qtyMilli: -KG(5) },
    { type: 'ADJUSTMENT', qtyMilli: -KG(1) },
    { type: 'EXPIRY', qtyMilli: -KG(2) },
    { type: 'INTERNAL_USE', qtyMilli: -KG(1) },
  ];

  for (const movement of decreases) {
    state = costing.applyMovement(state, movement);
    assert.equal(state.avgCostCentavos, 3200, `${movement.type} moved the average`);
    assert.equal(state.averageChanged, false, `${movement.type} reported a change`);
  }

  assert.equal(state.qtyOnHandMilli, KG(121), 'the quantity moved even though the cost did not');

  // A store must not be able to restate its historical margin by writing stock off.
  assert.equal(costing.valuation(state.qtyOnHandMilli, state.avgCostCentavos), P('3872.00'));
});

test('TC-UT-16: a decrease carrying a cost still does not move the average', () => {
  // The guard against the plausible-looking bug: a negative adjustment entered with a
  // unit cost must be consumed at the prevailing average, not averaged in (INV-106).
  const state = costing.applyMovement(
    { qtyOnHandMilli: KG(100), avgCostCentavos: P('30.00') },
    { type: 'ADJUSTMENT', qtyMilli: -KG(10), unitCostCentavos: P('99.00') }
  );
  assert.equal(state.avgCostCentavos, 3000);
  assert.equal(state.averageChanged, false);
});

test('INV-106: RECEIPT, OPENING and a positive costed ADJUSTMENT do move it', () => {
  const start = { qtyOnHandMilli: KG(100), avgCostCentavos: P('30.00') };

  for (const type of ['RECEIPT', 'OPENING', 'ADJUSTMENT']) {
    const after = costing.applyMovement(start, {
      type, qtyMilli: KG(50), unitCostCentavos: P('36.00'),
    });
    assert.equal(after.avgCostCentavos, 3200, `${type} should recompute the average`);
    assert.equal(after.averageChanged, true);
    assert.equal(after.qtyOnHandMilli, KG(150));
  }
});

test('INV-106: an increase with no cost supplied leaves the average alone', () => {
  // "recomputed on RECEIPT, OPENING and positive ADJUSTMENT **where a cost is
  // supplied**". A customer return or a void carries no new cost.
  for (const type of ['RECEIPT', 'ADJUSTMENT', 'CUSTOMER_RETURN', 'SALE_VOID']) {
    const after = costing.applyMovement(
      { qtyOnHandMilli: KG(100), avgCostCentavos: P('30.00') },
      { type, qtyMilli: KG(10) }
    );
    assert.equal(after.avgCostCentavos, 3000, `${type} without a cost moved the average`);
    assert.equal(after.averageChanged, false);
  }
});

test('an unknown movement type is refused (INV-103)', () => {
  assert.throws(
    () => costing.applyMovement({ qtyOnHandMilli: 0, avgCostCentavos: 0 }, { type: 'SHRINKAGE', qtyMilli: -1 }),
    /unknown movement type/
  );
  assert.equal(costing.ALL_TYPES.length, 12, 'INV-103 defines twelve movement types');
});

test('RPT-103: valuation is quantity × average cost in the base unit', () => {
  assert.equal(costing.valuation(KG(150), P('32.00')), P('4800.00'));
  assert.equal(costing.valuation(quantity.parse('1.255'), P('62.50')), 7844);
  assert.equal(costing.valuation(0, P('32.00')), 0);
});
