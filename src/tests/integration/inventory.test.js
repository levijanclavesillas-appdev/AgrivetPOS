'use strict';

// The movement ledger. TC-INT-20 is the one that matters: it is a permanent regression
// guard (07_TEST_PLAN.md §7), and every future inventory defect is expected to be
// diagnosed by it failing.
//
// TC-UT-16 is a named unit case and lives here rather than in the unit file for the
// same reason as TC-UT-10: the pure arithmetic is already covered by costing.test.js,
// and what this asserts is that a *posted* sale leaves the stored average alone. That
// is a fact about the ledger, and a mocked version would assert the mock.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const db = require('../../config/database');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const inventoryService = require('../../services/inventoryService');
const settingsService = require('../../services/settingsService');
const auditService = require('../../services/auditService');
const inventoryRepository = require('../../repositories/inventoryRepository');
const productRepository = require('../../repositories/productRepository');
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

const call = (path, { token = null, method = 'GET', body = null } = {}) => fetch(`${BASE}${path}`, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

let sku = 0;
function makeProduct(over = {}) {
  sku += 1;
  return productService.create({
    sku: `INV-${String(sku).padStart(3, '0')}`,
    name: `Ledger Test Feed ${sku}`,
    categoryId: ref.category.id,
    baseUnitId: ref.kg.id,
    retailPriceCentavos: 6250,
    minStockMilli: 0,
    ...over,
  }, sessions.OWNER);
}

test.before(async () => {
  temp.openEmpty('inventory');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;
  temp.seedStore({ withOwner: false });
  ref = temp.seedCatalog();

  for (const role of ['OWNER', 'MANAGER', 'CASHIER', 'INVENTORY']) {
    const username = role.toLowerCase();
    temp.seedUser({ username, role, password: PASSWORD });
    const signedIn = authService.login({ username, password: PASSWORD });
    tokens[role] = signedIn.token;
    sessions[role] = authService.verifyToken(signedIn.token);
  }
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── INV-101 / INV-103 — posting and the running balance ─────────────────────

test('a movement writes the ledger row and the on-hand figure in one transaction', () => {
  const product = makeProduct();

  const result = inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli: 500000, unitCostCentavos: 4800,
    actor: sessions.OWNER, referenceType: 'goods_receipt', referenceNo: 'GR-0001',
  });

  assert.equal(result.balanceMilli, 500000);
  assert.equal(result.movement.balance_after_milli, 500000, 'the row carries its own running balance');
  assert.equal(inventoryRepository.qtyOnHand(product.id), 500000);
  assert.equal(inventoryRepository.lastBalance(product.id), 500000);
});

test('INV-103: each type carries its fixed sign, whatever sign the caller passed', () => {
  const product = makeProduct();
  inventoryService.postStandalone({
    productId: product.id, type: 'OPENING', qtyMilli: 100000, unitCostCentavos: 4000, actor: sessions.OWNER,
  });

  // A SALE of 20 kilos is twenty out, whether the caller wrote 20000 or -20000. Fixing
  // the sign here is what stops a mis-signed quantity from making a sale *add* stock.
  inventoryService.postStandalone({ productId: product.id, type: 'SALE', qtyMilli: 20000, actor: sessions.CASHIER });
  assert.equal(inventoryRepository.qtyOnHand(product.id), 80000);

  inventoryService.postStandalone({ productId: product.id, type: 'SALE', qtyMilli: -20000, actor: sessions.CASHIER });
  assert.equal(inventoryRepository.qtyOnHand(product.id), 60000, 'still a decrease');

  // A two-directional type keeps what it was given.
  inventoryService.postStandalone({
    productId: product.id, type: 'COUNT_VARIANCE', qtyMilli: -5000, actor: sessions.OWNER, reason: 'Counted short',
  });
  assert.equal(inventoryRepository.qtyOnHand(product.id), 55000);
});

test('the twelve INV-103 types are exactly the schema CHECK, and no more', () => {
  // legacy/PRD_v1.1.md §19's STOCK_TRANSFER is withdrawn until v1.3: there is no
  // location entity, so there is nowhere to transfer between (02_PRD.md §7).
  assert.equal(inventoryService.TYPE_NAMES.length, 12);
  assert.equal(inventoryService.TYPE_NAMES.includes('STOCK_TRANSFER'), false);
  assert.throws(() => inventoryService.assertType('STOCK_TRANSFER'), RangeError);

  const check = db.get()
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inventory_movements'")
    .get().sql;
  for (const type of inventoryService.TYPE_NAMES) {
    assert.ok(check.includes(`'${type}'`), `${type} is missing from the schema CHECK`);
  }
});

test('a movement of zero is refused, and a movement needs an acting user', () => {
  const product = makeProduct();

  assert.throws(
    () => inventoryService.postStandalone({ productId: product.id, type: 'RECEIPT', qtyMilli: 0, actor: sessions.OWNER }),
    (err) => err.status === 400 && err.ruleId === 'MON-002'
  );
  assert.throws(
    () => inventoryService.postStandalone({ productId: product.id, type: 'RECEIPT', qtyMilli: 1000, actor: { username: 'ghost' } }),
    TypeError
  );
});

test('a type that requires a reason is refused without one (INV-103)', () => {
  const product = makeProduct();
  inventoryService.postStandalone({ productId: product.id, type: 'RECEIPT', qtyMilli: 10000, actor: sessions.OWNER });

  for (const type of ['DAMAGE', 'EXPIRY', 'INTERNAL_USE', 'SUPPLIER_RETURN', 'CUSTOMER_RETURN']) {
    assert.throws(
      () => inventoryService.postStandalone({ productId: product.id, type, qtyMilli: 1000, actor: sessions.OWNER }),
      (err) => err.status === 400 && err.ruleId === 'INV-103',
      type
    );
  }
});

// ── TC-INT-20 — the invariant ───────────────────────────────────────────────

test('TC-INT-20: SUM(movements) equals inventory.qty_on_hand for every product', () => {
  const product = makeProduct();
  const actor = sessions.OWNER;

  // A scripted trading day in miniature: in, out, corrected, written off, counted.
  inventoryService.postStandalone({ productId: product.id, type: 'OPENING', qtyMilli: 250000, unitCostCentavos: 4500, actor });
  inventoryService.postStandalone({ productId: product.id, type: 'RECEIPT', qtyMilli: 500000, unitCostCentavos: 4800, actor });
  inventoryService.postStandalone({ productId: product.id, type: 'SALE', qtyMilli: 1255, actor: sessions.CASHIER });
  inventoryService.postStandalone({ productId: product.id, type: 'SALE', qtyMilli: 50000, actor: sessions.CASHIER });
  inventoryService.postStandalone({ productId: product.id, type: 'DAMAGE', qtyMilli: 2000, actor, reason: 'Torn sack' });
  inventoryService.postStandalone({ productId: product.id, type: 'CUSTOMER_RETURN', qtyMilli: 1255, actor, reason: 'Wrong item' });
  inventoryService.postStandalone({ productId: product.id, type: 'COUNT_VARIANCE', qtyMilli: -750, actor, reason: 'Counted short' });

  const reconciliation = inventoryService.reconcile();
  assert.equal(reconciliation.ok, true, JSON.stringify(reconciliation.breaks));

  // Asserted independently of the service's own query, so the guard is not checking
  // its own arithmetic against itself.
  const ledgerSum = db.get()
    .prepare('SELECT SUM(qty_milli) AS n FROM inventory_movements WHERE product_id = ?')
    .get(product.id).n;
  assert.equal(inventoryRepository.qtyOnHand(product.id), ledgerSum);
  assert.equal(ledgerSum, 250000 + 500000 - 1255 - 50000 - 2000 + 1255 - 750);

  // And the running balance on each row agrees with the sum of everything before it.
  const rows = db.get()
    .prepare('SELECT qty_milli, balance_after_milli FROM inventory_movements WHERE product_id = ? ORDER BY occurred_at, id')
    .all(product.id);
  let running = 0;
  for (const row of rows) {
    running += row.qty_milli;
    assert.equal(row.balance_after_milli, running, 'balance_after_milli is the running total');
  }
});

test('TC-INT-20: the invariant holds across every product in the database', () => {
  const reconciliation = inventoryService.reconcile();
  assert.equal(reconciliation.ok, true, JSON.stringify(reconciliation.breaks));
  assert.deepEqual(reconciliation.breaks, []);
});

test('TC-INT-20: the check actually detects a break when one is introduced', () => {
  // A guard nobody has seen fail is a guard nobody knows works. The on-hand figure is
  // corrupted directly — which no application path can do — and put back afterwards.
  const product = makeProduct();
  inventoryService.postStandalone({ productId: product.id, type: 'RECEIPT', qtyMilli: 10000, unitCostCentavos: 100, actor: sessions.OWNER });

  db.get().prepare('UPDATE inventory SET qty_on_hand_milli = 999 WHERE product_id = ?').run(product.id);
  const broken = inventoryService.reconcile();

  assert.equal(broken.ok, false);
  assert.equal(broken.breaks.length, 1);
  assert.equal(broken.breaks[0].product_id, product.id);
  assert.equal(broken.breaks[0].difference_milli, 999 - 10000);

  db.get().prepare('UPDATE inventory SET qty_on_hand_milli = 10000 WHERE product_id = ?').run(product.id);
  assert.equal(inventoryService.reconcile().ok, true);
});

test('INV-107: a movement inside a rolled-back transaction takes the balance with it', () => {
  const product = makeProduct();
  inventoryService.postStandalone({ productId: product.id, type: 'RECEIPT', qtyMilli: 10000, unitCostCentavos: 100, actor: sessions.OWNER });

  assert.throws(() => db.transaction(() => {
    inventoryService.post({ productId: product.id, type: 'SALE', qtyMilli: 5000, actor: sessions.CASHIER });
    throw new Error('the document refused after its movements were written');
  }), /document refused/);

  assert.equal(inventoryRepository.qtyOnHand(product.id), 10000, 'on hand unchanged');
  assert.equal(inventoryRepository.countMovementsFor(product.id), 1, 'and no orphan movement');
  assert.equal(inventoryService.reconcile().ok, true);
});

// ── TC-INT-21 / INV-104 — negative stock ────────────────────────────────────

test('TC-INT-21: stock may not go negative by default', () => {
  const product = makeProduct();
  inventoryService.postStandalone({ productId: product.id, type: 'RECEIPT', qtyMilli: 10000, unitCostCentavos: 100, actor: sessions.OWNER });

  assert.equal(settingsService.get('allow_negative_stock'), false, 'INV-104: defaults to disabled');

  let err;
  try {
    inventoryService.postStandalone({ productId: product.id, type: 'SALE', qtyMilli: 15000, actor: sessions.CASHIER });
  } catch (caught) {
    err = caught;
  }

  assert.ok(err);
  assert.equal(err.status, 409);
  assert.equal(err.ruleId, 'INV-104');
  assert.match(err.message, /10 KG on hand/, 'the message says what is actually there');
  assert.match(err.message, /Receive stock first/, 'and what to do about it');
  assert.equal(inventoryRepository.qtyOnHand(product.id), 10000, 'nothing moved');
});

test('TC-INT-21: with the setting on, it proceeds, warns and flags the movement', () => {
  const product = makeProduct();
  inventoryService.postStandalone({ productId: product.id, type: 'RECEIPT', qtyMilli: 10000, unitCostCentavos: 100, actor: sessions.OWNER });

  db.transaction(() => settingsService.set('allow_negative_stock', true, sessions.OWNER));
  try {
    const result = inventoryService.postStandalone({
      productId: product.id, type: 'SALE', qtyMilli: 15000, actor: sessions.CASHIER,
    });

    assert.equal(result.balanceMilli, -5000);
    assert.equal(result.negativeStock, true);
    assert.match(result.warning, /below zero/, 'INV-104 requires a visible warning');
    assert.equal(result.movement.is_negative_stock, 1, 'and the movement is flagged');

    // The ledger still reconciles while short — the invariant is about agreement, not
    // about the sign.
    assert.equal(inventoryService.reconcile().ok, true);
  } finally {
    db.transaction(() => settingsService.set('allow_negative_stock', false, sessions.OWNER));
  }
});

// ── TC-UT-16 / INV-106 — what moves the average ─────────────────────────────

test('TC-UT-16: average cost moves on a receipt', () => {
  const product = makeProduct();

  inventoryService.postStandalone({ productId: product.id, type: 'OPENING', qtyMilli: 100000, unitCostCentavos: 4000, actor: sessions.OWNER });
  assert.equal(productRepository.findById(product.id).avg_cost_centavos, 4000);

  // 100 KG at ₱40 plus 100 KG at ₱50 is 200 KG at ₱45 (MON-004).
  const received = inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli: 100000, unitCostCentavos: 5000, actor: sessions.OWNER,
  });

  assert.equal(received.averageChanged, true);
  assert.equal(received.avgCostCentavos, 4500);
  assert.equal(productRepository.findById(product.id).avg_cost_centavos, 4500);
  assert.ok(productRepository.findById(product.id).avg_cost_as_of, 'and it is dated');
});

