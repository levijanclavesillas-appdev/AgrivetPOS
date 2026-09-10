'use strict';

// TASK-029's three unit cases — `TC-UT-52` to `TC-UT-54`. Expiry status, FEFO
// ordering, and the cost a split line snapshots.
//
// Each covers a rule that is easy to implement one step out and impossible to see
// afterwards:
//
//   `TC-UT-52` — `INV-203`'s **boundaries are inclusive at both ends**. A batch marked
//   "use by 30 June" is good on the 30th, and a batch exactly `near_expiry_days` out is
//   already near. Written with `<` at either end the code still looks right, still
//   passes on every date in the middle, and gives the store one day less warning than
//   the number it configured — or refuses a sale of stock that has not expired.
//
//   `TC-UT-53` — `INV-204` orders by **expiry date, not by receipt date**. The two
//   agree in every fixture where stock arrives in the order it expires, which is most
//   of them, so the batches here are deliberately received in the wrong order.
//
//   `TC-UT-54` — `MON-004`'s split line is a **quantity-weighted** average. Six at ₱300
//   and four at ₱320 is ₱308, not ₱310, and the unweighted version is right whenever
//   the two quantities happen to be equal.
//
// A temp database is opened because two of the three read `near_expiry_days` from the
// settings registry or batches from the ledger — the same reason `discounts.test.js`
// opens one. What is under test is still the arithmetic, not a document.

const test = require('node:test');
const assert = require('node:assert/strict');
const batchService = require('../../services/batchService');
const settingsService = require('../../services/settingsService');
const productService = require('../../services/productService');
const authService = require('../../services/authService');
const temp = require('../helpers/tempdb');

let ref;
let owner;
let supplier;

test.before(() => {
  temp.openMigrated('batches-unit');
  temp.seedStore({ withOwner: false });
  ref = temp.seedCatalog();
  temp.seedUser({ username: 'owner', role: 'OWNER', password: 'correct-horse-battery' });
  owner = authService.verifyToken(
    authService.login({ username: 'owner', password: 'correct-horse-battery' }).token
  );
  supplier = temp.seedSupplier({}, owner);
});

test.after(() => temp.cleanup());

let seq = 0;
function tracked({ qty = 0 } = {}) {
  seq += 1;
  const product = productService.create({
    sku: `BU-${String(seq).padStart(3, '0')}`,
    name: `Batch Unit Line ${seq}`,
    categoryId: ref.category.id,
    baseUnitId: ref.kg.id,
    retailPriceCentavos: 32000,
    isBatchTracked: true,
  }, owner);
  return { product, qty };
}

// ── TC-UT-52 — INV-203 ──────────────────────────────────────────────────────

test('TC-UT-52: the three expiry statuses, at the boundary, on Manila days', () => {
  const asOfDate = '2026-06-30';
  const status = (date, nearDays = 90) => batchService.statusOf(date, { asOfDate, nearDays });

  // A box marked "use by 30 June" is good on the 30th. Yesterday's is not.
  assert.equal(status('2026-06-30'), 'NEAR_EXPIRY', 'expiring today is not yet expired');
  assert.equal(status('2026-06-29'), 'EXPIRED');

  // Exactly the threshold is already near: a rule that excluded its own boundary would
  // give the store 89 days of warning against the 90 it configured.
  assert.equal(status('2026-09-28'), 'NEAR_EXPIRY', '90 days out, exactly');
  assert.equal(status('2026-09-29'), 'NORMAL', 'one day past the threshold');

  // And the threshold is the store's number, not the code's.
  assert.equal(status('2026-08-01', 30), 'NORMAL');
  assert.equal(status('2026-07-20', 30), 'NEAR_EXPIRY');
});

test('TC-UT-52: with no threshold given, the status reads the store’s setting', () => {
  settingsService.set('near_expiry_days', 30, owner);
  const asOfDate = '2026-06-30';

  assert.equal(batchService.statusOf('2026-07-20', { asOfDate }), 'NEAR_EXPIRY');
  assert.equal(batchService.statusOf('2026-08-20', { asOfDate }), 'NORMAL');

  settingsService.set('near_expiry_days', 90, owner);
  assert.equal(batchService.statusOf('2026-08-20', { asOfDate }), 'NEAR_EXPIRY',
    'the same date, against a threshold the owner widened');
});

test('TC-UT-52: expiry status is arithmetic — nothing stores it and no job computes it', () => {
  // The same batch row read on two days gives two answers, with nothing having run in
  // between. This is CR-107's reasoning applied to expiry: a stored status is a column
  // a missed job leaves stale, and the ageing bucket that went wrong that way is why.
  const row = { expiry_date: '2026-07-15', qty_milli: 1000, base_unit_code: 'KG' };

  assert.equal(batchService.present(row, { asOfDate: '2026-01-01', nearDays: 90 }).expiry_status, 'NORMAL');
  assert.equal(batchService.present(row, { asOfDate: '2026-06-01', nearDays: 90 }).expiry_status, 'NEAR_EXPIRY');
  assert.equal(batchService.present(row, { asOfDate: '2026-07-16', nearDays: 90 }).expiry_status, 'EXPIRED');
  assert.equal(batchService.present(row, { asOfDate: '2026-06-01', nearDays: 90 }).days_to_expiry, 44);
});

