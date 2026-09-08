'use strict';

// TC-E2E-08 — a full trading day with no network at all (NFR_3.1, FR_1.2).
//
// The product's central claim is that it works offline. Every other test in this suite
// runs on a machine that happens to have networking, which proves nothing: a hidden
// dependency on a font CDN, a telemetry ping or an NTP lookup would pass all of them
// and fail on a store's counter during a brownout.
//
// So this case **removes the ability to reach anything**. `dns`, `net`, `tls`, `http`,
// `https` and `fetch` are replaced with implementations that throw, before the
// application is required. There is no allow-list and no exception for localhost at
// the DNS layer — the server binds a literal 127.0.0.1 (SEC-8) and needs no resolver,
// and if any code path did need one, that is exactly the dependency this exists to
// find.
//
// TASK-018 requirement 8 asks for this on the installed build with the machine's
// networking switched off, which is UAT §8 and cannot be done from a build machine.
// What is automated here is the stronger-in-one-way half: the machine keeps its
// network and the *application* is denied it, so a passing run says the code reaches
// for nothing rather than that nothing answered.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Cut the wires, before anything else is loaded ───────────────────────────

const attempts = [];

function forbid(moduleName, methods) {
  const mod = require(moduleName);
  for (const method of methods) {
    if (typeof mod[method] !== 'function') continue;
    mod[method] = (...args) => {
      const target = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
      attempts.push(`${moduleName}.${method}(${target.slice(0, 120)})`);
      throw Object.assign(new Error(`this machine has no network (${moduleName}.${method})`), {
        code: 'ENETDOWN',
      });
    };
  }
}

// dns first: a resolver call is the earliest sign of an outbound dependency.
forbid('dns', ['lookup', 'resolve', 'resolve4', 'resolve6', 'lookupService']);
forbid('dns/promises', ['lookup', 'resolve', 'resolve4', 'resolve6']);
forbid('https', ['request', 'get']);
forbid('tls', ['connect', 'createServer']);

// http and net are how the API server itself listens, so only the *outbound* halves
// are cut. `net.connect` is a client socket; `http.request` is an outbound call. The
// listeners are untouched, or there would be no application to test.
forbid('net', ['connect', 'createConnection']);
forbid('http', ['request', 'get']);

const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  attempts.push(`fetch(${String(args[0]).slice(0, 120)})`);
  throw Object.assign(new Error('this machine has no network (fetch)'), { code: 'ENETDOWN' });
};

// ── Now the application ─────────────────────────────────────────────────────

const db = require('../../config/database');
const clock = require('../../config/clock');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const inventoryService = require('../../services/inventoryService');
const customerService = require('../../services/customerService');
const shiftService = require('../../services/shiftService');
const saleService = require('../../services/saleService');
const collectionService = require('../../services/collectionService');
const reportService = require('../../services/reportService');
const backupService = require('../../services/backupService');
const settingsService = require('../../services/settingsService');
const documentService = require('../../services/documentService');
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';

let owner;
let cashier;
let shift;
let feed;
let sack;
let farm;
let today;

test.before(() => {
  temp.openMigrated('offline');
  temp.seedStore({ withOwner: false, taxMode: 'NONE', storeName: 'Chachi Agrivet' });
  const ref = temp.seedCatalog();

  temp.seedUser({ username: 'owner', role: 'OWNER', password: PASSWORD });
  temp.seedUser({ username: 'till', role: 'CASHIER', password: PASSWORD });
  owner = authService.verifyToken(authService.login({ username: 'owner', password: PASSWORD }).token);
  cashier = authService.verifyToken(authService.login({ username: 'till', password: PASSWORD }).token);

  const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-offline-backups-'));
  db.transaction(() => settingsService.set('backup_folder', backups, owner));

  feed = productService.create({
    sku: 'FEED-001', name: 'Hog Grower Pellets',
    categoryId: ref.category.id, baseUnitId: ref.kg.id, retailPriceCentavos: 6000,
  }, owner);
  sack = productService.create({
    sku: 'FEED-050', name: 'Layer Mash 50kg',
    categoryId: ref.category.id, baseUnitId: ref.kg.id, retailPriceCentavos: 5000,
  }, owner);

  for (const product of [feed, sack]) {
    inventoryService.postStandalone({
      productId: product.id, type: 'RECEIPT', qtyMilli: 500000, unitCostCentavos: 4000, actor: owner,
    });
  }

  farm = customerService.create({
    name: 'Santos Farm', customerType: 'FARM', priceLevel: 'RETAIL',
    isCreditEligible: true, creditLimitCentavos: 5000000, termsDays: 30,
  }, owner);

  today = clock.manilaDate(clock.nowUtc());
});

test.after(() => {
  globalThis.fetch = realFetch;
  temp.cleanup();
});

test('TC-E2E-08: the network really is gone', () => {
  // The test is worthless if the wires are still connected, so this is asserted before
  // anything else runs.
  assert.throws(() => require('dns').lookup('example.com', () => {}), /no network/);
  assert.throws(() => require('net').connect(80, '1.1.1.1'), /no network/);
  assert.throws(() => require('https').get('https://example.com'), /no network/);
  assert.throws(() => globalThis.fetch('https://example.com'), /no network/);

  // Even the loopback: SEC-8 binds a literal address and needs no resolver.
  assert.throws(() => require('dns').lookup('localhost', () => {}), /no network/);

  // The probes above are this test's own; the ledger starts empty for the day's work.
  attempts.length = 0;
});

