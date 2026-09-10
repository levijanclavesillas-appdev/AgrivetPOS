'use strict';

// FT-209 — the stocktake. INV-110 to INV-113.
//
// The four named cases are `TC-INT-88` to `TC-INT-91`, and `TC-INT-88` is the one the
// whole feature turns on: **the shop trades in the middle of the count and the variance
// does not move.** It is written so the wrong implementation fails loudly rather than
// subtly — the case sells stock between the freeze and the posting, and asserts both
// the variance the count reports *and* the on-hand figure afterwards, because the two
// naive mistakes (measuring against live stock, and setting stock to the counted
// figure) each get one of those two right.
//
// `TC-INT-89` asserts an absence, which is the harder half of INV-111: a product that
// matched writes no movement, and a suite that only checked the varying ones would
// pass against an implementation that wrote a movement of zero for every product in
// the shop — noise the ledger would then carry for ever.
//
// The fifth thing this file guards is not in the rule document at all: **a blank is not
// a zero.** An uncounted line writes nothing. Defaulting it would write off the whole
// unreached remainder of a shop as shrinkage, and it is one keystroke away.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const inventoryService = require('../../services/inventoryService');
const shiftService = require('../../services/shiftService');
const saleService = require('../../services/saleService');
const stockCountService = require('../../services/stockCountService');
const settingsService = require('../../services/settingsService');
const auditService = require('../../services/auditService');
const permissions = require('../../services/permissions');
const inventoryRepository = require('../../repositories/inventoryRepository');
const productRepository = require('../../repositories/productRepository');
const stockCountRepository = require('../../repositories/stockCountRepository');
// Required lazily inside the cases: batchService reads settings that this file's own
// before-hook has not written when the module list is evaluated.
const batchService = () => require('../../services/batchService');
const temp = require('../helpers/tempdb');

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

let seq = 0;

function stocked({ qtyMilli = 10000, cost = 4000, retail = 6250, category = null } = {}) {
  seq += 1;
  const product = productService.create({
    sku: `CNT-${String(seq).padStart(3, '0')}`,
    name: `Count Test Line ${String(seq).padStart(3, '0')}`,
    categoryId: (category || ref.category).id,
    baseUnitId: ref.kg.id,
    retailPriceCentavos: retail,
  }, sessions.OWNER);

  if (qtyMilli > 0) {
    inventoryService.postStandalone({
      productId: product.id, type: 'OPENING', qtyMilli, unitCostCentavos: cost, actor: sessions.OWNER,
    });
  }
  return productRepository.findById(product.id);
}

const onHand = (productId) => inventoryRepository.qtyOnHand(productId);
const lineFor = (view, productId) => view.lines.find((l) => l.product_id === productId);

test.before(async () => {
  temp.openEmpty('stock-counts');
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

  shiftService.open({ actor: sessions.CASHIER, openingFloatCentavos: 100000, confirmed: true });
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── TC-INT-88 — INV-110 ─────────────────────────────────────────────────────

test('TC-INT-88: INV-110 — trading during a session does not change its variance', () => {
  // 10 KG on the shelf at the freeze. The counter finds 9 — one is genuinely missing.
  // Then the shop sells 2 before anybody posts.
  const product = stocked({ qtyMilli: 10000 });
  const opened = stockCountService.open({ scope: 'ALL' }, sessions.INVENTORY);
  const sessionId = opened.session.id;

  const frozen = lineFor(opened, product.id);
  assert.equal(frozen.expected_milli, 10000, 'INV-110: frozen at what the system held');
  assert.equal(frozen.is_counted, false, 'and nothing is counted yet');

  stockCountService.record(sessionId, {
    lines: [{ productId: product.id, countedMilli: 9000 }],
  }, sessions.INVENTORY);

  // The shop trades. This is the whole point of the rule.
  saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 2000 }],
    tenders: [{ method: 'CASH', amountCentavos: 100000 }],
  }, sessions.CASHIER);
  assert.equal(onHand(product.id), 8000, 'live stock has moved under the count');

  // The variance is still measured against 10, not against 8.
  const during = stockCountService.get(sessionId);
  const line = lineFor(during, product.id);
  assert.equal(line.expected_milli, 10000, 'the frozen figure did not follow the shelf');
  assert.equal(line.variance_milli, -1000, 'INV-110: 9 counted against 10 frozen is −1');

  stockCountService.approve(sessionId, {}, sessions.MANAGER);
  const posted = stockCountService.post(sessionId, {}, sessions.INVENTORY);

  // The movement is the *variance*, not the counted figure.
  const movement = posted.posting.movements.find((m) => m.product === product.name);
  assert.equal(movement.variance_milli, -1000);

  // And this is the assertion that separates the two wrong implementations from the
  // right one. Posting −1 leaves 8 − 1 = 7: nine really were there, two have since
  // been sold. Measuring against live stock would have posted +1 and reported a
  // surplus; setting stock to the counted figure would have left 9 and erased a sale.
  assert.equal(onHand(product.id), 7000,
    'the sale during the count survives, and the missing sack is written off');
});