test('TC-UT-16: sale, damage and negative adjustment leave the average alone', () => {
  const product = makeProduct();
  inventoryService.postStandalone({ productId: product.id, type: 'OPENING', qtyMilli: 200000, unitCostCentavos: 4500, actor: sessions.OWNER });

  const decreases = [
    { type: 'SALE', qtyMilli: 50000, actor: sessions.CASHIER },
    { type: 'DAMAGE', qtyMilli: 10000, actor: sessions.OWNER, reason: 'Water damage' },
    { type: 'EXPIRY', qtyMilli: 5000, actor: sessions.OWNER, reason: 'Past date' },
    { type: 'INTERNAL_USE', qtyMilli: 1000, actor: sessions.OWNER, reason: 'Own livestock' },
  ];

  for (const movement of decreases) {
    const result = inventoryService.postStandalone({ productId: product.id, ...movement });
    // Anything else would let a store change its historical margin by writing stock
    // off, which is exactly what INV-106 forbids.
    assert.equal(result.averageChanged, false, movement.type);
    assert.equal(result.avgCostCentavos, 4500, movement.type);
  }

  // A negative adjustment, even one carrying a cost, consumes at the prevailing average.
  const down = inventoryService.postStandalone({
    productId: product.id, type: 'ADJUSTMENT', qtyMilli: -2000, unitCostCentavos: 9999,
    actor: sessions.OWNER, reason: 'Physical count correction',
  });
  assert.equal(down.averageChanged, false);
  assert.equal(productRepository.findById(product.id).avg_cost_centavos, 4500);
});

