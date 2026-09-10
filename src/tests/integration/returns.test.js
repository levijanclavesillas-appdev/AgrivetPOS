'use strict';

// FT-307 — the sales return. POS-301 to POS-307, INV-103, CR-108.
//
// The four named cases are `TC-INT-81` to `TC-INT-84`. Two of them assert arithmetic
// that only goes wrong on the *second* operation — a cumulative limit and a
// three-part refund — which is the shape of defect a single-shot test never sees, so
// both return the same line repeatedly rather than once.
//
// `TC-INT-84` asserts a **net effect of zero** across two movements. That is the case
// worth reading: a write-off that posted nothing at all would also leave stock
// unchanged, and only counting the rows tells the two apart.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const customerService = require('../../services/customerService');
const inventoryService = require('../../services/inventoryService');
const creditService = require('../../services/creditService');
const shiftService = require('../../services/shiftService');
const saleService = require('../../services/saleService');
const returnService = require('../../services/returnService');
const collectionService = require('../../services/collectionService');
const settingsService = require('../../services/settingsService');
const auditService = require('../../services/auditService');
const documentService = require('../../services/documentService');
const inventoryRepository = require('../../repositories/inventoryRepository');
const productRepository = require('../../repositories/productRepository');
const saleRepository = require('../../repositories/saleRepository');
const returnRepository = require('../../repositories/returnRepository');
const creditRepository = require('../../repositories/creditRepository');
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

/** A product with stock, at a known price and cost. */
function stocked({ retail = 6250, cost = 4800, qtyMilli = 1000000, category = null, batchTracked = false } = {}) {
  seq += 1;
  const product = productService.create({
    sku: `RET-${String(seq).padStart(3, '0')}`,
    name: `Return Test Line ${seq}`,
    categoryId: (category || ref.category).id,
    baseUnitId: ref.kg.id,
    taxClass: 'VATABLE',
    retailPriceCentavos: retail,
    isBatchTracked: batchTracked,
  }, sessions.OWNER);

  // INV-201, from TASK-029: a batch-tracked product's stock arrives in a batch, so the
  // fixture that gives it stock has to be a delivery rather than a bare RECEIPT.
  if (batchTracked) {
    temp.seedBatch({
      product, supplier: ref.supplier, qtyMilli, unitCostCentavos: cost,
      batchNo: `RET-B-${seq}`, actor: sessions.OWNER,
    });
  } else {
    inventoryService.postStandalone({
      productId: product.id, type: 'RECEIPT', qtyMilli, unitCostCentavos: cost, actor: sessions.OWNER,
    });
  }
  return productRepository.findById(product.id);
}

function creditCustomer({ limit = 50000000, terms = 15 } = {}) {
  seq += 1;
  const customer = customerService.create({
    name: `Return Farm ${seq}`, customerType: 'FARM', priceLevel: 'RETAIL',
    isCreditEligible: true, creditLimitCentavos: limit, termsDays: terms,
  }, sessions.OWNER);
  return { customer, account: creditService.accountFor(customer.id) };
}

/**
 * What a cart comes to, asked of the engine that will charge it.
 *
 * A credit tender may not over-tender (POS-203), so a test that guessed the total
 * would be testing its own arithmetic against the tax engine's rather than the rule
 * it named.
 */
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

/** A completed credit sale of one line, tendered to the centavo. */
function creditSale({ product, qtyMilli, customer }) {
  return saleService.complete({
    lines: [{ productId: product.id, qtyMilli }],
    customerId: customer.id,
    tenders: [{ method: 'CREDIT', amountCentavos: totalOf({ product, qtyMilli, customer }) }],
  }, sessions.CASHIER);
}

/** A completed cash sale of one line, which is the starting point of most of these. */
function cashSale({ product, qtyMilli = 10000, actor = null }) {
  const priced = saleService.complete({
    lines: [{ productId: product.id, qtyMilli }],
    tenders: [{ method: 'CASH', amountCentavos: 100000000 }],
  }, actor || sessions.CASHIER);
  return priced;
}