test('INV-110: the freeze is a stored column, and the payload says what it is relative to', () => {
  const product = stocked({ qtyMilli: 5000 });
  const opened = stockCountService.open({ scope: 'ALL' }, sessions.INVENTORY);

  // Read straight out of the table: the guarantee is a column, not a convention.
  const stored = stockCountRepository.findLine(opened.session.id, product.id);
  assert.equal(stored.expected_milli, 5000);
  assert.equal(stored.avg_cost_centavos, 4000, 'MON-004 frozen with it');

  // A delivery moves both the shelf and the average, and the frozen line moves neither.
  inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli: 5000, unitCostCentavos: 8000, actor: sessions.OWNER,
  });
  const after = stockCountRepository.findLine(opened.session.id, product.id);
  assert.equal(after.expected_milli, 5000);
  assert.equal(after.avg_cost_centavos, 4000, 'the variance will be valued at what it was worth then');

  // The sentence a store would otherwise think is a bug.
  assert.match(opened.session.variance_basis, /not against stock now/);
  assert.match(opened.session.variance_basis, /anything sold since the count began stays sold/);

  stockCountService.cancel(opened.session.id, { reason: 'Fixture' }, sessions.INVENTORY);
});

// ── TC-INT-89 — INV-111 ─────────────────────────────────────────────────────

test('TC-INT-89: INV-111 — no movement for a product that matched', () => {
  const matched = stocked({ qtyMilli: 4000 });
  const short = stocked({ qtyMilli: 4000 });

  const opened = stockCountService.open({ scope: 'ALL' }, sessions.INVENTORY);
  const sessionId = opened.session.id;

  const before = {
    matched: inventoryService.ledger(matched.id, { limit: 20 }).movements.length,
    short: inventoryService.ledger(short.id, { limit: 20 }).movements.length,
  };

  stockCountService.record(sessionId, {
    lines: [
      { productId: matched.id, countedMilli: 4000 },      // exactly right
      { productId: short.id, countedMilli: 3000 },        // one short
    ],
  }, sessions.INVENTORY);

  stockCountService.approve(sessionId, {}, sessions.MANAGER);
  const posted = stockCountService.post(sessionId, {}, sessions.INVENTORY);

  // One movement, for the one that varied.
  assert.equal(posted.posting.movements.length, 1);
  assert.equal(posted.posting.movements[0].product, short.name);
  assert.equal(posted.posting.matched_products, 1, 'and the matched one is counted as matched');

  // The absence, asserted directly. A movement of zero would be noise every product in
  // the shop carries for ever, and a suite that only checked the varying line would
  // pass against exactly that.
  const afterMatched = inventoryService.ledger(matched.id, { limit: 20 }).movements;
  assert.equal(afterMatched.length, before.matched, 'the matched product got no movement at all');
  assert.equal(afterMatched.some((m) => m.type === 'COUNT_VARIANCE'), false);

  const afterShort = inventoryService.ledger(short.id, { limit: 20 }).movements;
  assert.equal(afterShort.length, before.short + 1);
  assert.equal(afterShort[0].type, 'COUNT_VARIANCE', 'INV-103: of the declared type');
  assert.ok(afterShort[0].reason, 'and it carries a reason');
  assert.equal(afterShort[0].reference.no, opened.session.count_no, 'citing the count');

  // The line records which of the two it was, so the pair stays legible afterwards.
  const view = stockCountService.get(sessionId);
  assert.equal(lineFor(view, matched.id).matched, true);
  assert.equal(lineFor(view, matched.id).movement_id, null);
  assert.ok(lineFor(view, short.id).movement_id);
});

