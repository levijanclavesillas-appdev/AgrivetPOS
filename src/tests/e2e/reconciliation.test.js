'use strict';

// TC-E2E-26 — a week of mixed tenders, and a GCash statement short by one sale.
//
// The walk TASK-032 describes, over HTTP: the store trades for a week across cash,
// GCash and QR Ph; the wallet's statement arrives on Monday and is ₱320 light; and the
// operator has to find out why and record what they found.
//
// **The assertion that carries the task is the one about what did not happen.** After
// the reconciliation the sales and the tenders are byte-identical — `RPT-105` forbids
// adjusting the recorded figure, and the missing ₱320 is a real sale that a cashier
// recorded and nobody ever paid for. A feature that quietly corrected the books would
// pass every other assertion in this file.
//
// The second is the drill-down. Being told "you are ₱320 short" is not useful; being
// able to read the four references off the list and tick them against the statement is
// — three are on it, one is not, and the one that is not is the ₱320.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const inventoryService = require('../../services/inventoryService');
const saleService = require('../../services/saleService');
const shiftService = require('../../services/shiftService');
const clock = require('../../config/clock');
const db = require('../../config/database');
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';

let instance;
let BASE = null;
const tokens = {};
const sessions = {};
let product;
let today;
let unpaidSaleNo;

