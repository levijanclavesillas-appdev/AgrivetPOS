'use strict';

// TASK-017 — backup, verification, retention, restore, health and the launch checks.
//
// This is the task that decides whether a bad day costs an afternoon or a year of
// history, so several cases here are written to be **seen to fail**: a backup target
// is deliberately corrupted, a clock is deliberately moved, a restore is deliberately
// attempted with the wrong filename. A control nobody has watched refuse is a control
// nobody has tested.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../../config/database');
const clock = require('../../config/clock');
const ids = require('../../config/ids');
const zip = require('../../config/zip');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const inventoryService = require('../../services/inventoryService');
const shiftService = require('../../services/shiftService');
const saleService = require('../../services/saleService');
const settingsService = require('../../services/settingsService');
const backupService = require('../../services/backupService');
const restoreService = require('../../services/restoreService');
const alertService = require('../../services/alertService');
const systemService = require('../../services/systemService');
const healthService = require('../../services/healthService');
const scheduleService = require('../../services/scheduleService');
const auditService = require('../../services/auditService');
const backupRepository = require('../../repositories/backupRepository');
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';

let owner;
let cashier;
let ref;
let product;
let backupFolder;

const sessionFor = (username) => authService
  .verifyToken(authService.login({ username, password: PASSWORD }).token);

function freshFolder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-backups-'));
  db.transaction(() => settingsService.set('backup_folder', dir, owner));
  return dir;
}

test.before(() => {
  temp.openMigrated('backups');
  temp.seedStore({ withOwner: false, taxMode: 'NONE' });
  ref = temp.seedCatalog();

  temp.seedUser({ username: 'owner', role: 'OWNER', password: PASSWORD });
  temp.seedUser({ username: 'till', role: 'CASHIER', password: PASSWORD });
  temp.seedUser({ username: 'boss', role: 'MANAGER', password: PASSWORD });
  owner = sessionFor('owner');
  cashier = sessionFor('till');

  backupFolder = freshFolder();

  product = productService.create({
    sku: 'FEED-001', name: 'Hog Grower Pellets',
    categoryId: ref.category.id, baseUnitId: ref.kg.id, retailPriceCentavos: 6000,
  }, owner);
  inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli: 500000, unitCostCentavos: 4000, actor: owner,
  });
});

test.after(() => temp.cleanup());

// ── The archive itself ──────────────────────────────────────────────────────

test('the archive is a real zip, readable by something that did not write it', () => {
  // The risk in hand-rolling an archive format is producing one only its own reader
  // can open. `unzip -t` and Python's zipfile share no code with src/config/zip.js,
  // and a store's recovery path is someone double-clicking the file in Explorer.
  const result = backupService.run({ trigger: 'MANUAL', actor: owner });
  assert.equal(result.ok, true, result.error);
  assert.match(result.file_name, /^agrivet_backup_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_manual_[0-9a-f]{6}\.zip$/);

  const { spawnSync } = require('child_process');
  const unzip = spawnSync('unzip', ['-t', result.file_path], { encoding: 'utf8' });
  if (unzip.error) {
    // Not every machine has Info-ZIP; the case still asserts what it can.
    assert.ok(result.size_bytes > 0);
  } else {
    assert.equal(unzip.status, 0, unzip.stdout + unzip.stderr);
    assert.match(unzip.stdout, /No errors detected/);
    assert.match(unzip.stdout, /agrivet\.db/, 'and the entry is named so a person can find it');
  }

  const python = spawnSync('python3', ['-c',
    `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); sys.exit(0 if z.testzip() is None and z.namelist()==['agrivet.db'] else 1)`,
    result.file_path], { encoding: 'utf8' });
  if (!python.error) assert.equal(python.status, 0, 'python zipfile reads it too');
});

test('the archive is smaller than the database it holds', () => {
  const result = backupService.run({ trigger: 'MANUAL', actor: owner });
  assert.ok(result.uncompressed_bytes > 0);
  assert.ok(
    result.size_bytes < result.uncompressed_bytes,
    `${result.size_bytes} is not smaller than ${result.uncompressed_bytes}`
  );
});