test('INV-111: an uncounted line is not a zero, and writes nothing', () => {
  // The most expensive mistake this feature could make: posting a half-finished count
  // and writing off everything nobody reached.
  const counted = stocked({ qtyMilli: 3000 });
  const neverReached = stocked({ qtyMilli: 7000 });

  const opened = stockCountService.open({ scope: 'ALL' }, sessions.INVENTORY);
  stockCountService.record(opened.session.id, {
    lines: [{ productId: counted.id, countedMilli: 2000 }],
  }, sessions.INVENTORY);

  const before = onHand(neverReached.id);
  stockCountService.approve(opened.session.id, {}, sessions.MANAGER);
  const posted = stockCountService.post(opened.session.id, {}, sessions.INVENTORY);

  assert.equal(onHand(neverReached.id), before, 'the aisle nobody reached is untouched');
  assert.ok(posted.posting.uncounted_products >= 1,
    'and the posting says how many were never counted');

  // A blank and a zero are different answers, and the payload keeps them apart.
  const view = stockCountService.get(opened.session.id);
  const untouched = lineFor(view, neverReached.id);
  assert.equal(untouched.is_counted, false);
  assert.equal(untouched.counted_milli, null);
  assert.equal(untouched.variance_milli, null);
  assert.equal(untouched.movement_id, null);

  // And a counted zero *is* a zero: an empty shelf writes the whole quantity off.
  const emptied = stocked({ qtyMilli: 2000 });
  const second = stockCountService.open({ scope: 'ALL' }, sessions.INVENTORY);
  stockCountService.record(second.session.id, {
    lines: [{ productId: emptied.id, countedMilli: 0 }],
  }, sessions.INVENTORY);
  stockCountService.approve(second.session.id, {}, sessions.MANAGER);
  stockCountService.post(second.session.id, {}, sessions.INVENTORY);
  assert.equal(onHand(emptied.id), 0, 'a shelf counted as empty is written down to nothing');
});

test('INV-110: a line can be cleared back to uncounted after a mis-key', () => {
  const product = stocked({ qtyMilli: 6000 });
  const opened = stockCountService.open({ scope: 'ALL' }, sessions.INVENTORY);

  stockCountService.record(opened.session.id, {
    lines: [{ productId: product.id, countedMilli: 60 }],   // typed into the wrong row
  }, sessions.INVENTORY);
  assert.equal(lineFor(stockCountService.get(opened.session.id), product.id).is_counted, true);

  stockCountService.record(opened.session.id, {
    lines: [{ productId: product.id, countedMilli: null }],
  }, sessions.INVENTORY);

  // Back to blank, not to zero — which is the only reason blank and zero can be
  // different in the first place.
  const cleared = lineFor(stockCountService.get(opened.session.id), product.id);
  assert.equal(cleared.is_counted, false);
  assert.equal(cleared.counted_milli, null);

  stockCountService.cancel(opened.session.id, { reason: 'Fixture' }, sessions.INVENTORY);
});

// ── TC-INT-90 — INV-112 ─────────────────────────────────────────────────────

test('TC-INT-90: INV-112 — self-approval is refused, and the refusal names the reason', () => {
  const product = stocked({ qtyMilli: 1000 });
  const opened = stockCountService.open({ scope: 'ALL' }, sessions.INVENTORY);
  stockCountService.record(opened.session.id, {
    lines: [{ productId: product.id, countedMilli: 900 }],
  }, sessions.INVENTORY);

  // The clerk who counted cannot release their own count, whatever they hold.
  assert.throws(
    () => stockCountService.approve(opened.session.id, { approver: { username: 'inventory' } }, sessions.INVENTORY),
    (err) => err.ruleId === 'TX-408' || err.ruleId === 'INV-112'
  );

  // Nor can a manager who took the count themselves — the rule is about identity, not
  // about role, because a stocktake is where shrinkage is written off.
  const managerCount = stockCountService.open({ scope: 'ALL' }, sessions.MANAGER);
  assert.throws(
    () => stockCountService.approve(managerCount.session.id, {}, sessions.MANAGER),
    (err) => err.ruleId === 'INV-112' && err.status === 403
      && /one person counting and approving their own/.test(err.message)
  );
  stockCountService.cancel(managerCount.session.id, { reason: 'Fixture' }, sessions.MANAGER);

  // A second person, holding TX-408, may.
  const approved = stockCountService.approve(opened.session.id, {}, sessions.MANAGER);
  assert.equal(approved.session.status, 'APPROVED');
  assert.equal(approved.session.approved_by, 'manager');
  assert.equal(approved.session.approval_waived, false);
  assert.equal(approved.approval.waived, false);

  // AUD-601: on the trail, with both names.
  const trail = auditService.browse({ action: 'STOCK_COUNT_APPROVED', entityId: opened.session.id });
  assert.equal(trail.rows.length, 1);
  assert.equal(trail.rows[0].after.counted_by, 'inventory');
  assert.equal(trail.rows[0].after.approved_by, 'manager');
  assert.equal(trail.rows[0].after.approval_waived, false);

  stockCountService.post(opened.session.id, {}, sessions.INVENTORY);
});

// ── TC-INT-91 — INV-113 ─────────────────────────────────────────────────────

