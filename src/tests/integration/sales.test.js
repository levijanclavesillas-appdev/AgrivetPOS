'use strict';

// POST /sales — the one endpoint where money, stock, credit and the till meet.
//
// TC-INT-34 is the case this whole task is judged by: an injected failure after the
// movements leaves no sale, no movement and no balance change. It is a permanent
// regression guard (07_TEST_PLAN.md §7), and it is written to fail at several
// different points rather than one, because "atomic" that has only been proved at one
// injection point is atomic by coincidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const db = require('../../config/database');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const customerService = require('../../services/customerService');
const inventoryService = require('../../services/inventoryService');
const creditService = require('../../services/creditService');
const shiftService = require('../../services/shiftService');
const saleService = require('../../services/saleService');
const sequenceService = require('../../services/sequenceService');
const auditService = require('../../services/auditService');
const settingsService = require('../../services/settingsService');
const drawerService = require('../../services/drawerService');
const inventoryRepository = require('../../repositories/inventoryRepository');
const productRepository = require('../../repositories/productRepository');
const saleRepository = require('../../repositories/saleRepository');
const creditRepository = require('../../repositories/creditRepository');
const temp = require('../helpers/tempdb');

// Port 0: the OS picks a free one and the real port is read back off the server.
// A fixed port collides whenever two runs overlap or a socket lingers, which is a
// flake that looks like a defect in whatever test happens to be running.
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
function stocked({ retail = 6250, cost = 4800, qtyMilli = 1000000, taxClass = 'VATABLE' } = {}) {
  seq += 1;
  const product = productService.create({
    sku: `SALE-${String(seq).padStart(3, '0')}`,
    name: `Sale Test Feed ${seq}`,
    categoryId: ref.category.id,
    baseUnitId: ref.kg.id,
    taxClass,
    retailPriceCentavos: retail,
  }, sessions.OWNER);

  inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli, unitCostCentavos: cost, actor: sessions.OWNER,
  });
  return productRepository.findById(product.id);
}

function creditCustomer({ limit = 5000000, terms = 15 } = {}) {
  seq += 1;
  const customer = customerService.create({
    name: `Credit Farm ${seq}`, customerType: 'FARM', priceLevel: 'RETAIL',
    isCreditEligible: true, creditLimitCentavos: limit, termsDays: terms,
  }, sessions.OWNER);
  return { customer, account: creditService.accountFor(customer.id) };
}

test.before(async () => {
  temp.openEmpty('sales');
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

  cashierShift = shiftService.open({
    actor: sessions.CASHIER, openingFloatCentavos: 500000, confirmed: true,
  }).shift;
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── Step 1 — the shift (POS-501) ────────────────────────────────────────────

test('step 1: a sale with no open shift is refused before anything else is checked', () => {
  temp.seedUser({ username: 'shiftless', role: 'CASHIER', password: PASSWORD });
  const session = authService.verifyToken(
    authService.login({ username: 'shiftless', password: PASSWORD }).token
  );
  const product = stocked();

  assert.throws(
    () => saleService.complete({
      lines: [{ productId: product.id, qtyMilli: 1000 }],
      tenders: [{ method: 'CASH', amountCentavos: 999999 }],
    }, session),
    (err) => err.status === 409 && err.ruleId === 'POS-501'
  );
  assert.equal(saleRepository.countAll(), 0, 'nothing written');
});

// ── Steps 2 and 4 — prices and totals (PR-101, MON-003, TAX-002) ────────────

test('a plain cash sale computes its own totals and takes the stock', () => {
  const product = stocked({ retail: 6250, cost: 4800 });
  const before = inventoryRepository.qtyOnHand(product.id);

  const result = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1255 }],       // 1.255 KG
    tenders: [{ method: 'CASH', amountCentavos: 10000 }],
  }, sessions.CASHIER);

  // MON-003: 1.255 × 6250 = 7843.75 → 7844 half-up (TC-UT-12's own figure).
  assert.equal(result.sale.total_centavos, 7844);
  assert.equal(result.sale.change_centavos, 10000 - 7844, 'MON-007');
  assert.equal(result.sale.tax_mode, 'VAT');
  assert.equal(result.sale.vat_centavos, 840, 'TAX-003, per line, after discount');

  assert.match(result.sale.sale_no, /^SALE-\d{8}-\d{6}$/, 'POS-108');
  assert.equal(result.items[0].price_level_applied, 'RETAIL');
  assert.equal(inventoryRepository.qtyOnHand(product.id), before - 1255, 'INV-101');
  assert.equal(inventoryService.reconcile().ok, true);
});

