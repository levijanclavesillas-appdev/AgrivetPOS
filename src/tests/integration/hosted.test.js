'use strict';

// TASK-062 — the web version: a copy of the POS on the internet, started the way
// web/compose.yml starts one. Nothing here runs on a store's PC; the last case checks that.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const server = require('../../server');
const hosting = require('../../config/hosting');
const setupService = require('../../services/setupService');
const settingsService = require('../../services/settingsService');
const productService = require('../../services/productService');
const inventoryService = require('../../services/inventoryService');
const auditService = require('../../services/auditService');
const authService = require('../../services/authService');
const temp = require('../helpers/tempdb');

const CODE = 'K7QM-3XPD-9WTR-HN4B';
const PASSWORD = 'owner-password-2026';
let BASE = null;
let instance;
let backups;

const call = (urlPath, { token = null, method = 'GET', body = null, headers = {} } = {}) => fetch(`${BASE}${urlPath}`, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
    ...headers,
  },
  ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
});

const wizard = (over = {}) => ({
  industry: 'PHARMACY',
  store: { storeName: 'Botika Online' },
  taxMode: 'NONE',
  owner: { fullName: 'Web Owner', username: 'webowner', password: PASSWORD },
  backupFolder: '/somewhere/the/browser/typed',
  acknowledgedRecoveryCode: true,
  ...over,
});

test.before(async () => {
  backups = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-hosted-backups-'));
  process.env.AGRIVET_HOSTED = '1';
  process.env.AGRIVET_HOST = '127.0.0.1';          // a test binds locally; a container binds 0.0.0.0
  process.env.AGRIVET_SETUP_CODE = CODE;
  process.env.AGRIVET_BACKUP_DIR = backups;
  temp.openEmpty('hosted');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;
  setupService.resetSetupCodeFailures();
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
  for (const key of ['AGRIVET_HOSTED', 'AGRIVET_HOST', 'AGRIVET_SETUP_CODE', 'AGRIVET_BACKUP_DIR']) delete process.env[key];
  fs.rmSync(backups, { recursive: true, force: true });
});

test('TASK-062: a hosted copy answers with the headers the internet needs', async () => {
  const res = await call('/health');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'none'");
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  const page = await fetch(BASE.replace('/api/v1', '/'));
  assert.match(await page.text(), /Content-Security-Policy/, 'the wizard page carries its policy too');
});

test('TASK-062: the first visitor is not the owner — setup needs the code Chachi\'s sent', async () => {
  const status = await (await call('/setup')).json();
  assert.equal(status.hosted, true);
  assert.equal(status.setup_code_required, true);
  assert.equal(status.suggested_backup_folder, backups);

  const without = await call('/setup', { method: 'POST', body: wizard() });
  assert.equal(without.status, 403);
  assert.equal((await without.json()).error.rule_id, 'SEC-8');

  // The restore path too, refused before a byte of the upload is read.
  const restore = await call('/setup/restore?fileName=x.zip', { method: 'POST', body: 'not a zip', headers: { 'content-type': 'application/zip' } });
  assert.equal(restore.status, 403);

  assert.equal((await call('/setup/code', { method: 'POST', body: { setupCode: 'WRONG-CODE-1234' } })).status, 403);
  // Case, spaces and dashes forgiven: it is read off a message.
  assert.equal((await call('/setup/code', { method: 'POST', body: { setupCode: ' k7qm 3xpd 9wtr hn4b ' } })).status, 204);
  assert.equal((await call('/setup')).status, 200);
});

test('TASK-062: wrong codes are counted; the sixth try within fifteen minutes waits', async () => {
  setupService.resetSetupCodeFailures();
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await call('/setup/code', { method: 'POST', body: { setupCode: `GUESS-${i}-GUESS` } })).status, 403);
  }
  const locked = await call('/setup/code', { method: 'POST', body: { setupCode: CODE } });
  assert.equal(locked.status, 423, 'even the right code waits');
  setupService.resetSetupCodeFailures();
});