test('TC-INT-91: INV-113 — a stale session needs an owner, and says how old it is', () => {
  const product = stocked({ qtyMilli: 8000 });
  const opened = stockCountService.open({ scope: 'ALL' }, sessions.INVENTORY);
  stockCountService.record(opened.session.id, {
    lines: [{ productId: product.id, countedMilli: 7000 }],
  }, sessions.INVENTORY);
  stockCountService.approve(opened.session.id, {}, sessions.MANAGER);

  // The window is a setting, so the test moves the setting rather than the clock — and
  // a session opened today is stale under a window of zero days only if the comparison
  // is `>`, which it is not. So the session is aged by moving its opened_at instead,
  // through the same freeze the rule measures from.
  settingsService.set('stock_count_stale_days', 7, sessions.OWNER);
  ageSession(opened.session.id, 10);

  const aged = stockCountService.get(opened.session.id);
  assert.equal(aged.session.stale, true);
  assert.equal(aged.session.days_open, 10);

  assert.throws(
    () => stockCountService.post(opened.session.id, {}, sessions.INVENTORY),
    (err) => err.ruleId === 'INV-113' && err.status === 403 && err.requiresRole === 'OWNER'
      && /everything sold since is not shrinkage/.test(err.message)
  );

  // A manager is not enough: the rule names the owner.
  assert.throws(
    () => stockCountService.post(opened.session.id, { approver: { username: 'manager' } }, sessions.INVENTORY),
    (err) => err.ruleId === 'INV-113' && /only an owner/i.test(err.message)
  );

  const posted = stockCountService.post(
    opened.session.id, { approver: { username: 'owner' } }, sessions.INVENTORY
  );
  assert.equal(posted.session.was_stale, true, 'recorded on the row, not inferred from the dates');
  assert.equal(posted.session.stale_approved_by, 'owner');
  assert.equal(posted.posting.stale_authorised_by, 'owner');

  // AUD-603's shape: two distinct actors on a row of its own.
  const overrides = auditService.browse({ action: 'OVERRIDE_STALE_STOCK_COUNT' });
  const row = overrides.rows.find((e) => e.entity_id === opened.session.id);
  assert.ok(row, 'the override has its own row');
  assert.equal(row.actor.username, 'inventory');
  assert.equal(row.approver.username, 'owner');
});

test('INV-113: an owner posting their own stale count needs nobody else', () => {
  const product = stocked({ qtyMilli: 2000 });
  const opened = stockCountService.open({ scope: 'ALL' }, sessions.OWNER);
  stockCountService.record(opened.session.id, {
    lines: [{ productId: product.id, countedMilli: 1500 }],
  }, sessions.OWNER);
  stockCountService.approve(opened.session.id, {}, sessions.MANAGER);
  ageSession(opened.session.id, 30);

  // INV-113 asks for owner authority, not for two people — the same carve-out INV-108
  // already makes for a large adjustment.
  const posted = stockCountService.post(opened.session.id, {}, sessions.OWNER);
  assert.equal(posted.session.was_stale, true);
  assert.equal(posted.posting.stale_authorised_by, 'owner');

  // No override row, because there was no second actor to record.
  const overrides = auditService.browse({ action: 'OVERRIDE_STALE_STOCK_COUNT' });
  assert.equal(overrides.rows.some((e) => e.entity_id === opened.session.id), false);
});

// ── The variance report, the machine, and the API ───────────────────────────

test('requirement 8: the variance report splits shortage from surplus and values both', () => {
  const short = stocked({ qtyMilli: 10000, cost: 5000 });    // 10 KG at ₱50.00
  const over = stocked({ qtyMilli: 10000, cost: 2000 });     // 10 KG at ₱20.00
  const same = stocked({ qtyMilli: 10000, cost: 9000 });

  const opened = stockCountService.open({ scope: 'ALL' }, sessions.INVENTORY);
  stockCountService.record(opened.session.id, {
    lines: [
      { productId: short.id, countedMilli: 8000 },           // −2 KG at ₱50 = −₱100
      { productId: over.id, countedMilli: 13000 },           // +3 KG at ₱20 = +₱60
      { productId: same.id, countedMilli: 10000 },
    ],
  }, sessions.INVENTORY);
  stockCountService.approve(opened.session.id, {}, sessions.MANAGER);
  stockCountService.post(opened.session.id, {}, sessions.INVENTORY);

  const report = stockCountService.varianceReport(opened.session.id);

  // Both sides separately: a shortage is shrinkage and a surplus is usually a receipt
  // nobody posted, and a net figure hides one behind the other.
  assert.equal(report.variance.shortage_products >= 1, true);
  assert.equal(report.variance.surplus_products >= 1, true);
  assert.ok(report.variance.shortage_value_centavos < 0);
  assert.ok(report.variance.surplus_value_centavos > 0);
  assert.equal(
    report.variance.net_value_centavos,
    report.variance.shortage_value_centavos + report.variance.surplus_value_centavos
  );
  assert.match(report.variance.basis, /average cost as it stood when the count was opened/);

  // The matched product is not in the report at all, and the coverage figure is what
  // says whether this was a stocktake of the shop or of one aisle of it.
  assert.equal(report.lines.some((l) => l.product_id === same.id), false);
  assert.equal(report.coverage.counted + report.coverage.uncounted, report.coverage.products_in_scope);

  // The values are the frozen costs. A delivery now must not restate a loss already taken.
  inventoryService.postStandalone({
    productId: short.id, type: 'RECEIPT', qtyMilli: 100000, unitCostCentavos: 20000, actor: sessions.OWNER,
  });
  const later = stockCountService.varianceReport(opened.session.id);
  assert.equal(later.variance.net_value_centavos, report.variance.net_value_centavos);
});