test('a positive adjustment moves the average only when it carries a cost (INV-106)', () => {
  const product = makeProduct();
  inventoryService.postStandalone({ productId: product.id, type: 'OPENING', qtyMilli: 100000, unitCostCentavos: 4000, actor: sessions.OWNER });

  const noCost = inventoryService.postStandalone({
    productId: product.id, type: 'ADJUSTMENT', qtyMilli: 10000, actor: sessions.OWNER, reason: 'Received but not recorded',
  });
  assert.equal(noCost.averageChanged, false, 'no cost supplied, nothing to average in');
  assert.equal(productRepository.findById(product.id).avg_cost_centavos, 4000);

  const withCost = inventoryService.postStandalone({
    productId: product.id, type: 'ADJUSTMENT', qtyMilli: 10000, unitCostCentavos: 6000,
    actor: sessions.OWNER, reason: 'Received but not recorded',
  });
  assert.equal(withCost.averageChanged, true);
});

// ── TC-INT-24 / INV-102 — append-only and corrections ───────────────────────

test('TC-INT-24: no repository method updates or deletes a movement', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'repositories', 'inventoryRepository.js'), 'utf8'
  );

  // Assembled from fragments so this file does not match its own pattern. Only string
  // literals are examined — prose about "never deleted" is not a delete path.
  const literals = source.split('\n').flatMap((line) => [...line.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? ''));
  const templates = source.match(/`[\s\S]*?`/g) || [];

  for (const verb of ['UP' + 'DATE', 'DEL' + 'ETE', 'DR' + 'OP', 'TRUN' + 'CATE']) {
    const pattern = new RegExp(`${verb}[\\s\\S]{0,60}inventory_movements`, 'i');
    const offender = [...literals, ...templates].find((text) => pattern.test(text));
    assert.equal(offender, undefined, `${verb} path on inventory_movements: ${offender}`);
  }

  const repository = require('../../repositories/inventoryRepository');
  const mutating = Object.keys(repository).filter((n) => /updateMovement|deleteMovement|removeMovement|purge/i.test(n));
  assert.deepEqual(mutating, []);
});