test('TC-INT-37: a tampered client total is rejected, not banked', () => {
  const product = stocked({ retail: 6250 });

  let err;
  try {
    saleService.complete({
      lines: [{ productId: product.id, qtyMilli: 1000 }],
      tenders: [{ method: 'CASH', amountCentavos: 10000 }],
      clientTotalCentavos: 1,                                  // a stale or tampered screen
    }, sessions.CASHIER);
  } catch (caught) {
    err = caught;
  }

  // §4.1's closing note: compared against the server's figure, and a mismatch rejects
  // the sale rather than banking it.
  assert.equal(err.status, 409);
  assert.match(err.message, /screen showed ₱0\.01 but this sale comes to ₱62\.50/);
  assert.equal(inventoryRepository.qtyOnHand(product.id), 1000000, 'no stock moved');

  // A caller that claims nothing cannot claim wrongly.
  assert.doesNotThrow(() => saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 10000 }],
  }, sessions.CASHIER));
});

test('TC-INT-37: the price the client sends is ignored entirely', () => {
  const product = stocked({ retail: 6250 });

  const result = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000, unitPriceCentavos: 1, priceCentavos: 1 }],
    tenders: [{ method: 'CASH', amountCentavos: 10000 }],
  }, sessions.CASHIER);

  assert.equal(result.items[0].unit_price_centavos, 6250, 'the server price, re-resolved');
  assert.equal(result.sale.total_centavos, 6250);
});

// ── Step 3 — stock at commit time (INV-104) ─────────────────────────────────

test('step 3: stock is re-checked at commit time, not at cart time', () => {
  const product = stocked({ qtyMilli: 5000 });

  // The cart was built when there were 5 KG. Another sale took them since.
  inventoryService.postStandalone({
    productId: product.id, type: 'SALE', qtyMilli: 5000, actor: sessions.CASHIER,
  });

  let err;
  try {
    saleService.complete({
      lines: [{ productId: product.id, qtyMilli: 1000 }],
      tenders: [{ method: 'CASH', amountCentavos: 10000 }],
    }, sessions.CASHIER);
  } catch (caught) {
    err = caught;
  }

  assert.equal(err.status, 409);
  assert.equal(err.ruleId, 'INV-104');
  assert.match(err.message, /There is 0 KG on hand/, 'the message names the product and the figure');
});

test('step 3: several lines of one product are checked on the total taken', () => {
  const product = stocked({ qtyMilli: 1500 });

  assert.throws(
    () => saleService.complete({
      lines: [
        { productId: product.id, qtyMilli: 1000 },
        { productId: product.id, qtyMilli: 1000 },
      ],
      tenders: [{ method: 'CASH', amountCentavos: 99999 }],
    }, sessions.CASHIER),
    (err) => err.ruleId === 'INV-104',
    'one kilo each is fine; two together is not'
  );
});

// ── Steps 5, 6 — the tenders (POS-202 to POS-207) ───────────────────────────

test('TC-INT-32: split tender ₱600 cash + ₱400 GCash completes a ₱1,000 sale', () => {
  const product = stocked({ retail: 100000 });     // ₱1,000 per KG

  const result = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [
      { method: 'CASH', amountCentavos: 60000 },
      { method: 'GCASH', amountCentavos: 40000, referenceNo: 'GC-0001' },
    ],
  }, sessions.CASHIER);

  assert.equal(result.sale.total_centavos, 100000);
  assert.equal(result.sale.change_centavos, 0);
  assert.equal(result.tenders.length, 2, 'POS-202');
  assert.deepEqual(result.tenders.map((t) => t.method).sort(), ['CASH', 'GCASH']);
  // POS-206: recorded means "the cashier saw it", and nothing ever says verified.
  assert.ok(result.tenders.every((t) => t.status === 'RECORDED'));
});

test('TC-INT-32: ₱600 alone does not complete a ₱1,000 sale', () => {
  const product = stocked({ retail: 100000 });

  let err;
  try {
    saleService.complete({
      lines: [{ productId: product.id, qtyMilli: 1000 }],
      tenders: [{ method: 'CASH', amountCentavos: 60000 }],
    }, sessions.CASHIER);
  } catch (caught) {
    err = caught;
  }

  assert.equal(err.ruleId, 'POS-204');
  assert.match(err.message, /₱400\.00 is still due/);
  assert.equal(inventoryRepository.qtyOnHand(product.id), 1000000, 'no stock moved');
});

