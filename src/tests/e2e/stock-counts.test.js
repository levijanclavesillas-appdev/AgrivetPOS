'use strict';

// TC-E2E-19 — count two hundred products while the shop trades, approve, post, reconcile.
//
// The scale is the point of doing this at all: the rules are proved by the integration
// cases on three products, and what a walk of two hundred adds is that the freeze holds
// across a session long enough for real trading to happen inside it, and that the
// ledger still reconciles afterwards.
//
// The shape of the walk is a real stocktake and not a tidy one:
//
//   • the clerk counts most of the shop but **does not reach every aisle**, because
//     nobody ever does — and the products they never reach must come out the other end
//     untouched;
//   • the shop **keeps selling** in the middle, which is the whole reason INV-110
//     exists;
//   • the clerk **cannot approve their own count**, so a manager does (INV-112);
//   • and the ledger is reconciled at the end — `INV-101`'s stored balance against the
//     sum of its own movements, across every product in the shop.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const inventoryService = require('../../services/inventoryService');
const shiftService = require('../../services/shiftService');
const inventoryRepository = require('../../repositories/inventoryRepository');
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';

/** Two hundred products: the size at which "count everything" stops being a list. */
const PRODUCTS = 200;
/** How many the clerk gets through before the shift ends. Nobody ever finishes. */
const REACHED = 170;
/** Of those, how many are genuinely wrong. A real shop finds a handful. */
const SHORT_AT = [3, 17, 42, 88, 131];
const OVER_AT = [9, 64, 150];

let instance;
let BASE = null;
const tokens = {};
const sessions = {};
let products = [];
let sold = [];
let session;