test('INV-102: a posted count is immutable, and an abandoned one says why', () => {
  const product = stocked({ qtyMilli: 1000 });
  const opened = stockCountService.open({ scope: 'ALL' }, sessions.INVENTORY);
  stockCountService.record(opened.session.id, {
    lines: [{ productId: product.id, countedMilli: 900 }],
  }, sessions.INVENTORY);
  stockCountService.approve(opened.session.id, {}, sessions.MANAGER);
  stockCountService.post(opened.session.id, {}, sessions.INVENTORY);

  assert.throws(
    () => stockCountService.record(opened.session.id, {
      lines: [{ productId: product.id, countedMilli: 500 }],
    }, sessions.INVENTORY),
    (err) => err.status === 409 && /cannot be changed/.test(err.message)
  );
  assert.throws(
    () => stockCountService.post(opened.session.id, {}, sessions.INVENTORY),
    (err) => err.ruleId === 'INV-102' && /already been posted/.test(err.message)
  );
  assert.throws(
    () => stockCountService.approve(opened.session.id, {}, sessions.MANAGER),
    (err) => err.ruleId === 'INV-112'
  );

  // An abandoned count keeps its reason: three abandoned in a row is a fact the trail
  // should be able to show.
  const abandoned = stockCountService.open({ scope: 'ALL' }, sessions.INVENTORY);
  assert.throws(
    () => stockCountService.cancel(abandoned.session.id, { reason: '' }, sessions.INVENTORY),
    (err) => err.ruleId === 'AUD-601'
  );
  const cancelled = stockCountService.cancel(
    abandoned.session.id, { reason: 'Power cut; restarting tomorrow' }, sessions.INVENTORY
  );
  assert.equal(cancelled.session.status, 'CANCELLED');
  assert.equal(cancelled.session.cancel_reason, 'Power cut; restarting tomorrow');
});

test('INV-112: posting is refused before anybody has approved', () => {
  const product = stocked({ qtyMilli: 1000 });
  const opened = stockCountService.open({ scope: 'ALL' }, sessions.INVENTORY);
  stockCountService.record(opened.session.id, {
    lines: [{ productId: product.id, countedMilli: 500 }],
  }, sessions.INVENTORY);

  assert.throws(
    () => stockCountService.post(opened.session.id, {}, sessions.INVENTORY),
    (err) => err.ruleId === 'INV-112' && /second pair of eyes/.test(err.message)
  );
  assert.equal(onHand(product.id), 1000, 'and nothing moved');

  stockCountService.cancel(opened.session.id, { reason: 'Fixture' }, sessions.INVENTORY);
});

test('INV-110: a category count freezes that category and nothing else', () => {
  const inScope = stocked({ qtyMilli: 3000, category: ref.otherCategory });
  const outOfScope = stocked({ qtyMilli: 3000, category: ref.category });

  const opened = stockCountService.open({
    scope: 'CATEGORY', categoryId: ref.otherCategory.id,
  }, sessions.INVENTORY);

  assert.ok(lineFor(opened, inScope.id), 'the category is in scope');
  assert.equal(lineFor(opened, outOfScope.id), undefined, 'and nothing else is');

  // A product outside the scope is not a line, and saying so beats writing it silently.
  assert.throws(
    () => stockCountService.record(opened.session.id, {
      lines: [{ productId: outOfScope.id, countedMilli: 1 }],
    }, sessions.INVENTORY),
    (err) => err.ruleId === 'INV-110' && /not a product in/.test(err.message)
  );

  stockCountService.cancel(opened.session.id, { reason: 'Fixture' }, sessions.INVENTORY);
});