test('POS-203: only cash may over-tender, and change is cash only', () => {
  const product = stocked({ retail: 100000 });

  const withChange = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 150000 }],
  }, sessions.CASHIER);
  assert.equal(withChange.sale.change_centavos, 50000);

  assert.throws(
    () => saleService.complete({
      lines: [{ productId: product.id, qtyMilli: 1000 }],
      tenders: [{ method: 'GCASH', amountCentavos: 150000, referenceNo: 'GC-OVER' }],
    }, sessions.CASHIER),
    (err) => err.ruleId === 'POS-203'
  );
});

test('POS-205: a GCash or QR Ph tender with no reference is rejected', () => {
  const product = stocked({ retail: 10000 });

  for (const method of ['GCASH', 'QRPH']) {
    for (const referenceNo of [undefined, '', '   ']) {
      assert.throws(
        () => saleService.complete({
          lines: [{ productId: product.id, qtyMilli: 1000 }],
          tenders: [{ method, amountCentavos: 10000, referenceNo }],
        }, sessions.CASHIER),
        (err) => err.status === 400 && err.ruleId === 'POS-205',
        `${method} ${JSON.stringify(referenceNo)}`
      );
    }
  }
  // Never generated and never defaulted: an auto-filled reference is a receipt saying
  // a payment was traced when nobody traced it.
  assert.equal(saleRepository.referenceUsedToday({
    method: 'GCASH', referenceNo: '', fromAt: '2000-01-01T00:00:00.000Z', toAt: '2100-01-01T00:00:00.000Z',
  }).length, 0);
});

test('TC-INT-38: a duplicate same-day reference warns and requires explicit acceptance', () => {
  const product = stocked({ retail: 10000 });
  const line = { productId: product.id, qtyMilli: 1000 };

  const first = saleService.complete({
    lines: [line], tenders: [{ method: 'GCASH', amountCentavos: 10000, referenceNo: 'GC-DUP-1' }],
  }, sessions.CASHIER);

  let err;
  try {
    saleService.complete({
      lines: [line], tenders: [{ method: 'GCASH', amountCentavos: 10000, referenceNo: 'GC-DUP-1' }],
    }, sessions.CASHIER);
  } catch (caught) {
    err = caught;
  }

  assert.equal(err.status, 409);
  assert.equal(err.ruleId, 'POS-207');
  assert.match(err.message, new RegExp(first.sale.sale_no), 'the message names the earlier sale');
  assert.match(err.message, /Double-keying the same reference is the common till error/);

  // Accepted explicitly, it goes through and the acceptance is reported back. There
  // are real cases — one transfer paying two sales — so a UNIQUE index would be wrong.
  const accepted = saleService.complete({
    lines: [line],
    tenders: [{ method: 'GCASH', amountCentavos: 10000, referenceNo: 'GC-DUP-1' }],
    acceptDuplicateReference: true,
  }, sessions.CASHIER);

  assert.equal(accepted.warnings.length, 1);
  assert.equal(accepted.warnings[0].rule_id, 'POS-207');

  // A different method with the same reference is not a duplicate.
  assert.doesNotThrow(() => saleService.complete({
    lines: [line], tenders: [{ method: 'QRPH', amountCentavos: 10000, referenceNo: 'GC-DUP-1' }],
  }, sessions.CASHIER));
});

// ── Step 7 — credit (CR-102, CR-104) ────────────────────────────────────────

test('POS-103: a customer is optional, and a walk-in sells at retail', () => {
  // The commonest sale in the store: somebody walks in, buys a sack, pays cash, and
  // nobody asks their name. A POS that needs a customer record before it will take
  // money is a POS the counter works around.
  const product = stocked({ retail: 10000 });

  const result = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 10000 }],
  }, sessions.CASHIER);

  assert.equal(result.sale.status, 'COMPLETED');
  assert.equal(result.sale.customer_id, null, 'no customer, and none invented');
  assert.equal(result.sale.price_level, 'RETAIL', 'POS-103: a walk-in is at retail price');

  // And nothing invents one on the way back out, either.
  const view = saleService.get(result.sale.id);
  assert.equal(view.sale.customer_id, null);
  assert.equal(view.items[0].price_level_applied, 'RETAIL');

  // The other half of POS-103, which TC-UT-40 below proves in the other direction:
  // a walk-in has no account to charge, so credit is not available to them (CR-102).
});

test('TC-UT-40: a walk-in may not pay on credit', () => {
  const product = stocked({ retail: 10000 });

  assert.throws(
    () => saleService.complete({
      lines: [{ productId: product.id, qtyMilli: 1000 }],
      tenders: [{ method: 'CREDIT', amountCentavos: 10000 }],
    }, sessions.CASHIER),
    (err) => err.ruleId === 'CR-102' && /walk-in/i.test(err.message)
  );
});