const onHand = (productId) => inventoryRepository.qtyOnHand(productId);

test.before(async () => {
  temp.openEmpty('returns');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;
  temp.seedStore({ taxMode: 'VAT', withOwner: false });
  ref = temp.seedCatalog();

  for (const role of ['OWNER', 'MANAGER', 'CASHIER', 'INVENTORY']) {
    const username = role.toLowerCase();
    temp.seedUser({ username, role, password: PASSWORD });
    const signedIn = authService.login({ username, password: PASSWORD });
    tokens[role] = signedIn.token;
    sessions[role] = authService.verifyToken(signedIn.token);
  }

  // After the users exist: INV-202 makes a supplier part of a batch's identity, and
  // suppliers.created_by is NOT NULL.
  ref.supplier = temp.seedSupplier({}, sessions.OWNER);

  cashierShift = shiftService.open({
    actor: sessions.CASHIER, openingFloatCentavos: 500000, confirmed: true,
  }).shift;
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── TC-INT-81 — POS-301 ─────────────────────────────────────────────────────

test('TC-INT-81: POS-301 — a line returns partially, repeatedly, and never beyond what was sold', () => {
  const product = stocked();
  const sale = cashSale({ product, qtyMilli: 10000 });          // 10 KG
  const item = saleRepository.itemsFor(sale.sale.id)[0];

  // Three partial returns of the same line. The limit is cumulative, so a rule checked
  // only against this return's quantity passes all three and then keeps going.
  const first = returnService.post({
    saleId: sale.sale.id,
    reason: 'Wrong item sold',
    lines: [{ saleItemId: item.id, qtyMilli: 4000 }],
  }, sessions.CASHIER);
  assert.equal(first.sale_return.total_centavos > 0, true);
  assert.equal(first.sale_status, 'PARTIALLY_RETURNED');

  returnService.post({
    saleId: sale.sale.id,
    reason: 'Wrong item sold',
    lines: [{ saleItemId: item.id, qtyMilli: 4000 }],
  }, sessions.CASHIER);

  // 8 KG back, 2 KG left. Nine is refused, and the refusal quotes the figure the
  // counter can act on rather than saying "too many".
  assert.throws(
    () => returnService.post({
      saleId: sale.sale.id,
      reason: 'Wrong item sold',
      lines: [{ saleItemId: item.id, qtyMilli: 9000 }],
    }, sessions.CASHIER),
    (err) => err.ruleId === 'POS-301' && err.status === 409 && /2 KG is left/.test(err.message)
  );

  // POS-301's stored counter and the sum of the return lines agree. The limit above is
  // checked against the sum; every screen reads the counter; a materialised figure
  // nobody reconciles is a figure that drifts.
  const after = saleRepository.findItem(item.id);
  assert.equal(after.returned_qty_milli, 8000);
  assert.equal(returnRepository.returnedQtyFor(item.id), 8000);

  // The last 2 KG closes the sale out. POS-107: the status moved, and nothing else on
  // the sale did.
  const last = returnService.post({
    saleId: sale.sale.id,
    reason: 'Wrong item sold',
    lines: [{ saleItemId: item.id, qtyMilli: 2000 }],
  }, sessions.CASHIER);
  assert.equal(last.sale_status, 'RETURNED');
  assert.equal(saleRepository.findById(sale.sale.id).total_centavos, sale.sale.total_centavos);

  // And a fully returned sale has nothing left to give back.
  assert.throws(
    () => returnService.post({
      saleId: sale.sale.id,
      reason: 'Wrong item sold',
      lines: [{ saleItemId: item.id, qtyMilli: 1000 }],
    }, sessions.CASHIER),
    (err) => err.ruleId === 'POS-301' && /returned in full/.test(err.message)
  );
});

test('POS-301: the three refunds of one line sum to exactly what the line charged', () => {
  // A quantity and a price whose thirds do not divide: 1 KG at ₱62.50 returned in
  // three parts is 3 × ₱20.8333…, and three roundings of that is not ₱62.50.
  const product = stocked({ retail: 6250 });
  const sale = cashSale({ product, qtyMilli: 1000 });
  const item = saleRepository.itemsFor(sale.sale.id)[0];

  let refunded = 0;
  for (const qty of [333, 333, 334]) {
    const posted = returnService.post({
      saleId: sale.sale.id,
      reason: 'Wrong item bought',
      lines: [{ saleItemId: item.id, qtyMilli: qty }],
    }, sessions.CASHIER);
    refunded += posted.sale_return.total_centavos;
  }

  // MON-003's reasoning applied to a reversal: the portion that finishes the line
  // takes the remainder, so what was refunded is what was charged, to the centavo.
  assert.equal(refunded, item.line_total_centavos);
});

test('POS-302: a return needs a reason from the configured list, and free text is not one', () => {
  const product = stocked();
  const sale = cashSale({ product, qtyMilli: 1000 });
  const item = saleRepository.itemsFor(sale.sale.id)[0];

  const lines = [{ saleItemId: item.id, qtyMilli: 1000 }];

  assert.throws(
    () => returnService.post({ saleId: sale.sale.id, reason: null, lines }, sessions.CASHIER),
    (err) => err.ruleId === 'POS-302' && err.status === 400
  );
  assert.throws(
    () => returnService.post({ saleId: sale.sale.id, reason: 'because', lines }, sessions.CASHIER),
    (err) => err.ruleId === 'POS-302' && /notes/.test(err.message)
  );

  // Free text alongside, never instead.
  const posted = returnService.post({
    saleId: sale.sale.id, reason: 'expired stock', notes: 'Best before was last March.', lines,
  }, sessions.CASHIER);
  // The listed spelling is stored, not the caller's, so the report groups.
  assert.equal(posted.sale_return.reason, 'Expired stock');
  assert.equal(posted.sale_return.notes, 'Best before was last March.');
});

// ── TC-INT-82 — POS-304 ─────────────────────────────────────────────────────

test('TC-INT-82: POS-304 — a batch-tracked product defaults to write-off, and restocking it needs a manager', () => {
  const medicine = stocked({ batchTracked: true });
  const sale = cashSale({ product: medicine, qtyMilli: 2000 });
  const item = saleRepository.itemsFor(sale.sale.id)[0];

  // The screen is told the default and **why**, before anybody chooses.
  const returnable = returnService.returnableFor(sale.sale.id);
  assert.equal(returnable.lines[0].default_disposition, 'WRITE_OFF');
  assert.match(returnable.lines[0].default_reason, /batch-tracked/);
  assert.match(returnable.lines[0].default_reason, /POS-304/);

  // A cashier restocking it against the default is refused, naming the role.
  assert.throws(
    () => returnService.post({
      saleId: sale.sale.id,
      reason: 'Customer changed their mind',
      lines: [{ saleItemId: item.id, qtyMilli: 1000, disposition: 'RESTOCK' }],
    }, sessions.CASHIER),
    (err) => err.ruleId === 'POS-304' && err.status === 403 && err.requiresRole === 'MANAGER or OWNER'
  );

  // With a manager authorising, it goes back on the shelf — and the trail says so.
  const before = onHand(medicine.id);
  const posted = returnService.post({
    saleId: sale.sale.id,
    reason: 'Customer changed their mind',
    approver: { username: 'manager' },
    approvalReason: 'Sealed, never left the counter.',
    lines: [{ saleItemId: item.id, qtyMilli: 1000, disposition: 'RESTOCK' }],
  }, sessions.CASHIER);

  assert.equal(onHand(medicine.id), before + 1000);
  assert.equal(posted.lines[0].restocked_against_default, true);
  assert.equal(posted.authorisation.authorised_by, 'manager');

  // AUD-603's own row: the exception, the two actors, and the reason.
  const overrides = auditService.browse({ action: 'OVERRIDE_RESTOCK_AGAINST_DEFAULT' });
  const row = overrides.rows.find((e) => e.entity_id === posted.sale_return.id);
  assert.ok(row, 'restocking against POS-304 writes its own override row');
  assert.equal(row.approver.username, 'manager');
  assert.equal(row.actor.username, 'cashier');

  // The default is unchanged by having been overridden once: the pair of columns is
  // what makes the exception legible, and one of them must not follow the other.
  const stored = returnRepository.itemsFor(posted.sale_return.id)[0];
  assert.equal(stored.default_disposition, 'WRITE_OFF');
  assert.equal(stored.disposition, 'RESTOCK');
});

test('POS-304: a configured medicine category defaults to write-off, and an ordinary line does not', () => {
  // "any batch-tracked product" is a column; "veterinary medicines and vaccines" is
  // the store's own category list, which is why it is a setting (OPS-005).
  const vet = stocked({ category: ref.otherCategory });
  settingsService.set('return_write_off_categories', ['Veterinary'], sessions.OWNER);

  const sale = cashSale({ product: vet, qtyMilli: 1000 });
  const returnable = returnService.returnableFor(sale.sale.id);
  assert.equal(returnable.lines[0].default_disposition, 'WRITE_OFF');
  assert.match(returnable.lines[0].default_reason, /Veterinary/);

  const feed = stocked();
  const feedSale = cashSale({ product: feed, qtyMilli: 1000 });
  assert.equal(returnService.returnableFor(feedSale.sale.id).lines[0].default_disposition, 'RESTOCK');
});

// ── TC-INT-83 — POS-305, POS-306 ────────────────────────────────────────────

test('TC-INT-83: POS-305 and POS-306 — credit first, and no cash out while a balance stands', () => {
  const product = stocked({ retail: 100000 });                  // ₱1,000.00 per KG
  const { customer, account } = creditCustomer();

  // Two credit sales, so a balance still stands after the first is returned. That is
  // the only shape in which POS-306's refusal is reachable, and it is the shape the
  // rule was written for.
  const first = creditSale({ product, qtyMilli: 2000, customer });
  creditSale({ product, qtyMilli: 2000, customer });

  const owedBefore = creditRepository.findAccountByCustomer(customer.id).balance_centavos;
  assert.equal(owedBefore, first.sale.total_centavos * 2);

  const before = shiftService.computeExpected(cashierShift.id);
  const refundsBefore = before.cash_refunds_centavos;
  const expectedCashBefore = before.expected_cash_centavos;

  const item = saleRepository.itemsFor(first.sale.id)[0];
  const posted = returnService.post({
    saleId: first.sale.id,
    reason: 'Wrong item sold',
    lines: [{ saleItemId: item.id, qtyMilli: 2000 }],
  }, sessions.CASHIER);

  // POS-305: the whole refund came off the balance, because credit comes first.
  assert.equal(posted.sale_return.refund.credit_centavos, posted.sale_return.total_centavos);
  // POS-306: not a centavo of cash, because the second sale is still outstanding.
  assert.equal(posted.sale_return.refund.cash_centavos, 0);

  // CR-103: the balance moved by exactly the refund, through a ledger row.
  const owedAfter = creditRepository.findAccountByCustomer(customer.id).balance_centavos;
  assert.equal(owedAfter, owedBefore - posted.sale_return.total_centavos);
  assert.ok(posted.sale_return.credit_txn_id, 'POS-306 writes a credit transaction');

  // POS-509: no cash left the drawer, so this return moved the expected figure by
  // nothing. Asserted as a delta, because the shift's refund total is cumulative and
  // other cases in this file have already refunded cash on it.
  assert.equal(posted.expected.cash_refunds_centavos, refundsBefore);
  assert.equal(posted.expected.expected_cash_centavos, expectedCashBefore);
});

test('POS-305: a cash sale refunds cash, and POS-509 takes it off the expected drawer', () => {
  const product = stocked({ retail: 50000 });
  const sale = cashSale({ product, qtyMilli: 2000 });
  const item = saleRepository.itemsFor(sale.sale.id)[0];

  const expectedBefore = shiftService.computeExpected(cashierShift.id).expected_cash_centavos;

  const posted = returnService.post({
    saleId: sale.sale.id,
    reason: 'Wrong item bought',
    lines: [{ saleItemId: item.id, qtyMilli: 2000 }],
  }, sessions.CASHIER);

  assert.equal(posted.sale_return.refund.cash_centavos, posted.sale_return.total_centavos);
  assert.equal(posted.sale_return.refund.credit_centavos, 0);
  assert.equal(posted.sale_return.credit_txn_id, null);

  // POS-509's sixth term, and it is subtracted once rather than twice — the return
  // records the refund and writes no till movement of its own.
  const expectedAfter = shiftService.computeExpected(cashierShift.id).expected_cash_centavos;
  assert.equal(expectedAfter, expectedBefore - posted.sale_return.total_centavos);

  // POS-507: the drawer opened for the cash, outside the transaction.
  assert.equal(posted.drawer.reason, 'CASH_REFUND');
});

test('CR-108: a credit-sale refund beyond what is owed becomes store credit, not cash', () => {
  const product = stocked({ retail: 100000 });
  const { customer } = creditCustomer();

  // A credit sale, then a payment against it. The refund is bigger than what is left
  // owing, which is the shape CR-108 describes: the excess is store credit, and it is
  // reached through the same ledger row that reduced the balance.
  const sale = creditSale({ product, qtyMilli: 4000, customer });
  const owedBefore = creditRepository.findAccountByCustomer(customer.id).balance_centavos;

  collectionService.record({
    customerId: customer.id,
    amountCentavos: Math.round(owedBefore * 0.6),
    method: 'CASH',
  }, sessions.CASHIER);

  const owing = creditRepository.findAccountByCustomer(customer.id).balance_centavos;
  const item = saleRepository.itemsFor(sale.sale.id)[0];

  const posted = returnService.post({
    saleId: sale.sale.id,
    reason: 'Duplicate purchase',
    lines: [{ saleItemId: item.id, qtyMilli: 4000 }],
  }, sessions.CASHIER);

  // POS-305's "same means": the whole refund goes back onto the account, because that
  // is what the sale put there. Not a centavo of it is cash — the customer never
  // handed the store cash for these goods.
  assert.equal(posted.sale_return.refund.cash_centavos, 0);
  assert.equal(posted.sale_return.refund.credit_centavos, owing, 'what was still owed');
  assert.equal(
    posted.sale_return.refund.store_credit_centavos,
    posted.sale_return.total_centavos - owing,
    'and the rest goes past zero (CR-108)'
  );

  // CR-108: store credit is a negative outstanding balance, through one RETURN_CREDIT
  // row rather than two mechanisms that have to agree.
  const after = creditRepository.findAccountByCustomer(customer.id).balance_centavos;
  assert.equal(after, owing - posted.sale_return.total_centavos);
  assert.ok(after < 0, 'the refund exceeded what was owed, so the account is in credit');
  assert.equal(posted.store_credit_centavos, -after);
});

test('POS-305: a cash sale is refunded in cash even where the customer owes on another sale', () => {
  // POS-306 is scoped to a return **against a credit sale**. Reading it wider would
  // mean confiscating a cash refund to settle an unrelated debt, which is not a thing
  // a shop may do — and POS-305 says the refund follows the original tender.
  const product = stocked({ retail: 100000 });
  const { customer } = creditCustomer();

  creditSale({ product, qtyMilli: 1000, customer });
  const owed = creditRepository.findAccountByCustomer(customer.id).balance_centavos;
  assert.ok(owed > 0);

  const cash = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 3000 }],
    customerId: customer.id,
    tenders: [{ method: 'CASH', amountCentavos: 500000 }],
  }, sessions.CASHIER);
  const item = saleRepository.itemsFor(cash.sale.id)[0];

  const posted = returnService.post({
    saleId: cash.sale.id,
    reason: 'Duplicate purchase',
    lines: [{ saleItemId: item.id, qtyMilli: 3000 }],
  }, sessions.CASHIER);

  assert.equal(posted.sale_return.refund.cash_centavos, posted.sale_return.total_centavos);
  assert.equal(posted.sale_return.refund.credit_centavos, 0);
  assert.equal(posted.sale_return.credit_txn_id, null, 'nothing touched their account');

  // And what they owe is exactly what it was: a return is not a collection.
  assert.equal(creditRepository.findAccountByCustomer(customer.id).balance_centavos, owed);
});