test('TC-INT-24: a correction is a compensating movement citing the original', () => {
  const product = makeProduct();
  const wrong = inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli: 500000, unitCostCentavos: 4800,
    actor: sessions.OWNER, referenceNo: 'GR-0002',
  });

  const correction = inventoryService.correct(wrong.movement.id, {
    actor: sessions.OWNER, reason: 'Delivery was 50 sacks, not 500 KG loose',
  });

  assert.equal(correction.movement.corrects_movement_id, wrong.movement.id);
  assert.equal(correction.movement.qty_milli, -500000, 'the exact opposite');
  assert.equal(inventoryRepository.qtyOnHand(product.id), 0);

  // The original is still there. That is the whole difference between a ledger and a
  // spreadsheet: what happened, including the mistake, stays legible.
  const original = inventoryRepository.findMovement(wrong.movement.id);
  assert.equal(original.qty_milli, 500000, 'untouched');
  assert.equal(inventoryRepository.countMovementsFor(product.id), 2);
  assert.equal(inventoryService.reconcile().ok, true);
});

test('TC-INT-24: a movement is corrected once, and the ledger shows the link both ways', () => {
  const product = productRepository.findBySku(`INV-${String(sku).padStart(3, '0')}`);
  const [correction, original] = inventoryRepository.movementsFor(product.id);

  assert.throws(
    () => inventoryService.correct(original.id, { actor: sessions.OWNER, reason: 'Again' }),
    (err) => err.status === 409 && err.ruleId === 'INV-102'
  );
  assert.throws(
    () => inventoryService.correct(original.id, { actor: sessions.OWNER, reason: '' }),
    (err) => err.status === 400 && err.ruleId === 'INV-102'
  );

  const view = inventoryService.ledger(product.id);
  const originalRow = view.movements.find((m) => m.id === original.id);
  assert.equal(originalRow.corrected_by_id, correction.id, 'the original says it was corrected');
  assert.equal(view.movements.find((m) => m.id === correction.id).corrects_movement_id, original.id);
});