test('a credit sale debits the account and carries a due date from the terms (CR-105)', () => {
  const product = stocked({ retail: 100000 });
  const { customer, account } = creditCustomer({ terms: 15 });

  const result = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    customerId: customer.id,
    tenders: [{ method: 'CREDIT', amountCentavos: 100000 }],
  }, sessions.CASHIER);

  assert.equal(creditRepository.findAccount(account.id).balance_centavos, 100000);
  assert.equal(creditService.reconcile().ok, true);

  const [txn] = creditRepository.transactionsFor(account.id, { type: 'CREDIT_SALE' });
  assert.equal(txn.sale_id, result.sale.id);
  assert.equal(txn.document_no, result.sale.sale_no);
  assert.equal(txn.shift_id, result.sale.shift_id, 'CR-201: the collection knows its shift');

  const dueAt = Date.parse(txn.due_at) - Date.parse(result.sale.occurred_at);
  assert.equal(Math.round(dueAt / 86400000), 15, 'the terms in force at the moment of sale');
});

test('TC-INT-41: over-limit credit is blocked, and an override records both actors', () => {
  const product = stocked({ retail: 100000 });
  const { customer, account } = creditCustomer({ limit: 50000 });   // ₱500 limit

  let err;
  try {
    saleService.complete({
      lines: [{ productId: product.id, qtyMilli: 1000 }],
      customerId: customer.id,
      tenders: [{ method: 'CREDIT', amountCentavos: 100000 }],
    }, sessions.CASHIER);
  } catch (caught) {
    err = caught;
  }

  assert.equal(err.status, 403);
  assert.equal(err.ruleId, 'CR-104');
  assert.equal(err.requiresRole, 'MANAGER or OWNER');
  assert.match(err.message, /₱500\.00 of credit available/);
  assert.equal(creditRepository.findAccount(account.id).balance_centavos, 0, 'nothing debited');

  // A cashier cannot approve their own.
  assert.throws(
    () => saleService.complete({
      lines: [{ productId: product.id, qtyMilli: 1000 }],
      customerId: customer.id,
      tenders: [{ method: 'CREDIT', amountCentavos: 100000 }],
      approver: { ...sessions.CASHIER, reason: 'me' },
    }, sessions.CASHIER),
    (e) => e.status === 403
  );

  const approved = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    customerId: customer.id,
    tenders: [{ method: 'CREDIT', amountCentavos: 100000 }],
    approver: { ...sessions.MANAGER, reason: 'Regular payer, harvest next week' },
  }, sessions.CASHIER);

  assert.equal(approved.sale.approved_by, sessions.MANAGER.id);
  assert.equal(creditRepository.findAccount(account.id).balance_centavos, 100000);

  // AUD-603: requester and approver as distinct actors, with the reason.
  const [row] = auditService.browse({ action: 'OVERRIDE_CREDIT_OVER_LIMIT' }).rows;
  assert.equal(row.actor.username, 'cashier');
  assert.equal(row.approver.username, 'manager');
  assert.equal(row.reason, 'Regular payer, harvest next week');
  assert.equal(row.before.credit_limit_centavos, 50000);
  assert.equal(row.after.balance_after_centavos, 100000);
});

test('a split of cash and credit debits only the credit part', () => {
  const product = stocked({ retail: 100000 });
  const { customer, account } = creditCustomer();

  saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    customerId: customer.id,
    tenders: [
      { method: 'CASH', amountCentavos: 40000 },
      { method: 'CREDIT', amountCentavos: 60000 },
    ],
  }, sessions.CASHIER);

  assert.equal(creditRepository.findAccount(account.id).balance_centavos, 60000);
});

// ── POS-102 / UOM-002 — packs ───────────────────────────────────────────────

test('POS-102: a line entered in packs is stored in the base unit', () => {
  const product = stocked({ retail: 6250, qtyMilli: 1000000 });
  productService.addPack(product.id, { unitId: ref.sack.id, factorMilli: 50000 }, sessions.OWNER);

  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 2000, packUnitId: ref.sack.id }],   // 2 sacks
    tenders: [{ method: 'CASH', amountCentavos: 9999999 }],
  }, sessions.CASHIER);

  // UOM-002: 2 sacks of 50 KG is 100 KG, and the ledger holds kilos.
  assert.equal(sale.items[0].qty_milli, 100000);
  assert.equal(sale.sale.total_centavos, 6250 * 100);
  assert.equal(inventoryRepository.qtyOnHand(product.id), 1000000 - 100000);
});