// ── TC-INT-84 — POS-303 ─────────────────────────────────────────────────────

test('TC-INT-84: POS-303 — a write-off posts both movements and nets to zero', () => {
  const product = stocked();
  const sale = cashSale({ product, qtyMilli: 5000 });
  const item = saleRepository.itemsFor(sale.sale.id)[0];

  const before = onHand(product.id);
  const posted = returnService.post({
    saleId: sale.sale.id,
    reason: 'Damaged on arrival',
    lines: [{ saleItemId: item.id, qtyMilli: 5000, disposition: 'WRITE_OFF' }],
  }, sessions.CASHIER);

  // The net effect is nothing — which is also what posting no movement at all would
  // look like. INV-102 is the difference, and it is the two rows that carry it.
  assert.equal(onHand(product.id), before);

  const line = posted.lines[0];
  assert.ok(line.return_movement_id, 'POS-303: the goods came back');
  assert.ok(line.write_off_movement_id, 'POS-303: and they are not saleable');
  assert.equal(line.net_stock_milli, 0);

  const ledger = inventoryService.ledger(product.id, { limit: 10 }).movements;
  const forReturn = ledger.filter((m) => m.reference && m.reference.no === posted.sale_return.return_no);
  assert.equal(forReturn.length, 2, 'INV-103: two movements, of the two declared types');
  assert.deepEqual(
    forReturn.map((m) => m.type).sort(),
    ['CUSTOMER_RETURN', 'DAMAGE'],
    'POS-303 names both, and neither substitutes for the other'
  );
  // INV-103: both carry the reason, because both types require one.
  for (const movement of forReturn) assert.ok(movement.reason, 'a movement of either type needs a reason');
});