test('a corrupted archive is caught before SQLite is ever asked', () => {
  // The bit-flip on a USB stick, found here rather than as a malformed database page
  // on the day it is restored.
  const payload = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.from('x'.repeat(8192))]);
  const good = zip.zipOne('agrivet.db', payload);
  assert.ok(zip.unzipOne(good).content.equals(payload), 'the good one reads back');

  // In the compressed data: caught by inflate or by the CRC.
  const inData = Buffer.from(good);
  inData[40] ^= 0xff;
  assert.throws(() => zip.unzipOne(inData), /checksum|invalid|incorrect|header|data/i);

  // Truncated — the commonest USB failure, a copy interrupted halfway.
  assert.throws(() => zip.unzipOne(good.subarray(0, good.length - 30)),
    /end-of-central-directory|truncated|damaged/i);

  // Central directory damaged. Nothing but this module reads the local header, so an
  // archive whose central directory is wrong is one Explorer will refuse to open —
  // which an earlier version of the reader accepted, because it only ever read the
  // local one.
  const inCentral = Buffer.from(good);
  const centralOffset = good.readUInt32LE(good.length - 22 + 16);
  inCentral.writeUInt32LE(0xdeadbeef, centralOffset + 16);   // the entry's CRC
  assert.throws(() => zip.unzipOne(inCentral), /headers disagree/);

  const badSig = Buffer.from(good);
  badSig.writeUInt32LE(0, centralOffset);
  assert.throws(() => zip.unzipOne(badSig), /central directory is damaged/);
});

// ── TC-INT-70 — the close backs up, and the 31st prunes the oldest ──────────

test('TC-INT-70: a shift close writes a backup and reports whether it verified', () => {
  const { shift } = shiftService.open({ actor: cashier, openingFloatCentavos: 200000, confirmed: true });
  saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 6000 }],
  }, { ...cashier, shiftId: shift.id });

  const result = shiftService.close({
    shiftId: shift.id, actualCashCentavos: 206000, actor: cashier,
  }, cashier);

  assert.equal(result.backup.ok, true);
  assert.equal(result.backup.verified, true);
  assert.equal(result.backup.trigger, 'SHIFT_CLOSE');
  assert.ok(fs.existsSync(result.backup.file_path));

  // The log row is what OPS-002 is actually about: the record that it was opened.
  const row = backupRepository.findLog(result.backup.id);
  assert.equal(row.verification_result, 'OK');
  assert.ok(row.verified_at, 'and when');
  assert.ok(Date.parse(row.verified_at) >= Date.parse(row.taken_at));
});

test('TC-INT-70: the 31st backup prunes the oldest, and only after it has verified', () => {
  const folder = freshFolder();
  const keep = settingsService.get('backup_retention_count');
  assert.equal(keep, 30, 'OPS-003 default');

  const taken = [];
  for (let i = 0; i < keep; i += 1) {
    const r = backupService.run({ trigger: 'MANUAL', actor: owner });
    assert.equal(r.ok, true, r.error);
    taken.push(r);
  }
  assert.equal(fs.readdirSync(folder).length, keep, 'thirty is not yet too many');
  assert.equal(taken[keep - 1].pruned.removed, 0);
  assert.equal(taken[keep - 1].pruned.kept, keep);

  const thirtyFirst = backupService.run({ trigger: 'MANUAL', actor: owner });
  assert.equal(thirtyFirst.ok, true);
  assert.equal(thirtyFirst.verified, true);
  assert.equal(thirtyFirst.pruned.removed, 1);
  assert.deepEqual(thirtyFirst.pruned.removed_files, [taken[0].file_name], 'oldest first');

  const onDisk = fs.readdirSync(folder);
  assert.equal(onDisk.length, keep);
  assert.equal(onDisk.includes(taken[0].file_name), false, 'the oldest file is gone');
  assert.ok(onDisk.includes(thirtyFirst.file_name), 'and the newest is there');

  // OPS-003: the row survives the file. "We pruned it" is a different fact from
  // "someone deleted it", and only one of them is a problem.
  const prunedRow = backupRepository.findLog(taken[0].id);
  assert.ok(prunedRow.pruned_at);
  assert.equal(prunedRow.verification_result, 'OK');
});

