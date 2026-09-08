'use strict';

// TC-E2E-10 — a cutover, from an empty catalogue to a sale.
//
// This is the case `TASK-036` exists for. Every other test in the suite starts from a
// seeded catalogue, which is exactly the state a real store is never in on its first
// morning: no categories, no units, no products, no customers, nothing.
//
// The path below is the one the deployment manual describes and the one the catalogue
// screens drive — category, unit, product, barcode, pack, price, opening stock — and
// it runs over HTTP against the same endpoints those screens call. If it passes, a
// store can be set up. If it fails, the manual is fiction.
//
// **Opening stock is posted as a costed receipt** (`OPS-106`). Not an adjustment: an
// adjustment with no cost leaves the average cost at zero, and every gross-profit
// figure the store ever sees would be wrong by the whole cost of goods. That is the
// single most expensive mistake available at cutover, so it is asserted here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const server = require('../../server');
const db = require('../../config/database');
const clock = require('../../config/clock');
const temp = require('../helpers/tempdb');

const PASSWORD = 'sack-of-feed-2026';
const RECOVERY = {};

let instance;
let BASE;
let token;
const made = {};

const call = (pathname, { method = 'GET', body = null, tok = token } = {}) => fetch(`${BASE}${pathname}`, {
  method,
  headers: {
    ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

const json = async (res) => {
  const body = await res.json();
  assert.ok(res.ok, `${res.status} ${JSON.stringify(body)}`);
  return body;
};

test.before(async () => {
  temp.openMigrated('cutover');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── The wizard ──────────────────────────────────────────────────────────────

test('TC-E2E-10: a fresh install is set up through the wizard', async () => {
  const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-cutover-backups-'));

  const setup = await json(await call('/setup', {
    method: 'POST', tok: null,
    body: {
      store: {
        storeName: 'Chachi Agrivet', address: 'Poblacion, Sultan Kudarat',
        contactNo: '09171234567', tin: null,
      },
      // Q-1's answer: the store is not BIR-registered.
      taxMode: 'NONE',
      owner: {
        username: 'chachi', fullName: 'Chachi Dela Cruz',
        password: PASSWORD, pin: '441703',
      },
      backupFolder: backups,
      acknowledgedRecoveryCode: true,
    },
  }));

  RECOVERY.code = setup.recoveryCode;
  assert.match(RECOVERY.code, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/, 'SEC-5: shown once, here');
  assert.equal(setup.profile.tax_mode, 'NONE');

  token = (await json(await call('/auth/login', {
    method: 'POST', tok: null, body: { username: 'chachi', password: PASSWORD },
  }))).token;
});

test('TC-E2E-10: the catalogue really is empty', async () => {
  // The state the screens must cope with, and the one every other test skips past.
  assert.deepEqual((await json(await call('/categories'))).categories, []);
  assert.deepEqual((await json(await call('/units'))).units, []);
  assert.equal((await json(await call('/products'))).total, 0);
});

// ── The catalogue, in the order the editor builds it ────────────────────────

test('TC-E2E-10: a category and the units are created from nothing', async () => {
  // SCR-202's "New category" and "New unit" buttons post exactly this. A store with no
  // reference data cannot make a product without them, which is why they live in the
  // editor rather than on a screen somebody has to go and find.
  made.category = (await json(await call('/categories', {
    method: 'POST', body: { name: 'Feeds' },
  }))).category;

  made.kg = (await json(await call('/units', {
    method: 'POST', body: { name: 'Kilogram', code: 'KG', allowsFraction: true },
  }))).unit;

  // UOM-002: a sack is a pack, not a base unit, and it does not divide.
  made.sack = (await json(await call('/units', {
    method: 'POST', body: { name: 'Sack', code: 'SACK', allowsFraction: false },
  }))).unit;

  // The reference endpoints return the raw column, so this is 1/0 rather than a
  // boolean — unlike the product payload, which presents it. Asserted as written
  // rather than papered over, because the renderer only feeds it into a select.
  assert.ok(made.kg.allows_fraction);
  assert.ok(!made.sack.allows_fraction);
});

test('TC-E2E-10: the first product is created', async () => {
  made.product = (await json(await call('/products', {
    method: 'POST',
    body: {
      sku: 'FEED-HG', name: 'Hog Grower Pellets',
      categoryId: made.category.id, baseUnitId: made.kg.id, taxClass: 'VATABLE',
      // VR-203: a product is created with a retail price. PR-102 makes one without a
      // price unsellable anyway, so the editor asks for it on the Identity tab rather
      // than sending somebody to a Pricing tab that does not exist until it is saved.
      retailPriceCentavos: 6000,
    },
  }))).product;

  assert.equal(made.product.base_unit.code, 'KG');
  // Nothing has moved, so the base unit is still changeable — the editor leaves the
  // field open at this point and locks it later.
  assert.equal(made.product.base_unit_locked, false);
  assert.equal(made.product.qty_on_hand_milli, 0, 'and it starts at nothing on hand');
});

test('TC-E2E-10: a barcode is attached, and a second product cannot take it', async () => {
  const attached = await json(await call(`/products/${made.product.id}/barcodes`, {
    method: 'POST', body: { barcode: '4800012345678' },
  }));
  assert.equal(attached.barcodes.length, 1);

  const other = (await json(await call('/products', {
    method: 'POST',
    body: {
      sku: 'FEED-LM', name: 'Layer Mash', categoryId: made.category.id,
      baseUnitId: made.kg.id, retailPriceCentavos: 5000,
    },
  }))).product;

  // VR-205: one barcode, one product. The editor surfaces this refusal rather than
  // silently moving the code.
  const clash = await call(`/products/${other.id}/barcodes`, {
    method: 'POST', body: { barcode: '4800012345678' },
  });
  assert.equal(clash.status >= 400, true);
  assert.match((await clash.json()).error.message, /barcode/i);

  made.other = other;
});

test('TC-E2E-10: a sack is added as a pack, against the base unit', async () => {
  const result = await json(await call(`/products/${made.product.id}/packs`, {
    method: 'POST', body: { unitId: made.sack.id, factorMilli: 50000 },
  }));

  assert.equal(result.packs.length, 1);
  // UOM-002: 1 SACK = 50 KG, and the editor states it in exactly those words so a
  // mistyped factor is visible rather than arithmetic nobody checks.
  assert.equal(result.packs[0].factor_milli, 50000);
});

test('TC-E2E-10: prices are set, and the product becomes sellable', async () => {
  const before = (await json(await call(`/products/${made.product.id}`))).product;
  assert.equal(before.prices.RETAIL, 6000, 'the price it was created with');

  const priced = await json(await call(`/products/${made.product.id}/prices`, {
    // The endpoint takes the level names themselves; anything else is PR-101.
    method: 'PUT', body: { RETAIL: 6250, WHOLESALE: 5800 },
  }));

  assert.equal(priced.product.prices.RETAIL, 6250);
  assert.equal(priced.product.prices.WHOLESALE, 5800);

  const listed = (await json(await call('/products?q=hog'))).products[0];
  assert.equal(listed.retail_price_centavos, 6250);
  assert.equal(listed.is_sellable, true, 'and the list says so');
});

// ── Opening stock (OPS-106) ─────────────────────────────────────────────────

test('TC-E2E-10: opening stock is posted as a costed receipt, not a bare adjustment', async () => {
  await json(await call('/inventory/adjustments', {
    method: 'POST',
    body: {
      productId: made.product.id, type: 'RECEIPT',
      qtyMilli: 500000,                 // 500 KG — ten sacks
      unitCostCentavos: 4000,           // OPS-106: the opening unit cost
      reason: 'Received but not recorded',
      notes: 'Opening stock at cutover',
    },
  }));

  const { on_hand: stock } = await json(await call(`/inventory/${made.product.id}`));
  assert.equal(stock.qty_on_hand_milli, 500000);

  // The figure the whole cutover turns on. An adjustment with no cost leaves this at
  // zero and every gross-profit figure the store ever sees is wrong by the entire cost
  // of goods — the most expensive mistake available on the first morning.
  const detail = (await json(await call(`/products/${made.product.id}`))).product;
  assert.equal(detail.avg_cost_centavos, 4000, 'MON-004: the opening cost took');

  // UOM-003: stock has moved, so the base unit is now locked and the editor says why.
  assert.equal(detail.base_unit_locked, true);
});

test('TC-E2E-10: the list now shows on-hand, which is what SCR-201 is read for', async () => {
  const listed = (await json(await call('/products?q=FEED-HG'))).products[0];

  assert.equal(listed.qty_on_hand_milli, 500000);
  assert.equal(listed.qty_on_hand_display, '500 KG');
  assert.equal(listed.is_low_stock, false, 'no minimum set yet');

  // One request, not one per row: the figure is joined into the search.
  const all = await json(await call('/products?limit=50'));
  assert.ok(all.products.every((p) => typeof p.qty_on_hand_milli === 'number'));
});

test('TC-E2E-10: a minimum turns the low-stock alert on (INV-109, UOM-005)', async () => {
  await json(await call(`/products/${made.product.id}`, {
    method: 'PUT', body: { minStockMilli: 600000 },   // above what is on hand
  }));

  const low = await json(await call('/inventory/low-stock'));
  assert.equal(low.total, 1);
  assert.equal(low.products[0].product_id, made.product.id);
  assert.equal(low.products[0].shortfall_milli, 100000);

  // And the dashboard tile SCR-204 hangs off agrees, because it is the same query.
  const dash = await json(await call(`/reports/dashboard?date=${clock.manilaDate(clock.nowUtc())}`));
  assert.equal(dash.tiles.find((t) => t.key === 'LOW_STOCK').value_centavos, 1);

  await json(await call(`/products/${made.product.id}`, {
    method: 'PUT', body: { minStockMilli: 100000 },
  }));
});

// ── And it sells ────────────────────────────────────────────────────────────

test('TC-E2E-10: the store opens and sells the product it just created', async () => {
  await json(await call('/shifts/open', {
    method: 'POST', body: { openingFloatCentavos: 200000, confirmed: true },
  }));

  // Scanned, the way the counter reaches it — the barcode attached three cases ago.
  const scanned = await json(await call('/products/barcode/4800012345678'));
  assert.equal((scanned.product || scanned).id, made.product.id);

  // Sold by the sack: the pack resolves server-side to 50 KG.
  const sale = await json(await call('/sales', {
    method: 'POST',
    body: {
      lines: [{ productId: made.product.id, qtyMilli: 1000, packUnitId: made.sack.id }],
      tenders: [{ method: 'CASH', amountCentavos: 350000 }],
    },
  }));

  assert.equal(sale.items[0].qty_milli, 50000, 'UOM-002: one sack is 50 KG');
  assert.equal(sale.sale.total_centavos, 6250 * 50);

  const { on_hand: after } = await json(await call(`/inventory/${made.product.id}`));
  assert.equal(after.qty_on_hand_milli, 450000, '500 KG less one sack');

  // The margin the opening cost made possible.
  assert.equal(sale.gross_profit_centavos, (6250 - 4000) * 50);
});

test('TC-E2E-10: an adjustment corrects a miscount, with a reason from the list', async () => {
  const reasons = (await json(await call('/inventory/meta/adjustment-reasons'))).reasons;
  assert.ok(reasons.includes('Physical count correction'));

  // SCR-203 sends the signed difference, never the counted figure.
  await json(await call('/inventory/adjustments', {
    method: 'POST',
    body: {
      productId: made.product.id, qtyMilli: -2000,
      reason: 'Physical count correction', notes: 'Counted 448, system said 450',
    },
  }));

  assert.equal(
    (await json(await call(`/inventory/${made.product.id}`))).on_hand.qty_on_hand_milli,
    448000
  );

  // INV-108: free text alone is refused, which is what makes the select the right
  // control on the screen.
  const refused = await call('/inventory/adjustments', {
    method: 'POST',
    body: { productId: made.product.id, qtyMilli: -1000, reason: 'shrinkage probably' },
  });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.rule_id, 'INV-108');
});

test('TC-E2E-10: the day reconciles, from a store that did not exist an hour ago', () => {
  const inventoryService = require('../../services/inventoryService');
  assert.equal(inventoryService.reconcile().ok, true);
});