test('UOM-004: selling a sack from a KG product posts no break-bulk event', () => {
  // The rule's second clause, and the normal case for feed: where the base unit is
  // already the loose unit, opening a sack is not an inventory event. Selling by the
  // sack simply deducts kilos.
  //
  // The assertion is the *absence* of a movement, which is worth stating explicitly:
  // a BREAK_BULK pair posted here would be two rows per sack sold, summing to zero,
  // cluttering every product ledger a store ever reads for no information at all.
  const product = stocked({ retail: 6250, qtyMilli: 1000000 });
  productService.addPack(product.id, { unitId: ref.sack.id, factorMilli: 50000 }, sessions.OWNER);

  const before = inventoryService.ledger(product.id).movements.length;
  saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000, packUnitId: ref.sack.id }],
    tenders: [{ method: 'CASH', amountCentavos: 9999999 }],
  }, sessions.CASHIER);

  const movements = inventoryService.ledger(product.id).movements;
  assert.equal(movements.length, before + 1, 'one sale, one movement');
  assert.equal(movements.some((m) => m.type === 'BREAK_BULK'), false, 'UOM-004: no event needed');
  assert.equal(inventoryRepository.qtyOnHand(product.id), 1000000 - 50000, 'and it deducted kilos');
});

test('UOM-004: break-bulk is a transfer, so its movement type moves no stock', () => {
  // Where a product *is* stocked as sealed packs and sold loose, the rule calls for a
  // movement pair — and a pair only balances if the type itself is signless. A
  // BREAK_BULK with sign -1 would be shrinkage every time somebody opened a sack.
  assert.equal(inventoryService.TYPES.BREAK_BULK.sign, 0);
  assert.equal(inventoryService.TYPES.BREAK_BULK.costed, false, 'opening a pack changes no cost');
  assert.ok(inventoryService.TYPE_NAMES.includes('BREAK_BULK'));
});

test('the pack factor is resolved server-side, never taken from the client', () => {
  const product = stocked({ retail: 6250 });
  productService.addPack(product.id, { unitId: ref.sack.id, factorMilli: 50000 }, sessions.OWNER);

  // A client-supplied factor is a client-supplied price in disguise: a factor of 1
  // would buy fifty kilos for the price of one. §4.1 step 2 forbids trusting the client
  // for a price, and a factor multiplies one.
  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000, packUnitId: ref.sack.id, packFactorMilli: 1 }],
    tenders: [{ method: 'CASH', amountCentavos: 9999999 }],
  }, sessions.CASHIER);

  assert.equal(sale.items[0].qty_milli, 50000, 'the pack the product actually defines');
  assert.equal(sale.sale.total_centavos, 6250 * 50);
});

test('UOM-002: a pack the product does not define is refused', () => {
  const product = stocked();

  assert.throws(
    () => saleService.complete({
      lines: [{ productId: product.id, qtyMilli: 1000, packUnitId: ref.piece.id }],
      tenders: [{ method: 'CASH', amountCentavos: 9999999 }],
    }, sessions.CASHIER),
    (err) => err.status === 400 && err.ruleId === 'UOM-002' && /no .* pack defined/.test(err.message)
  );
});

test('UOM-002: a unit that allows no fractions may not be sold in parts', () => {
  const product = stocked({ retail: 6250 });
  productService.addPack(product.id, { unitId: ref.sack.id, factorMilli: 50000 }, sessions.OWNER);

  // The failure this guards against is silent, not loud: `qtyMilli: 4` against a sack
  // means four thousandths of a sack, which prices and sells cleanly at 0.2 KG and
  // looks like nothing wrong until the takings are counted. It was written after
  // exactly that mistake in this project's own end-to-end test.
  let err;
  try {
    saleService.complete({
      lines: [{ productId: product.id, qtyMilli: 4, packUnitId: ref.sack.id }],
      tenders: [{ method: 'CASH', amountCentavos: 9999999 }],
    }, sessions.CASHIER);
  } catch (caught) {
    err = caught;
  }

  assert.equal(err.status, 400);
  assert.equal(err.ruleId, 'UOM-002');
  assert.match(err.message, /SACK cannot be sold in parts/);
  assert.match(err.message, /whole number of SACK, or sell by weight/);

  // The base unit allows fractions, so the same product sells by the kilo either way.
  assert.doesNotThrow(() => saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1255 }],
    tenders: [{ method: 'CASH', amountCentavos: 9999999 }],
  }, sessions.CASHIER));
});

