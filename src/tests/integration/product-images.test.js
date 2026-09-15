'use strict';

// A product's picture — TASK-052, IMG-001 – IMG-002.
//
// Over HTTP, as the renderer sends them: base64 in the JSON, and the bytes read back
// with the token. The pictures here are only their first bytes plus padding — the
// server checks the format by magic number and never decodes, so that is all a JPEG,
// a PNG or a WebP has to be for this test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const server = require('../../server');
const authService = require('../../services/authService');
const settingsService = require('../../services/settingsService');
const exportService = require('../../services/exportService');
const importService = require('../../services/importService');
const db = require('../../config/database');
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
const JPEG_THUMB = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 3)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1500, 1)]);
const PNG_THUMB = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 2)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

let pos;
let BASE;
let product;
const tokens = {};

const call = (p, { token = tokens.OWNER, method = 'GET', body = null } = {}) => fetch(`${BASE}${p}`, {
  method,
  headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const json = async (response) => ({ status: response.status, body: await response.json() });
const put = (image, thumb, token) => call(`/products/${product.id}/image`, {
  token, method: 'PUT', body: { image: image.toString('base64'), thumb: thumb.toString('base64') },
});

test.before(async () => {
  temp.openEmpty('product-images');
  pos = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${pos.address().port}/api/v1`;
  temp.seedStore({ storeName: 'Botika ni Aling Rosa', taxMode: 'NONE', withOwner: false });
  for (const role of ['OWNER', 'CASHIER', 'INVENTORY']) {
    const username = role.toLowerCase();
    temp.seedUser({ username, role, password: PASSWORD });
    tokens[role] = authService.login({ username, password: PASSWORD }).token;
  }
  const owner = authService.verifyToken(tokens.OWNER);
  settingsService.set('backup_folder', fs.mkdtempSync(path.join(os.tmpdir(), 'image-backups-')), owner);

  const ref = temp.seedCatalog(owner);
  const created = await json(await call('/products', { method: 'POST', body: {
    sku: 'BIO-500', name: 'Biogesic 500 mg', genericName: 'Paracetamol',
    categoryId: ref.category.id, baseUnitId: ref.piece.id, retailPriceCentavos: 550,
  } }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  product = created.body.product;
});

test.after(async () => {
  await server.stop(pos);
  temp.cleanup();
});

test('TASK-052: a product starts with no picture, and says so', async () => {
  assert.equal(product.image_version, null);
  const missing = await call(`/products/${product.id}/image`);
  assert.equal(missing.status, 404);
});

test('IMG-001: a JPEG and its thumbnail are stored, and the product carries their version', async () => {
  const saved = await json(await put(JPEG, JPEG_THUMB));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.match(saved.body.image.version, /^[0-9a-f]{16}$/);
  assert.equal(saved.body.image.mime, 'image/jpeg');

  const listed = await json(await call('/products?q=paracetamol', { token: tokens.CASHIER }));
  assert.equal(listed.body.products[0].image_version, saved.body.image.version, 'the list says which picture');
});

test('IMG-001: the bytes come back as they went, each size, to a cashier too', async () => {
  const full = await call(`/products/${product.id}/image`, { token: tokens.CASHIER });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'image/jpeg');
  assert.match(full.headers.get('cache-control'), /immutable/);
  assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), JPEG);

  const thumb = await call(`/products/${product.id}/image?size=thumb`, { token: tokens.CASHIER });
  assert.deepEqual(Buffer.from(await thumb.arrayBuffer()), JPEG_THUMB);
});

test('IMG-001: anything that is not a JPEG, PNG or WebP is refused — an SVG above all', async () => {
  const svg = await json(await put(SVG, SVG));
  assert.equal(svg.status, 400);
  assert.equal(svg.body.error.rule_id, 'IMG-001');
  assert.match(svg.body.error.message, /not a JPEG, PNG or WebP/);

  const mixed = await json(await put(PNG, JPEG_THUMB));
  assert.equal(mixed.status, 400, 'the two sizes are one format');

  const junk = await json(await call(`/products/${product.id}/image`, { method: 'PUT', body: { image: 'not base64!', thumb: 'x' } }));
  assert.equal(junk.status, 400);
});

test('IMG-001: a picture over its size is refused with what to do', async () => {
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(80 * 1024, 9)]);
  const refused = await json(await put(JPEG, big));
  assert.equal(refused.status, 400);
  assert.match(refused.body.error.message, /thumbnail is 81 KB; the most is 64 KB/);
});

test('IMG-002: a cashier sees the picture and cannot change it; stock staff can', async () => {
  const cashier = await json(await put(PNG, PNG_THUMB, tokens.CASHIER));
  assert.equal(cashier.status, 403);

  const clerk = await json(await put(PNG, PNG_THUMB, tokens.INVENTORY));
  assert.equal(clerk.status, 200);
  assert.equal(clerk.body.image.mime, 'image/png');
  assert.notEqual(clerk.body.image.version, product.image_version);
});

test('IMG-002: setting is on the trail, by version, never the bytes', async () => {
  const rows = db.get().prepare("SELECT action, after_value, before_value FROM audit_logs WHERE action LIKE 'PRODUCT_IMAGE_%' ORDER BY rowid").all();
  assert.deepEqual(rows.map((r) => r.action), ['PRODUCT_IMAGE_SET', 'PRODUCT_IMAGE_SET']);
  assert.match(rows[1].before_value, /"image":"[0-9a-f]{16}"/, 'the replacement names the picture it replaced');
  assert.ok(rows.every((r) => (r.after_value || '').length < 300), 'no picture in the trail');
});

test('TASK-052: the picture travels in an export and comes back with an import', async () => {
  const { archive } = exportService.build();
  const entry = require('../../config/zip').unzipMany(archive).find((e) => e.name === 'product_images.json');
  const rows = JSON.parse(entry.content.toString('utf8'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].image, PNG.toString('base64'), 'base64 in the JSON');

  // Take it off, then import the archive: the product is already here and skipped, and
  // the picture — not here any more — is written back from base64 to bytes.
  assert.equal((await call(`/products/${product.id}/image`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/products/${product.id}/image`)).status, 404);
  assert.equal(db.get().prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'PRODUCT_IMAGE_REMOVED'").get().n, 1,
    'IMG-002: the removal is on the trail too');

  const owner = authService.verifyToken(tokens.OWNER);
  importService.run(archive, { collisionMode: 'SKIP' }, owner);
  const back = await call(`/products/${product.id}/image`);
  assert.equal(back.status, 200);
  assert.deepEqual(Buffer.from(await back.arrayBuffer()), PNG);
  assert.equal(db.get().prepare('SELECT typeof(image) AS t FROM product_images').get().t, 'blob');
});

test('TASK-052: an archive with text where a picture should be is refused whole', () => {
  assert.throws(() => importService.fromArchive('product_images', { product_id: 'x', image: 'not base64!' }),
    (err) => err.ruleId === 'OPS-102');
});
