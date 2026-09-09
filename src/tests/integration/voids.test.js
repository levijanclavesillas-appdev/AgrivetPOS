'use strict';

// FT-308 — the void. POS-401 to POS-404.
//
// The three named cases are `TC-INT-85` to `TC-INT-87`. Two of them assert an
// **absence**, which is the harder half: POS-404 says a voided sale stays in the
// ledger and in the sequence, and a test that only checked the totals had gone down
// would pass just as happily against an implementation that deleted the row.
//
// `TC-INT-85`'s hardest assertion is the drawer. A void corrects POS-509's expected
// cash *by the status alone* — `tenderTotalsByMethod` has filtered `VOIDED` since
// TASK-010 — so the failure mode is not "the drawer is wrong" but "the drawer is wrong
// by exactly twice", which is what a compensating till movement would produce. The
// case asserts the figure, and asserts that no till row was written to reach it.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const db = require('../../config/database');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const customerService = require('../../services/customerService');
const inventoryService = require('../../services/inventoryService');
const creditService = require('../../services/creditService');
const collectionService = require('../../services/collectionService');
const shiftService = require('../../services/shiftService');
const saleService = require('../../services/saleService');
const returnService = require('../../services/returnService');
const voidService = require('../../services/voidService');
const reportService = require('../../services/reportService');
const auditService = require('../../services/auditService');
const permissions = require('../../services/permissions');
const inventoryRepository = require('../../repositories/inventoryRepository');
const productRepository = require('../../repositories/productRepository');
const saleRepository = require('../../repositories/saleRepository');
const creditRepository = require('../../repositories/creditRepository');
const shiftRepository = require('../../repositories/shiftRepository');
const temp = require('../helpers/tempdb');

let BASE = null;
const PASSWORD = 'correct-horse-battery';

let instance;
let ref;
const tokens = {};
const sessions = {};
let cashierShift;

const call = (path, { token = null, method = 'GET', body = null } = {}) => fetch(`${BASE}${path}`, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

let seq = 0;

function stocked({ retail = 6250, cost = 4800, qtyMilli = 1000000 } = {}) {
  seq += 1;
  const product = productService.create({
    sku: `VOID-${String(seq).padStart(3, '0')}`,
    name: `Void Test Line ${seq}`,
    categoryId: ref.category.id,
    baseUnitId: ref.kg.id,
    retailPriceCentavos: retail,
  }, sessions.OWNER);

  inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli, unitCostCentavos: cost, actor: sessions.OWNER,
  });
  return productRepository.findById(product.id);
}

function creditCustomer() {
  seq += 1;
  const customer = customerService.create({
    name: `Void Farm ${seq}`, customerType: 'FARM', priceLevel: 'RETAIL',
    isCreditEligible: true, creditLimitCentavos: 50000000, termsDays: 15,
  }, sessions.OWNER);
  return { customer, account: creditService.accountFor(customer.id) };
}

/** What a cart comes to, asked of the engine that will charge it (POS-203). */
function totalOf({ product, qtyMilli, customer = null }) {
  const pricingService = require('../../services/pricingService');
  const storeProfileService = require('../../services/storeProfileService');
  return pricingService.priceCart({
    lines: [{ productId: product.id, qtyMilli }],
    customer,
    taxMode: storeProfileService.taxMode(),
    actorRole: 'CASHIER',
  }).total_centavos;
}

const onHand = (productId) => inventoryRepository.qtyOnHand(productId);
const tillRows = (shiftId) => db.get()
  .prepare('SELECT COUNT(*) AS n FROM till_movements WHERE shift_id = ?').get(shiftId).n;

