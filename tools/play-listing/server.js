'use strict';
// The Google Play listing's screenshots (TASK-068 follow-up): a throwaway POS with an
// invented pharmacy and a morning's trade, so every screen captured has something real
// on it. Same shape as tools/browser-smoke/server.js: the API in its own Node process.

const path = require('path');
const fs = require('fs');
const os = require('os');

const PROJECT = path.join(__dirname, '..', '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chachi-listing-'));
const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chachi-listing-backups-'));
process.env.AGRIVET_DATA_DIR = root;
process.env.AGRIVET_BCRYPT_COST = '6';
process.env.AGRIVET_LICENSING = 'off';

const PORT = Number(process.env.UI_PORT || 47896);
const API = `http://127.0.0.1:${PORT}/api/v1`;
const USER = 'maria';
const PASSWORD = 'listing-demo-2026';

async function api(pathname, { method = 'GET', body = null, token = null } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  if (res.status >= 400) throw new Error(`${method} ${pathname}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const csv = (rows) => `${rows.map((r) => r.join(',')).join('\n')}\n`;
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const PRODUCTS = [
  // sku, name, generic, category, unit, retail (₱), tax class, barcode, min stock, batch-tracked
  ['PARA-500', 'Paracetamol 500 mg tablet', 'Paracetamol', 'Pain and fever', 'TAB', '6.00', 'VAT_EXEMPT', '4800000100017', '100', 'yes'],
  ['IBU-400', 'Ibuprofen 400 mg capsule', 'Ibuprofen', 'Pain and fever', 'CAP', '9.50', 'VAT_EXEMPT', '4800000100024', '60', 'yes'],
  ['CET-10', 'Cetirizine 10 mg tablet', 'Cetirizine', 'Allergy', 'TAB', '8.00', 'VAT_EXEMPT', '4800000100031', '50', 'yes'],
  ['AMB-SYR', 'Ambroxol 30 mg/5 mL syrup 60 mL', 'Ambroxol', 'Cough and cold', 'BTL', '95.00', 'VAT_EXEMPT', '4800000100048', '10', 'yes'],
  ['LOP-2', 'Loperamide 2 mg capsule', 'Loperamide', 'Stomach', 'CAP', '7.75', 'VAT_EXEMPT', '4800000100055', '40', 'yes'],
  ['ORS-SACH', 'Oral rehydration salts sachet', 'ORS', 'Stomach', 'SACHET', '18.00', 'VAT_EXEMPT', '4800000100062', '20', 'no'],
  ['ASC-500', 'Ascorbic acid 500 mg tablet', 'Ascorbic acid', 'Vitamins', 'TAB', '5.00', 'VATABLE', '4800000100079', '100', 'no'],
  ['MV-KIDS', 'Multivitamin syrup for kids 120 mL', 'Multivitamins', 'Vitamins', 'BTL', '145.00', 'VATABLE', '4800000100086', '6', 'no'],
  ['POV-60', 'Povidone-iodine 10% solution 60 mL', 'Povidone-iodine', 'First aid', 'BTL', '85.00', 'VATABLE', '4800000100093', '5', 'no'],
  ['ALC-500', 'Isopropyl alcohol 70% 500 mL', 'Isopropyl alcohol', 'First aid', 'BTL', '78.00', 'VATABLE', '4800000100109', '12', 'no'],
  ['BAND-100', 'Adhesive bandage strip', '', 'First aid', 'PC', '3.00', 'VATABLE', '4800000100116', '100', 'no'],
  ['MASK-50', 'Face mask 3-ply', '', 'First aid', 'PC', '4.00', 'VATABLE', '4800000100123', '50', 'no'],
];
const STOCK = { 'PARA-500': 480, 'IBU-400': 220, 'CET-10': 30, 'AMB-SYR': 14, 'LOP-2': 160, 'ORS-SACH': 9,
  'ASC-500': 430, 'MV-KIDS': 18, 'POV-60': 11, 'ALC-500': 26, 'BAND-100': 800, 'MASK-50': 35 };
const COST = { 'PARA-500': '3.90', 'IBU-400': '6.40', 'CET-10': '5.20', 'AMB-SYR': '68.00', 'LOP-2': '5.10', 'ORS-SACH': '12.00',
  'ASC-500': '3.10', 'MV-KIDS': '101.00', 'POV-60': '58.00', 'ALC-500': '52.00', 'BAND-100': '1.60', 'MASK-50': '2.30' };

(async () => {
  const server = require(path.join(PROJECT, 'src/server.js'));
  await server.start({ listenPort: PORT });

  await api('/setup', {
    method: 'POST',
    body: {
      industry: 'PHARMACY',
      store: { storeName: 'Botika Santa Maria', address: 'Poblacion, Koronadal City', contactNo: '09171234567' },
      taxMode: 'NONE',
      owner: { username: USER, fullName: 'Maria Santos', password: PASSWORD, pin: '482913' },
      backupFolder: backupRoot,
      acknowledgedRecoveryCode: true,
    },
  });
  const token = (await api('/auth/login', { method: 'POST', body: { username: USER, password: PASSWORD } })).token;

  const categories = [...new Set(PRODUCTS.map((p) => p[3]))];
  await api('/data/opening', {
    method: 'POST', token,
    body: {
      reason: 'Listing demo',
      categories: csv([['name'], ...categories.map((c) => [c])]),
      units: csv([['code', 'name'], ['TAB', 'Tablet'], ['CAP', 'Capsule'], ['BTL', 'Bottle'], ['SACHET', 'Sachet'], ['PC', 'Piece'], ['BOX', 'Box']]),
      suppliers: csv([['name', 'code', 'contact_no', 'terms_days'], ['Mindanao Pharma Supply', 'MPS', '09179876543', '30']]),
      products: csv([
        ['sku', 'name', 'generic_name', 'category', 'base_unit', 'retail_price', 'tax_class', 'barcode', 'min_stock', 'batch_tracked'],
        ...PRODUCTS,
      ]),
      packs: csv([['sku', 'unit', 'contains', 'barcode'], ['PARA-500', 'BOX', '100', '4800000100900']]),
      stock: csv([
        ['sku', 'quantity', 'unit_cost', 'batch_no', 'expiry_date', 'supplier'],
        ...PRODUCTS.map(([sku, , , , , , , , , batch]) => [sku, STOCK[sku], COST[sku],
          batch === 'yes' ? `${sku.slice(0, 3)}-2${sku.length}41` : '', batch === 'yes' ? day(sku === 'AMB-SYR' ? 40 : 420) : '',
          batch === 'yes' ? 'Mindanao Pharma Supply' : '']),
      ]),
      balances: csv([
        ['customer', 'balance', 'contact_no', 'credit_limit', 'terms_days'],
        ['Barangay Zone IV Health Center', '12500.00', '09171112222', '50000.00', '30'],
        ['Aling Nena Reyes', '860.00', '09183334444', '2000.00', '15'],
        ['St. Joseph Clinic', '4320.00', '09195556666', '20000.00', '30'],
      ]),
    },
  });

  const products = {};
  for (const [sku, , , , , , , barcode] of PRODUCTS) {
    products[sku] = (await api(`/products/barcode/${barcode}`, { token })).product;
  }
  const customers = (await api('/customers?q=', { token })).customers || [];

  // A morning's trade, so the dashboard and the shift have figures.
  await api('/shifts/open', { method: 'POST', token, body: { openingFloatCentavos: 200000, confirmed: true } });
  const sell = async (lines, tender, extra = {}) => {
    const body = { lines: lines.map(([sku, qty]) => ({ productId: products[sku].id, qtyMilli: qty * 1000 })), ...extra };
    const preview = await api('/sales/price-check', { method: 'POST', token, body });
    const total = preview.total_centavos;
    const tenders = tender === 'CASH' ? [{ method: 'CASH', amountCentavos: Math.ceil(total / 10000) * 10000 }]
      : tender === 'GCASH' ? [{ method: 'GCASH', amountCentavos: total, referenceNo: `GC${Math.floor(Math.random() * 1e9)}` }]
        : [{ method: 'CREDIT', amountCentavos: total }];
    await api('/sales', { method: 'POST', token, body: { ...body, tenders, clientTotalCentavos: total } });
  };
  await sell([['PARA-500', 10], ['ORS-SACH', 2]], 'CASH');
  await sell([['AMB-SYR', 1], ['CET-10', 10]], 'GCASH');
  await sell([['MV-KIDS', 1], ['ASC-500', 20]], 'CASH');
  await sell([['BAND-100', 10], ['POV-60', 1], ['ALC-500', 1]], 'CASH');
  await sell([['IBU-400', 20], ['LOP-2', 8]], 'GCASH');
  const health = customers.find((c) => /Health Center/.test(c.name));
  if (health) await sell([['PARA-500', 100], ['ORS-SACH', 5]], 'CREDIT', { customerId: health.id });
  await sell([['MASK-50', 10], ['ASC-500', 10]], 'CASH');

  console.log(`READY ${JSON.stringify({ port: PORT, user: USER, password: PASSWORD, customerId: health ? health.id : null })}`);
})().catch((err) => { console.error('SERVER CRASH', err); process.exit(2); });