test('POS-303: a restock posts one movement and increases stock', () => {
  const product = stocked();
  const sale = cashSale({ product, qtyMilli: 5000 });
  const item = saleRepository.itemsFor(sale.sale.id)[0];

  const before = onHand(product.id);
  const posted = returnService.post({
    saleId: sale.sale.id,
    reason: 'Wrong item sold',
    lines: [{ saleItemId: item.id, qtyMilli: 5000, disposition: 'RESTOCK' }],
  }, sessions.CASHIER);

  assert.equal(onHand(product.id), before + 5000);
  assert.equal(posted.lines[0].write_off_movement_id, null);
  assert.equal(posted.lines[0].net_stock_milli, 5000);
});

// ── POS-307 — the window ────────────────────────────────────────────────────

/**
 * Ten days after a sale, in UTC.
 *
 * The window is measured in whole Manila days, so a late return is produced by moving
 * the *return* rather than the setting: a window of zero days would make a same-day
 * return exactly on the boundary and never past it, which is the one case POS-307 does
 * not describe.
 */
const daysAfter = (iso, days) => new Date(Date.parse(iso) + days * 86400000).toISOString();

test('POS-307: a return beyond the window is refused without authorisation, and allowed with it', () => {
  const product = stocked();
  const sale = cashSale({ product, qtyMilli: 2000 });
  const item = saleRepository.itemsFor(sale.sale.id)[0];
  const late = daysAfter(sale.sale.occurred_at, 10);

  assert.equal(settingsService.get('return_window_days'), 7);

  assert.throws(
    () => returnService.post({
      saleId: sale.sale.id,
      reason: 'Wrong item sold',
      occurredAt: late,
      lines: [{ saleItemId: item.id, qtyMilli: 1000 }],
    }, sessions.CASHIER),
    (err) => err.ruleId === 'POS-307' && err.status === 403 && /late return/.test(err.message)
  );

  const posted = returnService.post({
    saleId: sale.sale.id,
    reason: 'Wrong item sold',
    occurredAt: late,
    approver: { username: 'manager' },
    lines: [{ saleItemId: item.id, qtyMilli: 1000 }],
  }, sessions.CASHIER);

  // Recorded on the row rather than inferred from the dates: the window is a setting,
  // and a report read next year must say whether this return was late *then*.
  assert.equal(posted.sale_return.beyond_window, true);
  assert.ok(posted.sale_return.approval_reason);

  // Within the window, the same return needs nobody.
  const inTime = returnService.post({
    saleId: sale.sale.id,
    reason: 'Wrong item sold',
    lines: [{ saleItemId: item.id, qtyMilli: 1000 }],
  }, sessions.CASHIER);
  assert.equal(inTime.sale_return.beyond_window, false);
  assert.equal(inTime.authorisation.required, false);
});

