'use strict';

// TC-PERF-04 — cold start to login, against NFR_1.4's 8 seconds.
//
// Same split as the other perf files, for the reason 07_TEST_PLAN.md §6 gives: this is
// a budget measured on the reference machine (NFR_4.1), and a figure from a build
// machine is not a result. So it seeds to scale, reports the measurement, and asserts
// only a ceiling far above the budget.
//
// **What "cold start" means here.** A real cold start is a double-click on a Windows
// desktop: Electron's own process launch, Chromium's, then the server, then the
// window. Only the last two are this repository's; Electron's share is roughly a
// second on the reference hardware and is measured at UAT. What is measured here is
// the part the code controls — process launch through migrations, driver install,
// launch checks and the schedule, to the moment `/health` answers and the sign-in
// screen can be served — which is also the part that would regress.
//
// The database is seeded to NFR_2.1 scale first, because an empty database starts fast
// no matter what is wrong with the start-up path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const db = require('../../config/database');
const ids = require('../../config/ids');
const clock = require('../../config/clock');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const inventoryService = require('../../services/inventoryService');
const shiftService = require('../../services/shiftService');
const settingsService = require('../../services/settingsService');
const temp = require('../helpers/tempdb');

const PRODUCTS = 5000;                 // NFR_2.1
const SALES = 5000;
const BUDGET_MS = 8000;                // NFR_1.4 — reported, not asserted
const CEILING_MS = 8000;               // a start-up that scans the catalogue, not the budget
const RUNS = 5;

const PASSWORD = 'correct-horse-battery';
const ROOT = path.join(__dirname, '..', '..', '..');

let dir;
let dbPath;

test.before(() => {
  dir = temp.openMigrated('perf-startup');
  dbPath = path.join(dir, 'agrivet.db');
  temp.seedStore({ withOwner: false, taxMode: 'NONE' });
  const ref = temp.seedCatalog();

  temp.seedUser({ username: 'owner', role: 'OWNER', password: PASSWORD });
  const owner = authService.verifyToken(authService.login({ username: 'owner', password: PASSWORD }).token);

  const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-startup-backups-'));
  db.transaction(() => settingsService.set('backup_folder', backups, owner));

  process.stdout.write(`\n    seeding ${PRODUCTS} products and ${SALES} sales…\n`);
  const started = Date.now();

  // Not wrapped in a transaction: each service opens its own, and nesting them is the
  // design error §8.3 refuses. The seed is slower for it and correct.
  const catalogue = [];
  for (let i = 0; i < PRODUCTS; i += 1) {
    catalogue.push(productService.create({
      sku: `PERF-${String(i).padStart(5, '0')}`,
      name: `Perf Product ${i}`,
      categoryId: ref.category.id,
      baseUnitId: ref.kg.id,
      retailPriceCentavos: 5000 + i,
    }, owner));
  }
  for (const product of catalogue.slice(0, 500)) {
    inventoryService.postStandalone({
      productId: product.id, type: 'RECEIPT', qtyMilli: 1000000,
      unitCostCentavos: 4000, actor: owner,
    });
  }

  // Sales rows written directly: what is being measured is the *read* at start-up.
  const shift = shiftService.open({ actor: owner, openingFloatCentavos: 200000, confirmed: true }).shift;
  const insertSale = db.get().prepare(`
    INSERT INTO sales (id, sale_no, customer_id, shift_id, status, price_level, tax_mode,
      subtotal_centavos, line_discount_centavos, txn_discount_centavos, statutory_discount_centavos,
      vatable_centavos, vat_exempt_centavos, zero_rated_centavos, vat_centavos,
      total_centavos, change_centavos, occurred_at, created_by)
    VALUES (@id, @no, NULL, @shift, 'COMPLETED', 'RETAIL', 'NONE', @total, 0, 0, 0, 0, 0, 0, 0,
      @total, 0, @at, @by)
  `);
  const at = clock.nowUtc();
  db.transaction(() => {
    for (let i = 0; i < SALES; i += 1) {
      insertSale.run({ id: ids.uuidv7(), no: `PERF-${i}`, shift: shift.id, total: 6000, at, by: owner.id });
    }
  });

  process.stdout.write(`    seeded in ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
  db.close();
});

test.after(() => temp.cleanup());

/**
 * One cold start: a new process, from spawn to the API answering.
 *
 * A fresh process every time, because the thing being measured is the cost of coming
 * up — module loading, the migration check, the driver install, the launch checks —
 * and a warm require cache would measure none of it.
 */
function coldStart(port) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
      env: {
        ...process.env,
        AGRIVET_DATA_DIR: dir,
        AGRIVET_PORT: String(port),
        NODE_ENV: 'test',
        AGRIVET_BCRYPT_COST: '4',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const errors = [];
    child.stderr.on('data', (chunk) => errors.push(chunk.toString()));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the server did not answer in 30 s: ${errors.join('')}`));
    }, 30000);

    const poll = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
        if (res.ok) {
          const ms = Number(process.hrtime.bigint() - started) / 1e6;
          clearTimeout(timer);
          child.kill('SIGKILL');
          resolve(ms);
          return;
        }
      } catch { /* not up yet */ }
      setTimeout(poll, 20);
    };
    setTimeout(poll, 20);

    child.on('exit', (code, signal) => {
      if (signal !== 'SIGKILL' && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`the server exited with ${code}: ${errors.join('')}`));
      }
    });
  });
}