const call = (pathname, { method = 'GET', body = null, who = 'bodega' } = {}) => fetch(`${BASE}${pathname}`, {
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

const refusal = async (res, { status, ruleId }) => {
  const body = await res.json();
  assert.equal(res.status, status, JSON.stringify(body));
  assert.equal(body.error.rule_id, ruleId);
  return body.error;
};

const onHand = (productId) => inventoryRepository.qtyOnHand(productId);

test.before(async () => {
  temp.openMigrated('stock-counts-e2e');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;

  temp.seedStore({ withOwner: false, taxMode: 'NONE' });
  const ref = temp.seedCatalog();

  // Bodega counts, Rosa approves, Chachi owns the store. INV-112 needs the first two
  // to be different people or the control is one person asserted twice.
  for (const [who, role] of [['chachi', 'OWNER'], ['rosa', 'MANAGER'], ['bodega', 'INVENTORY'], ['tess', 'CASHIER']]) {
    temp.seedUser({ username: who, role, password: PASSWORD });
    tokens[who] = authService.login({ username: who, password: PASSWORD }).token;
    sessions[who] = authService.verifyToken(tokens[who]);
  }

  for (let i = 0; i < PRODUCTS; i += 1) {
    const product = productService.create({
      sku: `STK-${String(i).padStart(4, '0')}`,
      name: `Shelf Line ${String(i).padStart(4, '0')}`,
      categoryId: ref.category.id,
      baseUnitId: ref.kg.id,
      retailPriceCentavos: 5000 + i,
    }, sessions.chachi);
    inventoryService.postStandalone({
      productId: product.id,
      type: 'OPENING',
      qtyMilli: 20000 + i * 10,
      unitCostCentavos: 3000 + i,
      actor: sessions.chachi,
    });
    products.push(product);
  }

  shiftService.open({ actor: sessions.tess, openingFloatCentavos: 200000, confirmed: true });
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

test('TC-E2E-19 · the clerk opens a count and the whole shop is frozen', async () => {
  const opened = await json(await call('/stock-counts', {
    method: 'POST', body: { scope: 'ALL', notes: 'Monthly count' },
  }));
  session = opened.session;

  assert.match(session.count_no, /^SC-\d{8}-\d{6}$/);
  assert.equal(session.status, 'OPEN');
  assert.equal(session.line_count, PRODUCTS, 'every product in the shop is in scope');
  assert.equal(session.counted_count, 0, 'and none of them has a figure yet');

  // INV-110's freeze, verified against the live figure rather than assumed.
  const view = await json(await call(`/stock-counts/${session.id}?limit=5000`));
  for (const line of view.lines.slice(0, 20)) {
    assert.equal(line.expected_milli, onHand(line.product_id));
    assert.equal(line.is_counted, false);
    assert.equal(line.counted_milli, null, 'a blank, not a zero');
  }

  // The sentence a store would otherwise report as a bug.
  assert.match(session.variance_basis, /not against stock now/);
});

test('TC-E2E-19 · the shop keeps trading while the aisles are walked', async () => {
  // Ten sales, on products the clerk has already counted and on products they have
  // not. Either way the frozen figures must not move.
  for (let i = 0; i < 10; i += 1) {
    const product = products[i * 7];
    const before = onHand(product.id);
    await json(await call('/sales', {
      method: 'POST', who: 'tess',
      body: {
        lines: [{ productId: product.id, qtyMilli: 1000 }],
        tenders: [{ method: 'CASH', amountCentavos: 50000 }],
      },
    }));
    assert.equal(onHand(product.id), before - 1000, 'the shelf moved');
    sold.push(product);
  }

  const view = await json(await call(`/stock-counts/${session.id}?limit=5000`));
  for (const product of sold) {
    const line = view.lines.find((l) => l.product_id === product.id);
    assert.equal(line.expected_milli, onHand(product.id) + 1000,
      'INV-110: the count still holds what the system believed at the freeze');
  }
});

test('TC-E2E-19 · the clerk counts 170 of the 200, and gets five wrong', async () => {
  const view = await json(await call(`/stock-counts/${session.id}?limit=5000`));
  const byProduct = new Map(view.lines.map((l) => [l.product_id, l]));

  // Sent in batches, as a screen saving in the background would.
  const batch = [];
  for (let i = 0; i < REACHED; i += 1) {
    const line = byProduct.get(products[i].id);
    let counted = line.expected_milli;
    if (SHORT_AT.includes(i)) counted -= 2000;
    if (OVER_AT.includes(i)) counted += 3000;
    batch.push({ productId: products[i].id, countedMilli: counted });
  }

  for (let i = 0; i < batch.length; i += 50) {
    const saved = await json(await call(`/stock-counts/${session.id}/lines`, {
      method: 'PUT', body: { lines: batch.slice(i, i + 50) },
    }));
    assert.ok(saved.session.counted_count > 0);
  }

  const after = await json(await call(`/stock-counts/${session.id}?limit=5000`));
  assert.equal(after.session.counted_count, REACHED);
  assert.equal(after.session.uncounted_count, PRODUCTS - REACHED, 'thirty aisles nobody reached');
  assert.equal(after.session.varying_count, SHORT_AT.length + OVER_AT.length);
});

test('TC-E2E-19 · the clerk cannot approve their own count, and the manager can', async () => {
  // §10 keeps TX-408 away from the clerk entirely, so this is refused at the route.
  const atTheDoor = await call(`/stock-counts/${session.id}/approve`, { method: 'POST' });
  assert.equal(atTheDoor.status, 403);
  assert.equal((await atTheDoor.json()).error.rule_id, 'TX-408');

  // And posting is refused before anybody has approved.
  await refusal(
    await call(`/stock-counts/${session.id}/post`, { method: 'POST' }),
    { status: 409, ruleId: 'INV-112' }
  );

  const approved = await json(await call(`/stock-counts/${session.id}/approve`, {
    method: 'POST', who: 'rosa',
  }));
  assert.equal(approved.session.status, 'APPROVED');
  assert.equal(approved.session.approved_by, 'rosa');
  assert.equal(approved.session.approval_waived, false, 'this store has more than one user');
});

test('TC-E2E-19 · posting writes one movement per varying product, and nothing else', async () => {
  const before = new Map(products.map((p) => [p.id, onHand(p.id)]));

  const posted = await json(await call(`/stock-counts/${session.id}/post`, {
    method: 'POST', body: { reason: 'Monthly count' },
  }));

  assert.equal(posted.session.status, 'POSTED');
  assert.equal(posted.posting.varying_products, SHORT_AT.length + OVER_AT.length);
  assert.equal(posted.posting.movements.length, SHORT_AT.length + OVER_AT.length);
  assert.equal(posted.posting.matched_products, REACHED - SHORT_AT.length - OVER_AT.length);
  assert.equal(posted.posting.uncounted_products, PRODUCTS - REACHED);

  // INV-111's absence, at scale: 192 of the 200 products got nothing at all.
  let moved = 0;
  for (const product of products) {
    if (onHand(product.id) !== before.get(product.id)) moved += 1;
  }
  assert.equal(moved, SHORT_AT.length + OVER_AT.length,
    'only the varying products moved — not the matched ones, and not the uncounted ones');

  // INV-110, at the end: a product that was both sold during the count and short at
  // the count keeps both facts. Product 0 was sold (index 0 is in `sold`) and is one
  // of the short ones is not — so check the two categories separately.
  for (const product of sold) {
    const index = products.indexOf(product);
    if (SHORT_AT.includes(index) || OVER_AT.includes(index)) continue;
    assert.equal(onHand(product.id), before.get(product.id),
      'a product sold during the count but counted correctly is untouched by the posting');
  }

  // The uncounted tail is exactly as it was.
  for (let i = REACHED; i < PRODUCTS; i += 1) {
    assert.equal(onHand(products[i].id), before.get(products[i].id));
  }
});

test('TC-E2E-19 · the variance report values it at the frozen cost, both ways round', async () => {
  const report = await json(await call(`/stock-counts/${session.id}/variance`, { who: 'rosa' }));

  assert.equal(report.variance.varying_products, SHORT_AT.length + OVER_AT.length);
  assert.equal(report.variance.shortage_products, SHORT_AT.length);
  assert.equal(report.variance.surplus_products, OVER_AT.length);
  assert.ok(report.variance.shortage_value_centavos < 0, 'a shortage is a loss');
  assert.ok(report.variance.surplus_value_centavos > 0);
  assert.equal(
    report.variance.net_value_centavos,
    report.variance.shortage_value_centavos + report.variance.surplus_value_centavos
  );

  // The coverage figure, which is what says whether this was a stocktake of the shop.
  assert.equal(report.coverage.products_in_scope, PRODUCTS);
  assert.equal(report.coverage.counted, REACHED);
  assert.equal(report.coverage.uncounted, PRODUCTS - REACHED);

  // Both sides shown separately, because a shortage is shrinkage and a surplus is
  // usually a receipt nobody posted — and a net figure hides one behind the other.
  assert.match(report.variance.basis, /average cost as it stood when the count was opened/);
});

test('TC-E2E-19 · the ledger reconciles across every product afterwards', () => {
  // INV-101: the stored balance is a materialised running total, and it must equal the
  // sum of the movements behind it — for all two hundred products, after a count that
  // wrote movements for eight of them while the shop was selling.
  assert.deepEqual(inventoryRepository.reconciliationBreaks(), []);

  const reconciled = inventoryService.reconcile();
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled.breaks));
});

test('TC-E2E-19 · a posted count is immutable, and the trail holds the whole session', async () => {
  await refusal(
    await call(`/stock-counts/${session.id}/lines`, {
      method: 'PUT', body: { lines: [{ productId: products[0].id, countedMilli: 1 }] },
    }),
    { status: 409, ruleId: 'INV-110' }
  );
  await refusal(
    await call(`/stock-counts/${session.id}/post`, { method: 'POST' }),
    { status: 409, ruleId: 'INV-102' }
  );

  // AUD-601 and INV-110: opened, approved and posted are three rows, and the first is
  // what answers "what was this measured against" a year from now.
  const trail = await json(await call(
    `/audit?entity=stock_count_sessions&limit=50`, { who: 'chachi' }
  ));
  const mine = trail.rows.filter((row) => row.entity_id === session.id);
  assert.deepEqual(
    mine.map((row) => row.action).sort(),
    ['STOCK_COUNT_APPROVED', 'STOCK_COUNT_OPENED', 'STOCK_COUNT_POSTED']
  );

  const opened = mine.find((row) => row.action === 'STOCK_COUNT_OPENED');
  assert.equal(opened.after.products_frozen, PRODUCTS);
  assert.ok(opened.after.frozen_at, 'INV-110: the instant everything is relative to');

  const postedRow = mine.find((row) => row.action === 'STOCK_COUNT_POSTED');
  assert.equal(postedRow.after.varying_products, SHORT_AT.length + OVER_AT.length);
  assert.equal(postedRow.after.matched_products, REACHED - SHORT_AT.length - OVER_AT.length);
  assert.equal(postedRow.after.uncounted_products, PRODUCTS - REACHED);
});
