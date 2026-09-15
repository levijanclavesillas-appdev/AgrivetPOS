'use strict';

// TASK-057 — a store moving to a new computer, through the real server.
//
// The backups here are made by other installations: each is a database of its own,
// set up, traded and archived before the "new computer" is switched on. That is the
// case the log-only restore could not serve — the new computer's log has never heard
// of these files — and the case where the restorer's own user is not in the backup.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const server = require('../../server');
const db = require('../../config/database');
const secrets = require('../../config/secrets');
const zip = require('../../config/zip');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const inventoryService = require('../../services/inventoryService');
const shiftService = require('../../services/shiftService');
const saleService = require('../../services/saleService');
const settingsService = require('../../services/settingsService');
const auditService = require('../../services/auditService');
const setupService = require('../../services/setupService');
const backupRepository = require('../../repositories/backupRepository');
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';
let BASE = null;
let instance;
const made = {};
let newFolder;

const call = (urlPath, { token = null, method = 'GET', body = null, file = null } = {}) => fetch(`${BASE}${urlPath}`, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(file ? { 'content-type': 'application/zip' } : body ? { 'content-type': 'application/json' } : {}),
  },
  ...(file ? { body: file } : body ? { body: JSON.stringify(body) } : {}),
});

/** Another computer: a store set up, traded a little, and backed up to `zipPath`. */
function storeElsewhere({ label, storeName, ownerName, cashierName, sales }) {
  temp.openMigrated(label);
  temp.seedStore({ storeName, withOwner: false });
  temp.seedUser({ username: ownerName, role: 'OWNER', password: PASSWORD });
  temp.seedUser({ username: cashierName, role: 'CASHIER', password: PASSWORD });
  const owner = authService.verifyToken(authService.login({ username: ownerName, password: PASSWORD }).token);
  const cashier = authService.verifyToken(authService.login({ username: cashierName, password: PASSWORD }).token);
  const ref = temp.seedCatalog();
  const product = productService.create({
    sku: 'PAR-500', name: 'Paracetamol 500mg',
    categoryId: ref.category.id, baseUnitId: ref.kg.id, retailPriceCentavos: 500,
  }, owner);
  inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli: 100000, unitCostCentavos: 300, actor: owner,
  });
  const { shift } = shiftService.open({ actor: cashier, openingFloatCentavos: 10000, confirmed: true });
  for (let i = 0; i < sales; i += 1) {
    saleService.complete({
      lines: [{ productId: product.id, qtyMilli: 1000 }],
      tenders: [{ method: 'CASH', amountCentavos: 500 }],
    }, { ...cashier, shiftId: shift.id });
  }
  shiftService.close({ shiftId: shift.id, actualCashCentavos: 10000 + 500 * sales, actor: cashier }, cashier);

  const dir = temp.freshDir(`${label}-usb`);
  const zipPath = path.join(dir, `chachipos_backup_2026-09-01_20-00-00_shift_close_${label.slice(0, 6)}.zip`);
  backupRepository.archive(zipPath);
  return zipPath;
}

/** A backup a newer build wrote: one migration this build does not ship. */
function fromTheFuture(zipPath) {
  const dir = temp.freshDir('future');
  const staged = path.join(dir, 'agrivet.db');
  backupRepository.extract(zipPath, staged);
  const copy = new Database(staged);
  copy.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
    .run(99999, '99999_from_a_newer_build.sql', new Date().toISOString());
  copy.close();
  const out = path.join(dir, 'chachipos_backup_2027-01-01_09-00-00_manual_future.zip');
  fs.writeFileSync(out, zip.zipOne(backupRepository.ENTRY_NAME, fs.readFileSync(staged)));
  return out;
}

const login = async (username) => {
  const res = await call('/auth/login', { method: 'POST', body: { username, password: PASSWORD } });
  return { status: res.status, token: res.status === 200 ? (await res.json()).token : null };
};

test.before(async () => {
  made.oldPc = storeElsewhere({ label: 'oldpc', storeName: 'Botika ni Chachi', ownerName: 'chachi', cashierName: 'joy', sales: 3 });
  made.other = storeElsewhere({ label: 'branch', storeName: 'Branch Two Pharmacy', ownerName: 'branchowner', cashierName: 'branchtill', sales: 1 });
  made.future = fromTheFuture(made.oldPc);

  // The new computer: installed, never set up.
  db.close();
  secrets.reset();
  temp.openEmpty('newpc');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;
  newFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-newpc-backups-'));
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
  fs.rmSync(newFolder, { recursive: true, force: true });
});