test('TC-INT-70: nothing is pruned when the newer backup does not verify', (t) => {
  // The ordering is the whole rule. A prune that ran first and then failed to write
  // its replacement would leave the folder one backup shorter for no gain.
  const folder = freshFolder();
  for (let i = 0; i < 30; i += 1) backupService.run({ trigger: 'MANUAL', actor: owner });
  const before = fs.readdirSync(folder).sort();

  t.mock.method(backupRepository, 'verify', () => ({ ok: false, error: 'database disk image is malformed' }));
  const failed = backupService.run({ trigger: 'MANUAL', actor: owner });

  assert.equal(failed.ok, false);
  assert.equal(failed.pruned, undefined, 'the prune never ran');
  assert.deepEqual(fs.readdirSync(folder).sort(), before, 'and the thirty are untouched');
});

test('OPS-003: a run of failures cannot push the last good backup out of the window', () => {
  const folder = freshFolder();
  const good = backupService.run({ trigger: 'MANUAL', actor: owner });
  db.transaction(() => settingsService.set('backup_folder', '', owner));

  for (let i = 0; i < 40; i += 1) backupService.run({ trigger: 'MANUAL', actor: owner });

  db.transaction(() => settingsService.set('backup_folder', folder, owner));
  // Only verified backups are counted for retention, so forty failures did not
  // displace the one that worked. That is the difference between retention and
  // attrition.
  assert.ok(fs.existsSync(good.file_path));
  assert.equal(backupService.lastVerified().id, good.id);
});

// ── TC-INT-71 — verification failure ────────────────────────────────────────

test('TC-INT-71: a corrupt backup fails verification, is deleted, and raises an alert', () => {
  const folder = freshFolder();
  const before = backupService.lastVerified();

  // Corrupt the copy after it is written and before it is checked — which is the real
  // failure this guards: a disk that accepts the write and hands back rubbish.
  const original = backupRepository.archive;
  backupRepository.archive = (target) => {
    const result = original(target);
    const bytes = fs.readFileSync(target);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    fs.writeFileSync(target, bytes);
    return result;
  };

  let result;
  try {
    result = backupService.run({ trigger: 'MANUAL', actor: owner });
  } finally {
    backupRepository.archive = original;
  }

  assert.equal(result.ok, false);
  assert.equal(result.rule_id, 'OPS-002');
  assert.match(result.error, /failed verification/);

  // OPS-002: it did not happen. The file goes, because the next person to look at the
  // folder would otherwise see a recent backup and believe it.
  assert.equal(fs.existsSync(result.file_path), false, 'the corrupt file was removed');
  assert.equal(fs.readdirSync(folder).length, 0);

  // And it does not become "last successful backup".
  const after = backupService.lastVerified();
  assert.equal(after ? after.id : null, before ? before.id : null, 'OPS-002: it does not count');

  const row = backupRepository.findLog(result.id);
  assert.equal(row.verification_result, 'FAILED');
  assert.ok(row.error);

  const alerts = alertService.list().alerts;
  const raised = alerts.find((a) => a.kind === 'BACKUP_UNVERIFIED');
  assert.ok(raised, 'the alert is raised');
  assert.equal(raised.dismissible, false, 'OPS-007: never dismissible');

  // AUD-601: and it is on the trail.
  const audited = auditService.list({ action: 'BACKUP_FAILED' });
  assert.ok(audited.length > 0);
});