test('TC-E2E-08: the shift opens', () => {
  const opened = shiftService.open({ actor: cashier, openingFloatCentavos: 200000, confirmed: true });
  shift = opened.shift;
  cashier = { ...cashier, shiftId: shift.id };
  assert.equal(shift.status, 'OPEN');
});

test('TC-E2E-08: a day of trading — cash, split tender and credit', () => {
  const cash = saleService.complete({
    lines: [{ productId: feed.id, qtyMilli: 1255 }, { productId: sack.id, qtyMilli: 2000 }],
    tenders: [{ method: 'CASH', amountCentavos: 30000 }],
  }, cashier);
  assert.equal(cash.sale.status, 'COMPLETED');
  assert.ok(cash.sale.change_centavos > 0);

  const split = saleService.complete({
    lines: [{ productId: feed.id, qtyMilli: 3000 }],
    tenders: [
      { method: 'CASH', amountCentavos: 10000 },
      { method: 'GCASH', amountCentavos: 8000, referenceNo: '0009988776' },
    ],
  }, cashier);
  assert.equal(split.sale.status, 'COMPLETED');

  const credit = saleService.complete({
    lines: [{ productId: sack.id, qtyMilli: 10000 }],
    customerId: farm.id,
    tenders: [{ method: 'CREDIT', amountCentavos: 50000 }],
  }, cashier);
  assert.equal(credit.sale.status, 'COMPLETED');

  // A GCash reference is keyed from the customer's phone screen and never confirmed
  // by anything (POS-205, POS-206) — which is precisely why it works with no network.
  const tender = credit.sale.tenders ? credit.sale.tenders[0] : null;
  assert.ok(tender === null || tender.status === 'RECORDED');
});

test('TC-E2E-08: a credit collection is taken and allocated', () => {
  const result = collectionService.record({
    customerId: farm.id, amountCentavos: 20000, method: 'CASH',
  }, cashier);
  assert.ok(result.allocations.length > 0);
});

test('TC-E2E-08: the reports render, and the day reconciles', () => {
  const daily = reportService.daily({ from: today }, owner);
  assert.equal(daily.totals.sale_count, 3);
  assert.equal(daily.reconciliation.reconciles, true, daily.reconciliation.statement);

  const dash = reportService.dashboard({ date: today }, owner);
  assert.equal(dash.tiles.length, 7);

  assert.deepEqual(inventoryService.reconcile().discrepancies || [], []);
});

test('TC-E2E-08: the receipt is composed and printed with no network', () => {
  // INT-1: the printer is USB or a LAN socket. This installation has neither, so the
  // document is composed and queued — which is the behaviour that must not turn into
  // an outbound call looking for a print service.
  const sale = reportService.daily({ from: today }, owner).sales[0];
  const printed = saleService.reprint(sale.id, owner);
  assert.ok(printed);

  const rendered = JSON.stringify(printed);
  // TAX-006 travels with the document whether or not it reached paper.
  assert.match(rendered, /not an official receipt/i);
});

test('TC-E2E-08: the shift closes and the day is backed up', () => {
  const expected = shiftService.computeExpected(shift.id);
  const closed = shiftService.close({
    shiftId: shift.id, actualCashCentavos: expected.expected_cash_centavos, actor: cashier,
  }, cashier);

  assert.equal(closed.variance_centavos, 0);
  assert.equal(closed.backup.ok, true, closed.backup.error);
  assert.equal(closed.backup.verified, true, 'OPS-002 with no network either');

  // A backup is a local file. Nothing about it reaches for a cloud target — TASK-017
  // requirement 13, asserted rather than assumed.
  assert.ok(fs.existsSync(closed.backup.file_path));
});

test('TC-E2E-08: a manual backup and its verification also work', () => {
  const result = backupService.run({ trigger: 'MANUAL', actor: owner });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.verified, true);
});

test('TC-E2E-08: nothing in the whole day attempted to reach the network', () => {
  // The assertion that makes the rest of this file mean something. Every trading
  // operation ran; if any of them had reached for a resolver, a socket or a URL, the
  // attempt is recorded here whether or not the caller swallowed the error.
  assert.deepEqual(attempts, [], `the application reached for the network:\n${attempts.join('\n')}`);
});

test('TC-E2E-08: and the renderer carries no remote asset either', () => {
  // A stylesheet from a font CDN fails silently on a store's counter: the screen
  // renders in a fallback face and nobody knows why. The server side is proved above;
  // this is the other half.
  const walk = (dir, files = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, files);
      else files.push(full);
    }
    return files;
  };

  for (const file of walk(path.join(__dirname, '..', '..', '..', 'public'))) {
    if (!/\.(html|css|js)$/.test(file)) continue;
    const source = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    assert.equal(
      /https?:\/\/(?!127\.0\.0\.1|localhost)/.test(source), false,
      `${path.basename(file)} loads something from off the machine`
    );
    assert.equal(/@import\s+url\(/.test(source), false, `${path.basename(file)} imports a remote stylesheet`);
  }
});
