'use strict';

// TC-E2E-09 — `kill -9` mid-sale, restart, and the ledger is consistent.
//
// FR_7.4 and OPS-008. This is the case that decides whether a power cut in Sultan
// Kudarat costs a day's takings, and it is the one that cannot be argued from the
// pragmas: WAL and `synchronous = NORMAL` are a claim about what SQLite does when a
// process dies, and the only way to know is to kill one.
//
// SIGKILL is the right signal and the only honest one. It cannot be caught, so no
// cleanup runs, no handler flushes anything and no `finally` block tidies up — which
// is what a power cut looks like from inside the process. A SIGTERM test would pass
// while proving nothing.
//
// What it must show is two things, and they pull in opposite directions:
//
//   * **No committed sale is lost.** Every sale the child said it had completed is in
//     the database after the restart.
//   * **No partial sale is committed.** No sale exists without its lines, its tenders
//     and its inventory movements (INV-107) — including whichever one was in flight
//     when the signal arrived.
//
// A system that satisfies the first by writing eagerly usually fails the second, and
// one that satisfies the second by holding everything back usually fails the first.
//
// **What this case cannot prove.** SIGKILL kills the process; it does not empty the
// operating system's page cache. So this proves durability against a crashed
// application — a hung POS someone force-quits, an Electron restart, a killed service
// — and it would still pass with `synchronous = OFF`, which a real power cut would
// not. The OS-level half of OPS-008 needs the plug pulled on the reference machine,
// and it is item 7 of the UAT script (07_TEST_PLAN.md §8) for that reason. Saying so
// here rather than letting a green E2E imply more than it tested.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const db = require('../../config/database');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const inventoryService = require('../../services/inventoryService');
const shiftService = require('../../services/shiftService');
const settingsService = require('../../services/settingsService');
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';
const ROOT = path.join(__dirname, '..', '..', '..');

let dir;
let owner;
let cashier;
let product;
let shift;
let dbPath;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test.before(() => {
  dir = temp.openMigrated('durability');
  dbPath = path.join(dir, 'agrivet.db');
  temp.seedStore({ withOwner: false, taxMode: 'NONE' });
  const ref = temp.seedCatalog();

  temp.seedUser({ username: 'owner', role: 'OWNER', password: PASSWORD });
  temp.seedUser({ username: 'till', role: 'CASHIER', password: PASSWORD });
  owner = authService.verifyToken(authService.login({ username: 'owner', password: PASSWORD }).token);
  cashier = authService.verifyToken(authService.login({ username: 'till', password: PASSWORD }).token);

  const backups = fs.mkdtempSync(path.join(require('os').tmpdir(), 'agrivet-dur-backups-'));
  db.transaction(() => settingsService.set('backup_folder', backups, owner));

  product = productService.create({
    sku: 'FEED-001', name: 'Hog Grower Pellets',
    categoryId: ref.category.id, baseUnitId: ref.kg.id, retailPriceCentavos: 6000,
  }, owner);
  inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli: 100000000, unitCostCentavos: 4000, actor: owner,
  });

  shift = shiftService.open({ actor: cashier, openingFloatCentavos: 200000, confirmed: true }).shift;

  // The parent lets go of the file entirely. Two processes writing one SQLite file is
  // not a state worth reaching, and the child is the one trading.
  db.close();
});

test.after(() => {
  temp.cleanup();
});

let reported = [];
let killedAfterMs = 0;

test('TC-E2E-09: a till ringing sales is killed with SIGKILL mid-loop', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, 'helpers', 'till-loop.js')], {
    env: {
      ...process.env,
      LOOP_DB: dbPath,
      LOOP_USER: 'till',
      LOOP_PASSWORD: PASSWORD,
      LOOP_PRODUCT: product.id,
      LOOP_SHIFT: shift.id,
      AGRIVET_DATA_DIR: dir,
      NODE_ENV: 'test',
      AGRIVET_BCRYPT_COST: '4',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const lines = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const parts = buffer.split('\n');
    buffer = parts.pop();
    for (const line of parts) if (line) lines.push(line);
  });

  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  // Wait until it is genuinely trading, not merely started.
  const started = Date.now();
  while (lines.filter((l) => l.startsWith('SALE ')).length < 20) {
    if (Date.now() - started > 30000) {
      child.kill('SIGKILL');
      assert.fail(`the till never got going: ${lines.join(' | ')} ${stderr.join('')}`);
    }
    await sleep(50);
  }

  // Mid-loop, with no warning of any kind. SIGKILL cannot be caught, so nothing in the
  // child gets to flush, close or tidy — which is what a power cut is.
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  child.kill('SIGKILL');
  const outcome = await exited;
  killedAfterMs = Date.now() - started;

  assert.equal(outcome.signal, 'SIGKILL', 'the child was killed, not asked to stop');
  assert.equal(outcome.code, null);

  reported = lines.filter((l) => l.startsWith('SALE ')).map((l) => {
    const [, saleNo, id] = l.split(' ');
    return { saleNo, id };
  });
  assert.ok(reported.length >= 20, `only ${reported.length} sales were reported`);
});

test('TC-E2E-09: the database opens again, and its WAL is replayed', () => {
  // A dead process leaves the -wal and -shm behind. The next open replays it; that
  // replay is the whole of OPS-008's promise, and it is asserted here rather than
  // assumed from the pragma.
  assert.ok(fs.existsSync(dbPath), 'the database file survived');

  db.open({ path: dbPath });
  const pragmas = db.pragmaState();
  assert.equal(pragmas.journal_mode, 'wal', 'OPS-008');
  assert.equal(pragmas.foreign_keys, 1);

  const check = db.get().pragma('integrity_check');
  assert.equal(check[0].integrity_check, 'ok', 'the file is sound after the kill');
  assert.deepEqual(db.get().pragma('foreign_key_check'), [], 'and has no dangling references');
});