test('POS-307: a manager at the counter authorises their own late return, and the trail says so', () => {
  const product = stocked();
  const managerShift = shiftService.open({
    actor: sessions.MANAGER, openingFloatCentavos: 100000, confirmed: true,
  }).shift;

  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 100000 }],
  }, sessions.MANAGER);
  const item = saleRepository.itemsFor(sale.sale.id)[0];

  const posted = returnService.post({
    saleId: sale.sale.id,
    reason: 'Wrong item sold',
    occurredAt: daysAfter(sale.sale.occurred_at, 10),
    lines: [{ saleItemId: item.id, qtyMilli: 1000 }],
  }, sessions.MANAGER);

  // "A manager did this himself" and "no authorisation was needed" read identically
  // unless one of them is written down.
  assert.equal(posted.authorisation.required, true);
  assert.equal(posted.authorisation.self_authorised, true);
  assert.equal(posted.authorisation.authorised_by, null);

  // The manager's drawer is closed against its own expected figure, so this file's
  // later cases go back to the cashier's shift and POS-501 stays unambiguous.
  shiftService.close({
    shiftId: managerShift.id,
    actor: sessions.MANAGER,
    actualCashCentavos: shiftService.computeExpected(managerShift.id).expected_cash_centavos,
  });
});

// ── POS-107, and the absences ───────────────────────────────────────────────