test.before(async () => {
  temp.openEmpty('voids');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;
  temp.seedStore({ taxMode: 'NONE', withOwner: false });
  ref = temp.seedCatalog();

  for (const role of ['OWNER', 'MANAGER', 'CASHIER', 'INVENTORY']) {
    const username = role.toLowerCase();
    temp.seedUser({ username, role, password: PASSWORD });
    const signedIn = authService.login({ username, password: PASSWORD });
    tokens[role] = signedIn.token;
    sessions[role] = authService.verifyToken(signedIn.token);
  }

  cashierShift = shiftService.open({
    actor: sessions.CASHIER, openingFloatCentavos: 500000, confirmed: true,
  }).shift;
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── TC-INT-85 — POS-401 ─────────────────────────────────────────────────────

test('TC-INT-85: POS-401 — every movement, tender and credit transaction reverses, and the ledgers reconcile', () => {
  const product = stocked();
  const { customer, account } = creditCustomer();
  const owedBefore = creditRepository.findAccountByCustomer(customer.id).balance_centavos;
  const stockBefore = onHand(product.id);

  const total = totalOf({ product, qtyMilli: 4000, customer });
  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 4000 }],
    customerId: customer.id,
    tenders: [{ method: 'CREDIT', amountCentavos: total }],
  }, sessions.CASHIER);

  assert.equal(onHand(product.id), stockBefore - 4000, 'the sale took the stock');
  assert.equal(creditRepository.findAccountByCustomer(customer.id).balance_centavos, owedBefore + total);

  const voided = voidService.post({
    saleId: sale.sale.id,
    reason: 'Rang up the wrong farm’s account',
    approver: { username: 'manager' },
  }, sessions.CASHIER);

  // POS-401: stock back, by a compensating movement rather than a deletion (INV-102).
  assert.equal(onHand(product.id), stockBefore, 'the stock is exactly where it started');
  assert.equal(voided.reversal.movements.length, 1);

  const ledger = inventoryService.ledger(product.id, { limit: 10 }).movements;
  const forSale = ledger.filter((m) => m.reference && m.reference.no === sale.sale.sale_no);
  assert.equal(forSale.length, 2, 'INV-102: the sale and its reversal both stand');
  assert.deepEqual(forSale.map((m) => m.type).sort(), ['SALE', 'SALE_VOID']);
  assert.ok(forSale.every((m) => m.reason || m.type === 'SALE'), 'INV-103: the reversal carries a reason');

  // POS-401: the credit transaction reverses, and CR-103's balance derives from the
  // pair rather than being written back to what it was.
  assert.equal(creditRepository.findAccountByCustomer(customer.id).balance_centavos, owedBefore);
  assert.equal(voided.reversal.credit.length, 1);
  const txns = creditRepository.transactionsForSale(sale.sale.id);
  assert.equal(txns.length, 2, 'the credit sale and its adjustment both stand');
  assert.equal(txns.reduce((sum, t) => sum + t.amount_centavos, 0), 0, 'and they sum to nothing');

  // CR-103 reconciles: the account's stored balance equals its ledger.
  assert.deepEqual(creditRepository.reconciliationBreaks(), []);
});

test('TC-INT-85: a cash void corrects the drawer by the status alone, and writes no till row', () => {
  const product = stocked({ retail: 25000 });

  const before = shiftService.computeExpected(cashierShift.id);
  const tillBefore = tillRows(cashierShift.id);

  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 2000 }],       // ₱500.00
    tenders: [{ method: 'CASH', amountCentavos: 100000 }],    // ₱1,000 in, ₱500 change
  }, sessions.CASHIER);
  assert.equal(sale.sale.change_centavos, 50000);

  const during = shiftService.computeExpected(cashierShift.id);
  assert.equal(during.expected_cash_centavos, before.expected_cash_centavos + 50000,
    'POS-509: ₱1,000 tendered less ₱500 change is ₱500 into the drawer');

  const voided = voidService.post({
    saleId: sale.sale.id, reason: 'Wrong item scanned', approver: { username: 'manager' },
  }, sessions.CASHIER);

  // Requirement 6. The failure this asserts against is not "wrong" but "wrong by
  // exactly twice", which is what a compensating till movement would have produced.
  const after = shiftService.computeExpected(cashierShift.id);
  assert.equal(after.expected_cash_centavos, before.expected_cash_centavos,
    'the drawer expects what it did before the sale — once, not twice');
  assert.equal(tillRows(cashierShift.id), tillBefore, 'POS-509: and no till movement was written');
  assert.equal(voided.reversal.drawer.till_movement_written, false);
  assert.equal(voided.reversal.drawer.cash_out_centavos, 50000, 'what the cashier hands back');

  // POS-507: the drawer still opens, because there are notes to return.
  assert.equal(voided.drawer.reason, 'CASH_VOID');
});