const restoreAtSetup = (file, { fileName = path.basename(file), folder = newFolder } = {}) => call(
  `/setup/restore?fileName=${encodeURIComponent(fileName)}&backupFolder=${encodeURIComponent(folder)}`,
  { method: 'POST', file: fs.readFileSync(file) }
);

// ── In the wizard, on a new computer ───────────────────────────────────────

test('TASK-057: the wizard refuses what is not a backup, and changes nothing', async () => {
  const junk = path.join(temp.freshDir('junk'), 'chachipos_backup_junk.zip');
  fs.writeFileSync(junk, 'this is a spreadsheet, not a backup');

  const res = await restoreAtSetup(junk);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.rule_id, 'OPS-002');

  const json = await call('/setup/restore', { method: 'POST', body: { archive: 'x' } });
  assert.equal(json.status, 400, 'JSON is refused rather than read as a file');

  assert.equal((await (await call('/setup')).json()).required, true, 'still a fresh install');
});

test('TASK-057: the wizard refuses a backup a newer version made', async () => {
  const res = await restoreAtSetup(made.future);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error.message, /newer version of Chachi POS/);
  assert.equal((await (await call('/setup')).json()).required, true);
});

test('TASK-057: the wizard refuses a backup folder inside the application data', async () => {
  const res = await restoreAtSetup(made.oldPc, { folder: path.join(process.env.AGRIVET_DATA_DIR, 'backups') });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.rule_id, 'OPS-001');
  assert.equal((await (await call('/setup')).json()).required, true);
});

test('TASK-057: a new computer restores the old one\'s backup in the wizard, and signs in as before', async () => {
  const res = await restoreAtSetup(made.oldPc);
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.store_name, 'Botika ni Chachi');
  assert.deepEqual(body.owners, ['chachi']);
  assert.equal(body.sales, 3, 'the trading came with it');
  assert.equal(body.first_backup.ok, true, 'and this computer backs it up at once');

  const status = await (await call('/setup')).json();
  assert.equal(status.required, false);
  assert.equal(status.store_name, 'Botika ni Chachi');

  // The users and passwords are the old computer's.
  const owner = await login('chachi');
  assert.equal(owner.status, 200);
  assert.equal((await login('joy')).status, 200);

  // OPS-001: the backups go to this computer's folder, not a path on the old one.
  assert.equal(settingsService.get('backup_folder'), path.resolve(newFolder));
  const list = await (await call('/backups', { token: owner.token })).json();
  assert.equal(list.folder, path.resolve(newFolder));
  assert.ok(list.backups.some((b) => b.file_name === body.first_backup.file_name && b.verified && b.on_disk));

  // AUD-601, in the restored database.
  const audited = auditService.list({ action: 'BACKUP_RESTORED' });
  assert.equal(audited.length, 1);
  assert.equal(audited[0].actor_username, 'setup');
  assert.equal(JSON.parse(audited[0].after_value).restored_from, path.basename(made.oldPc));

  // Reachable exactly as long as POST /setup is.
  const again = await restoreAtSetup(made.other);
  assert.equal(again.status, 409);
  assert.equal((await (await call('/setup')).json()).store_name, 'Botika ni Chachi');
});

// ── On the Backups screen, over a store already here ───────────────────────

test('TASK-057: a backup from elsewhere is uploaded into the folder, checked first, owner only', async () => {
  const owner = await login('chachi');
  const cashier = await login('joy');

  const refused = await call(`/backups/files?fileName=${encodeURIComponent(path.basename(made.other))}`,
    { method: 'POST', token: cashier.token, file: fs.readFileSync(made.other) });
  assert.equal(refused.status, 403);

  const junk = await call('/backups/files?fileName=chachipos_backup_notes.zip',
    { method: 'POST', token: owner.token, file: Buffer.from('not a zip') });
  assert.equal(junk.status, 400);
  assert.equal(fs.readdirSync(newFolder).some((n) => n.includes('notes')), false, 'nothing left in the folder');

  const res = await call(`/backups/files?fileName=${encodeURIComponent(path.basename(made.other))}`,
    { method: 'POST', token: owner.token, file: fs.readFileSync(made.other) });
  const added = await res.json();
  assert.equal(res.status, 201, JSON.stringify(added));
  assert.equal(added.file_name, path.basename(made.other));
  assert.equal(added.store_name, 'Branch Two Pharmacy');

  const list = await (await call('/backups', { token: owner.token })).json();
  const row = list.unrecognised.find((f) => f.file_name === added.file_name);
  assert.ok(row && row.size_bytes > 0, 'listed as a file this computer did not make');
});