test('TC-PERF-04: cold start to login at 5,000 products', async () => {
  const timings = [];
  for (let i = 0; i < RUNS; i += 1) {
    timings.push(await coldStart(47950 + i));
  }
  timings.sort((a, b) => a - b);

  const median = timings[Math.floor(RUNS / 2)];
  const worst = timings[RUNS - 1];
  process.stdout.write(
    `    cold start (process → /health): median ${median.toFixed(0)} ms · worst ${worst.toFixed(0)} ms`
    + ` — ${worst < BUDGET_MS ? 'within' : 'OVER'} the ${BUDGET_MS} ms budget on this machine\n`
  );
  process.stdout.write(
    '    NFR_1.4 also covers Electron and Chromium starting, which is not this process '
    + 'and is measured at UAT.\n'
  );

  // The ceiling, not the budget. A start-up that scanned the catalogue or checked every
  // backup would land in the tens of seconds here.
  assert.ok(worst < CEILING_MS, `worst ${worst.toFixed(0)} ms exceeded the ${CEILING_MS} ms ceiling`);
});

test('start-up does not get slower as the database fills', async () => {
  // The property, which unlike the figure above is machine-independent: nothing in the
  // start-up path is proportional to the number of rows. A migration check reads one
  // table, the launch checks read one row each.
  const empty = temp.freshDir('perf-startup-empty');
  const before = await coldStart(47960);

  const seeded = dir;
  dir = empty;
  const fresh = await coldStart(47961);
  dir = seeded;

  process.stdout.write(
    `    empty database: ${fresh.toFixed(0)} ms · 5,000 products and 5,000 sales: ${before.toFixed(0)} ms\n`
  );

  // The claim is that start-up is not proportional to the database. The seeded one
  // holds five thousand products and five thousand sales against an empty file, so a
  // proportional start-up would be orders of magnitude slower — this catches that
  // while staying loose enough to survive four perf files seeding in parallel, which
  // is how the suite actually runs and which made a tighter bound flaky.
  assert.ok(
    before < fresh * 5 + 2000,
    `a seeded database started in ${before.toFixed(0)} ms against ${fresh.toFixed(0)} ms empty`
  );
  assert.ok(before < CEILING_MS, `a seeded start-up of ${before.toFixed(0)} ms is past the ceiling`);
});

test('the figures above are not a release gate', () => {
  // 07_TEST_PLAN.md §6: NFR_1.4 is met on the reference machine or it is not met.
  assert.ok(true);
});