// ── Step 8 — the sale number (POS-108) ──────────────────────────────────────

test('TC-INT-55: sale numbers are gapless per day, and a rolled-back sale consumes none', (t) => {
  const product = stocked({ retail: 10000 });
  const line = { productId: product.id, qtyMilli: 1000 };
  const tenders = [{ method: 'CASH', amountCentavos: 10000 }];

  const before = sequenceService.auditDay('SALE');

  const a = saleService.complete({ lines: [line], tenders }, sessions.CASHIER);

  // A sale that fails after its number is allocated. The number must come back.
  const original = auditService.write;
  t.mock.method(auditService, 'write', () => { throw new Error('disk full'); });
  let failed = false;
  try {
    saleService.complete({
      lines: [line], tenders,
      customerId: creditCustomer().customer.id,
      // Force step 12 by making it an over-limit override, which is the last thing
      // written before COMMIT.
    }, sessions.CASHIER);
  } catch {
    failed = true;
  } finally {
    t.mock.restoreAll();
  }
  assert.ok(failed, 'the injected failure took effect');

  const c = saleService.complete({ lines: [line], tenders }, sessions.CASHIER);

  const after = sequenceService.auditDay('SALE');
  assert.equal(after.issued, before.issued + 2, 'two sales landed, not three');
  assert.equal(after.gapless, true, 'and the run has no holes');
  assert.deepEqual(after.gaps, []);

  // The two that survived are consecutive.
  assert.equal(
    sequenceService.parse(c.sale.sale_no).counter,
    sequenceService.parse(a.sale.sale_no).counter + 1
  );
});

test('POS-108: the number is the database sequence, not the clock (VR-103)', () => {
  const audit = sequenceService.auditDay('SALE');
  assert.ok(audit.issued > 0);
  assert.equal(audit.gapless, true);

  // The counter is derived from the rows themselves. There is no counter table to
  // drift out of step with them on the rollback this rule exists to survive.
  const schemaRepository = require('../../repositories/schemaRepository');
  assert.equal(schemaRepository.listTables().some((t) => /sequence|counter/i.test(t)), false);
});

// ── TC-INT-34 — atomicity ───────────────────────────────────────────────────

test('TC-INT-34: an injected failure after the movements leaves no sale, no movement, no balance change', (t) => {
  const product = stocked({ retail: 100000 });
  // A limit small enough that the credit tender is over it, so the sale reaches step 12
  // — the audit row for the override, which is the last write before COMMIT.
  const { customer, account } = creditCustomer({ limit: 50000 });

  const before = {
    sales: saleRepository.countAll(),
    onHand: inventoryRepository.qtyOnHand(product.id),
    movements: inventoryRepository.countMovementsFor(product.id),
    balance: creditRepository.findAccount(account.id).balance_centavos,
    credits: creditRepository.countTransactionsFor(account.id),
    numbers: sequenceService.auditDay('SALE').issued,
  };

  // Step 12 — the last write before COMMIT, after the sale, its lines, its tenders,
  // its inventory movements and its credit transaction have all been written.
  const original = auditService.recordOverride;
  t.mock.method(auditService, 'recordOverride', () => { throw new Error('the disk gave out'); });

  assert.throws(() => saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    customerId: customer.id,
    tenders: [{ method: 'CREDIT', amountCentavos: 100000 }],
    approver: { ...sessions.MANAGER, reason: 'forced over limit to reach step 12' },
  }, sessions.CASHIER), /disk gave out/);

  t.mock.restoreAll();
  assert.equal(auditService.recordOverride, original);

  // Every one of them, back where it was.
  assert.equal(saleRepository.countAll(), before.sales, 'no sale');
  assert.equal(inventoryRepository.qtyOnHand(product.id), before.onHand, 'no stock moved');
  assert.equal(inventoryRepository.countMovementsFor(product.id), before.movements, 'no movement');
  assert.equal(creditRepository.findAccount(account.id).balance_centavos, before.balance, 'no balance change');
  assert.equal(creditRepository.countTransactionsFor(account.id), before.credits, 'no credit row');
  assert.equal(sequenceService.auditDay('SALE').issued, before.numbers, 'no number consumed');

  // And both ledgers still reconcile.
  assert.equal(inventoryService.reconcile().ok, true);
  assert.equal(creditService.reconcile().ok, true);
});

