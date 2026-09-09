'use strict';

// TC-E2E-20 — export a traded store, import it into an empty one, reconcile everything.
//
// The integration cases prove each rule in isolation. What a walk adds is the claim
// the whole feature exists for and that none of them makes on its own: **the second
// database is the first one.** Not "the import reported 900 rows" — the ledgers agree,
// the balances agree, the reports agree, and a second export of the imported store is
// byte-identical to the archive that built it.
//
// That last check is the strongest available and the cheapest to write: if any row
// arrived altered, reordered or missing, two archives cannot match. It is why
// requirement 8's determinism is worth having beyond tidiness.
//
// The walk runs over HTTP for the export and the import, because `TX-426` and `TX-427`
// are the grants an operator actually passes through, and because a base64 archive
// crossing a request body is the part most likely to be got wrong by a byte.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const server = require('../../server');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const customerService = require('../../services/customerService');
const inventoryService = require('../../services/inventoryService');
const shiftService = require('../../services/shiftService');
const saleService = require('../../services/saleService');
const collectionService = require('../../services/collectionService');
const settingsService = require('../../services/settingsService');
const exportService = require('../../services/exportService');
const reportService = require('../../services/reportService');
const creditRepository = require('../../repositories/creditRepository');
const inventoryRepository = require('../../repositories/inventoryRepository');
const dataRepository = require('../../repositories/dataRepository');
const clock = require('../../config/clock');
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';

let instance;
let BASE = null;
const tokens = {};
const sessions = {};

let archiveB64;
let sourceFacts;      // what the traded store held, read before it was left behind
let sourceChecksum;

