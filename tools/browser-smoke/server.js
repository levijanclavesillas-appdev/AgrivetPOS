'use strict';
// The API, in its own Node process with its own native modules. Electron is only the
// browser in this test — mixing the two would need better-sqlite3 rebuilt for
// Electron's ABI, which is TASK-018's problem, not TASK-015's.

const path = require('path');
const fs = require('fs');
const os = require('os');

const PROJECT = path.join(__dirname, '..', '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-ui-'));
const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-ui-backups-'));
process.env.AGRIVET_DATA_DIR = root;
process.env.AGRIVET_BCRYPT_COST = '6';

const PORT = Number(process.env.UI_PORT || 47897);
const API = `http://127.0.0.1:${PORT}/api/v1`;

async function api(pathname, { method = 'GET', body = null, token = null } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

(async () => {
  const server = require(path.join(PROJECT, 'src/server.js'));
  await server.start({ listenPort: PORT });

  await api('/setup', {
    method: 'POST',
    body: {
      store: { storeName: 'Chachi Agrivet', address: 'Poblacion, Sultan Kudarat', contactNo: '09171234567', tin: '123-456-789-000' },
      taxMode: 'NON_VAT',
      owner: { username: 'chachi', fullName: 'Chachi Dela Cruz', password: 'sack-of-feed-2026', pin: '441703' },
      backupFolder: backupRoot,
      acknowledgedRecoveryCode: true,
    },
  });
  const token = (await api('/auth/login', { method: 'POST', body: { username: 'chachi', password: 'sack-of-feed-2026' } })).json.token;
  const kg = (await api('/units', { method: 'POST', token, body: { name: 'Kilogram', code: 'KG', allowsFraction: true } })).json.unit;
  const cat = (await api('/categories', { method: 'POST', token, body: { name: 'Feeds' } })).json.category;
  const product = (await api('/products', {
    method: 'POST', token,
    body: { sku: 'FEED-HG-50', name: 'Hog Grower Pellets', categoryId: cat.id, baseUnitId: kg.id, retailPriceCentavos: 6250 },
  })).json.product;
  await api(`/products/${product.id}/barcodes`, { method: 'POST', token, body: { barcode: '4800012345678' } });
  await api('/inventory/adjustments', {
    method: 'POST', token,
    body: { productId: product.id, type: 'RECEIPT', qtyMilli: 500000, unitCostCentavos: 4000, reason: 'Received but not recorded' },
  });

  // Everything the browser side needs to drive and to check against.
  console.log(`READY ${JSON.stringify({ port: PORT, token, productId: product.id })}`);
})().catch((err) => { console.error('SERVER CRASH', err); process.exit(2); });