// ── TC-INT-23 / INV-108 — adjustments ───────────────────────────────────────

test('TC-INT-23: an adjustment without a listed reason is rejected', () => {
  const product = makeProduct();
  inventoryService.postStandalone({ productId: product.id, type: 'RECEIPT', qtyMilli: 100000, unitCostCentavos: 100, actor: sessions.OWNER });

  for (const reason of [undefined, '', '   ', 'because I said so']) {
    assert.throws(
      () => inventoryService.adjust({ productId: product.id, qtyMilli: -1000, reason, actor: sessions.OWNER }),
      (err) => err.status === 400 && err.ruleId === 'INV-108',
      JSON.stringify(reason)
    );
  }

  // Free text is permitted as a note *beside* a listed reason, never instead of one.
  const ok = inventoryService.adjust({
    productId: product.id, qtyMilli: -1000, reason: 'Spoilage',
    notes: 'Bottom two sacks in the corner', actor: sessions.OWNER,
  });
  assert.equal(ok.movement.reason, 'Spoilage — Bottom two sacks in the corner');
});

test('TC-INT-23: the reason list is configured, not hard-coded (OPS-005)', () => {
  const listed = inventoryService.adjustmentReasons();
  assert.ok(listed.includes('Spoilage'));

  db.transaction(() => settingsService.set('adjustment_reasons', ['Eaten by rats'], sessions.OWNER));
  try {
    const product = makeProduct();
    inventoryService.postStandalone({ productId: product.id, type: 'RECEIPT', qtyMilli: 10000, unitCostCentavos: 100, actor: sessions.OWNER });

    assert.throws(
      () => inventoryService.adjust({ productId: product.id, qtyMilli: -1000, reason: 'Spoilage', actor: sessions.OWNER }),
      (err) => err.ruleId === 'INV-108'
    );
    assert.doesNotThrow(
      () => inventoryService.adjust({ productId: product.id, qtyMilli: -1000, reason: 'Eaten by rats', actor: sessions.OWNER })
    );
  } finally {
    db.transaction(() => settingsService.set('adjustment_reasons', listed, sessions.OWNER));
  }
});

test('TC-INT-23: an adjustment needs TX-407', () => {
  const product = makeProduct();
  inventoryService.postStandalone({ productId: product.id, type: 'RECEIPT', qtyMilli: 10000, unitCostCentavos: 100, actor: sessions.OWNER });

  assert.throws(
    () => inventoryService.adjust({ productId: product.id, qtyMilli: -1000, reason: 'Spoilage', actor: sessions.CASHIER }, sessions.CASHIER),
    (err) => err.status === 403 && err.ruleId === 'TX-407'
  );
  // §10 grants TX-407 to the inventory clerk as well as owner and manager.
  assert.doesNotThrow(
    () => inventoryService.adjust({ productId: product.id, qtyMilli: -1000, reason: 'Spoilage', actor: sessions.INVENTORY }, sessions.INVENTORY)
  );
});