test('POS-107: a return never edits the sale, and the repository has no path that could', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'repositories', 'saleRepository.js'), 'utf8'
  );
  // The two narrow setters exist; a general update path does not. The difference
  // between "the sale records that goods came back" and "the sale can be edited" is
  // the whole of POS-107.
  assert.match(source, /function setStatus/);
  assert.match(source, /function setReturnedQty/);
  assert.doesNotMatch(source, /function updateSale|function updateFields|function deleteSale/);

  // And the setter refuses a status POS-107's machine does not allow.
  assert.throws(() => saleRepository.setStatus('whatever', 'COMPLETED'), RangeError);
});

test('POS-301: a voided sale has nothing to return against', () => {
  const product = stocked();
  const sale = cashSale({ product, qtyMilli: 1000 });
  const item = saleRepository.itemsFor(sale.sale.id)[0];

  // A real void (TASK-021). This forced the status by hand while POS-401 was unbuilt;
  // driving the real thing is what makes the refusal below mean "a void already
  // reversed this" rather than "a column says VOIDED".
  require('../../services/voidService').post({
    saleId: sale.sale.id, reason: 'Voided at the counter',
  }, sessions.MANAGER);

  assert.throws(
    () => returnService.post({
      saleId: sale.sale.id, reason: 'Wrong item sold',
      lines: [{ saleItemId: item.id, qtyMilli: 1000 }],
    }, sessions.CASHIER),
    (err) => err.ruleId === 'POS-301' && /voided/.test(err.message)
  );
});