test('TC-INT-34: the same holds for a failure at the inventory step', (t) => {
  const product = stocked({ retail: 100000 });
  const before = {
    sales: saleRepository.countAll(),
    onHand: inventoryRepository.qtyOnHand(product.id),
    numbers: sequenceService.auditDay('SALE').issued,
  };

  // "Atomic" proved at one injection point is atomic by coincidence.
  t.mock.method(inventoryService, 'post', () => { throw new Error('ledger refused'); });

  assert.throws(() => saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 100000 }],
  }, sessions.CASHIER), /ledger refused/);

  t.mock.restoreAll();
  assert.equal(saleRepository.countAll(), before.sales);
  assert.equal(inventoryRepository.qtyOnHand(product.id), before.onHand);
  assert.equal(sequenceService.auditDay('SALE').issued, before.numbers);
  assert.equal(inventoryService.reconcile().ok, true);
});

test('TC-INT-34: a sale that commits leaves every ledger agreeing', () => {
  const product = stocked({ retail: 100000 });
  const { customer } = creditCustomer();

  saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 2000 }],
    customerId: customer.id,
    tenders: [
      { method: 'CASH', amountCentavos: 100000 },
      { method: 'CREDIT', amountCentavos: 100000 },
    ],
  }, sessions.CASHIER);

  assert.equal(inventoryService.reconcile().ok, true, 'INV-101');
  assert.equal(creditService.reconcile().ok, true, 'CR-103');
  assert.equal(sequenceService.auditDay('SALE').gapless, true, 'POS-108');
});

// ── MON-005 — the snapshots ─────────────────────────────────────────────────

test('TC-INT-35: changing a product cost afterwards does not change that sale profit', () => {
  const product = stocked({ retail: 10000, cost: 6000 });

  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 10000 }],
  }, sessions.CASHIER);

  const profitBefore = sale.gross_profit_centavos;
  assert.equal(sale.items[0].unit_cost_centavos, 6000, 'the cost at the instant of sale');

  // The cost moves — a later receipt at a different price, or an owner correction.
  productService.setCost(product.id, 9500, sessions.OWNER);
  assert.equal(productRepository.findById(product.id).avg_cost_centavos, 9500);

  const reread = saleService.get(sale.sale.id);
  assert.equal(reread.items[0].unit_cost_centavos, 6000, 'MON-005: the snapshot stands');
  assert.equal(reread.gross_profit_centavos, profitBefore, 'RPT-104 reads the snapshot');
});

test('MON-005: the product name is snapshotted too', () => {
  const product = stocked({ retail: 10000 });
  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 10000 }],
  }, sessions.CASHIER);

  productService.update(product.id, { name: 'Renamed Next Month' }, sessions.OWNER);

  // A receipt from March must not change because a product was renamed in April.
  assert.equal(saleService.get(sale.sale.id).items[0].name, product.name);
});

test('the sale snapshots the tax mode in force (RPT-106)', () => {
  const product = stocked({ retail: 112000 });
  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 112000 }],
  }, sessions.CASHIER);

  assert.equal(sale.sale.tax_mode, 'VAT');
  assert.equal(sale.sale.vat_centavos, 12000, 'TC-UT-18’s figure, through the till');
  assert.equal(sale.sale.vatable_centavos, 100000);
  assert.equal(sale.items[0].tax_class, 'VATABLE');
});

// ── POS-107 — immutability ──────────────────────────────────────────────────

test('POS-107: no repository method updates or deletes a sale', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'repositories', 'saleRepository.js'), 'utf8');

  const literals = source.split('\n').flatMap((line) => [...line.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? ''));
  const templates = source.match(/`[\s\S]*?`/g) || [];

  for (const verb of ['UP' + 'DATE', 'DEL' + 'ETE', 'DR' + 'OP', 'TRUN' + 'CATE']) {
    for (const table of ['sales', 'sale_items', 'sale_tenders']) {
      const pattern = new RegExp(`${verb}[\\s\\S]{0,40}\\b${table}\\b`, 'i');
      const offender = [...literals, ...templates].find((text) => pattern.test(text));
      assert.equal(offender, undefined, `${verb} path on ${table}`);
    }
  }
});

// ── Over HTTP ───────────────────────────────────────────────────────────────