test('TC-INT-71: a backup with no folder configured is logged, not silently skipped', () => {
  // The state a store is in on its first day, and the one that matters most. An
  // earlier version returned before writing a row, so the most exposed condition the
  // product has was also its quietest.
  db.transaction(() => settingsService.set('backup_folder', '', owner));
  const result = backupService.run({ trigger: 'SCHEDULED', actor: auditService.SYSTEM_ACTOR });

  assert.equal(result.ok, false);
  assert.equal(result.rule_id, 'OPS-001');
  assert.ok(result.id, 'it still left a row');
  assert.equal(backupRepository.findLog(result.id).verification_result, 'FAILED');

  freshFolder();
});

// ── TC-INT-72 / TC-INT-73 — the launch checks ───────────────────────────────

test('TC-INT-72: no verified backup inside the period raises a non-dismissible warning', () => {
  freshFolder();
  const period = settingsService.get('backup_period_hours');
  backupService.run({ trigger: 'MANUAL', actor: owner });

  assert.equal(backupService.overdue().overdue, false, 'just backed up');

  // The clock advanced past the period, rather than waiting a day and a half.
  const later = new Date(Date.now() + (period + 1) * 3600000).toISOString();
  const overdue = backupService.overdue({ now: later });

  assert.equal(overdue.overdue, true);
  assert.match(overdue.message, /longer than the \d+-hour backup period/);
  assert.ok(overdue.hours_since >= period);

  const launch = systemService.onLaunch({ now: later });
  assert.equal(launch.backup.overdue, true);

  const alert = alertService.list({ now: later }).alerts.find((a) => a.kind === 'BACKUP_OVERDUE');
  assert.ok(alert, 'the launch warning is in the alert list');
  assert.equal(alert.dismissible, false, 'FR_7.3 / OPS-007: not dismissible');
  assert.equal(alert.severity, 'CRITICAL');
});

test('TC-INT-72: the warning cannot be dismissed, and the refusal explains itself', () => {
  assert.throws(
    () => alertService.dismiss('BACKUP_OVERDUE', owner),
    (err) => err.status === 403 && err.ruleId === 'OPS-007'
  );
  assert.throws(() => alertService.dismiss('CLOCK_ANOMALY', owner), (err) => err.status === 403);
  assert.throws(() => alertService.dismiss('BACKUP_UNVERIFIED', owner), (err) => err.status === 403);

  // And the refusal is not merely a service check: the table itself will not hold one.
  assert.throws(() => require('../../repositories/alertRepository').insert({
    id: ids.uuidv7(), alert_key: 'CLOCK_ANOMALY', kind: 'CLOCK_ANOMALY',
    dismissed_at: clock.nowUtc(), dismissed_by: owner.id,
  }), /CHECK constraint/);
});

test('a dismissible alert can be dismissed, and comes back when the window lapses', () => {
  const key = 'LOW_STOCK';
  const result = alertService.dismiss(key, owner);
  assert.equal(result.dismissed, true);
  assert.equal(alertService.list().alerts.some((a) => a.kind === 'LOW_STOCK'), false);

  const days = settingsService.get('alert_dismissal_window_days');
  const later = new Date(Date.now() + (days + 1) * 86400000).toISOString();
  // A dismissal lapses. An alert whose condition has not gone away is not something a
  // single click should silence for good.
  const raised = alertService.list({ now: later }).alerts.map((a) => a.kind);
  assert.equal(raised.includes('LOW_STOCK'), inventoryService.lowStock({ limit: 1 }).total > 0);

  alertService.undismiss(key);
});

test('TC-INT-73: a clock earlier than the last transaction raises the anomaly and is audited', () => {
  const latest = backupRepository.latestRecordedAt();
  assert.ok(latest, 'this store has traded');

  const behind = new Date(Date.parse(latest) - 30 * 86400000).toISOString();
  const state = systemService.checkClock({ now: behind });

  assert.equal(state.anomaly, true);
  assert.ok(state.behind_by_hours >= 24 * 29);

  const before = auditService.list({ action: 'CLOCK_ANOMALY' }).length;
  const launch = systemService.onLaunch({ now: behind });

  assert.equal(launch.clock.anomaly, true);
  assert.equal(auditService.list({ action: 'CLOCK_ANOMALY' }).length, before + 1, 'OPS-009: audited');

  const alert = alertService.list({ now: behind }).alerts.find((a) => a.kind === 'CLOCK_ANOMALY');
  assert.ok(alert);
  assert.equal(alert.dismissible, false);
  assert.match(alert.message, /Selling is unaffected/, 'VR-103: transactions continue');
});