let who_ = 'chachi';   // the signed-in operator, which changes with the database
const call = (p, { method = 'GET', body = null, who = who_ } = {}) => fetch(`${BASE}${p}`, {
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

/** A backup folder outside the data directory, so OPS-103's backup can be taken. */
const backupFolder = (actor) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-e2e-xfer-'));
  settingsService.set('backup_folder', dir, actor);
  return dir;
};

/** Sign every role in, against whichever database is currently open. */
function signIn(roles) {
  for (const [who, role] of roles) {
    temp.seedUser({ username: who, role, password: PASSWORD });
    tokens[who] = authService.login({ username: who, password: PASSWORD }).token;
    sessions[who] = authService.verifyToken(tokens[who]);
  }
}

test.before(async () => {
  temp.openMigrated('xfer-e2e-source');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;

  temp.seedStore({ withOwner: false, taxMode: 'NONE', storeName: 'Chachi Agrivet' });
  const ref = temp.seedCatalog();
  signIn([['chachi', 'OWNER'], ['tess', 'CASHIER']]);
  backupFolder(sessions.chachi);

  // A store that has traded properly: stock received, a cash sale, a credit sale, and
  // a part payment against it. An export of an empty database round-trips trivially.
  const feed = productService.create({
    sku: 'HG-50', name: 'Hog Grower Pellets', categoryId: ref.category.id,
    baseUnitId: ref.kg.id, retailPriceCentavos: 5200,
  }, sessions.chachi);
  inventoryService.postStandalone({
    productId: feed.id, type: 'OPENING', qtyMilli: 500000, unitCostCentavos: 3900,
    actor: sessions.chachi,
  });

  const farm = customerService.create({
    name: 'Sitio Maligaya Farm', code: 'MALIGAYA', customerType: 'FARM', priceLevel: 'RETAIL',
    isCreditEligible: true, creditLimitCentavos: 5000000, termsDays: 30,
  }, sessions.chachi);

  shiftService.open({ actor: sessions.tess, openingFloatCentavos: 200000, confirmed: true });
  saleService.complete({
    lines: [{ productId: feed.id, qtyMilli: 50000 }],
    tenders: [{ method: 'CASH', amountCentavos: 300000 }],
  }, sessions.tess);
  saleService.complete({
    lines: [{ productId: feed.id, qtyMilli: 100000 }],
    customerId: farm.id,
    tenders: [{ method: 'CREDIT', amountCentavos: 520000 }],
  }, sessions.tess);
  collectionService.record({
    customerId: farm.id, amountCentavos: 200000, method: 'CASH',
  }, sessions.tess);

  const today = clock.manilaDate(clock.nowUtc());
  sourceFacts = {
    stock: inventoryRepository.qtyOnHand(feed.id),
    balance: creditRepository.findAccountByCustomer(farm.id).balance_centavos,
    daily: reportService.daily({ from: today }, sessions.chachi),
    counts: Object.fromEntries(
      dataRepository.EXPORTABLE.map((t) => [t, dataRepository.countOf(t)])
    ),
    feedId: feed.id,
    farmId: farm.id,
    today,
  };
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

test('TC-E2E-20 · the traded store exports as one readable archive', async () => {
  const res = await call('/data/export', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');

  const bytes = Buffer.from(await res.arrayBuffer());
  archiveB64 = bytes.toString('base64');
  sourceChecksum = res.headers.get('x-export-checksum');

  assert.ok(bytes.length > 0);
  assert.match(sourceChecksum, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Number(res.headers.get('x-export-rows')), sourceFacts.counts
    ? Object.values(sourceFacts.counts).reduce((a, b) => a + b, 0)
    : NaN);

  // The archive holds the sale that was rung, not a summary of it.
  const entries = require('../../config/zip').unzipMany(bytes);
  const sales = JSON.parse(entries.find((e) => e.name === 'sales.json').content.toString('utf8'));
  assert.equal(sales.length, 2);
});

test('TC-E2E-20 · an empty store validates it before writing a row', async () => {
  // A different database, migrated and installed but never traded. Everything after
  // this point is the second store.
  await server.stop(instance);
  temp.openMigrated('xfer-e2e-target');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;

  // The new PC's own setup owner, with a name of their own. That matters and is not
  // incidental: `users.username` is UNIQUE, so an owner called `chachi` on both
  // machines is an `OPS-104` collision — and a SKIP would then leave every row that
  // cites the archive's `chachi` pointing at a user who was skipped. The case below
  // drives exactly that, because it is the mistake an operator will make.
  temp.seedStore({ withOwner: false, taxMode: 'NONE', storeName: 'A different shop' });
  signIn([['newowner', 'OWNER']]);
  who_ = 'newowner';
  backupFolder(sessions.newowner);

  const before = dataRepository.countOf('sales');
  assert.equal(before, 0, 'the target has never traded');

  const checked = await json(await call('/data/import/validate', {
    method: 'POST', body: { archive: archiveB64, collisionMode: 'SKIP' },
  }));

  assert.equal(checked.ok, true, JSON.stringify(checked.problems));
  assert.equal(checked.manifest.store_name, 'Chachi Agrivet', 'the archive names where it came from');
  assert.equal(checked.manifest.checksum, sourceChecksum);
  assert.ok(checked.summary.total_rows > 0);

  // SEC-1's consequence, surfaced before the operator commits rather than the morning
  // after, when nobody can sign in.
  assert.ok(checked.warnings.some((w) => w.rule_id === 'SEC-1' && /without passwords/.test(w.message)));

  // OPS-102: validating wrote nothing.
  assert.equal(dataRepository.countOf('sales'), before);
});

test('TC-E2E-20 · the import runs in one transaction, after taking its backup', async () => {
  const result = await json(await call('/data/import', {
    method: 'POST',
    body: { archive: archiveB64, collisionMode: 'SKIP', reason: 'Moving to the new PC' },
  }));

  assert.equal(result.ok, true);
  assert.ok(result.pre_import_backup.file_name, 'OPS-103: the way back is named');
  assert.equal(result.pre_import_backup.verified, true);
  assert.ok(result.rows_inserted > 0);
  assert.equal(result.collision_mode, 'SKIP');
});

test('TC-E2E-20 · every ledger reconciles in the imported store', () => {
  // **The claim the whole feature exists for.** Not the counts the import reported —
  // the figures the store computes for itself, from the rows that actually arrived.

  // INV-101: the stored on-hand equals the sum of the movements behind it.
  assert.deepEqual(inventoryRepository.reconciliationBreaks(), []);
  assert.equal(inventoryRepository.qtyOnHand(sourceFacts.feedId), sourceFacts.stock);

  // CR-103: the balance derives from the transaction ledger and agrees with it.
  assert.deepEqual(creditRepository.reconciliationBreaks(), []);
  assert.equal(
    creditRepository.findAccountByCustomer(sourceFacts.farmId).balance_centavos,
    sourceFacts.balance
  );

  // RPT-101: the same day, computed here, comes to the same figures — and still
  // reconciles on both of its halves.
  const daily = reportService.daily({ from: sourceFacts.today }, sessions.newowner);
  assert.equal(daily.totals.gross_centavos, sourceFacts.daily.totals.gross_centavos);
  assert.equal(daily.totals.net_centavos, sourceFacts.daily.totals.net_centavos);
  assert.equal(daily.totals.sale_count, sourceFacts.daily.totals.sale_count);
  assert.equal(daily.reconciliation.reconciles, true);
  assert.equal(daily.profit.gross_profit_centavos, sourceFacts.daily.profit.gross_profit_centavos);
});

test('TC-E2E-20 · every row the archive carried is in the new store, unchanged', () => {
  // **The claim, stated exactly.** Not "the two archives are identical": they cannot
  // be, and expecting them to be was the first version of this assertion. The target
  // has its own setup owner, its own store profile and its own seeded settings, and an
  // import adds to a store rather than becoming it.
  //
  // What must be true is that **every row the archive carried arrived, unaltered**. So
  // the source archive and a fresh export of the imported store are compared row by
  // row, which catches a value changed in transit, a row dropped, a column silently
  // defaulted — everything a count would miss.
  const zip = require('../../config/zip');
  const source = zip.unzipMany(Buffer.from(archiveB64, 'base64'));
  const after = zip.unzipMany(exportService.build().archive);

  const rowsOf = (entries, name) => JSON.parse(
    entries.find((e) => e.name === name).content.toString('utf8')
  );

  // `system_settings` is the one table this comparison must exclude, and the reason is
  // `OPS-104` working rather than failing: both stores seed the same registry, so every
  // key collides and SKIP kept the target's own rows. Their values are asserted
  // separately below — what differs is `updated_at`, which is when *this* store seeded
  // them and is not a fact the archive gets to overwrite.
  const SKIPPED_BY_COLLISION = ['system_settings'];

  let compared = 0;
  for (const table of dataRepository.EXPORTABLE) {
    if (SKIPPED_BY_COLLISION.includes(table)) continue;
    const before = rowsOf(source, `${table}.json`);
    if (before.length === 0) continue;

    const now = rowsOf(after, `${table}.json`);
    const byKey = new Map(now.map((row) => [JSON.stringify(row), row]));

    for (const row of before) {
      assert.ok(byKey.has(JSON.stringify(row)),
        `${table}: a row the archive carried is missing or altered — ${JSON.stringify(row).slice(0, 120)}`);
      compared += 1;
    }
  }

  // A floor on the comparison itself. Without it, a bug that made every entity file
  // parse as empty would leave this case passing loudly and asserting nothing — the
  // failure mode a "every X satisfies Y" loop always has.
  assert.ok(compared >= 40, `only ${compared} rows compared; the fixture is too thin to mean anything`);

  // And the tables the target had none of hold exactly what the source held — no more
  // and no fewer, so nothing was duplicated on the way in.
  for (const table of ['sales', 'sale_items', 'sale_tenders', 'inventory_movements', 'products']) {
    assert.equal(dataRepository.countOf(table), sourceFacts.counts[table], table);
  }

  // The skipped settings: same keys, same values, the target's own rows. A SKIP that
  // had silently dropped a setting rather than keeping the local one would show here.
  const sourceSettings = new Map(rowsOf(source, 'system_settings.json').map((r) => [r.key, r.value]));
  const nowSettings = new Map(rowsOf(after, 'system_settings.json').map((r) => [r.key, r.value]));
  for (const [key, value] of sourceSettings) {
    // `backup_folder` is the exception, and SKIP keeping the local one is the right
    // answer rather than an accident: a backup folder is a property of the **machine**,
    // not of the data. An import that carried it over would point the new PC's backups
    // at a drive letter on the old one, and the store would find out the day it needed
    // a backup. Asserted as a difference, so nobody later "fixes" it into a copy.
    if (key === 'backup_folder') {
      assert.notEqual(nowSettings.get(key), value, 'the new machine keeps its own backup folder');
      continue;
    }
    assert.equal(nowSettings.get(key), value, `setting ${key}`);
  }
});

test('TC-E2E-20 · importing the same archive twice changes nothing', async () => {
  // OPS-104's SKIP, at the scale that matters: an operator who is not sure whether the
  // import ran can run it again and find out, rather than doubling the store.
  const before = Object.fromEntries(
    dataRepository.EXPORTABLE.map((t) => [t, dataRepository.countOf(t)])
  );

  const again = await json(await call('/data/import', {
    method: 'POST', body: { archive: archiveB64, collisionMode: 'SKIP' },
  }));

  assert.equal(again.rows_inserted, 0, 'nothing new');
  assert.ok(again.rows_skipped > 0);

  const after = Object.fromEntries(
    dataRepository.EXPORTABLE.map((t) => [t, dataRepository.countOf(t)])
  );
  // Three tables move because the *import itself* is an event: its backup, its audit
  // row, and the system event behind them. Everything the archive carries is untouched.
  for (const table of Object.keys(before)) {
    if (['backups', 'audit_logs', 'system_events'].includes(table)) continue;
    assert.equal(after[table], before[table], table);
  }

  // And the store still reconciles after being imported onto twice.
  assert.deepEqual(inventoryRepository.reconciliationBreaks(), []);
  assert.deepEqual(creditRepository.reconciliationBreaks(), []);
});
