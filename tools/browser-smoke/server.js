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

  // A pack, so SCR-202's Units tab has something to state in words (UOM-002).
  const sack = (await api('/units', {
    method: 'POST', token, body: { name: 'Sack', code: 'SACK', allowsFraction: false },
  })).json.unit;
  await api(`/products/${product.id}/packs`, {
    method: 'POST', token, body: { unitId: sack.id, factorMilli: 50000 },
  });
  await api('/inventory/adjustments', {
    method: 'POST', token,
    body: { productId: product.id, type: 'RECEIPT', qtyMilli: 500000, unitCostCentavos: 4000, reason: 'Received but not recorded' },
  });

  // A batch-tracked line, so SCR-305 has something POS-304 actually defaults to
  // write-off. Without one the return screen's central rule renders in only its easy
  // case, which is the half nobody gets wrong.
  const vet = (await api('/categories', { method: 'POST', token, body: { name: 'Veterinary' } })).json.category;
  const medicine = (await api('/products', {
    method: 'POST', token,
    body: {
      sku: 'VET-AMOX-100', name: 'Amoxicillin 100ml', categoryId: vet.id, baseUnitId: kg.id,
      retailPriceCentavos: 32000, isBatchTracked: true,
    },
  })).json.product;
  await api('/inventory/adjustments', {
    method: 'POST', token,
    body: { productId: medicine.id, type: 'RECEIPT', qtyMilli: 20000, unitCostCentavos: 21000, reason: 'Received but not recorded' },
  });

  // A credit customer, so SCR-401 to SCR-403 have something to show.
  const farm = (await api('/customers', {
    method: 'POST', token,
    body: {
      name: 'Santos Farm', code: 'SANTOS', customerType: 'FARM', priceLevel: 'RETAIL',
      isCreditEligible: true, creditLimitCentavos: 5000000, termsDays: 30,
    },
  })).json.customer;

  // A supplier, so SCR-801 to SCR-804 have somebody to buy from (VR-401).
  const mill = (await api('/suppliers', {
    method: 'POST', token,
    body: { name: 'B-MEG Feeds', code: 'BMEG', contactNo: '09171234567', termsDays: 30 },
  })).json.supplier;

  // A second user who may receive goods and may not authorise an exception. Without
  // one, PO-204 and PO-205 self-authorise for the owner and the panel never opens —
  // which would leave the half of SCR-803 most worth driving untested.
  await api('/users', {
    method: 'POST', token,
    body: { username: 'bodega', fullName: 'Bodega Clerk', password: 'sack-of-feed-2026', role: 'INVENTORY' },
  });

  // Everything the browser side needs to drive and to check against.
  console.log(`READY ${JSON.stringify({ port: PORT, token, productId: product.id, medicineId: medicine.id, customerId: farm.id, supplierId: mill.id })}`);
})().catch((err) => { console.error('SERVER CRASH', err); process.exit(2); });