test('TC-INT-73: selling continues with a wrong clock, and the sale numbers stay gapless', () => {
  // OPS-009's own emphasis. Stopping a store from selling because its BIOS battery
  // died would be the product causing the outage it exists to prevent.
  const { shift } = shiftService.open({ actor: cashier, openingFloatCentavos: 100000, confirmed: true });
  const session = { ...cashier, shiftId: shift.id };

  const first = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 6000 }],
  }, session);
  const second = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 6000 }],
  }, session);

  // VR-103: the number comes from a per-day sequence in the database, not the clock.
  const numberOf = (r) => Number(r.sale.sale_no.split('-').pop());
  assert.equal(numberOf(second), numberOf(first) + 1);

  shiftService.close({ shiftId: shift.id, actualCashCentavos: 112000, actor: cashier }, cashier);
});

test('a clock a few seconds behind its own last write is not an anomaly', () => {
  // Timestamps are written at slightly different moments than they are read. A machine
  // marginally behind itself is a normal machine, and an alert that fires on it is an
  // alert people learn to ignore.
  const latest = backupRepository.latestRecordedAt();
  const barely = new Date(Date.parse(latest) - 5000).toISOString();
  assert.equal(systemService.checkClock({ now: barely }).anomaly, false);

  const past = new Date(Date.parse(latest) - systemService.CLOCK_SKEW_TOLERANCE_MS - 60000).toISOString();
  assert.equal(systemService.checkClock({ now: past }).anomaly, true);
});

// ── TC-INT-74 — the restore ─────────────────────────────────────────────────

test('TC-INT-74: a restore is owner-only', () => {
  const backup = backupService.run({ trigger: 'MANUAL', actor: owner });

  for (const who of ['till', 'boss']) {
    assert.throws(
      () => restoreService.restore({
        backupId: backup.id, confirmFilename: backup.file_name, actor: sessionFor(who),
      }),
      (err) => err.status === 403 && err.ruleId === 'OPS-004',
      `${who} must not be able to restore`
    );
  }
});

test('TC-INT-74: a restore needs the filename typed, exactly', () => {
  const backup = backupService.run({ trigger: 'MANUAL', actor: owner });

  for (const typed of ['', null, 'agrivet_backup.zip', backup.file_name.slice(0, -1), backup.file_name.toUpperCase()]) {
    assert.throws(
      () => restoreService.restore({ backupId: backup.id, confirmFilename: typed, actor: owner }),
      (err) => err.status === 400 && err.ruleId === 'OPS-004',
      `"${typed}" must not be accepted`
    );
  }
});

test('TC-INT-74: a restore is refused while a shift is open', () => {
  const backup = backupService.run({ trigger: 'MANUAL', actor: owner });
  const { shift } = shiftService.open({ actor: cashier, openingFloatCentavos: 100000, confirmed: true });

  try {
    assert.throws(
      () => restoreService.restore({
        backupId: backup.id, confirmFilename: backup.file_name, actor: owner,
      }),
      (err) => err.status === 409 && /shift/.test(err.message)
    );
    // And the preflight says so before the filename is ever typed (04_UX_SPEC §6).
    assert.equal(restoreService.preflight({ backupId: backup.id }).blocked_by_open_shift, true);
  } finally {
    shiftService.close({ shiftId: shift.id, actualCashCentavos: 100000, actor: cashier }, cashier);
  }
});