test('TASK-062: set up with the code, backups on the server\'s volume, printing through the browser', async () => {
  const res = await call('/setup', { method: 'POST', body: wizard({ setupCode: CODE }) });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.backupFolder, path.resolve(backups), 'not the folder the form named');
  assert.equal(settingsService.get('printer_transport'), 'BROWSER');

  // The folder is the server's, and stays so.
  const token = authService.login({ username: 'webowner', password: PASSWORD }).token;
  const change = await call('/settings', { token, method: 'PUT', body: { backup_folder: path.join(os.tmpdir(), 'elsewhere') } });
  assert.equal(change.status, 400);
  assert.equal((await change.json()).error.rule_id, 'OPS-001');
});

test('TASK-062: a sale\'s receipt comes back for the browser to print; the drawer does not pretend', async () => {
  const owner = authService.verifyToken(authService.login({ username: 'webowner', password: PASSWORD }).token);
  const token = authService.login({ username: 'webowner', password: PASSWORD }).token;
  const ref = temp.seedCatalog();
  const product = productService.create({
    sku: 'WEB-001', name: 'Paracetamol 500 mg', categoryId: ref.category.id, baseUnitId: ref.kg.id,
    retailPriceCentavos: 500, isBatchTracked: false,
  }, owner);
  inventoryService.postStandalone({ productId: product.id, type: 'RECEIPT', qtyMilli: 100000, unitCostCentavos: 300, actor: owner });
  assert.equal((await call('/shifts/open', { token, method: 'POST', body: { openingFloatCentavos: 50000, confirmed: true } })).status, 201);

  const sale = await call('/sales', {
    token, method: 'POST',
    body: { lines: [{ productId: product.id, qtyMilli: 2000 }], tenders: [{ method: 'CASH', amountCentavos: 1000 }], clientTotalCentavos: 1000 },
  });
  const body = await sale.json();
  assert.equal(sale.status, 201, JSON.stringify(body));
  assert.equal(body.printed.transport, 'BROWSER');
  assert.match(body.printed.text, /Botika Online/, 'the document itself, for the print dialog');
  assert.match(body.printed.text, /not an official receipt/i, 'TAX-006 on the browser\'s paper too');
  assert.doesNotMatch(body.printed.text, /REPRINT/);

  const reprint = await (await call(`/sales/${body.sale.id}/reprint`, { token, method: 'POST', body: {} })).json();
  assert.match(reprint.printed.text, /REPRINT/, 'POS-208 on the second copy');
});

test('TASK-062: the owner downloads a verified backup; a manager cannot; it is audited', async () => {
  const token = authService.login({ username: 'webowner', password: PASSWORD }).token;
  const made = await (await call('/backups', { token, method: 'POST', body: {} })).json();
  assert.equal(made.ok, true);
  assert.ok(made.file_path.startsWith(backups), 'into the backup volume');

  const res = await call(`/backups/${made.id}/download`, { token });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition'), new RegExp(made.file_name));
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.ok(bytes.equals(fs.readFileSync(made.file_path)), 'the file itself');

  temp.seedUser({ username: 'webmanager', role: 'MANAGER', password: PASSWORD });
  const manager = authService.login({ username: 'webmanager', password: PASSWORD }).token;
  assert.equal((await call(`/backups/${made.id}/download`, { token: manager })).status, 403);

  const [row] = auditService.list({ action: 'BACKUP_DOWNLOADED' });
  assert.equal(row.actor_username, 'webowner');
});

test('TASK-062: on a store\'s PC none of this applies', () => {
  const saved = { ...process.env };
  delete process.env.AGRIVET_HOSTED;
  try {
    assert.equal(hosting.isHosted(), false);
    assert.equal(hosting.listenHost(), '127.0.0.1', 'SEC-8, whatever AGRIVET_HOST says');
    assert.equal(hosting.backupDir(), null);
    assert.doesNotThrow(() => setupService.assertSetupCode(undefined));
  } finally {
    Object.assign(process.env, saved);
  }
  assert.match(hosting.newSetupCode(), /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
});