test('SEC-6: counting is TX-407 and approving is TX-408, and the matrix is the control', async () => {
  // §10's split, which is INV-112 expressed as a permission rather than only as a check.
  assert.deepEqual(permissions.rolesHolding('TX-407').sort(), ['INVENTORY', 'MANAGER', 'OWNER']);
  assert.deepEqual(permissions.rolesHolding('TX-408').sort(), ['MANAGER', 'OWNER']);

  const product = stocked({ qtyMilli: 2000 });

  const refused = await call('/stock-counts', {
    token: tokens.CASHIER, method: 'POST', body: { scope: 'ALL' },
  });
  assert.equal(refused.status, 403, 'a cashier does not count stock');

  const created = await call('/stock-counts', {
    token: tokens.INVENTORY, method: 'POST', body: { scope: 'ALL' },
  });
  assert.equal(created.status, 201);
  const session = (await created.json()).session;
  assert.match(session.count_no, /^SC-\d{8}-\d{6}$/);

  const saved = await call(`/stock-counts/${session.id}/lines`, {
    token: tokens.INVENTORY, method: 'PUT',
    body: { lines: [{ productId: product.id, countedMilli: 1500 }] },
  });
  assert.equal(saved.status, 200);

  // The clerk cannot reach the approval at all — refused by the route, not by a check.
  const cannotApprove = await call(`/stock-counts/${session.id}/approve`, {
    token: tokens.INVENTORY, method: 'POST',
  });
  assert.equal(cannotApprove.status, 403);
  assert.equal((await cannotApprove.json()).error.rule_id, 'TX-408');

  const approved = await call(`/stock-counts/${session.id}/approve`, {
    token: tokens.MANAGER, method: 'POST',
  });
  assert.equal(approved.status, 200);

  const posted = await call(`/stock-counts/${session.id}/post`, {
    token: tokens.INVENTORY, method: 'POST', body: { reason: 'Monthly count' },
  });
  assert.equal(posted.status, 201);
  assert.equal((await posted.json()).session.status, 'POSTED');

  // A posted count is never deleted, and the refusal names the correction.
  const deleted = await call(`/stock-counts/${session.id}`, { token: tokens.INVENTORY, method: 'DELETE' });
  assert.equal(deleted.status, 409);
  assert.equal((await deleted.json()).error.rule_id, 'INV-102');

  // The report is a read, so it sits under TX-422 and a cashier may see it.
  const report = await call(`/stock-counts/${session.id}/variance`, { token: tokens.CASHIER });
  assert.equal(report.status, 200);
  assert.ok((await report.json()).variance.varying_products >= 1);
});

// ── Helpers that touch the database directly ────────────────────────────────

/**
 * Age a session by moving the freeze back, which is the column INV-113 measures from.
 *
 * The alternative — a stale window of zero days — does not work: the comparison is
 * `elapsed > window`, so a count opened today is never stale under any window, which
 * is correct and is why the clock has to be the thing that moves.
 */
function ageSession(sessionId, days) {
  const db = require('../../config/database');
  const at = new Date(Date.now() - days * 86400000).toISOString();
  db.get().prepare('UPDATE stock_count_sessions SET opened_at = ? WHERE id = ?').run(at, sessionId);
}

// ── TASK-042 — INV-201, counting batch-tracked stock by batch ───────────────
//
// `TC-INT-114` to `TC-INT-116`. The three of them are one argument: a batch-tracked
// product is counted one line per batch, a variance lands on the batch it was found
// in, and INV-201 still holds afterwards without anything having been repaired.
//
// TASK-029 left these products off the sheet entirely, because a product-level count
// has no batch to name and posting the variance FEFO would have invented which box was
// short. The two tests that pinned that exclusion are gone, replaced by these.

/** A batch-tracked product with two batches on the shelf. */
function trackedWithBatches({ first = 6000, second = 4000 } = {}) {
  // The tag is captured here rather than read from `seq` afterwards: `stocked()` shares
  // the counter, so a test that created a plain product in between would look up batch
  // numbers that belong to a different fixture.
  seq += 1;
  const tag = seq;
  const supplier = temp.seedSupplier({ name: `Count Supply ${seq}`, code: `CS${seq}` }, sessions.OWNER);
  const product = productService.create({
    sku: `CNT-B-${String(seq).padStart(3, '0')}`,
    name: `Counted Vaccine ${seq}`,
    categoryId: ref.category.id,
    baseUnitId: ref.piece.id,
    retailPriceCentavos: 32000,
    isBatchTracked: true,
  }, sessions.OWNER);

  const batchService = require('../../services/batchService');
  const batches = [
    temp.seedBatch({
      product, supplier, qtyMilli: first, unitCostCentavos: 21000,
      batchNo: `${tag}-EARLY`, expiryDate: batchService.addDays(batchService.today(), 60),
      actor: sessions.OWNER,
    }).batch,
    temp.seedBatch({
      product, supplier, qtyMilli: second, unitCostCentavos: 23000,
      batchNo: `${tag}-LATE`, expiryDate: batchService.addDays(batchService.today(), 400),
      actor: sessions.OWNER,
    }).batch,
  ];
  return { product, batches, tag };
}

const lineOf = (opened, batchNo) => stockCountService.get(opened.session.id).lines
  .find((l) => l.batch_no === batchNo);