// ── TC-INT-86 — POS-402 ─────────────────────────────────────────────────────

test('TC-INT-86: POS-402 — a void after the close is refused, and the message names the return', () => {
  const product = stocked();

  // A shift of its own, so closing it does not disturb the rest of this file.
  temp.seedUser({ username: 'closer', role: 'CASHIER', password: PASSWORD });
  const closer = authService.verifyToken(authService.login({ username: 'closer', password: PASSWORD }).token);
  const shift = shiftService.open({ actor: closer, openingFloatCentavos: 100000, confirmed: true }).shift;

  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 10000 }],
  }, closer);

  // While it is open, the void is available — asserted first, so the refusal below is
  // demonstrably about the close and not about something else on this sale.
  const before = voidService.eligibility(sale.sale.id, closer);
  assert.equal(before.can_void, true);
  assert.equal(before.shift.open, true);

  shiftService.close({
    shiftId: shift.id,
    actor: closer,
    actualCashCentavos: shiftService.computeExpected(shift.id).expected_cash_centavos,
  });

  assert.throws(
    () => voidService.post({
      saleId: sale.sale.id, reason: 'Changed their mind', approver: { username: 'manager' },
    }, closer),
    (err) => err.ruleId === 'POS-402' && err.status === 409 && /as a return/.test(err.message)
  );

  // The screen is told the same thing, before it offers the button.
  const after = voidService.eligibility(sale.sale.id, closer);
  assert.equal(after.can_void, false);
  assert.equal(after.refusal.rule_id, 'POS-402');
  assert.match(after.refusal.message, /return, not a void/);

  // And a manager cannot reach past the close either. POS-402 is a property of the
  // shift, not of who is asking.
  assert.throws(
    () => voidService.post({ saleId: sale.sale.id, reason: 'Changed their mind' }, sessions.MANAGER),
    (err) => err.ruleId === 'POS-402'
  );

  // The sale is untouched by any of it.
  assert.equal(saleRepository.findById(sale.sale.id).status, 'COMPLETED');
});

test('TC-INT-86: the window is the sale’s shift, not the actor’s', () => {
  const product = stocked();
  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 10000 }],
  }, sessions.CASHIER);

  // The manager has no open shift of their own, and voids the cashier's sale anyway:
  // POS-402 asks whether the *sale's* shift is open, and TX-419 is what lets somebody
  // act on a drawer they did not count.
  assert.ok(!shiftRepository.findOpenForUser(sessions.MANAGER.id), 'and no shift of their own');
  const voided = voidService.post({
    saleId: sale.sale.id, reason: 'Cashier called me over',
  }, sessions.MANAGER);
  assert.equal(voided.sale.status, 'VOIDED');
  assert.equal(voided.authorisation.self_authorised, true);

  // A different cashier may not, and the refusal names TX-419 rather than POS-402 —
  // which is a different problem and a different sentence.
  const other = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 10000 }],
  }, sessions.CASHIER);
  const nosy = authService.verifyToken(authService.login({ username: 'closer', password: PASSWORD }).token);
  assert.throws(
    () => voidService.post({
      saleId: other.sale.id, reason: 'Not mine to undo', approver: { username: 'manager' },
    }, nosy),
    (err) => err.ruleId === 'TX-419' && err.status === 403
  );
});

