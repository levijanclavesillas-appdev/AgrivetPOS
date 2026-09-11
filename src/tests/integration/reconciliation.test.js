'use strict';

// FT-606 — payment reconciliation (TASK-032). `TC-INT-117` to `TC-INT-119`.
//
// **`TC-INT-117` is the case `RPT-105` exists for, and it asserts an absence.** The
// temptation the rule forbids is obvious: the statement says ₱14,270, the POS says
// ₱14,320, and a "correct to actual" button would make the discrepancy go away — along
// with the only record of a ₱50 sale a cashier recorded and nobody ever paid. So the
// case takes a byte-level snapshot of every sale and every tender, reconciles, and
// asserts that not one of them moved. A test that only checked the variance would pass
// against an implementation that quietly fixed the books.
//
// `TC-INT-118` is `POS-510`'s shape one level up: a reason beyond the tolerance and
// none demanded within it. `TC-INT-119` is the agreement that makes the whole feature
// trustworthy — the recorded figure is `RPT-102`'s own, not a second query that will
// eventually disagree with it.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const inventoryService = require('../../services/inventoryService');
const saleService = require('../../services/saleService');
const shiftService = require('../../services/shiftService');
const reportService = require('../../services/reportService');
const reconciliationService = require('../../services/reconciliationService');
const settingsService = require('../../services/settingsService');
const auditService = require('../../services/auditService');
const clock = require('../../config/clock');
const db = require('../../config/database');
const temp = require('../helpers/tempdb');

let BASE = null;
const PASSWORD = 'correct-horse-battery';

let instance;
let ref;
const tokens = {};
const sessions = {};
let today;

const call = (path, { token = null, method = 'GET', body = null } = {}) => fetch(`${BASE}${path}`, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

let seq = 0;

function stocked({ retail = 5000 } = {}) {
  seq += 1;
  const product = productService.create({
    sku: `REC-${String(seq).padStart(3, '0')}`,
    name: `Reconciled Feed ${seq}`,
    categoryId: ref.category.id,
    baseUnitId: ref.kg.id,
    retailPriceCentavos: retail,
  }, sessions.OWNER);
  inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli: 1000000,
    unitCostCentavos: 3000, actor: sessions.OWNER,
  });
  return product;
}

/** A sale paid by one method, at a known amount. */
function sale(product, { method = 'GCASH', qtyMilli = 1000, reference = 'GC-0001' } = {}) {
  const amount = Math.round((product.retail_price_centavos || 5000) * (qtyMilli / 1000));
  return saleService.complete({
    lines: [{ productId: product.id, qtyMilli }],
    tenders: [{
      method,
      amountCentavos: amount,
      ...(method === 'CASH' ? {} : { referenceNo: reference }),
    }],
  }, sessions.CASHIER);
}

/** Every sale and tender row, as bytes, for the assertion that nothing moved. */
const ledgerSnapshot = () => JSON.stringify({
  sales: db.get().prepare('SELECT * FROM sales ORDER BY id').all(),
  tenders: db.get().prepare('SELECT * FROM sale_tenders ORDER BY id').all(),
});