test('TC-INT-74: a restore takes a pre-restore backup, replaces the data, and is audited', () => {
  freshFolder();
  const salesBefore = db.get().prepare('SELECT COUNT(*) AS n FROM sales').get().n;
  const backup = backupService.run({ trigger: 'MANUAL', actor: owner });
  assert.equal(backup.ok, true);

  // Trade after the backup. This is what a restore throws away, and what the
  // pre-restore backup is for.
  const { shift } = shiftService.open({ actor: cashier, openingFloatCentavos: 100000, confirmed: true });
  saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 6000 }],
  }, { ...cashier, shiftId: shift.id });
  shiftService.close({ shiftId: shift.id, actualCashCentavos: 106000, actor: cashier }, cashier);

  const salesAfterTrading = db.get().prepare('SELECT COUNT(*) AS n FROM sales').get().n;
  assert.ok(salesAfterTrading > salesBefore);

  const result = restoreService.restore({
    backupId: backup.id, confirmFilename: backup.file_name, actor: owner,
  });

  assert.equal(result.restored, true);
  assert.equal(result.before.sales, salesAfterTrading);
  assert.equal(result.after.sales, salesBefore, 'the store is as it was at the backup');

  // OPS-004: a fresh backup of the current database, taken first. Without it there is
  // nothing to come back from, and restoring the wrong file is the commonest way this
  // goes wrong.
  assert.ok(result.pre_restore_backup.file_name);

  // The row for it was written into the database that has just been replaced, so the
  // restore rolled it back — and the one file holding everything just undone would
  // have been invisible in the log at exactly the moment somebody needs to find it.
  // restoreService writes it into the restored database for that reason.
  const safety = backupRepository.findLog(result.pre_restore_backup.id);
  assert.ok(safety, 'the way back is visible in the restored database');
  assert.equal(safety.trigger, 'PRE_RESTORE');
  assert.equal(safety.verification_result, 'OK');
  assert.ok(fs.existsSync(safety.path), 'and it is on disk, holding the trading just undone');

  // The trading is recoverable from it — which is the claim that makes the control
  // worth anything.
  const staged = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-x-')), 'copy.db');
  backupRepository.extract(safety.path, staged);
  const copy = new Database(staged, { readonly: true, fileMustExist: true });
  try {
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM sales').get().n, salesAfterTrading);
  } finally {
    copy.close();
  }

  // AUD-601, written into the restored database — the one that will be read afterwards.
  const audited = auditService.list({ action: 'BACKUP_RESTORED' });
  assert.equal(audited.length, 1);
  assert.equal(JSON.parse(audited[0].after_value).restored_from, backup.file_name);
  assert.equal(JSON.parse(audited[0].before_value).sales, salesAfterTrading);
});

test('TC-INT-74: an unverified backup cannot be restored from', () => {
  const row = backupRepository.listLog({ limit: 100 }).find((r) => r.verification_result === 'FAILED');
  assert.ok(row, 'earlier cases left one');

  assert.throws(
    () => restoreService.restore({ backupId: row.id, confirmFilename: row.filename, actor: owner }),
    (err) => err.status === 409 && err.ruleId === 'OPS-002'
  );
});

test('TC-INT-74: a backup missing from the folder is refused with a reason', () => {
  const backup = backupService.run({ trigger: 'MANUAL', actor: owner });
  fs.rmSync(backup.file_path);

  assert.throws(
    () => restoreService.restore({ backupId: backup.id, confirmFilename: backup.file_name, actor: owner }),
    (err) => err.status === 409 && /moved, deleted or pruned/.test(err.message)
  );
});

// ── TC-INT-75 — a backup taken mid-sale ─────────────────────────────────────