// ── TC-INT-87 — POS-403 ─────────────────────────────────────────────────────

test('TC-INT-87: POS-403 — a cashier alone is refused, and with a manager both actors are on the row', () => {
  const product = stocked();
  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 10000 }],
  }, sessions.CASHIER);

  // §10 grants TX-405 to a manager and an owner. The cashier reaches the route — they
  // are the one who noticed — and is stopped here, where the rule can be named.
  assert.equal(permissions.can(sessions.CASHIER, 'TX-405'), false);
  assert.throws(
    () => voidService.post({ saleId: sale.sale.id, reason: 'Mis-scan' }, sessions.CASHIER),
    (err) => err.ruleId === 'POS-403' && err.status === 403
      && err.requiresRole === 'MANAGER or OWNER' && /never void a sale unaided/.test(err.message)
  );
  assert.equal(saleRepository.findById(sale.sale.id).status, 'COMPLETED', 'and nothing happened');

  // An approver who is not one of the two is refused by their **stored** role, not by
  // what the request claimed (SEC-6).
  assert.throws(
    () => voidService.post({
      saleId: sale.sale.id, reason: 'Mis-scan', approver: { username: 'inventory', role: 'OWNER' },
    }, sessions.CASHIER),
    (err) => err.ruleId === 'POS-403' && /cannot authorise a void/.test(err.message)
  );

  const voided = voidService.post({
    saleId: sale.sale.id, reason: 'Mis-scan — scanned the sack twice', approver: { username: 'manager' },
  }, sessions.CASHIER);
  assert.equal(voided.authorisation.self_authorised, false);
  assert.equal(voided.authorisation.authorised_by, 'manager');

  // AUD-603: two distinct actors, on a row of its own.
  const overrides = auditService.browse({ action: 'OVERRIDE_SALE_VOID' });
  const row = overrides.rows.find((e) => e.entity_id === sale.sale.id);
  assert.ok(row, 'the override has its own row');
  assert.equal(row.actor.username, 'cashier');
  assert.equal(row.approver.username, 'manager');
  assert.match(row.reason, /scanned the sack twice/);

  // AUD-601: and the void itself is on the trail, with both actors and the reason.
  const trail = auditService.browse({ action: 'SALE_VOIDED', entityId: sale.sale.id });
  assert.equal(trail.rows.length, 1);
  assert.equal(trail.rows[0].approver.username, 'manager');
  assert.equal(trail.rows[0].before.status, 'COMPLETED');
  assert.equal(trail.rows[0].after.status, 'VOIDED');
});

test('POS-403: a manager voiding their own mis-scan is the authority the rule asks for', () => {
  const product = stocked();
  const managerShift = shiftService.open({
    actor: sessions.MANAGER, openingFloatCentavos: 100000, confirmed: true,
  }).shift;

  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 10000 }],
  }, sessions.MANAGER);

  const voided = voidService.post({ saleId: sale.sale.id, reason: 'My own mis-scan' }, sessions.MANAGER);

  // Required, and self-authorised. "A manager did this himself" and "no authorisation
  // was needed" read identically unless one of them is written down — and here the
  // second is never true.
  assert.equal(voided.authorisation.required, true);
  assert.equal(voided.authorisation.self_authorised, true);
  assert.equal(voided.authorisation.authorised_by, null);

  // No override row: recordOverride refuses an approver who is the actor, which is the
  // whole point of AUD-603's two columns.
  const overrides = auditService.browse({ action: 'OVERRIDE_SALE_VOID' });
  assert.equal(overrides.rows.some((e) => e.entity_id === sale.sale.id), false);

  shiftService.close({
    shiftId: managerShift.id,
    actor: sessions.MANAGER,
    actualCashCentavos: shiftService.computeExpected(managerShift.id).expected_cash_centavos,
  });
});

// ── POS-404 — what survives it ──────────────────────────────────────────────