const call = (pathname, { method = 'GET', body = null, who = 'boss' } = {}) => fetch(`${BASE}${pathname}`, {
  method,
  headers: {
    ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

const json = async (res) => {
  const body = await res.json();
  assert.ok(res.ok, `${res.status} ${JSON.stringify(body)}`);
  return body;
};

const snapshot = () => JSON.stringify({
  sales: db.get().prepare('SELECT * FROM sales ORDER BY id').all(),
  tenders: db.get().prepare('SELECT * FROM sale_tenders ORDER BY id').all(),
});

test.before(async () => {
  temp.openMigrated('reconciliation-e2e');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;

  temp.seedStore({ withOwner: false, taxMode: 'NONE' });
  const ref = temp.seedCatalog();

  for (const [who, role] of [['boss', 'OWNER'], ['till', 'CASHIER']]) {
    temp.seedUser({ username: who, role, password: PASSWORD });
    const signedIn = authService.login({ username: who, password: PASSWORD });
    tokens[who] = signedIn.token;
    sessions[who] = authService.verifyToken(signedIn.token);
  }

  product = productService.create({
    sku: 'FEED-HG-50', name: 'Hog Grower Pellets', categoryId: ref.category.id,
    baseUnitId: ref.kg.id, retailPriceCentavos: 8000,
  }, sessions.boss);
  inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli: 5000000,
    unitCostCentavos: 5000, actor: sessions.boss,
  });

  shiftService.open({ actor: sessions.till, openingFloatCentavos: 500000, confirmed: true });
  today = clock.manilaDate(clock.nowUtc());
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

test('TC-E2E-26 · a week of mixed tenders across the counter', async () => {
  // Four GCash sales, two QR Ph, three cash. One of the GCash sales will turn out never
  // to have settled — and it carries a reference like every other, because POS-205
  // refuses a non-cash tender without one.
  //
  // **That is POS-206's whole point, and the reason this feature exists.** RECORDED
  // means the cashier saw a "sent" screen on somebody's telephone. It does not mean the
  // money arrived, and no API tells this store which. The transfer failed afterwards
  // and nobody knew until the statement came.
  const gcash = [200, 320, 400, 160];
  for (const [index, pesos] of gcash.entries()) {
    const sale = await json(await call('/sales', {
      method: 'POST', who: 'till',
      body: {
        lines: [{ productId: product.id, qtyMilli: (pesos / 80) * 1000 }],
        tenders: [{
          method: 'GCASH',
          amountCentavos: pesos * 100,
          referenceNo: `GC-77${index}`,
        }],
      },
    }));
    if (index === 1) unpaidSaleNo = sale.sale.sale_no;
  }

  for (const pesos of [240, 80]) {
    await json(await call('/sales', {
      method: 'POST', who: 'till',
      body: {
        lines: [{ productId: product.id, qtyMilli: (pesos / 80) * 1000 }],
        tenders: [{ method: 'QRPH', amountCentavos: pesos * 100, referenceNo: `QR-${pesos}` }],
      },
    }));
  }

  for (const pesos of [80, 160, 400]) {
    await json(await call('/sales', {
      method: 'POST', who: 'till',
      body: {
        lines: [{ productId: product.id, qtyMilli: (pesos / 80) * 1000 }],
        tenders: [{ method: 'CASH', amountCentavos: pesos * 100 }],
      },
    }));
  }

  const recorded = await json(await call(`/reports/reconciliation?from=${today}`));
  const byMethod = Object.fromEntries(recorded.methods.map((row) => [row.method, row]));

  assert.equal(byMethod.GCASH.recorded_centavos, 108000, '₱1,080 of GCash recorded');
  assert.equal(byMethod.GCASH.tender_count, 4);
  assert.equal(byMethod.QRPH.recorded_centavos, 32000);
  // POS-206: what the store actually knows about those figures.
  assert.equal(byMethod.GCASH.recorded_label, 'RECORDED');

  // Requirement 2, on the screen rather than as three silently missing methods.
  const excluded = Object.fromEntries(recorded.excluded.map((row) => [row.method, row.why]));
  assert.match(excluded.CASH, /shift close/);
  assert.equal(recorded.cash.recorded_centavos, 64000, 'cash is shown, from where it is counted');
});

test('TC-E2E-26 · the statement is ₱320 short, and the variance says so without changing anything', async () => {
  const before = snapshot();

  // The wallet settled ₱760 of the ₱1,080 recorded.
  const refusedWithoutReason = await call('/reconciliations', {
    method: 'POST',
    body: { from: today, to: today, method: 'GCASH', actualCentavos: 76000 },
  });
  assert.equal(refusedWithoutReason.status, 400);
  const refusal = (await refusedWithoutReason.json()).error;
  assert.equal(refusal.rule_id, 'RPT-105');
  // POS-510's shape: beyond the tolerance, say what it is — and the refusal names the
  // three things it usually turns out to be.
  assert.match(refusal.message, /a fee, a transfer that landed late, or a sale nobody paid for/);
  assert.match(refusal.message, /not changed either way/);

  const saved = await json(await call('/reconciliations', {
    method: 'POST',
    body: {
      from: today, to: today, method: 'GCASH', actualCentavos: 76000,
      reference: 'GCASH-2026-09-11',
      reason: 'GC-771 never arrived — the transfer failed after the customer showed the sent screen',
    },
  }));

  assert.equal(saved.recorded_centavos, 108000);
  assert.equal(saved.actual_centavos, 76000);
  assert.equal(saved.variance_centavos, -32000);
  assert.match(saved.variance_label, /₱320\.00 short/);
  assert.equal(saved.within_tolerance, false);

  // **The assertion the whole rule is about.** Not one byte of any sale or tender
  // moved: the ₱320 sale is still on the books, still recorded, still unpaid — which is
  // the fact the store needs and the fact a "correct to actual" button would erase.
  assert.equal(snapshot(), before, 'RPT-105: a reconciliation adjusts nothing');

  // And the payments report still says ₱1,080, because it is the same query.
  const payments = await json(await call(`/reports/payments?from=${today}`));
  assert.equal(payments.methods.find((row) => row.method === 'GCASH').amount_centavos, 108000);
});

test('TC-E2E-26 · the operator drills through the variance and finds the sale', async () => {
  const drill = await json(await call(
    `/reports/reconciliation/tenders?from=${today}&method=GCASH`
  ));

  assert.equal(drill.tenders.length, 4);
  assert.equal(drill.total_centavos, 108000, 'the list adds up to the figure it drills into');

  // This is the work the screen exists to make possible: the operator reads the four
  // references off the list and ticks them against the statement. Three are there and
  // one is not, and the one that is not is the ₱320.
  const onStatement = ['GC-770', 'GC-772', 'GC-773'];
  const missing = drill.tenders.filter((tender) => !onStatement.includes(tender.reference_no));

  assert.equal(missing.length, 1);
  assert.equal(missing[0].amount_centavos, 32000, 'which is exactly the variance');
  assert.equal(missing[0].sale_no, unpaidSaleNo);
  assert.equal(missing[0].cashier, 'till');
  // POS-206 again, on the row: the status is all the store ever knew about it.
  assert.equal(missing[0].status, 'RECORDED');

  // And the arithmetic closes: what settled plus what did not is what was recorded.
  const settled = drill.tenders
    .filter((tender) => onStatement.includes(tender.reference_no))
    .reduce((sum, tender) => sum + tender.amount_centavos, 0);
  assert.equal(settled, 76000, 'the three that arrived are the statement’s total');
  assert.equal(settled + missing[0].amount_centavos, drill.total_centavos);
});

test('TC-E2E-26 · the week cannot be reconciled twice, and the answer stays on the screen', async () => {
  const again = await call('/reconciliations', {
    method: 'POST',
    body: { from: today, to: today, method: 'GCASH', actualCentavos: 108000, reason: 'Second thoughts' },
  });
  assert.equal(again.status, 409);
  const error = (await again.json()).error;
  assert.equal(error.rule_id, 'RPT-105');
  assert.match(error.message, /already reconciled/);
  // The refusal quotes what was decided, so the operator sees the earlier answer rather
  // than only that one exists.
  assert.match(error.message, /GC-771 never arrived/);

  // The saved answer is on the row, where the next person looks.
  const recorded = await json(await call(`/reports/reconciliation?from=${today}`));
  const gcash = recorded.methods.find((row) => row.method === 'GCASH');
  assert.equal(gcash.already_reconciled.length, 1);
  assert.equal(gcash.already_reconciled[0].actual_centavos, 76000);
  assert.equal(gcash.already_reconciled[0].reconciled_by, 'boss');
  assert.equal(gcash.last_reconciled_to, today, 'and where the next range starts');

  // QR Ph settled exactly, needs no reason, and is a separate question about the same
  // week — which is allowed.
  const qrph = await json(await call('/reconciliations', {
    method: 'POST',
    body: { from: today, to: today, method: 'QRPH', actualCentavos: 32000, reference: 'QRPH-0911' },
  }));
  assert.equal(qrph.variance_centavos, 0);
  assert.equal(qrph.variance_label, 'Exactly as recorded');
  assert.equal(qrph.reason, null);
});
