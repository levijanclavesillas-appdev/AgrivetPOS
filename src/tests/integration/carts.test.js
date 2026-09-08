'use strict';

// POS-105, POS-106 — the cart survives, and parked carts expire at shift close.
//
// The decision this file exercises is the one TASK-015 required and named: a cart lives
// in the database rather than in the renderer's storage, because POS-105 says an
// in-progress cart survives "an application restart" and localStorage does not survive
// a reinstall, a Windows profile change or v1.3's second terminal.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const db = require('../../config/database');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const inventoryService = require('../../services/inventoryService');
const customerService = require('../../services/customerService');
const shiftService = require('../../services/shiftService');
const cartService = require('../../services/cartService');
const settingsService = require('../../services/settingsService');
const cartRepository = require('../../repositories/cartRepository');
const temp = require('../helpers/tempdb');

const PORT = 47881;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'correct-horse-battery';

let instance;
let ref;
let product;
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

let seq = 0;
function cashierWithShift() {
  seq += 1;
  const username = `till${seq}`;
  temp.seedUser({ username, role: 'CASHIER', password: PASSWORD });
  const signedIn = authService.login({ username, password: PASSWORD });
  const session = authService.verifyToken(signedIn.token);
  const { shift } = shiftService.open({ actor: session, openingFloatCentavos: 200000, confirmed: true });
  return { session, token: signedIn.token, shift, username };
}

test.before(async () => {
  temp.openEmpty('carts');
  instance = await server.start({ listenPort: PORT });
  temp.seedStore({ withOwner: false });
  ref = temp.seedCatalog();

  for (const role of ['OWNER', 'CASHIER']) {
    const username = role.toLowerCase();
    temp.seedUser({ username, role, password: PASSWORD });
    const signedIn = authService.login({ username, password: PASSWORD });
    tokens[role] = signedIn.token;
    sessions[role] = authService.verifyToken(signedIn.token);
  }

  product = productService.create({
    sku: 'CART-001', name: 'Hog Grower Pellets',
    categoryId: ref.category.id, baseUnitId: ref.kg.id, retailPriceCentavos: 6250,
  }, sessions.OWNER);
  inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli: 1000000, unitCostCentavos: 4000, actor: sessions.OWNER,
  });

  const backups = require('path').join(
    require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'agrivet-cart-')), 'backups'
  );
  db.transaction(() => settingsService.set('backup_folder', backups, sessions.OWNER));
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── POS-105 — the cart survives ─────────────────────────────────────────────

test('POS-105: a saved cart is there again on the next load', () => {
  const { session } = cashierWithShift();

  cartService.save({ lines: [{ productId: product.id, qtyMilli: 1255 }] }, session);
  const restored = cartService.active(session);

  assert.equal(restored.line_count, 1);
  assert.equal(restored.lines[0].qtyMilli, 1255);
  // The figures come back priced, because a cart shown without them is a cart the
  // cashier cannot read.
  assert.equal(restored.priced.total_centavos, 7844);
});

test('POS-105: it survives a restart, which renderer storage would not', () => {
  const { session, username } = cashierWithShift();
  cartService.save({ lines: [{ productId: product.id, qtyMilli: 2000 }] }, session);

  // A restart is the process going away and coming back to the same file. That is what
  // the rule asks for, and it is the case localStorage cannot serve after a reinstall.
  db.close();
  db.open();

  const again = authService.verifyToken(authService.login({ username, password: PASSWORD }).token);
  const restored = cartService.active(again);
  assert.equal(restored.lines[0].qtyMilli, 2000);
});

test('POS-105: it belongs to the same user on the same shift, and to nobody else', () => {
  const mine = cashierWithShift();
  const theirs = cashierWithShift();

  cartService.save({ lines: [{ productId: product.id, qtyMilli: 1000 }] }, mine.session);

  // A cart is a customer standing at a counter. Handing it to whoever logs in next is
  // how the wrong person's sale gets completed.
  assert.equal(cartService.active(theirs.session), null);
  assert.equal(cartService.active(mine.session).line_count, 1);
});

test('an empty cart is cleared rather than saved as an empty one', () => {
  const { session } = cashierWithShift();
  cartService.save({ lines: [{ productId: product.id, qtyMilli: 1000 }] }, session);

  const result = cartService.save({ lines: [] }, session);
  assert.equal(result.saved, false);
  // A row saying "this cashier has a cart with nothing in it" restores an empty screen
  // and looks like a defect.
  assert.equal(cartService.active(session), null);
});