test('POS-404: the sale keeps its number, the sequence has no gap, and it cannot be voided twice', () => {
  const product = stocked();
  const sequenceService = require('../../services/sequenceService');

  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 10000 }],
  }, sessions.CASHIER);

  const before = sequenceService.auditDay('SALE');
  voidService.post({
    saleId: sale.sale.id, reason: 'Wrong customer', approver: { username: 'manager' },
  }, sessions.CASHIER);
  const after = sequenceService.auditDay('SALE');

  // POS-108: the number is not reissued, and the run has no hole where it sits. A gap
  // is what an auditor looks for, and a void that removed one would hide the thing the
  // sequence exists to reveal.
  assert.deepEqual(after.gaps, before.gaps);
  assert.equal(after.issued, before.issued, 'no number was consumed or released');
  const row = saleRepository.findById(sale.sale.id);
  assert.equal(row.sale_no, sale.sale.sale_no);
  assert.equal(saleRepository.findByNo(sale.sale.sale_no).id, sale.sale.id);

  // POS-401's four columns, written together.
  assert.equal(row.status, 'VOIDED');
  assert.ok(row.voided_at);
  assert.equal(row.voided_by, sessions.CASHIER.id);
  assert.equal(row.void_reason, 'Wrong customer');

  // Requirement 8: not twice, not returned against, and the refusals say why.
  assert.throws(
    () => voidService.post({
      saleId: sale.sale.id, reason: 'Again', approver: { username: 'manager' },
    }, sessions.CASHIER),
    (err) => err.ruleId === 'POS-404' && /already voided/.test(err.message)
  );
  assert.throws(
    () => returnService.post({
      saleId: sale.sale.id,
      reason: 'Wrong item sold',
      lines: [{ saleItemId: saleRepository.itemsFor(sale.sale.id)[0].id, qtyMilli: 1000 }],
    }, sessions.CASHIER),
    (err) => err.ruleId === 'POS-301' && /voided/.test(err.message)
  );
});

test('POS-401: a sale with goods already returned is not voided — the two corrections are alternatives', () => {
  const product = stocked();
  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 4000 }],
    tenders: [{ method: 'CASH', amountCentavos: 100000 }],
  }, sessions.CASHIER);

  returnService.post({
    saleId: sale.sale.id,
    reason: 'Wrong item sold',
    lines: [{ saleItemId: saleRepository.itemsFor(sale.sale.id)[0].id, qtyMilli: 1000 }],
  }, sessions.CASHIER);

  // A void says the sale never happened, and part of it demonstrably did.
  assert.throws(
    () => voidService.post({
      saleId: sale.sale.id, reason: 'Undo the lot', approver: { username: 'manager' },
    }, sessions.CASHIER),
    (err) => err.ruleId === 'POS-401' && /never happened/.test(err.message)
  );
});

test('CR-203: a credit sale a collection has already settled is not voided either', () => {
  const product = stocked({ retail: 100000 });
  const { customer } = creditCustomer();

  const total = totalOf({ product, qtyMilli: 2000, customer });
  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 2000 }],
    customerId: customer.id,
    tenders: [{ method: 'CREDIT', amountCentavos: total }],
  }, sessions.CASHIER);

  collectionService.record({
    customerId: customer.id, amountCentavos: Math.round(total / 2), method: 'CASH',
  }, sessions.CASHIER);

  // The money came in. Making it disappear is exactly what POS-404 exists to prevent,
  // so the honest answer is a refusal that names the correction that does apply.
  assert.throws(
    () => voidService.post({
      saleId: sale.sale.id, reason: 'Undo it', approver: { username: 'manager' },
    }, sessions.CASHIER),
    (err) => err.ruleId === 'CR-203' && /return instead/.test(err.message)
  );
  assert.equal(saleRepository.findById(sale.sale.id).status, 'COMPLETED');
});