test('TC-INT-23: above the threshold an owner must authorise, and both actors are recorded', () => {
  const product = makeProduct();
  // 1,000 KG at ₱60 is ₱60,000 — well above the ₱5,000 default threshold.
  inventoryService.postStandalone({ productId: product.id, type: 'RECEIPT', qtyMilli: 1000000, unitCostCentavos: 6000, actor: sessions.OWNER });

  const threshold = settingsService.get('adjustment_authorisation_centavos');
  assert.equal(threshold, 500000, '₱5,000');

  const big = { productId: product.id, qtyMilli: -500000, reason: 'Spoilage', actor: sessions.MANAGER };

  let refused;
  try {
    inventoryService.adjust(big, sessions.MANAGER);
  } catch (err) {
    refused = err;
  }
  assert.equal(refused.status, 403);
  assert.equal(refused.ruleId, 'INV-108');
  assert.equal(refused.requiresRole, 'OWNER');
  assert.match(refused.message, /₱30,000\.00/, 'the message states the value being authorised');

  // A manager cannot authorise it either — the rule says owner.
  assert.throws(
    () => inventoryService.adjust({ ...big, approver: sessions.MANAGER }, sessions.MANAGER),
    (err) => err.ruleId === 'AUD-603' || err.ruleId === 'INV-108'
  );

  const done = inventoryService.adjust({ ...big, approver: sessions.OWNER }, sessions.MANAGER);
  assert.equal(done.authorisedBy, 'owner');
  assert.equal(done.selfAuthorised, false);

  const [row] = auditService.browse({ action: 'INVENTORY_ADJUSTED', entityId: product.id }).rows;
  assert.equal(row.actor.username, 'manager', 'the requesting user');
  assert.equal(row.approver.username, 'owner', 'and the authorising user, distinctly');
  assert.equal(row.after.authorisation_required, true);
  assert.equal(row.after.value_centavos, 3000000);
});

test('an owner filing a large adjustment themselves is already the authorisation', () => {
  // Found by driving the real server rather than by a test: demanding a *second*,
  // distinct owner makes a large adjustment impossible in a one-owner store, which is
  // most of them. INV-108 asks for owner authority, not for two people — AUD-603's
  // distinct actors govern an override one user requests and another grants.
  const product = makeProduct();
  inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli: 200000, unitCostCentavos: 4800, actor: sessions.OWNER,
  });

  const result = inventoryService.adjust({
    productId: product.id, qtyMilli: -150000, reason: 'Spoilage', actor: sessions.OWNER,
  }, sessions.OWNER);

  assert.equal(result.authorisationRequired, true, '₱7,200 is over the ₱5,000 threshold');
  assert.equal(result.selfAuthorised, true);
  assert.equal(result.authorisedBy, 'owner');

  const [row] = auditService.browse({ action: 'INVENTORY_ADJUSTED', entityId: product.id }).rows;
  assert.equal(row.approver, null, 'there is no second party to record');
  // Recorded so the trail distinguishes "an owner did this himself" from "no
  // authorisation was needed" — they would read identically otherwise.
  assert.equal(row.after.authorisation_required, true);
  assert.equal(row.after.self_authorised, true);
});

test('a manager still cannot self-authorise past the threshold', () => {
  const product = makeProduct();
  inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli: 200000, unitCostCentavos: 4800, actor: sessions.OWNER,
  });

  assert.throws(
    () => inventoryService.adjust({
      productId: product.id, qtyMilli: -150000, reason: 'Spoilage',
      actor: sessions.MANAGER, approver: sessions.MANAGER,
    }, sessions.MANAGER),
    (err) => err.status === 403
  );
});

test('an adjustment below the threshold needs no authorisation and records one actor', () => {
  const product = makeProduct();
  inventoryService.postStandalone({ productId: product.id, type: 'RECEIPT', qtyMilli: 10000, unitCostCentavos: 100, actor: sessions.OWNER });

  const result = inventoryService.adjust({
    productId: product.id, qtyMilli: -1000, reason: 'Spoilage', actor: sessions.MANAGER,
  }, sessions.MANAGER);

  assert.equal(result.authorisedBy, null);
  const [row] = auditService.browse({ action: 'INVENTORY_ADJUSTED', entityId: product.id }).rows;
  assert.equal(row.approver, null);
  assert.equal(row.after.authorisation_required, false);
});

// ── TC-INT-22 / INV-109 — low stock ─────────────────────────────────────────