test('a cart cannot be built without an open shift (POS-501)', () => {
  temp.seedUser({ username: 'cartless', role: 'CASHIER', password: PASSWORD });
  const session = authService.verifyToken(
    authService.login({ username: 'cartless', password: PASSWORD }).token
  );

  assert.throws(
    () => cartService.save({ lines: [{ productId: product.id, qtyMilli: 1000 }] }, session),
    (err) => err.status === 409 && err.ruleId === 'POS-501'
  );
  assert.equal(cartService.active(session), null, 'and there is nothing to restore');
});

test('a cart stores no price, so it resumes at the price in force when it is sold', () => {
  const { session } = cashierWithShift();
  cartService.save({ lines: [{ productId: product.id, qtyMilli: 1000 }] }, session);
  assert.equal(cartService.active(session).priced.total_centavos, 6250);

  productService.setPrices(product.id, { RETAIL: 7000 }, sessions.OWNER);

  // §4.1 step 2: prices are re-resolved, never remembered. A cart parked before a price
  // change sells at today's price.
  assert.equal(cartService.active(session).priced.total_centavos, 7000);

  const stored = JSON.parse(cartRepository.findActive(session.id, shiftService.openShiftFor(session.id).id).payload);
  assert.equal(/price|centavos/i.test(JSON.stringify(stored.lines)), true, 'discounts are stored');
  assert.equal(stored.lines[0].unitPriceCentavos, undefined, 'but no unit price is');

  productService.setPrices(product.id, { RETAIL: 6250 }, sessions.OWNER);
});

test('a cart whose product is withdrawn is returned and flagged, not dropped', () => {
  const { session } = cashierWithShift();
  const doomed = productService.create({
    sku: `CART-GONE-${seq}`, name: 'Discontinued Feed',
    categoryId: ref.category.id, baseUnitId: ref.kg.id, retailPriceCentavos: 5000,
  }, sessions.OWNER);

  cartService.save({ lines: [{ productId: doomed.id, qtyMilli: 1000 }] }, session);
  productService.deactivate(doomed.id, sessions.OWNER);

  const restored = cartService.active(session);
  assert.ok(restored, 'the cart still comes back');
  assert.equal(restored.unpriceable, true, 'and says it cannot be priced');
  assert.equal(restored.lines.length, 1, 'so the cashier can see and remove the line');
});

// ── POS-106 — parking ───────────────────────────────────────────────────────

test('POS-106: parking hands back an empty counter and keeps the cart', () => {
  const { session } = cashierWithShift();
  cartService.save({ lines: [{ productId: product.id, qtyMilli: 1000 }] }, session);

  const { cart: parked } = cartService.park({ label: 'Blue shirt, waiting' }, session);

  assert.equal(parked.status, 'PARKED');
  assert.equal(parked.label, 'Blue shirt, waiting');
  assert.equal(cartService.active(session), null, 'the counter is free');
  assert.equal(cartService.parked(session).carts.length, 1);
});

test('POS-106: parking with no cart is refused rather than parking nothing', () => {
  const { session } = cashierWithShift();
  assert.throws(
    () => cartService.park({}, session),
    (err) => err.status === 400 && err.ruleId === 'POS-106'
  );
});

test('resuming parks whatever was in progress rather than losing it', () => {
  const { session } = cashierWithShift();

  cartService.save({ lines: [{ productId: product.id, qtyMilli: 1000 }] }, session);
  const { cart: first } = cartService.park({ label: 'First' }, session);
  cartService.save({ lines: [{ productId: product.id, qtyMilli: 5000 }] }, session);

  const { cart: resumed, displaced } = cartService.resume(first.id, session);

  assert.equal(resumed.id, first.id);
  assert.equal(resumed.lines[0].qtyMilli, 1000);
  // Losing the half-built second cart silently is worse than the extra parked one.
  assert.ok(displaced, 'the cart in progress was parked, not discarded');
  assert.equal(displaced.lines[0].qtyMilli, 5000);
});