test('TC-INT-75: a backup taken with a sale still in the WAL holds that sale', () => {
  // The concern this case exists for is a **filesystem copy**. better-sqlite3 is
  // synchronous, so a sale and a backup never interleave inside one process — what
  // actually goes wrong is copying `agrivet.db` while its committed pages are still in
  // `agrivet.db-wal`. That copy restores to a database missing the last transactions,
  // and it looks perfectly healthy: integrity_check passes on it.
  //
  // So the sale below is committed and deliberately left un-checkpointed, and the two
  // mechanisms are compared directly.
  freshFolder();
  const { shift } = shiftService.open({ actor: cashier, openingFloatCentavos: 100000, confirmed: true });
  const session = { ...cashier, shiftId: shift.id };

  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 2000 }],
    tenders: [{ method: 'CASH', amountCentavos: 12000 }],
  }, session);

  const live = db.get().prepare('SELECT COUNT(*) AS n FROM sales').get().n;
  const walBytes = fs.existsSync(db.currentPath() + '-wal')
    ? fs.statSync(db.currentPath() + '-wal').size : 0;
  assert.ok(walBytes > 0, 'the sale is still in the WAL, which is the whole point');

  const taken = backupService.run({ trigger: 'MANUAL', actor: owner });
  assert.equal(taken.ok, true, taken.error);

  const staged = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-mid-')), 'copy.db');
  backupRepository.extract(taken.file_path, staged);
  const copy = new Database(staged, { readonly: true, fileMustExist: true });

  try {
    assert.equal(copy.pragma('integrity_check')[0].integrity_check, 'ok');
    assert.deepEqual(copy.pragma('foreign_key_check'), []);
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM sales').get().n, live,
      'VACUUM INTO reads the WAL; the sale is in the backup');
    assert.ok(copy.prepare('SELECT id FROM sales WHERE id = ?').get(sale.sale.id));

    // INV-107: every sale in the copy has its lines, its tenders and its movements.
    const orphans = copy.prepare(`
      SELECT COUNT(*) AS n FROM sales s
      WHERE NOT EXISTS (SELECT 1 FROM sale_items i WHERE i.sale_id = s.id)
         OR NOT EXISTS (SELECT 1 FROM sale_tenders t WHERE t.sale_id = s.id)
    `).get().n;
    assert.equal(orphans, 0, 'no sale in the copy is missing its lines or its tenders');

    const halfMovements = copy.prepare(`
      SELECT COUNT(*) AS n FROM inventory_movements m
      WHERE m.reference_type = 'sale'
        AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = m.reference_id)
    `).get().n;
    assert.equal(halfMovements, 0, 'and no movement points at a sale that is not there');
  } finally {
    copy.close();
  }

  // The comparison that makes the point: a byte copy of the database file alone, which
  // is what "just copy agrivet.db" means, is missing the sale — and passes an
  // integrity check while missing it.
  const naive = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-naive-')), 'copy.db');
  fs.copyFileSync(db.currentPath(), naive);
  const byteCopy = new Database(naive, { readonly: true, fileMustExist: true });
  try {
    assert.equal(byteCopy.pragma('integrity_check')[0].integrity_check, 'ok',
      'and it looks perfectly healthy, which is why this is dangerous');
    assert.ok(
      byteCopy.prepare('SELECT COUNT(*) AS n FROM sales').get().n < live,
      'the byte copy is missing what was still in the WAL'
    );
  } finally {
    byteCopy.close();
  }

  shiftService.close({ shiftId: shift.id, actualCashCentavos: 112000, actor: cashier }, cashier);
});

// ── OPS-006 — the health panel ──────────────────────────────────────────────

test('SCR-705 reports all six OPS-006 figures', () => {
  systemService.integrityCheck({ actor: owner });
  const panel = healthService.panel();

  assert.ok(panel.schema.version > 0, '1 — schema version');
  assert.ok(panel.database.size_bytes > 0, '2 — database size');
  assert.ok(Object.keys(panel.database.row_counts).length > 20, '3 — row counts');
  assert.ok(panel.backup.last_successful_at, '4 — last successful backup');
  assert.ok('last_export_at' in panel, '5 — last export');
  assert.ok(panel.last_integrity_check_at, '6 — last integrity check');

  assert.equal(panel.last_integrity_check_ok, true);
  assert.equal(panel.schema.up_to_date, true);
  assert.match(panel.database.size_display, /KB|MB|B/);
});

test('the health panel reports an absent figure rather than failing to render', (t) => {
  // It is the screen someone opens *because* something is wrong, so it is the last
  // screen that may fail when one of its sources does.
  t.mock.method(backupService, 'lastVerified', () => { throw new Error('the log is unreadable'); });

  const panel = healthService.panel();
  assert.equal(panel.backup.last_successful_at, null);
  assert.ok(panel.database.size_bytes > 0, 'and the rest still renders');
});

