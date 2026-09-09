'use strict';

// The embedded API: it answers on loopback, it reports OPS-006, and it is not
// reachable from the LAN (SEC-8).

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const net = require('net');
const server = require('../../server');
const temp = require('../helpers/tempdb');

const PORT = 47899;   // not the production default, so a running app is untouched
const BASE = `http://127.0.0.1:${PORT}`;

let instance;

test.before(async () => {
  temp.openEmpty('server');          // migrate() inside start() brings it to current
  instance = await server.start({ listenPort: PORT });
  temp.seedStore();                  // past the FR_1.1 setup gate; the wizard has its own cases
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

test('GET /api/v1/health is thin, and says nothing about the store', async () => {
  // main.js polls this before the window opens, so it answers before anyone has
  // authenticated (05_TECH_SPEC.md §4). TASK-017 moved OPS-006's six figures behind
  // TX-428 for exactly that reason: an unauthenticated caller on the loopback has no
  // business learning how many sales the store has taken.
  const res = await fetch(`${BASE}/api/v1/health`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.status, 'ok');
  assert.match(body.checked_at, /Z$/, 'UTC (VR-102)');
  assert.ok(body.app_version);

  for (const leaked of ['database', 'row_counts', 'schema', 'backup']) {
    assert.equal(leaked in body, false, `${leaked} is not served unauthenticated`);
  }
});

test('GET /api/v1/health/panel reports OPS-006’s six figures, behind TX-428', async () => {
  const anonymous = await fetch(`${BASE}/api/v1/health/panel`);
  assert.equal(anonymous.status, 401, 'and not to anyone who has not signed in');

  const token = require('../../services/authService')
    .login({ username: 'installowner', password: 'correct-horse-battery' }).token;
  const res = await fetch(`${BASE}/api/v1/health/panel`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.schema.version, body.schema.binary_version, 'a started server is fully migrated');
  assert.equal(body.schema.binary_version, require('../../config/migrate').binaryVersion());
  assert.equal(body.schema.up_to_date, true);
  assert.ok(body.database.size_bytes > 0, 'a migrated database has a size');
  assert.deepEqual(Object.keys(body.database.row_counts).sort(), [
    'alert_dismissals', 'audit_logs', 'backups', 'brands', 'carts', 'cashier_closings',
    'cashier_shifts', 'categories', 'closing_method_lines', 'credit_allocations',
    'customer_credit_accounts', 'customer_credit_transactions', 'customers',
    'goods_receipt_items', 'goods_receipts',
    'inventory', 'inventory_movements',
    'product_barcodes', 'product_packs', 'product_prices', 'products',
    'purchase_order_items', 'purchase_orders',
    'sale_discounts', 'sale_items', 'sale_return_items', 'sale_returns', 'sale_tenders', 'sales',
    'schema_migrations', 'stock_count_lines', 'stock_count_sessions',
    'store_profile', 'suppliers', 'system_events', 'system_settings',
    'till_movements', 'units', 'users',
  ]);
  assert.equal(body.database.row_counts.schema_migrations, body.schema.binary_version);

  // OPS-006's six, all present and honest about being empty on a fresh install.
  assert.equal(body.backup.last_successful_at, null, 'nothing has been backed up yet');
  assert.equal(body.last_export_at, null);
  assert.equal(body.last_integrity_check_at, null);
});

test('the renderer is served from the same origin as the API', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Chachi Agrivet POS/);
});

test('an unknown API route returns the documented error shape (05_TECH_SPEC.md §4)', async () => {
  const res = await fetch(`${BASE}/api/v1/nope`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.ok(body.error.message.includes('/api/v1/nope'));
});

test('SEC-8: the API is not reachable on a non-loopback interface', async (t) => {
  const external = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);

  if (external.length === 0) {
    t.skip('no non-loopback IPv4 interface on this machine to test against');
    return;
  }

  for (const address of external) {
    const refused = await new Promise((resolve) => {
      const socket = net.connect({ host: address, port: PORT, timeout: 1500 });
      socket.on('connect', () => { socket.destroy(); resolve(false); });
      socket.on('error', () => resolve(true));
      socket.on('timeout', () => { socket.destroy(); resolve(true); });
    });
    assert.ok(refused, `the API answered on ${address}:${PORT}; SEC-8 requires loopback only`);
  }
});

test('a second launch reuses the running server rather than duplicating it', async () => {
  // TASK-001 requirement 1. Two processes writing one SQLite file is not a state
  // worth reaching, and a second shortcut click must not fail on EADDRINUSE.
  assert.equal(await server.probe({ listenPort: PORT }), true, 'the first server is up');

  const second = await server.ensureStarted({ listenPort: PORT });

  assert.equal(second, null, 'ensureStarted must not open a second listener');
  const res = await fetch(`${BASE}/api/v1/health`);
  assert.equal(res.status, 200, 'the original server is untouched');
});

test('probe() reports false on a port nothing is listening on', async () => {
  assert.equal(await server.probe({ listenPort: 47898, timeoutMs: 500 }), false);
});

test('waitForHealth() gives up rather than hanging when nothing answers', async () => {
  const answered = await server.waitForHealth({ listenPort: 47898, attempts: 3, intervalMs: 20 });
  assert.equal(answered, false);
});