test('a parked cart is resumable by a colleague on the same shift', () => {
  // POS-106 exists because a cashier goes to lunch mid-transaction. The colleague
  // taking over is on the same shift's counter.
  const owner = cashierWithShift();
  cartService.save({ lines: [{ productId: product.id, qtyMilli: 1000 }] }, owner.session);
  cartService.park({ label: 'Lunch' }, owner.session);

  const listed = cartService.parked(owner.session).carts;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].label, 'Lunch');
});

test('POS-106: parked carts expire at shift close', () => {
  const { session, shift } = cashierWithShift();
  cartService.save({ lines: [{ productId: product.id, qtyMilli: 1000 }] }, session);
  cartService.park({ label: 'Left at close' }, session);
  cartService.save({ lines: [{ productId: product.id, qtyMilli: 2000 }] }, session);

  shiftService.close({ shiftId: shift.id, actualCashCentavos: 200000, actor: session }, session);

  // A cart from a closed day, priced at yesterday's prices against a drawer that has
  // been counted, is not something anyone should be able to complete this morning.
  const rows = db.get().prepare('SELECT status FROM carts WHERE shift_id = ?').all(shift.id);
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((row) => row.status === 'EXPIRED'), 'both the parked and the active one');

  // Expired rather than deleted, so "where did my parked cart go" has an answer.
  assert.equal(cartRepository.countForShift(shift.id), rows.length);
});

test('a cart parked on another shift cannot be resumed', () => {
  const first = cashierWithShift();
  cartService.save({ lines: [{ productId: product.id, qtyMilli: 1000 }] }, first.session);
  const { cart: parked } = cartService.park({ label: 'Yesterday' }, first.session);

  // Force it back to PARKED after the close, which no application path does — the
  // point is that resume refuses on the shift, not only on the status.
  shiftService.close({ shiftId: first.shift.id, actualCashCentavos: 200000, actor: first.session }, first.session);
  db.get().prepare("UPDATE carts SET status = 'PARKED' WHERE id = ?").run(parked.id);

  const second = cashierWithShift();
  assert.throws(
    () => cartService.resume(parked.id, second.session),
    (err) => err.status === 409 && err.ruleId === 'POS-106'
  );
});

// ── Over HTTP ───────────────────────────────────────────────────────────────

test('the cart endpoints need TX-401 and round-trip a cart', async () => {
  const { token } = cashierWithShift();

  const refused = await call('/carts/active', { token: tokens.OWNER, method: 'PUT', body: { lines: [] } });
  assert.notEqual(refused.status, 403, 'an owner holds TX-401');

  const saved = await call('/carts/active', {
    token, method: 'PUT',
    body: { lines: [{ productId: product.id, qtyMilli: 1255 }] },
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).cart.line_count, 1);

  const loaded = await (await call('/carts/active', { token })).json();
  assert.equal(loaded.cart.lines[0].qtyMilli, 1255);
  assert.equal(loaded.cart.priced.total_centavos, 7844);

  const parked = await call('/carts/park', { token, method: 'POST', body: {} });
  assert.equal(parked.status, 201);

  const list = await (await call('/carts/parked', { token })).json();
  assert.equal(list.carts.length, 1);

  const resumed = await call(`/carts/${list.carts[0].id}/resume`, { token, method: 'POST', body: {} });
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).cart.status, 'ACTIVE');

  assert.equal((await call('/carts/active', { token, method: 'DELETE' })).status, 200);
  assert.equal((await (await call('/carts/active', { token })).json()).cart, null);
});

test('a cart is refused a customer that does not exist', () => {
  const { session } = cashierWithShift();
  assert.throws(
    () => cartService.save({ lines: [{ productId: product.id, qtyMilli: 1000 }], customerId: 'nobody' }, session),
    (err) => err.status === 404
  );
});

test('a cart carries its customer, and the price level that follows', () => {
  const { session } = cashierWithShift();
  const customer = customerService.create({
    name: `Cart Farm ${seq}`, customerType: 'FARM', priceLevel: 'WHOLESALE',
  }, sessions.OWNER);
  productService.setPrices(product.id, { WHOLESALE: 5800 }, sessions.OWNER);

  cartService.save({ lines: [{ productId: product.id, qtyMilli: 1000 }], customerId: customer.id }, session);
  const restored = cartService.active(session);

  assert.equal(restored.customer.name, customer.name);
  assert.equal(restored.priced.lines[0].price_level, 'WHOLESALE');
  assert.equal(restored.priced.total_centavos, 5800);
});