test('TC-E2E-09: no committed sale was lost', () => {
  // Every sale the till said it had completed, checked one at a time. `synchronous =
  // NORMAL` in WAL mode loses nothing to a process death — only to an OS or power
  // failure, which is the trade OPS-008 makes deliberately, and this is the half of it
  // that must hold.
  const found = db.get().prepare('SELECT id, sale_no FROM sales').all();
  const byId = new Map(found.map((row) => [row.id, row]));

  const missing = reported.filter((r) => !byId.has(r.id));
  assert.deepEqual(missing, [], `${missing.length} committed sale(s) went missing after the kill`);
  assert.ok(reported.length > 0);
});

test('TC-E2E-09: no partial sale was committed', () => {
  // The other half, and the one the kill actually tests: whichever sale was in flight
  // when the signal arrived is either wholly there or wholly absent (INV-107).
  const partial = db.get().prepare(`
    SELECT s.id, s.sale_no FROM sales s
    WHERE NOT EXISTS (SELECT 1 FROM sale_items  i WHERE i.sale_id = s.id)
       OR NOT EXISTS (SELECT 1 FROM sale_tenders t WHERE t.sale_id = s.id)
  `).all();
  assert.deepEqual(partial, [], 'a sale exists without its lines or its tenders');

  const orphanMovements = db.get().prepare(`
    SELECT m.id FROM inventory_movements m
    WHERE m.reference_type = 'sale'
      AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = m.reference_id)
  `).all();
  assert.deepEqual(orphanMovements, [], 'a movement points at a sale that is not there');

  const salesWithoutMovements = db.get().prepare(`
    SELECT s.id FROM sales s
    WHERE NOT EXISTS (
      SELECT 1 FROM inventory_movements m
      WHERE m.reference_type = 'sale' AND m.reference_id = s.id
    )
  `).all();
  assert.deepEqual(salesWithoutMovements, [], 'a sale exists whose stock never moved');
});

/**
 * The sales the database holds — which is at least the ones the child reported.
 *
 * The child writes its line synchronously *after* the commit, so a sale can be
 * committed with its line still sitting in the pipe when the signal lands. That excess
 * is correct behaviour, not a defect: the guarantee runs one way, and it is the one
 * that matters — nothing the till said it had committed may be missing.
 */
const surviving = () => db.get().prepare('SELECT COUNT(*) AS n FROM sales').get().n;

test('TC-E2E-09: the ledgers still reconcile, and the sequence has no gaps', () => {
  // INV-101 and POS-108 after an abrupt death. A sale that half-committed would show
  // up here as stock that does not add up, which is the failure a store would find
  // weeks later at a physical count.
  const reconciliation = inventoryService.reconcile();
  assert.equal(reconciliation.ok, true, JSON.stringify(reconciliation.discrepancies || []).slice(0, 300));

  const numbers = db.get()
    .prepare("SELECT sale_no FROM sales WHERE sale_no LIKE 'SALE-%' ORDER BY sale_no")
    .all()
    .map((row) => Number(row.sale_no.split('-').pop()));

  for (let i = 1; i < numbers.length; i += 1) {
    assert.equal(numbers[i], numbers[i - 1] + 1, `gap in the sale sequence at ${numbers[i - 1]}`);
  }

  // POS-108's sequence comes from the rows themselves, so a rolled-back sale frees its
  // number rather than burning it — which is why there is no gap even though a sale
  // was interrupted.
  assert.ok(
    numbers.length >= reported.length,
    `${numbers.length} sales survived but ${reported.length} were reported committed`
  );
});

test('TC-E2E-09: the till can be closed afterwards, and the day reconciles', () => {
  // The recovery a store actually performs the morning after: turn it on, close
  // yesterday's drawer, and find out what is in it.
  const expected = shiftService.computeExpected(shift.id);
  const cash = 200000 + surviving() * 6000;
  assert.equal(expected.expected_cash_centavos, cash, 'the drawer expects every sale that survived');

  const closed = shiftService.close({
    shiftId: shift.id, actualCashCentavos: cash, actor: cashier,
  }, cashier);

  assert.equal(closed.variance_centavos, 0);
  assert.equal(closed.backup.ok, true, 'and the recovered day is backed up');
  assert.equal(closed.backup.verified, true);
});

test('TC-E2E-09: a backup of the recovered database verifies and holds the day', () => {
  const backupService = require('../../services/backupService');
  const backupRepository = require('../../repositories/backupRepository');

  const result = backupService.run({ trigger: 'MANUAL', actor: owner });
  assert.equal(result.ok, true, result.error);

  const staged = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'agrivet-dur-')), 'copy.db');
  backupRepository.extract(result.file_path, staged);
  const copy = new Database(staged, { readonly: true, fileMustExist: true });
  try {
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM sales').get().n, surviving());
    assert.equal(copy.pragma('integrity_check')[0].integrity_check, 'ok');
  } finally {
    copy.close();
  }

  process.stdout.write(
    `    killed after ${killedAfterMs} ms; ${reported.length} sales reported committed, `
    + `${surviving()} in the database — all present, none partial\n`
  );
});