test('TC-INT-114: a batch-tracked product is on the sheet once per batch, expiry first', () => {
  const { product, tag } = trackedWithBatches();
  const plain = stocked({ qtyMilli: 10000 });

  const opened = stockCountService.open({ scope: 'ALL' }, sessions.INVENTORY);
  const lines = stockCountService.get(opened.session.id).lines
    .filter((l) => l.product_id === product.id);

  // One line per box on the shelf, earliest expiry first — the order a counter works a
  // shelf in, and the order FEFO would take them in (INV-204).
  assert.deepEqual(
    lines.map((l) => [l.batch_no, l.expected_milli]),
    [[`${tag}-EARLY`, 6000], [`${tag}-LATE`, 4000]]
  );
  // Each carries its own date, or the counter has to look up which of two identical
  // cartons the row means.
  assert.ok(lines.every((l) => /^\d{4}-\d{2}-\d{2}$/.test(l.expiry_date)));
  // MON-004: the frozen cost is the batch's own, not the product's moving average —
  // valuing a batch variance at the average prices the loss at stock still on the shelf.
  assert.deepEqual(lines.map((l) => l.avg_cost_centavos), [21000, 23000]);

  // And a product that is not batch-tracked is counted exactly as it was before.
  const plainLines = stockCountService.get(opened.session.id).lines
    .filter((l) => l.product_id === plain.id);
  assert.equal(plainLines.length, 1);
  assert.equal(plainLines[0].batch_id, null);
  assert.equal(plainLines[0].batch_no, null);

  stockCountService.cancel(opened.session.id, { reason: 'Abandoned by the test' }, sessions.INVENTORY);
});

test('TC-INT-114: a variance on one batch posts against that batch and leaves the other alone', () => {
  const { product, batches, tag: mine } = trackedWithBatches();
  const opened = stockCountService.open({ scope: 'ALL' }, sessions.INVENTORY);

  // Two boxes short of the early batch; the late one counts exactly right.
  stockCountService.record(opened.session.id, {
    lines: [
      { lineId: lineOf(opened, `${mine}-EARLY`).id, countedMilli: 4000 },
      { lineId: lineOf(opened, `${mine}-LATE`).id, countedMilli: 4000 },
    ],
  }, sessions.INVENTORY);

  stockCountService.approve(opened.session.id, {}, sessions.MANAGER);
  const posted = stockCountService.post(opened.session.id, {}, sessions.INVENTORY);

  const mineMovements = posted.posting.movements.filter((m) => m.product === product.name);
  assert.equal(mineMovements.length, 1, 'INV-111: one movement, for the one batch that varied');
  assert.equal(mineMovements[0].batch_no, `${mine}-EARLY`);
  assert.equal(mineMovements[0].variance_milli, -2000);

  // The shrinkage came out of the box it was found missing from. Posting it FEFO would
  // have produced the same product total and the wrong batch balance — which is what
  // INV-206's recall would then have read.
  const balances = batchService().listForProduct(product.id, { includeEmpty: true })
    .map((b) => [b.batch_no, b.qty_milli]);
  assert.deepEqual(balances, [[`${mine}-EARLY`, 4000], [`${mine}-LATE`, 4000]]);
  assert.equal(batches.length, 2);
});

test('TC-INT-115: INV-201 holds after a posted count, with no repair job', () => {
  const { product, tag: mine } = trackedWithBatches({ first: 8000, second: 5000 });
  const opened = stockCountService.open({ scope: 'ALL' }, sessions.INVENTORY);

  // Both batches wrong, in opposite directions — the case where a product-level count
  // would have found no variance at all and written nothing.
  stockCountService.record(opened.session.id, {
    lines: [
      { lineId: lineOf(opened, `${mine}-EARLY`).id, countedMilli: 7000 },
      { lineId: lineOf(opened, `${mine}-LATE`).id, countedMilli: 6000 },
    ],
  }, sessions.INVENTORY);
  stockCountService.approve(opened.session.id, {}, sessions.MANAGER);
  stockCountService.post(opened.session.id, {}, sessions.INVENTORY);

  const batched = batchService().listForProduct(product.id, { includeEmpty: true })
    .reduce((sum, b) => sum + b.qty_milli, 0);
  assert.equal(batched, inventoryRepository.qtyOnHand(product.id), 'INV-201, by construction');
  assert.equal(batched, 13000, 'and the product total is unchanged, which is the trap');
  assert.deepEqual(inventoryService.reconcile().batch_breaks, []);
});