test('TC-INT-22: selling down to the minimum surfaces the product in low stock', () => {
  const product = makeProduct({ minStockMilli: 50000 });
  inventoryService.postStandalone({ productId: product.id, type: 'RECEIPT', qtyMilli: 200000, unitCostCentavos: 4800, actor: sessions.OWNER });

  const before = inventoryService.lowStock().products.map((p) => p.product_id);
  assert.equal(before.includes(product.id), false, 'well stocked');

  // Down to exactly the threshold: INV-109 is "≤", not "<".
  inventoryService.postStandalone({ productId: product.id, type: 'SALE', qtyMilli: 150000, actor: sessions.CASHIER });

  const list = inventoryService.lowStock().products;
  const row = list.find((p) => p.product_id === product.id);
  assert.ok(row, 'at the minimum is low stock');
  assert.equal(row.qty_on_hand_milli, 50000);
  assert.equal(row.shortfall_milli, 0);
  assert.equal(row.is_out_of_stock, false);
  assert.equal(row.qty_on_hand_display, '50 KG', 'UOM-005 labels it with the base unit');
});

test('TC-INT-22: low stock is computed at read time, never stored', () => {
  const product = makeProduct({ minStockMilli: 10000 });
  inventoryService.postStandalone({ productId: product.id, type: 'RECEIPT', qtyMilli: 5000, unitCostCentavos: 100, actor: sessions.OWNER });
  assert.ok(inventoryService.lowStock().products.some((p) => p.product_id === product.id));

  // Receiving stock takes it back off the list with no flag to clear anywhere. A stored
  // flag has to be recomputed by something, and the something is always missed on one
  // path — which is the failure FR_2.6 is about.
  inventoryService.postStandalone({ productId: product.id, type: 'RECEIPT', qtyMilli: 50000, unitCostCentavos: 100, actor: sessions.OWNER });
  assert.equal(inventoryService.lowStock().products.some((p) => p.product_id === product.id), false);

  const columns = db.get().prepare("SELECT sql FROM sqlite_master WHERE name = 'products'").get().sql;
  assert.equal(/low_stock/i.test(columns), false, 'INV-109: there is no stored flag to go stale');
});

test('a deactivated product leaves the low-stock list but keeps its stock (INV-105)', () => {
  const product = makeProduct({ minStockMilli: 10000 });
  inventoryService.postStandalone({ productId: product.id, type: 'RECEIPT', qtyMilli: 1000, unitCostCentavos: 5000, actor: sessions.OWNER });
  assert.ok(inventoryService.lowStock().products.some((p) => p.product_id === product.id));

  productService.deactivate(product.id, sessions.OWNER);

  assert.equal(inventoryService.lowStock().products.some((p) => p.product_id === product.id), false,
    'INV-109 is about active products — a withdrawn one is not a reorder');
  // But the stock, history and valuation are all intact.
  assert.equal(inventoryService.onHand(product.id).qty_on_hand_milli, 1000);
  assert.equal(inventoryService.ledger(product.id).total, 1);
  assert.ok(inventoryService.valuation().products.some((p) => p.product_id === product.id),
    'INV-105: withdrawing a product does not make the stock worthless');
});

test('a product with no minimum set is not permanently low stock', () => {
  const product = makeProduct({ minStockMilli: 0 });
  assert.equal(inventoryService.lowStock().products.some((p) => p.product_id === product.id), false);
});

// ── Requirement 8 — the ledger view ─────────────────────────────────────────

test('the ledger view returns date, type, quantity, reference and running balance', () => {
  const product = makeProduct();
  inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli: 100000, unitCostCentavos: 4800,
    actor: sessions.OWNER, referenceType: 'goods_receipt', referenceId: 'gr-1', referenceNo: 'GR-0003',
  });
  inventoryService.postStandalone({ productId: product.id, type: 'SALE', qtyMilli: 25000, actor: sessions.CASHIER });

  const view = inventoryService.ledger(product.id);
  assert.equal(view.total, 2);
  assert.equal(view.on_hand.qty_on_hand_milli, 75000);

  const [newest, oldest] = view.movements;
  assert.equal(newest.type, 'SALE');
  assert.equal(newest.type_label, 'Sold');
  assert.equal(newest.qty_display, '-25 KG');
  assert.equal(newest.balance_after_display, '75 KG');
  assert.equal(newest.created_by, 'cashier', 'AUD-606-style: the username, not an id');
  assert.match(newest.occurred_at_manila, /\d{2}\/\d{2}\/\d{4}/, 'VR-102: rendered Manila');

  assert.deepEqual(oldest.reference, { type: 'goods_receipt', id: 'gr-1', no: 'GR-0003' });
  assert.equal(oldest.unit_cost_centavos, 4800);
});