test('POS-401: a void needs a reason, and the reason is what survives on the row', () => {
  const product = stocked();
  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 10000 }],
  }, sessions.CASHIER);

  for (const reason of [null, '', '   ', 'ab']) {
    assert.throws(
      () => voidService.post({ saleId: sale.sale.id, reason, approver: { username: 'manager' } }, sessions.CASHIER),
      (err) => err.ruleId === 'POS-401' && err.status === 400
    );
  }

  // POS-107, from the other side: the repository cannot be made to write the status
  // without the three columns that go with it.
  assert.throws(() => saleRepository.setStatus(sale.sale.id, 'VOIDED'), RangeError);
  assert.throws(() => saleRepository.setVoided(sale.sale.id, { voidedAt: null, voidedBy: null, reason: null }), TypeError);
});

// ── The report, and the API ─────────────────────────────────────────────────

test('POS-404: the void report lists what every other report leaves out', () => {
  const clock = require('../../config/clock');
  const today = clock.manilaDate(clock.nowUtc());

  const report = reportService.voids({ from: today }, sessions.OWNER);
  assert.ok(report.totals.void_count >= 1);
  assert.match(report.sequence_note, /no gap/);
  assert.equal(report.header.rule_id, 'POS-404');

  const row = report.voids[0];
  assert.ok(row.sale_no && row.reason, 'a void carries its number and its reason');
  assert.ok(row.voided_by, 'and who did it');

  // The pair AUD-603 asks a reader to check, on the row rather than in another report.
  const authorised = report.voids.find((v) => v.approved_by);
  assert.ok(authorised === undefined || authorised.approved_by !== authorised.cashier_username);

  // The daily report leaves the same sales out of net, which is the other half of
  // POS-404's sentence and the reason both reports exist.
  const daily = reportService.daily({ from: today }, sessions.OWNER);
  assert.equal(daily.header.voided_excluded_count, report.totals.void_count);
  assert.equal(daily.reconciliation.reconciles, true, 'and the day still reconciles');
});

test('SEC-6: the void route is the counter’s, and the report is TX-421’s', async () => {
  const product = stocked();
  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 10000 }],
  }, sessions.CASHIER);

  // The inventory clerk holds neither TX-401 nor TX-405 — refused at the door.
  const refused = await call(`/sales/${sale.sale.id}/void`, {
    token: tokens.INVENTORY, method: 'POST', body: { reason: 'Not mine' },
  });
  assert.equal(refused.status, 403);

  // The cashier reaches it and is stopped by POS-403 rather than by the route, which
  // is the difference that lets the screen open an authorisation panel.
  const unaided = await call(`/sales/${sale.sale.id}/void`, {
    token: tokens.CASHIER, method: 'POST', body: { reason: 'Mis-scan' },
  });
  assert.equal(unaided.status, 403);
  const body = await unaided.json();
  assert.equal(body.error.rule_id, 'POS-403');
  assert.equal(body.error.requires_role, 'MANAGER or OWNER');

  // And the screen could have known that before it showed the button.
  const eligible = await (await call(`/sales/${sale.sale.id}/voidable`, { token: tokens.CASHIER })).json();
  assert.equal(eligible.can_void, true);
  assert.equal(eligible.self_authorised, false);
  assert.equal(eligible.requires_role, 'MANAGER or OWNER');

  const done = await call(`/sales/${sale.sale.id}/void`, {
    token: tokens.CASHIER, method: 'POST',
    body: { reason: 'Mis-scan at the counter', approver: { username: 'manager' } },
  });
  assert.equal(done.status, 201);
  assert.equal((await done.json()).sale.status, 'VOIDED');

  const clock = require('../../config/clock');
  const report = await call(`/reports/voids?from=${clock.manilaDate(clock.nowUtc())}`, { token: tokens.OWNER });
  assert.equal(report.status, 200);
  assert.ok((await report.json()).totals.void_count >= 1);
});