test('TC-INT-116: a batch the system thinks is empty is on the sheet, and can be counted up', () => {
  const { product, tag: mine } = trackedWithBatches({ first: 5000, second: 3000 });

  // The early batch is sold out. The system believes there is none of it left, which is
  // exactly the batch that turns up at the back of the fridge.
  const batches = batchService().listForProduct(product.id, {});
  const early = batches.find((b) => b.batch_no === `${mine}-EARLY`);
  inventoryService.postStandalone({
    productId: product.id, type: 'SALE', qtyMilli: 5000, batchId: early.id, actor: sessions.CASHIER,
  });
  assert.equal(batchService().listForProduct(product.id, {}).some((b) => b.batch_no === `${mine}-EARLY`), false);

  const opened = stockCountService.open({ scope: 'ALL' }, sessions.INVENTORY);
  const line = lineOf(opened, `${mine}-EARLY`);
  assert.ok(line, 'the exhausted batch is still on the sheet — a sheet without it has nowhere to write the discovery');
  assert.equal(line.expected_milli, 0);

  stockCountService.record(opened.session.id, {
    lines: [{ lineId: line.id, countedMilli: 1000 }],
  }, sessions.INVENTORY);
  stockCountService.approve(opened.session.id, {}, sessions.MANAGER);
  stockCountService.post(opened.session.id, {}, sessions.INVENTORY);

  const found = batchService().listForProduct(product.id, {}).find((b) => b.batch_no === `${mine}-EARLY`);
  assert.ok(found, 'and it is back on the shelf, in the batch it was found in');
  assert.equal(found.qty_milli, 1000);
  assert.deepEqual(inventoryService.reconcile().batch_breaks, []);
});

test('INV-202: a batch on the shelf that the system does not know cannot be created from a count', () => {
  const { product } = trackedWithBatches();
  const opened = stockCountService.open({ scope: 'ALL' }, sessions.INVENTORY);

  // A count sheet has no supplier and no cost to give a batch, and INV-202 makes both
  // part of its identity. The refusal names the path rather than only refusing.
  assert.throws(
    () => stockCountService.record(opened.session.id, {
      lines: [{ productId: product.id, batchId: 'not-a-batch-we-know', countedMilli: 1000 }],
    }, sessions.INVENTORY),
    (err) => {
      assert.equal(err.ruleId, 'INV-202');
      assert.match(err.message, /Buying → Receive/);
      return true;
    }
  );

  stockCountService.cancel(opened.session.id, { reason: 'Abandoned by the test' }, sessions.INVENTORY);
});

// ── Last, deliberately ──────────────────────────────────────────────────────
//
// The case below opens a **different database** — one with a single active user — to
// exercise INV-112's waiver, which depends on how many people the store has and cannot
// be asserted in a file whose own store has four. Every test above it, and the running
// server, hold this file's database, so it goes at the end rather than in the INV-112
// section where it belongs by subject.

test('TC-INT-90: a single-user store posts, and is told the second pair of eyes was not available', () => {
  // A database of its own: the waiver depends on how many active users the store has,
  // and this file's own store has four.
  temp.openEmpty('stock-counts-solo');
  require('../../config/migrate').migrate();
  temp.seedStore({ taxMode: 'NONE', withOwner: false });
  const solo = temp.seedCatalog();

  temp.seedUser({ username: 'onlyowner', role: 'OWNER', password: PASSWORD });
  const owner = authService.verifyToken(
    authService.login({ username: 'onlyowner', password: PASSWORD }).token
  );

  const product = productService.create({
    sku: 'SOLO-1', name: 'Solo Feed', categoryId: solo.category.id, baseUnitId: solo.kg.id,
    retailPriceCentavos: 5000,
  }, owner);
  inventoryService.postStandalone({
    productId: product.id, type: 'OPENING', qtyMilli: 5000, unitCostCentavos: 3000, actor: owner,
  });

  const opened = stockCountService.open({ scope: 'ALL' }, owner);
  stockCountService.record(opened.session.id, {
    lines: [{ productId: product.id, countedMilli: 4000 }],
  }, owner);

  // The rule cannot be met, so it is waived — and **stated**, not silently skipped. A
  // store that refused to post here would be a store that never counted.
  assert.deepEqual(stockCountService.approverPool(owner.id), []);
  const approved = stockCountService.approve(opened.session.id, {}, owner);
  assert.equal(approved.session.status, 'APPROVED');
  assert.equal(approved.approval.waived, true);
  assert.equal(approved.approval.rule_id, 'INV-112');
  assert.match(approved.approval.message, /no second active user/);
  assert.equal(approved.session.approval_waived, true);

  // And the waiver is on the row, not only in a response nobody keeps.
  const trail = auditService.browse({ action: 'STOCK_COUNT_APPROVED', entityId: opened.session.id });
  assert.equal(trail.rows[0].after.approval_waived, true);
  assert.match(trail.rows[0].reason, /INV-112 waived/);

  const posted = stockCountService.post(opened.session.id, {}, owner);
  assert.equal(posted.session.status, 'POSTED');
  assert.equal(require('../../repositories/inventoryRepository').qtyOnHand(product.id), 4000);
});