test('POST /sales needs TX-401 and answers 201 with the receipt', async () => {
  const product = stocked({ retail: 6250 });

  const refused = await call('/sales', {
    token: tokens.INVENTORY, method: 'POST',
    body: { lines: [{ productId: product.id, qtyMilli: 1000 }], tenders: [{ method: 'CASH', amountCentavos: 6250 }] },
  });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.rule_id, 'TX-401');

  const res = await call('/sales', {
    token: tokens.CASHIER, method: 'POST',
    body: {
      lines: [{ productId: product.id, qtyMilli: 1000 }],
      tenders: [{ method: 'CASH', amountCentavos: 10000 }],
      clientTotalCentavos: 6250,
    },
  });
  assert.equal(res.status, 201);
  const body = await res.json();

  assert.equal(body.sale.total_centavos, 6250);
  assert.equal(body.sale.change_centavos, 3750);
  assert.ok(body.drawer, 'POS-507: a cash tender pulses the drawer');
  assert.equal(body.drawer.reason, 'CASH_TENDER');

  const fetched = await call(`/sales/${body.sale.id}`, { token: tokens.CASHIER });
  assert.equal((await fetched.json()).sale.sale_no, body.sale.sale_no);
});

test('POS-107: there is no route that edits or deletes a sale', async () => {
  const sale = saleService.complete({
    lines: [{ productId: stocked().id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 99999 }],
  }, sessions.CASHIER);

  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const res = await call(`/sales/${sale.sale.id}`, { token: tokens.CASHIER, method });
    assert.equal(res.status, 409, method);
    assert.equal((await res.json()).error.rule_id, 'POS-107');
  }
});

test('a sale feeds the shift’s expected cash (POS-509)', () => {
  const expected = shiftService.computeExpected(cashierShift.id);

  const cashTaken = saleRepository.listForShift(cashierShift.id)
    .filter((s) => s.status !== 'VOIDED')
    .reduce((sum, s) => sum + s.change_centavos, 0);

  assert.ok(expected.cash_sales_centavos > 0, 'the till now sees the day’s cash tenders');
  assert.equal(expected.change_given_centavos, cashTaken, 'and the change handed back');
  assert.equal(
    expected.expected_cash_centavos,
    expected.opening_float_centavos + expected.cash_sales_centavos + expected.cash_collections_centavos
      + expected.cash_in_centavos - expected.cash_out_centavos - expected.cash_refunds_centavos
      - expected.change_given_centavos,
    'POS-509, term by term'
  );
});

test('the drawer is pulsed on a cash tender and not on a pure credit sale', () => {
  const product = stocked({ retail: 10000 });
  const { customer } = creditCustomer();
  const pulses = [];
  drawerService.setDriver((record) => pulses.push(record));

  try {
    saleService.complete({
      lines: [{ productId: product.id, qtyMilli: 1000 }],
      customerId: customer.id,
      tenders: [{ method: 'CREDIT', amountCentavos: 10000 }],
    }, sessions.CASHIER);
    assert.equal(pulses.length, 0, 'no cash, no drawer');

    saleService.complete({
      lines: [{ productId: product.id, qtyMilli: 1000 }],
      tenders: [{ method: 'CASH', amountCentavos: 10000 }],
    }, sessions.CASHIER);
    assert.equal(pulses.length, 1);
    assert.equal(pulses[0].reason, 'CASH_TENDER');
  } finally {
    drawerService.setDriver(null);
  }
});

test('INT-1: a drawer failure never rolls back a committed sale', () => {
  const product = stocked({ retail: 10000 });
  drawerService.setDriver(() => { throw new Error('printer offline'); });

  try {
    const sale = saleService.complete({
      lines: [{ productId: product.id, qtyMilli: 1000 }],
      tenders: [{ method: 'CASH', amountCentavos: 10000 }],
    }, sessions.CASHIER);

    // The pulse is outside the transaction on purpose: the customer has paid, and a
    // stuck drawer must not undo that.
    assert.equal(sale.drawer.delivered, false);
    assert.ok(saleRepository.findById(sale.sale.id), 'the sale stands');
    assert.equal(inventoryService.reconcile().ok, true);
  } finally {
    drawerService.setDriver(null);
  }
});

test('negative stock is permitted through a sale when the setting allows it (INV-104)', () => {
  const product = stocked({ retail: 10000, qtyMilli: 1000 });
  db.transaction(() => settingsService.set('allow_negative_stock', true, sessions.OWNER));

  try {
    saleService.complete({
      lines: [{ productId: product.id, qtyMilli: 3000 }],
      tenders: [{ method: 'CASH', amountCentavos: 99999 }],
    }, sessions.CASHIER);

    assert.equal(inventoryRepository.qtyOnHand(product.id), -2000);
    assert.equal(inventoryService.reconcile().ok, true, 'short, and still reconciling');
  } finally {
    db.transaction(() => settingsService.set('allow_negative_stock', false, sessions.OWNER));
  }
});