test('POS-301: a line from another sale is not a line on this one', async () => {
  const product = stocked();
  const one = cashSale({ product, qtyMilli: 1000 });
  const two = cashSale({ product, qtyMilli: 1000 });
  const otherItem = saleRepository.itemsFor(two.sale.id)[0];

  assert.throws(
    () => returnService.post({
      saleId: one.sale.id, reason: 'Wrong item sold',
      lines: [{ saleItemId: otherItem.id, qtyMilli: 1000 }],
    }, sessions.CASHIER),
    (err) => err.ruleId === 'POS-301' && /not a line on/.test(err.message)
  );
});

// ── The document, and the API ───────────────────────────────────────────────

test('TAX-006: the refund acknowledgement carries the notice and none of the forbidden phrases', () => {
  const product = stocked();
  const sale = cashSale({ product, qtyMilli: 1000 });
  const item = saleRepository.itemsFor(sale.sale.id)[0];

  const posted = returnService.post({
    saleId: sale.sale.id,
    reason: 'Wrong item sold',
    lines: [{ saleItemId: item.id, qtyMilli: 1000, disposition: 'WRITE_OFF' }],
  }, sessions.CASHIER);

  const text = posted.acknowledgement.text;
  assert.match(text, /This is not an official receipt/);
  assert.match(text, new RegExp(posted.sale_return.return_no));
  assert.match(text, new RegExp(sale.sale.sale_no));
  // POS-303's disposition on the paper: a customer holding a slip that says a bottle
  // was written off cannot later be told it went back on the shelf.
  assert.match(text, /written off/);
  // And documentService would have refused it otherwise — the check is not this test's.
  assert.doesNotThrow(() => documentService.print(posted.acknowledgement));
});