test('TASK-057: a file in the folder is opened and described before anyone types its name', async () => {
  const owner = await login('chachi');
  const name = path.basename(made.other);

  const pre = await (await call(`/backups/restore/preflight?fileName=${encodeURIComponent(name)}`, { token: owner.token })).json();
  assert.equal(pre.backup.verified, true);
  assert.equal(pre.backup.restorable, true);
  assert.equal(pre.backup.store_name, 'Branch Two Pharmacy');
  assert.deepEqual(pre.backup.owners, ['branchowner']);
  assert.ok(pre.backup.taken_at, 'dated by the last thing it recorded');

  fs.copyFileSync(made.future, path.join(newFolder, path.basename(made.future)));
  const future = await (await call(`/backups/restore/preflight?fileName=${encodeURIComponent(path.basename(made.future))}`,
    { token: owner.token })).json();
  assert.equal(future.backup.verified, true);
  assert.equal(future.backup.restorable, false);
  assert.match(future.backup.error, /newer version/);

  for (const sneaky of ['../agrivet.db', `..\\${name}`, `sub/${name}`, 'agrivet.db', 'chachipos_backup_missing.zip']) {
    const res = await call(`/backups/restore/preflight?fileName=${encodeURIComponent(sneaky)}`, { token: owner.token });
    assert.equal(res.status, 404, `${sneaky} must not be resolved`);
  }
});

test('TASK-057: restoring another store\'s backup: typed name, pre-restore backup, folder kept, audited', async () => {
  const owner = await login('chachi');
  const name = path.basename(made.other);

  const cashier = await login('joy');
  const notOwner = await call('/backups/files/restore', { method: 'POST', token: cashier.token, body: { fileName: name, confirmFilename: name } });
  assert.equal(notOwner.status, 403);

  const wrong = await call('/backups/files/restore', { method: 'POST', token: owner.token, body: { fileName: name, confirmFilename: 'chachipos_backup.zip' } });
  assert.equal(wrong.status, 400);

  const future = path.basename(made.future);
  const newer = await call('/backups/files/restore', { method: 'POST', token: owner.token, body: { fileName: future, confirmFilename: future } });
  assert.equal(newer.status, 409);
  assert.equal((await (await call('/setup')).json()).store_name, 'Botika ni Chachi', 'nothing changed');

  const res = await call('/backups/files/restore', { method: 'POST', token: owner.token, body: { fileName: name, confirmFilename: name } });
  const result = await res.json();
  assert.equal(res.status, 200, JSON.stringify(result));
  assert.equal(result.store_name, 'Branch Two Pharmacy');
  assert.equal(result.after.sales, 1);
  // The restorer is not a user of that store. The restore still lands and is audited,
  // naming them, and it says who can sign in.
  assert.equal(result.signed_in_user_survives, false);
  assert.match(result.message, /branchowner/);
  assert.ok(fs.existsSync(path.join(newFolder, result.pre_restore_backup.file_name)), 'the way back is on disk');

  assert.equal(settingsService.get('backup_folder'), path.resolve(newFolder), "this computer's folder, kept");
  const audited = auditService.list({ action: 'BACKUP_RESTORED' });
  assert.equal(audited.length, 1);
  assert.equal(audited[0].actor_username, 'chachi');
  assert.equal(audited[0].actor_id, null);

  assert.equal((await login('branchowner')).status, 200);
  assert.equal((await login('chachi')).status, 401);
  assert.equal(setupService.isComplete(), true);
});

test('TASK-057: a file in the folder that is not a backup cannot be restored', async () => {
  const owner = await login('branchowner');
  const name = 'chachipos_backup_2026-09-02_08-00-00_manual_broken.zip';
  fs.writeFileSync(path.join(newFolder, name), 'PK not really');

  const pre = await (await call(`/backups/restore/preflight?fileName=${name}`, { token: owner.token })).json();
  assert.equal(pre.backup.verified, false);
  assert.ok(pre.backup.error);

  const res = await call('/backups/files/restore', { method: 'POST', token: owner.token, body: { fileName: name, confirmFilename: name } });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.rule_id, 'OPS-002');
});