test('the last export figure moves when a report is exported', () => {
  const reportService = require('../../services/reportService');
  const today = clock.manilaDate(clock.nowUtc());
  const before = healthService.panel().last_export_at;

  systemService.recordExport({ actor: owner, what: 'daily' });
  assert.notEqual(healthService.panel().last_export_at, before);
  assert.ok(reportService.exportCsv('payments', { from: today }, owner).csv);
});

// ── OPS-001 — the daily schedule ────────────────────────────────────────────

test('the daily backup is due once the configured hour has passed, and once only', () => {
  freshFolder();
  const hour = settingsService.get('backup_hour');
  const today = clock.manilaDate(clock.nowUtc());
  // **Tomorrow's hour, not today's.**
  //
  // The scheduler asks whether a verified backup has been taken since the scheduled
  // hour, and the backups earlier in this file were taken at the real clock. Simulated
  // against *today's* hour that is a coin toss on the time of day: run in the morning
  // those backups precede the hour and the tick is due; run any evening after 21:00
  // Manila they follow it, the scheduler rightly answers "already verified", and a
  // correct rule fails a test that had quietly assumed office hours.
  //
  // Tomorrow's hour has nothing before it but this file's own history, which is the
  // condition the case is actually about.
  const before = new Date(
    new Date(`${today}T${String(hour).padStart(2, '0')}:00:00+08:00`).getTime() + 86400000
  );

  assert.equal(scheduleService.due({ now: new Date(before.getTime() - 3600000).toISOString() }).due, false,
    'an hour before the scheduled time, nothing is due');

  const after = new Date(before.getTime() + 60000).toISOString();
  const first = scheduleService.tick({ now: after });
  assert.equal(first.ran, true, JSON.stringify(first));
  assert.equal(first.result.ok, true);

  // And not again: the check is against the log, not a variable, so a restarted
  // process neither repeats the backup nor skips one it should have taken.
  const second = scheduleService.tick({ now: after });
  assert.equal(second.ran, false);
  assert.match(second.reason, /already verified/);
});

test('a shift close satisfies the daily schedule without it firing', () => {
  // OPS-001 says both, and a busy store meets the schedule through its own closes.
  // That is the intended outcome, not a gap.
  const hour = settingsService.get('backup_hour');
  const today = clock.manilaDate(clock.nowUtc());
  const after = new Date(new Date(`${today}T${String(hour).padStart(2, '0')}:00:00+08:00`).getTime() + 60000).toISOString();

  const { shift } = shiftService.open({ actor: cashier, openingFloatCentavos: 100000, confirmed: true });
  shiftService.close({ shiftId: shift.id, actualCashCentavos: 100000, actor: cashier }, cashier);

  assert.equal(scheduleService.tick({ now: after }).ran, false, 'the close already did it');
});

// ── SEC-9, OPS-001 — what the operator is told ──────────────────────────────

test('SEC-9: the backup list states in plain words who can read a backup', () => {
  const listed = backupService.list({ limit: 5 });
  assert.match(listed.shared_drive_warning, /readable by anyone/i);
  assert.match(listed.shared_drive_warning, /every price, every customer/i);
  assert.equal(/encrypt/i.test(listed.shared_drive_warning), false, 'it does not promise encryption');
});

test('OPS-001: a backup folder inside the application data folder is reported as such', () => {
  const paths = require('../../config/paths');
  assert.equal(backupService.isInsideAppData(paths.dataDir()), true);
  assert.equal(backupService.isInsideAppData(path.join(paths.dataDir(), 'backups')), true);
  assert.equal(backupService.isInsideAppData(backupFolder), false);

  // 05_TECH_SPEC.md §7: a backup inside the folder being backed up survives exactly
  // the failures that do not matter.
  assert.equal(backupService.list().inside_app_data, false);
});