test('SEC-6 / TX-406: an inventory clerk may not process a return, and a cashier may', async () => {
  const product = stocked();
  const sale = cashSale({ product, qtyMilli: 1000 });
  const item = saleRepository.itemsFor(sale.sale.id)[0];

  const refused = await call(`/sales/${sale.sale.id}/returns`, {
    token: tokens.INVENTORY, method: 'POST',
    body: { reason: 'Wrong item sold', lines: [{ saleItemId: item.id, qtyMilli: 1000 }] },
  });
  assert.equal(refused.status, 403);

  const allowed = await call(`/sales/${sale.sale.id}/returns`, {
    token: tokens.CASHIER, method: 'POST',
    body: { reason: 'Wrong item sold', lines: [{ saleItemId: item.id, qtyMilli: 1000 }] },
  });
  assert.equal(allowed.status, 201);
  const body = await allowed.json();
  assert.match(body.sale_return.return_no, /^RET-\d{8}-\d{6}$/);

  // A posted return is immutable, and the refusal names the correction.
  const edited = await call(`/returns/${body.sale_return.id}`, { token: tokens.CASHIER, method: 'PUT' });
  assert.equal(edited.status, 409);
  assert.equal((await edited.json()).error.rule_id, 'INV-102');
});

test('RPT-101: the daily report’s returns term is no longer zero, and both halves reconcile', () => {
  const reportService = require('../../services/reportService');
  const clock = require('../../config/clock');

  const product = stocked({ retail: 25000 });
  const sale = cashSale({ product, qtyMilli: 4000 });
  const item = saleRepository.itemsFor(sale.sale.id)[0];

  const posted = returnService.post({
    saleId: sale.sale.id,
    reason: 'Wrong item sold',
    lines: [{ saleItemId: item.id, qtyMilli: 2000 }],
  }, sessions.CASHIER);

  const daily = reportService.daily({ from: clock.manilaDate(clock.nowUtc()) }, sessions.OWNER);
  assert.ok(daily.totals.returns_centavos >= posted.sale_return.total_centavos);
  assert.ok(daily.totals.return_count >= 1);

  // The identity RPT-101 states, and the one the payments side states, both hold —
  // and they hold *because* the fourth term is now a figure. A report that does not
  // reconcile is a defect, not a rounding artefact.
  assert.equal(daily.reconciliation.balances, true);
  assert.equal(daily.reconciliation.tenders_balance, true);
  assert.equal(daily.reconciliation.reconciles, true);
  assert.match(daily.reconciliation.statement, /returns/);
  assert.match(daily.reconciliation.tender_statement, /refunded/);
});