test.before(async () => {
  temp.openEmpty('reconciliation');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;
  temp.seedStore({ withOwner: false, taxMode: 'NONE' });
  ref = temp.seedCatalog();

  for (const role of ['OWNER', 'MANAGER', 'CASHIER', 'INVENTORY']) {
    const username = role.toLowerCase();
    temp.seedUser({ username, role, password: PASSWORD });
    const signedIn = authService.login({ username, password: PASSWORD });
    tokens[role] = signedIn.token;
    sessions[role] = authService.verifyToken(signedIn.token);
  }

  shiftService.open({ actor: sessions.CASHIER, openingFloatCentavos: 200000, confirmed: true });
  today = clock.manilaDate(clock.nowUtc());

  // A day's trade across the methods the store actually takes.
  const feed = stocked({ retail: 5000 });
  sale(feed, { method: 'GCASH', qtyMilli: 2000, reference: 'GC-1001' });   // ₱100
  sale(feed, { method: 'GCASH', qtyMilli: 3000, reference: 'GC-1002' });   // ₱150
  sale(feed, { method: 'QRPH', qtyMilli: 1000, reference: 'QR-2001' });    // ₱50
  sale(feed, { method: 'CASH', qtyMilli: 4000 });                          // ₱200
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── TC-INT-119 — the recorded figure is RPT-102's own ───────────────────────

test('TC-INT-119: the recorded totals agree with the payments report for the same range', () => {
  const payments = reportService.payments({ from: today }, sessions.OWNER);
  const recorded = reconciliationService.recorded({ from: today, actor: sessions.OWNER });

  for (const method of ['GCASH', 'QRPH']) {
    const fromReport = payments.methods.find((row) => row.method === method);
    const fromRecon = recorded.methods.find((row) => row.method === method);
    assert.equal(fromRecon.recorded_centavos, fromReport.amount_centavos, `${method} disagrees`);
    assert.equal(fromRecon.tender_count, fromReport.tender_count);
  }
  assert.equal(recorded.methods.find((row) => row.method === 'GCASH').recorded_centavos, 25000);

  // Every reconcilable method is listed, including one with nothing in the range: a
  // method that vanished because the week was quiet is a method somebody forgets.
  assert.deepEqual(recorded.methods.map((row) => row.method), ['GCASH', 'QRPH', 'OTHER']);
  assert.equal(recorded.methods.find((row) => row.method === 'OTHER').recorded_centavos, 0);

  // POS-206, on the figure it qualifies: this is what the cashier saw, and the store
  // has no confirmation of it from anybody.
  assert.ok(recorded.methods.every((row) => row.recorded_label === 'RECORDED'));

  // Requirement 2: the absences are explained rather than left as gaps.
  const excluded = Object.fromEntries(recorded.excluded.map((row) => [row.method, row.why]));
  assert.match(excluded.CASH, /shift close/);
  assert.match(excluded.CREDIT, /Settles nowhere/);
  assert.match(excluded.STORE_CREDIT, /already holds/);
  // And cash is shown from where it *is* reconciled, rather than asked for twice.
  assert.equal(recorded.cash.recorded_centavos, 20000);
});

test('TC-INT-119: the drill-down rows add up to the figure they drill into', () => {
  const recorded = reconciliationService.recorded({ from: today, actor: sessions.OWNER });
  const gcash = recorded.methods.find((row) => row.method === 'GCASH');

  const drill = reconciliationService.drill({ from: today, method: 'GCASH', actor: sessions.OWNER });

  // Requirement 8: "we are ₱50 short" is answered by reading down a list until the ₱50
  // turns up. A list that did not sum to the total would answer nothing.
  assert.equal(drill.total_centavos, gcash.recorded_centavos);
  assert.equal(drill.tenders.length, 2);
  assert.deepEqual(drill.tenders.map((row) => row.reference_no), ['GC-1001', 'GC-1002']);
  // The reference is the field somebody matches against a statement line, and its
  // absence is the first thing to look at when a total is short.
  assert.ok(drill.tenders.every((row) => row.sale_no && row.occurred_at_manila));
});

// ── TC-INT-117 — RPT-105's prohibition ──────────────────────────────────────

test('TC-INT-117: a reconciliation computes a variance and moves nothing', () => {
  const before = ledgerSnapshot();

  const result = reconciliationService.record({
    from: today, method: 'GCASH', actualCentavos: 24500,
    reference: 'GCASH-STMT-0910',
    reason: 'One ₱5.00 transfer fee, and a ₱500 sale the customer never sent',
  }, sessions.OWNER);

  // actual − recorded, and the words a shopkeeper uses about a till.
  assert.equal(result.recorded_centavos, 25000);
  assert.equal(result.actual_centavos, 24500);
  assert.equal(result.variance_centavos, -500);
  assert.match(result.variance_label, /₱5\.00 short/);

  // **The assertion the rule is about.** Not one byte of any sale or tender moved: the
  // recorded figure is what the sales say, and the sales are not edited (POS-107).
  assert.equal(ledgerSnapshot(), before, 'RPT-105: a reconciliation adjusts nothing');

  // And the payments report still says what it said, which is the same statement read
  // from the other side.
  const payments = reportService.payments({ from: today }, sessions.OWNER);
  assert.equal(payments.methods.find((row) => row.method === 'GCASH').amount_centavos, 25000);

  // AUD-601: who compared what to what, with the reason.
  const trail = auditService.browse({ action: 'PAYMENT_RECONCILED', entityId: result.id });
  assert.equal(trail.rows.length, 1);
  assert.equal(trail.rows[0].after.variance_centavos, -500);
  assert.equal(trail.rows[0].after.recorded_centavos, 25000);
  assert.match(trail.rows[0].reason, /never sent/);
});

test('TC-INT-117: the same range cannot be reconciled twice with a different answer', () => {
  assert.throws(
    () => reconciliationService.record({
      from: today, method: 'GCASH', actualCentavos: 25000,
    }, sessions.OWNER),
    (err) => {
      assert.equal(err.ruleId, 'RPT-105');
      assert.match(err.message, /already reconciled/);
      // The refusal quotes the reason the first one carried, so the operator can see
      // what was already decided rather than only that something was.
      assert.match(err.message, /never sent/);
      return true;
    }
  );

  // A different method over the same days is a different question, and is allowed.
  const qrph = reconciliationService.record({
    from: today, method: 'QRPH', actualCentavos: 5000,
  }, sessions.OWNER);
  assert.equal(qrph.variance_centavos, 0);
  assert.equal(qrph.variance_label, 'Exactly as recorded');
});

// ── TC-INT-118 — POS-510's shape, one level up ──────────────────────────────

test('TC-INT-118: a variance beyond tolerance needs a reason, and within it does not', () => {
  const tolerance = settingsService.get('settlement_variance_tolerance_centavos');
  assert.equal(tolerance, 10000, 'the default the store starts with');

  // Within tolerance: no reason demanded. A store that had to explain every ₱2 of
  // wallet fee would stop reading the question.
  const small = reconciliationService.record({
    from: '2026-01-05', to: '2026-01-05', method: 'GCASH', actualCentavos: 0,
  }, sessions.OWNER);
  assert.equal(small.variance_centavos, 0);
  assert.equal(small.within_tolerance, true);
  assert.equal(small.reason, null);

  // Beyond it: refused until somebody says what it is, and the refusal names the three
  // things it usually turns out to be.
  assert.throws(
    () => reconciliationService.record({
      from: '2026-01-06', to: '2026-01-06', method: 'GCASH', actualCentavos: 50000,
    }, sessions.OWNER),
    (err) => {
      assert.equal(err.ruleId, 'RPT-105');
      assert.match(err.message, /beyond the ₱100\.00 tolerance/);
      assert.match(err.message, /a fee, a transfer that landed late, or a sale nobody paid for/);
      // And it says the figures are not changed either way, because that is the question
      // somebody asks when a screen refuses them.
      assert.match(err.message, /not changed either way/);
      return true;
    }
  );

  // With the reason, it saves — and the variance is still the variance.
  const explained = reconciliationService.record({
    from: '2026-01-06', to: '2026-01-06', method: 'GCASH', actualCentavos: 50000,
    reason: 'A transfer from the 5th landed on the 6th',
  }, sessions.OWNER);
  assert.equal(explained.variance_centavos, 50000);
  assert.equal(explained.within_tolerance, false);
});

test('TC-INT-118: the tolerance is the store’s setting, not a number in the code', () => {
  settingsService.set('settlement_variance_tolerance_centavos', 100000, sessions.OWNER);

  // The same ₱500 variance that needed a reason above now does not, because the owner
  // widened the tolerance. RPT-105's shape is POS-510's, including this.
  const wide = reconciliationService.record({
    from: '2026-01-07', to: '2026-01-07', method: 'QRPH', actualCentavos: 50000,
  }, sessions.OWNER);
  assert.equal(wide.within_tolerance, true);
  assert.equal(wide.reason, null);

  settingsService.set('settlement_variance_tolerance_centavos', 10000, sessions.OWNER);
});

// ── Over HTTP, and who may reach it ─────────────────────────────────────────

test('the reconciliation is behind TX-421 at store scope, and there is no route that edits a tender', async () => {
  assert.equal((await call(`/reports/reconciliation?from=${today}`, { token: tokens.MANAGER })).status, 200);
  assert.equal((await call(`/reports/reconciliation?from=${today}`, { token: tokens.INVENTORY })).status, 403);

  // A cashier holds TX-421 for their own shift's sales figures; the store's settlements
  // are not a shift's figure.
  const refused = await call(`/reports/reconciliation?from=${today}`, { token: tokens.CASHIER });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.rule_id, 'TX-421');

  const saved = await call('/reconciliations', {
    token: tokens.OWNER, method: 'POST',
    body: { from: '2026-02-01', to: '2026-02-07', method: 'OTHER', actualCentavos: 0 },
  });
  assert.equal(saved.status, 201);

  const history = await (await call('/reconciliations?method=OTHER', { token: tokens.OWNER })).json();
  assert.equal(history.reconciliations.length, 1);
  assert.equal(history.reconciliations[0].from_date, '2026-02-01');

  // RPT-105's prohibition, at the edge: no route edits or deletes one, and none names a
  // sale. The path that could break the rule does not exist.
  const edit = await call(`/reconciliations/${history.reconciliations[0].id}`, {
    token: tokens.OWNER, method: 'PUT', body: { actualCentavos: 999 },
  });
  assert.equal(edit.status, 404);
  assert.equal((await call(`/reconciliations/${history.reconciliations[0].id}`, {
    token: tokens.OWNER, method: 'DELETE',
  })).status, 404);
});

test('CASH, CREDIT and STORE_CREDIT are refused by name, with the reason', () => {
  for (const [method, expected] of [
    ['CASH', /shift close/],
    ['CREDIT', /Settles nowhere/],
    ['STORE_CREDIT', /already holds/],
  ]) {
    assert.throws(
      () => reconciliationService.record({
        from: today, method, actualCentavos: 1000,
      }, sessions.OWNER),
      (err) => {
        assert.equal(err.ruleId, 'RPT-105');
        assert.match(err.message, expected, `${method}: the refusal says why`);
        return true;
      }
    );
  }
});
