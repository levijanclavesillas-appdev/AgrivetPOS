'use strict';

// TASK-063 — one store on the web and on its devices, for real: every installation here is
// its own server process with its own database, talking over HTTP as a store's would.
//
//   web first     a hub is set up on the web; device A and device B connect to it
//   offline       the hub goes away; A keeps selling, on credit too, and adds a customer
//   together      the hub sells and edits meanwhile; A syncs and both agree on everything
//   conflict      A and B give two customers one code offline; the hub keeps both
//   removed       the owner removes B; B stops syncing
//   mobile first  a store that began on device C goes online, and C carries on as its device

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const OWNER = { username: 'owner', password: 'owner-password-26' };
const CODE = 'SYNC-TEST-CODE-2026';
const servers = [];

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** A Chachi POS server of its own: a data folder, a port, and — for a hub — hosted mode. */
async function server(name, { hosted = false } = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agrivet-sync-${name}-`));
  const backups = fs.mkdtempSync(path.join(os.tmpdir(), `agrivet-sync-${name}-backups-`));
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', TZ: 'Asia/Manila',
    AGRIVET_DATA_DIR: dir, AGRIVET_PORT: String(port), AGRIVET_LICENSING: 'off', AGRIVET_BCRYPT_COST: '4',
    AGRIVET_BACKUP_SUGGESTION: backups,
    ...(hosted ? { AGRIVET_HOSTED: '1', AGRIVET_HOST: '127.0.0.1', AGRIVET_SETUP_CODE: CODE, AGRIVET_BACKUP_DIR: backups } : {}),
  };
  const srv = { name, port, base: `http://127.0.0.1:${port}`, dir, backups, env, child: null, log: '' };
  srv.start = async () => {
    srv.child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.child.stdout.on('data', (b) => { srv.log += b; });
    srv.child.stderr.on('data', (b) => { srv.log += b; });
    for (let i = 0; i < 100; i += 1) {
      try { if ((await fetch(`${srv.base}/api/v1/health`)).ok) return srv; } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${name} did not start:\n${srv.log}`);
  };
  srv.stop = () => new Promise((resolve) => {
    if (!srv.child || srv.child.exitCode !== null) return resolve();
    srv.child.once('exit', () => resolve());
    srv.child.kill('SIGTERM');
  });
  servers.push(srv);
  return srv.start();
}

async function api(srv, method, pathname, { token = null, body = null, headers = {} } = {}) {
  const res = await fetch(`${srv.base}/api/v1${pathname}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await res.json().catch(() => null);
  return { status: res.status, body: payload };
}

async function login(srv, who = OWNER) {
  const { status, body } = await api(srv, 'POST', '/auth/login', { body: who });
  assert.equal(status, 200, `${srv.name}: sign in ${who.username}: ${JSON.stringify(body)}`);
  return body.token;
}

const onHand = async (srv, token, productId) => (await api(srv, 'GET', `/inventory/${productId}`, { token })).body.on_hand.qty_on_hand_milli;
const salesOf = async (srv, token) => {
  const { body } = await api(srv, 'GET', '/sales?limit=100', { token });
  return (body.sales.rows || body.sales).map((s) => s.sale_no).sort();
};
const syncNow = async (srv, token) => (await api(srv, 'POST', '/sync/now', { token })).body;

async function sell(srv, token, productId, { qtyMilli, tenders, customerId = null, total }) {
  const res = await api(srv, 'POST', '/sales', {
    token, body: { lines: [{ productId, qtyMilli }], tenders, customerId, clientTotalCentavos: total },
  });
  assert.equal(res.status, 201, `${srv.name}: sale: ${JSON.stringify(res.body)}`);
  return res.body.sale;
}

const state = {};

// A runner stopped half-way must not leave servers behind on a shared machine.
process.on('exit', () => { for (const srv of servers) if (srv.child && srv.child.exitCode === null) srv.child.kill('SIGKILL'); });

test.after(async () => {
  for (const srv of servers) await srv.stop();
  for (const srv of servers) {
    fs.rmSync(srv.dir, { recursive: true, force: true });
    fs.rmSync(srv.backups, { recursive: true, force: true });
  }
});

// ── Web first ───────────────────────────────────────────────────────────────

test('TASK-063: a store set up on the web, stocked there', async () => {
  const hub = state.hub = await server('hub', { hosted: true });
  const setup = await api(hub, 'POST', '/setup', {
    body: {
      setupCode: CODE, industry: 'PHARMACY', taxMode: 'NONE', store: { storeName: 'Botika Web' },
      owner: { fullName: 'Web Owner', ...OWNER }, acknowledgedRecoveryCode: true,
    },
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  const token = state.hubToken = await login(hub);
  const unit = (await api(hub, 'POST', '/units', { token, body: { code: 'TAB', name: 'Tablet' } })).body.unit;
  const category = (await api(hub, 'POST', '/categories', { token, body: { name: 'Medicines' } })).body.category;
  const made = await api(hub, 'POST', '/products', {
    token, body: { sku: 'PAR-500', name: 'Paracetamol 500 mg', categoryId: category.id, baseUnitId: unit.id, retailPriceCentavos: 500, isBatchTracked: false },
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  state.product = made.body.product;
  const stocked = await api(hub, 'POST', '/inventory/adjustments', {
    token, body: { productId: state.product.id, qtyMilli: 100000, reason: 'Received but not recorded', unitCostCentavos: 300 },
  });
  assert.equal(stocked.status, 201, JSON.stringify(stocked.body));
  const nena = await api(hub, 'POST', '/customers', {
    token, body: { name: 'Aling Nena', code: 'NENA', customerType: 'REGULAR', priceLevel: 'RETAIL', isCreditEligible: true, creditLimitCentavos: 500000, termsDays: 15 },
  });
  assert.equal(nena.status, 201, JSON.stringify(nena.body));
  state.nena = nena.body.customer;
  assert.equal((await api(hub, 'GET', '/sync/status', { token })).body.role, 'HUB');
});

test('TASK-063: a fresh install connects to the web store and starts from it', async () => {
  const a = state.a = await server('device-a');
  const refused = await api(a, 'POST', '/setup/connect', { body: { hubUrl: state.hub.base, username: OWNER.username, password: 'wrong-password-1', deviceName: 'Counter A' } });
  assert.equal(refused.status, 403);

  const joined = await api(a, 'POST', '/setup/connect', { body: { hubUrl: state.hub.base, ...OWNER, deviceName: 'Counter A' } });
  assert.equal(joined.status, 201, `${JSON.stringify(joined.body)}\nhub: ${state.hub.log.slice(-3000)}\ndevice: ${a.log.slice(-3000)}`);
  assert.equal(joined.body.role, 'DEVICE');
  assert.equal(joined.body.device.series, 'A');
  assert.equal(joined.body.store_name, 'Botika Web');

  const token = state.aToken = await login(a);                       // the web store's owner, signing in on the device
  assert.equal(await onHand(a, token, state.product.id), 100000);
  const status = (await api(a, 'GET', '/sync/status', { token })).body;
  assert.equal(status.hub_url, state.hub.base);
  // The machine's own settings are its own, not the server's.
  const settings = (await api(a, 'GET', '/settings', { token })).body.settings;
  assert.equal(settings.find((s) => s.key === 'backup_folder').value, path.resolve(a.backups));
  assert.equal(settings.find((s) => s.key === 'printer_transport').value, 'NONE');

  const devices = (await api(state.hub, 'GET', '/sync/devices', { token: state.hubToken })).body.devices;
  assert.deepEqual(devices.map((d) => [d.name, d.series]), [['Counter A', 'A']]);
});

test('TASK-063: the device numbers its own documents, and its sale reaches the web', async () => {
  const { a, aToken: token } = state;
  assert.ok([200, 201].includes((await api(a, 'POST', '/shifts/open', { token, body: { openingFloatCentavos: 10000, confirmed: true } })).status));
  const sale = await sell(a, token, state.product.id, { qtyMilli: 2000, tenders: [{ method: 'CASH', amountCentavos: 1000 }], total: 1000 });
  assert.match(sale.sale_no, /^SALE-A-\d{8}-000001$/);

  const synced = await syncNow(a, token);
  assert.equal(synced.pending, 0, JSON.stringify(synced));
  assert.equal(synced.last_error, null);
  assert.equal(await onHand(state.hub, state.hubToken, state.product.id), 98000, 'the hub counts it');
  assert.deepEqual(await salesOf(state.hub, state.hubToken), [sale.sale_no]);
});

// ── Offline, then together ──────────────────────────────────────────────────

test('TASK-063: offline, the counter, credit and customers carry on; the catalogue waits', async () => {
  const { a, aToken: token } = state;
  await state.hub.stop();

  const offline = await syncNow(a, token);
  assert.equal(offline.rule_id, 'SYNC-004');
  assert.match(offline.error, /could not be reached/);

  const credit = await sell(a, token, state.product.id, {
    qtyMilli: 3000, customerId: state.nena.id, tenders: [{ method: 'CREDIT', amountCentavos: 1500 }], total: 1500,
  });
  assert.match(credit.sale_no, /^SALE-A-\d{8}-000002$/, 'gapless in its own series, offline');
  const ben = await api(a, 'POST', '/customers', { token, body: { name: 'Mang Ben', code: 'BEN', customerType: 'REGULAR', priceLevel: 'RETAIL' } });
  assert.equal(ben.status, 201, 'customers work offline');
  state.ben = ben.body.customer;

  const rename = await api(a, 'PUT', `/products/${state.product.id}`, { token, body: { name: 'Offline rename' } });
  assert.equal(rename.status, 409);
  assert.equal(rename.body.error.rule_id, 'SYNC-005', 'products wait for a connection');

  const status = (await api(a, 'GET', '/sync/status', { token })).body;
  assert.ok(status.pending > 0, 'and the changes wait');
  assert.equal(status.connected, false);
});

test('TASK-063: the web sells and edits meanwhile; the device syncs and they agree', async () => {
  const { a, aToken: token } = state;
  await state.hub.start();
  const hubToken = state.hubToken = await login(state.hub);
  assert.ok([200, 201].includes((await api(state.hub, 'POST', '/shifts/open', { token: hubToken, body: { openingFloatCentavos: 10000, confirmed: true } })).status));
  const webSale = await sell(state.hub, hubToken, state.product.id, { qtyMilli: 1000, tenders: [{ method: 'CASH', amountCentavos: 500 }], total: 500 });
  assert.match(webSale.sale_no, /^SALE-\d{8}-000001$/, 'the web copy keeps the store\'s own series');
  const renamed = await api(state.hub, 'PUT', `/products/${state.product.id}`, { token: hubToken, body: { name: 'Paracetamol 500 mg tablet' } });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));

  const synced = await syncNow(a, token);
  assert.equal(synced.pending, 0, JSON.stringify(synced));
  assert.equal(synced.last_error, null);

  // Stock: 100 − 2 (A) − 3 (A, offline) − 1 (web) = 94, on both, worked out by the hub.
  assert.equal(await onHand(state.hub, hubToken, state.product.id), 94000);
  assert.equal(await onHand(a, token, state.product.id), 94000);
  // Every sale on both.
  const all = await salesOf(state.hub, hubToken);
  assert.equal(all.length, 3);
  assert.deepEqual(await salesOf(a, token), all);
  // The web's edit reached the device; the device's customer reached the web.
  assert.equal((await api(a, 'GET', `/products/${state.product.id}`, { token })).body.product.name, 'Paracetamol 500 mg tablet');
  const webCustomers = (await api(state.hub, 'GET', '/customers?q=BEN', { token: hubToken })).body;
  assert.ok((webCustomers.rows || webCustomers.customers).some((c) => c.id === state.ben.id));
  // The credit sale made offline is on the account, on both (CR-103, recomputed by the hub).
  const hubCredit = (await api(state.hub, 'GET', `/customers/${state.nena.id}/credit`, { token: hubToken })).body.credit;
  const devCredit = (await api(a, 'GET', `/customers/${state.nena.id}/credit`, { token })).body.credit;
  assert.equal(hubCredit.balance_centavos, 1500);
  assert.equal(devCredit.balance_centavos, 1500);
});

test('TASK-063: a second device joins with its own letter and everything so far', async () => {
  const b = state.b = await server('device-b');
  const joined = await api(b, 'POST', '/setup/connect', { body: { hubUrl: state.hub.base, ...OWNER, deviceName: 'Owner phone' } });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  assert.equal(joined.body.device.series, 'B');
  const token = state.bToken = await login(b);
  assert.equal(await onHand(b, token, state.product.id), 94000);
  assert.equal((await salesOf(b, token)).length, 3);

  assert.ok([200, 201].includes((await api(b, 'POST', '/shifts/open', { token, body: { openingFloatCentavos: 5000, confirmed: true } })).status));
  const sale = await sell(b, token, state.product.id, { qtyMilli: 1000, tenders: [{ method: 'CASH', amountCentavos: 500 }], total: 500 });
  assert.match(sale.sale_no, /^SALE-B-\d{8}-000001$/);
  await syncNow(b, token);
  await syncNow(state.a, state.aToken);
  assert.ok((await salesOf(state.a, state.aToken)).includes(sale.sale_no), 'A has B\'s sale');
  assert.equal(await onHand(state.a, state.aToken, state.product.id), 93000);
});

test('TASK-070: a pack\'s own price and the quick keys, arranged on the web, reach the devices', async () => {
  const { hub, hubToken, a, aToken } = state;
  const box = await api(hub, 'POST', '/units', { token: hubToken, body: { code: 'BOXSYNC', name: 'Box' } });
  assert.equal(box.status, 201, JSON.stringify(box.body));
  const unitId = (box.body.unit || box.body.row || box.body).id;
  const packs = await api(hub, 'POST', `/products/${state.product.id}/packs`, { token: hubToken, body: { unitId, factorMilli: 10000 } });
  assert.equal(packs.status, 201, JSON.stringify(packs.body));
  const packId = packs.body.packs.find((p) => p.unit.id === unitId).id;
  const priced = await api(hub, 'PUT', `/products/${state.product.id}/packs/${packId}/prices`, { token: hubToken, body: { RETAIL: 4500 } });
  assert.equal(priced.status, 200, JSON.stringify(priced.body));
  for (const keys of [[{ productId: state.product.id }], [{ productId: state.product.id, packUnitId: unitId, label: 'Box' }, { productId: state.product.id }]]) {
    const arranged = await api(hub, 'PUT', '/quick-keys', { token: hubToken, body: { keys } });
    assert.equal(arranged.status, 200, JSON.stringify(arranged.body));
  }

  await syncNow(a, aToken);
  const onA = (await api(a, 'GET', '/quick-keys', { token: aToken })).body.keys;
  assert.deepEqual(onA.map((k) => [k.position, k.label]), [[1, 'Box'], [2, 'Paracetamol 500 mg tablet']], 'the rearranged set, not the first');
  const preview = await api(a, 'POST', '/sales/price-check', { token: aToken, body: { lines: [{ productId: state.product.id, qtyMilli: 1000, packUnitId: unitId }] } });
  assert.equal(preview.body.lines[0].unit_price_centavos, 4500, 'the box\'s own price, on the device');
});

test('TASK-063: two devices give one code to two customers offline; the web copy keeps both', async () => {
  await state.hub.stop();
  const onA = await api(state.a, 'POST', '/customers', { token: state.aToken, body: { name: 'Juan (A)', code: 'DUP', customerType: 'REGULAR', priceLevel: 'RETAIL' } });
  const onB = await api(state.b, 'POST', '/customers', { token: state.bToken, body: { name: 'Juan (B)', code: 'DUP', customerType: 'REGULAR', priceLevel: 'RETAIL' } });
  assert.equal(onA.status, 201);
  assert.equal(onB.status, 201);
  await state.hub.start();
  state.hubToken = await login(state.hub);
  await syncNow(state.a, state.aToken);
  const afterB = await syncNow(state.b, state.bToken);
  assert.equal(afterB.last_error, null, JSON.stringify(afterB));
  await syncNow(state.a, state.aToken);

  const codes = async (srv, token) => {
    const body = (await api(srv, 'GET', '/customers?q=Juan', { token })).body;
    return (body.rows || body.customers).map((c) => `${c.name}:${c.code}`).sort();
  };
  const expected = ['Juan (A):DUP', 'Juan (B):DUP-B'];
  assert.deepEqual(await codes(state.hub, state.hubToken), expected);
  assert.deepEqual(await codes(state.a, state.aToken), expected);
  assert.deepEqual(await codes(state.b, state.bToken), expected);
  const audit = (await api(state.hub, 'GET', '/audit?action=SYNC_CONFLICT', { token: state.hubToken })).body;
  assert.ok(JSON.stringify(audit).includes('DUP-B'), 'the conflict is on the trail');
});

test('TASK-063: a device the owner removes stops syncing', async () => {
  const devices = (await api(state.hub, 'GET', '/sync/devices', { token: state.hubToken })).body.devices;
  const b = devices.find((d) => d.series === 'B');
  assert.equal((await api(state.hub, 'POST', `/sync/devices/${b.id}/revoke`, { token: state.hubToken })).status, 200);
  const refused = await syncNow(state.b, state.bToken);
  assert.equal(refused.rule_id, 'SYNC-001');
  assert.match(refused.error, /removed/);
});

// ── Mobile first ────────────────────────────────────────────────────────────

test('TASK-063: a store that began on a device goes online, and the device carries on', async () => {
  const c = await server('device-c');
  const setup = await api(c, 'POST', '/setup', {
    body: {
      industry: 'PHARMACY', taxMode: 'NONE', store: { storeName: 'Botika sa Telepono' },
      owner: { fullName: 'Phone Owner', username: 'chachi', password: 'chachi-password-26' },
      backupFolder: c.backups, acknowledgedRecoveryCode: true,
    },
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  const token = await login(c, { username: 'chachi', password: 'chachi-password-26' });
  const unit = (await api(c, 'POST', '/units', { token, body: { code: 'TAB', name: 'Tablet' } })).body.unit;
  const category = (await api(c, 'POST', '/categories', { token, body: { name: 'Medicines' } })).body.category;
  const product = (await api(c, 'POST', '/products', { token, body: { sku: 'ASC', name: 'Ascorbic acid', categoryId: category.id, baseUnitId: unit.id, retailPriceCentavos: 400, isBatchTracked: false } })).body.product;
  await api(c, 'POST', '/inventory/adjustments', { token, body: { productId: product.id, qtyMilli: 50000, reason: 'Received but not recorded', unitCostCentavos: 250 } });
  await api(c, 'POST', '/shifts/open', { token, body: { openingFloatCentavos: 10000, confirmed: true } });
  const before = await sell(c, token, product.id, { qtyMilli: 1000, tenders: [{ method: 'CASH', amountCentavos: 400 }], total: 400 });
  assert.match(before.sale_no, /^SALE-\d{8}-000001$/, 'standalone: the store\'s own series');

  const web = await server('hub-2', { hosted: true });
  const wrong = await api(c, 'POST', '/sync/go-online', { token, body: { hubUrl: web.base, setupCode: 'WRONG-CODE-XXXX', password: 'chachi-password-26', deviceName: 'Botika phone' } });
  assert.equal(wrong.status, 403, JSON.stringify(wrong.body));
  assert.equal((await api(c, 'GET', '/sync/status', { token })).body.role, 'STANDALONE', 'nothing changed');

  const online = await api(c, 'POST', '/sync/go-online', { token, body: { hubUrl: web.base, setupCode: CODE, password: 'chachi-password-26', deviceName: 'Botika phone' } });
  assert.equal(online.status, 200, JSON.stringify(online.body));
  assert.equal(online.body.role, 'DEVICE');
  assert.equal(online.body.device.series, 'A');

  const webToken = await login(web, { username: 'chachi', password: 'chachi-password-26' });
  assert.deepEqual(await salesOf(web, webToken), [before.sale_no], 'the store is on the web, history and all');
  assert.equal(await onHand(web, webToken, product.id), 49000);

  const after = await sell(c, token, product.id, { qtyMilli: 2000, tenders: [{ method: 'CASH', amountCentavos: 800 }], total: 800 });
  assert.match(after.sale_no, /^SALE-A-\d{8}-000001$/, 'the phone now has its own letter');
  const synced = await syncNow(c, token);
  assert.equal(synced.pending, 0, JSON.stringify(synced));
  assert.deepEqual(await salesOf(web, webToken), [before.sale_no, after.sale_no].sort());
  assert.equal(await onHand(web, webToken, product.id), 47000);

  assert.ok([200, 201].includes((await api(web, 'POST', '/shifts/open', { token: webToken, body: { openingFloatCentavos: 10000, confirmed: true } })).status));
  const onWeb = await sell(web, webToken, product.id, { qtyMilli: 1000, tenders: [{ method: 'CASH', amountCentavos: 400 }], total: 400 });
  assert.match(onWeb.sale_no, /^SALE-\d{8}-000002$/, 'the web continues the store\'s original series');
});