test('the ledger view filters by type and date, and pages', () => {
  const product = productRepository.findBySku(`INV-${String(sku).padStart(3, '0')}`);

  assert.equal(inventoryService.ledger(product.id, { type: 'SALE' }).total, 1);
  assert.equal(inventoryService.ledger(product.id, { type: 'DAMAGE' }).total, 0);
  assert.equal(inventoryService.ledger(product.id, { limit: 1 }).movements.length, 1);
  assert.equal(inventoryService.ledger(product.id, { limit: 1, offset: 1 }).movements[0].type, 'RECEIPT');
  assert.throws(() => inventoryService.ledger(product.id, { type: 'NONSENSE' }), RangeError);
});

// ── Over HTTP ───────────────────────────────────────────────────────────────

test('the ledger and low-stock routes need TX-422', async () => {
  const product = productRepository.findBySku('INV-001');

  assert.equal((await call(`/inventory/${product.id}/movements`, { token: tokens.OWNER })).status, 200);
  assert.equal((await call('/inventory/low-stock', { token: tokens.INVENTORY })).status, 200);
  assert.equal((await call('/inventory/low-stock')).status, 401);

  // §10 gives the cashier TX-422 at VIEW, so the counter can see stock; it gives them
  // no TX-407, so they cannot move it.
  assert.equal((await call('/inventory/low-stock', { token: tokens.CASHIER })).status, 200);
});

test('POST /inventory/adjustments needs TX-407 and posts through the service', async () => {
  const product = makeProduct();
  inventoryService.postStandalone({ productId: product.id, type: 'RECEIPT', qtyMilli: 20000, unitCostCentavos: 100, actor: sessions.OWNER });

  const refused = await call('/inventory/adjustments', {
    token: tokens.CASHIER, method: 'POST',
    body: { productId: product.id, qtyMilli: -1000, reason: 'Spoilage' },
  });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.rule_id, 'TX-407');

  const ok = await call('/inventory/adjustments', {
    token: tokens.INVENTORY, method: 'POST',
    body: { productId: product.id, qtyMilli: -1000, reason: 'Spoilage', notes: 'Wet corner' },
  });
  assert.equal(ok.status, 201);
  const body = await ok.json();
  assert.equal(body.balanceMilli, 19000);
  assert.equal(body.movement.reason, 'Spoilage — Wet corner');
  assert.equal(inventoryService.reconcile().ok, true);
});

test('there is no route that writes an on-hand figure', async () => {
  const product = productRepository.findBySku('INV-001');

  for (const [method, path] of [
    ['PUT', `/inventory/${product.id}`],
    ['POST', `/inventory/${product.id}`],
    ['PATCH', `/inventory/${product.id}`],
    ['DELETE', `/inventory/${product.id}/movements`],
  ]) {
    const res = await call(path, { token: tokens.OWNER, method });
    // INV-101: on-hand is a consequence of the ledger. The absence of the endpoint is
    // how that is enforced at the edge.
    assert.equal(res.status, 404, `${method} ${path} must not exist`);
  }
});

test('the adjustment reason list is served to the screen rather than hard-coded there', async () => {
  const res = await call('/inventory/meta/adjustment-reasons', { token: tokens.INVENTORY });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.ok(body.reasons.includes('Spoilage'));
  assert.equal(body.types.length, 12);
  assert.ok(body.types.some((t) => t.value === 'BREAK_BULK' && t.label === 'Break bulk'));
});

test('the reconciliation endpoint is owner-only', async () => {
  assert.equal((await call('/inventory/reconciliation', { token: tokens.MANAGER })).status, 403);

  const res = await call('/inventory/reconciliation', { token: tokens.OWNER });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, breaks: [] });
});

test('valuation is computed at read time with its as-of timestamp (RPT-103)', async () => {
  const res = await call('/inventory/valuation', { token: tokens.OWNER });
  const body = await res.json();

  assert.match(body.as_of, /Z$/);
  assert.ok(body.total_value_centavos > 0);
  assert.equal(
    body.total_value_centavos,
    body.products.reduce((sum, p) => sum + p.value_centavos, 0),
    'the total is the sum of its rows'
  );
});