// ── TC-UT-53 — INV-204 ──────────────────────────────────────────────────────

test('TC-UT-53: FEFO takes the earliest expiry first, whatever order it arrived in', () => {
  const { product } = tracked();
  // Received newest-expiring first, deliberately: receipt order and expiry order agree
  // in most fixtures, and an allocator sorting by the wrong one passes all of them.
  temp.seedBatch({
    product, supplier, qtyMilli: 6000, unitCostCentavos: 30000,
    batchNo: 'LATE', expiryDate: '2027-12-31', actor: owner,
  });
  temp.seedBatch({
    product, supplier, qtyMilli: 6000, unitCostCentavos: 32000,
    batchNo: 'EARLY', expiryDate: '2027-01-31', actor: owner,
  });

  const [first] = batchService.allocate(product.id, 1000, { asOfDate: '2026-06-30' });
  assert.equal(first.batchNo, 'EARLY');
  assert.equal(first.qtyMilli, 1000);
});

test('TC-UT-53: a line larger than the oldest batch spans into the next one', () => {
  const { product } = tracked();
  temp.seedBatch({
    product, supplier, qtyMilli: 6000, unitCostCentavos: 30000,
    batchNo: 'SIX', expiryDate: '2027-01-31', actor: owner,
  });
  temp.seedBatch({
    product, supplier, qtyMilli: 20000, unitCostCentavos: 32000,
    batchNo: 'REST', expiryDate: '2027-06-30', actor: owner,
  });

  // Ten where the oldest holds six: six and four, in that order. This is the ordinary
  // case rather than the corner, which is why INV-206 needed a table per line.
  const draw = batchService.allocate(product.id, 10000, { asOfDate: '2026-06-30' });
  assert.deepEqual(draw.map((a) => [a.batchNo, a.qtyMilli]), [['SIX', 6000], ['REST', 4000]]);
  assert.equal(draw.reduce((sum, a) => sum + a.qtyMilli, 0), 10000, 'and it sums to the line');
});

test('TC-UT-53 / INV-205: an expired batch is not allocated, and the refusal says why', () => {
  const { product } = tracked();
  temp.seedBatch({
    product, supplier, qtyMilli: 50000, unitCostCentavos: 30000,
    batchNo: 'GONE', expiryDate: '2026-01-31', actor: owner,
  });

  // Fifty on the shelf and none of it sellable. The refusal has to say that rather than
  // "insufficient stock", which sends a clerk looking for goods that are in front of
  // them — the two are different problems with different answers.
  assert.throws(
    () => batchService.allocate(product.id, 1000, { asOfDate: '2026-06-30' }),
    (err) => {
      assert.equal(err.ruleId, 'INV-205');
      assert.match(err.message, /expired/);
      assert.match(err.message, /GONE on 2026-01-31/);
      return true;
    }
  );
});

test('TC-UT-53: short stock is short stock, and says so without mentioning expiry', () => {
  const { product } = tracked();
  temp.seedBatch({
    product, supplier, qtyMilli: 2000, unitCostCentavos: 30000,
    batchNo: 'THIN', expiryDate: '2027-06-30', actor: owner,
  });

  assert.throws(
    () => batchService.allocate(product.id, 5000, { asOfDate: '2026-06-30' }),
    (err) => {
      assert.equal(err.ruleId, 'INV-204');
      assert.equal(/expired/.test(err.message), false);
      return true;
    }
  );
});

// ── TC-UT-54 — MON-004 ──────────────────────────────────────────────────────

test('TC-UT-54: a split line costs at the quantity-weighted average of its batches', () => {
  // Six at ₱300 and four at ₱320 is ₱308. The unweighted average is ₱310, and it is
  // right whenever the two quantities are equal — which is why this case is not.
  const blended = batchService.blendedCostCentavos([
    { qtyMilli: 6000, unitCostCentavos: 30000 },
    { qtyMilli: 4000, unitCostCentavos: 32000 },
  ]);
  assert.equal(blended, 30800);

  // One batch is its own cost, exactly, with no rounding drift introduced on the way.
  assert.equal(batchService.blendedCostCentavos([{ qtyMilli: 7000, unitCostCentavos: 21349 }]), 21349);
  assert.equal(batchService.blendedCostCentavos([]), 0);
});

test('TC-UT-54: the blend rounds half-up once, not per batch', () => {
  // 1 at ₱1.00 and 2 at ₱1.01 is 100.666… centavos, which is ₱1.01 rounded once. Two
  // roundings — per batch, then again on the total — is how a cent goes missing from
  // every split line and turns up in the gross-profit report as drift.
  assert.equal(batchService.blendedCostCentavos([
    { qtyMilli: 1000, unitCostCentavos: 100 },
    { qtyMilli: 2000, unitCostCentavos: 101 },
  ]), 101);
});
