'use strict';

// FR_1.1 / SCR-001 — the first-run wizard against a real database.
//
// The cases that matter are the failure ones. A wizard that works when everything is
// right is easy; what an installation actually needs is that a wizard which fails
// halfway has written nothing, because the person at the counter cannot repair a
// half-built database and there is nobody to call.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const setupService = require('../../services/setupService');
const settingsService = require('../../services/settingsService');
const storeProfileService = require('../../services/storeProfileService');
const authService = require('../../services/authService');
const auditService = require('../../services/auditService');
const userRepository = require('../../repositories/userRepository');
const settingsRepository = require('../../repositories/settingsRepository');
const storeProfileRepository = require('../../repositories/storeProfileRepository');
const temp = require('../helpers/tempdb');

const OWNER = Object.freeze({
  fullName: 'Aling Nena',
  username: 'nena',
  password: 'correct-horse-battery',
  pin: '284917',
});

/** A writable backup folder outside the data directory, as OPS-001 requires. */
function backupFolder(label) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `agrivet-backup-${label}-`)), 'backups');
}

const validPayload = (label, over = {}) => ({
  store: { storeName: 'Chachi Agrivet Supply', address: 'Poblacion', tin: '752-951-092-00000' },
  taxMode: 'NON_VAT',
  owner: { ...OWNER },
  backupFolder: backupFolder(label),
  acknowledgedRecoveryCode: true,
  ...over,
});

// ── The gate (requirement 1) ────────────────────────────────────────────────

test('a fresh database reports that setup is required, and names the five steps', () => {
  temp.openMigrated('setup-status');

  const status = setupService.status();
  assert.equal(status.required, true);
  assert.deepEqual(status.steps, ['store', 'tax', 'owner', 'recovery', 'backup']);
  assert.deepEqual(status.tax_modes.map((m) => m.value), ['NONE', 'NON_VAT', 'VAT']);
  for (const mode of status.tax_modes) {
    assert.ok(mode.sentence.length > 40, `${mode.value} needs its plain-language sentence (SCR-001)`);
  }

  // OPS-001: the suggestion is outside the application data directory, or the first
  // backup is on the same disk, in the same folder, as the thing it is backing up.
  assert.ok(!setupService.isInsideDataDir(status.suggested_backup_folder));
});

test('a store profile without an owner is not a set-up installation', () => {
  temp.openMigrated('setup-half');
  storeProfileService.create({ storeName: 'Half Built', taxMode: 'NONE' });

  // Either half alone is a state the wizard must finish: a profile with no owner
  // cannot be signed into at all.
  assert.equal(setupService.isComplete(), false);
  assert.throws(() => setupService.assertComplete(), (err) => err.code === 'SETUP_REQUIRED');
});

// ── Completion (requirement 6) ──────────────────────────────────────────────

test('completion writes exactly one profile, one owner and the full settings set', () => {
  temp.openMigrated('setup-complete');
  const payload = validPayload('complete');

  const result = setupService.complete(payload);

  assert.equal(storeProfileRepository.count(), 1, 'exactly one store profile');
  assert.equal(userRepository.countAll(), 1, 'exactly one user');
  assert.equal(userRepository.countActiveOwners(), 1, 'and it is an active owner');
  assert.equal(settingsRepository.count(), settingsService.KEYS.length, 'the whole OPS-005 list');
  assert.equal(result.settingsSeeded, settingsService.KEYS.length);

  const profile = storeProfileService.profile();
  assert.equal(profile.store_name, 'Chachi Agrivet Supply');
  assert.equal(profile.tax_mode, 'NON_VAT');
  assert.equal(profile.currency, 'PHP');

  // Every seeded key reads back at its declared default, except the folder the
  // operator chose.
  for (const key of settingsService.KEYS) {
    const expected = key === 'backup_folder' ? result.backupFolder : settingsService.REGISTRY[key].value;
    assert.deepEqual(settingsService.get(key), expected, `${key} seeded`);
  }

  assert.equal(setupService.isComplete(), true);
});

test('the owner can sign in with the credentials the wizard took, and the PIN is set', () => {
  temp.openMigrated('setup-login');
  setupService.complete(validPayload('login'));

  const session = authService.login({ username: OWNER.username, password: OWNER.password });
  assert.equal(session.user.role, 'OWNER');
  assert.equal(session.user.has_pin, true);
  assert.ok(session.token);
});

test('completion is one transaction: a failure inside it leaves nothing behind', (t) => {
  temp.openMigrated('setup-atomic');

  // Fail at the last write inside the transaction — the audit row — which is as late
  // as anything can fail once the profile and the owner are already inserted.
  const original = auditService.record;
  t.mock.method(auditService, 'record', () => { throw new Error('disk full'); });

  assert.throws(() => setupService.complete(validPayload('atomic')), /disk full/);

  assert.equal(storeProfileRepository.count(), 0, 'no store profile');
  assert.equal(userRepository.countAll(), 0, 'no owner');
  assert.equal(settingsRepository.count(), 0, 'no settings');
  assert.equal(setupService.isComplete(), false);

  t.mock.restoreAll();
  assert.equal(auditService.record, original);
});

test('killing the app mid-wizard resumes at step 1 with nothing written', () => {
  const dir = temp.openMigrated('setup-resume');

  // Steps 1 to 4 are answered and the application is killed before the last one. The
  // wizard holds no server state, so there is nothing to be half-written: this is the
  // property, not a recovery routine.
  assert.throws(
    () => setupService.complete(validPayload('resume', { backupFolder: '' })),
    (err) => err.ruleId === 'OPS-001'
  );

  temp.reopen(dir);
  assert.equal(setupService.status().required, true, 'back at step 1');
  assert.equal(storeProfileRepository.count(), 0);
  assert.equal(userRepository.countAll(), 0);
  assert.equal(settingsRepository.count(), 0);
});

test('setup runs exactly once in the life of a database', () => {
  temp.openMigrated('setup-once');
  setupService.complete(validPayload('once'));

  assert.throws(
    () => setupService.complete(validPayload('once-again')),
    (err) => err.status === 409 && err.ruleId === 'FR_1.1'
  );
  assert.equal(userRepository.countAll(), 1);
});

// ── The recovery code (SEC-5) ───────────────────────────────────────────────

test('the recovery code is returned once, stored hashed, and works', () => {
  temp.openMigrated('setup-recovery');
  const result = setupService.complete(validPayload('recovery'));

  assert.match(result.recoveryCode, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/, 'four readable groups');

  // Stored bcrypt-hashed, never in plaintext, and never in the shape a user leaves in.
  const stored = userRepository.findByUsername(OWNER.username);
  assert.match(stored.recovery_code_hash, /^\$2[aby]\$/);
  assert.notEqual(stored.recovery_code_hash, result.recoveryCode);
  assert.equal(JSON.stringify(result.owner).includes('hash'), false, 'SEC-1');

  // It is the real code: consuming it resets the password (TASK-003's path).
  const recovered = authService.recover({
    username: OWNER.username,
    recoveryCode: result.recoveryCode,
    newPassword: 'a-brand-new-password',
  });
  assert.ok(recovered.recoveryCode, 'and a replacement is issued');
  assert.notEqual(recovered.recoveryCode, result.recoveryCode);
});

test('setup is refused without the "I have written this down" acknowledgement', () => {
  temp.openMigrated('setup-ack');

  assert.throws(
    () => setupService.complete(validPayload('ack', { acknowledgedRecoveryCode: false })),
    (err) => err.status === 400 && err.ruleId === 'SEC-5'
  );
  assert.equal(userRepository.countAll(), 0, 'and nothing was written');
});

// ── The backup folder (OPS-001) ─────────────────────────────────────────────

test('an unwritable backup folder blocks completion with a message that says what to do', () => {
  temp.openMigrated('setup-unwritable');
  if (process.platform === 'win32' || process.getuid() === 0) {
    // Running as root defeats a permission bit, and Windows has no POSIX mode. The
    // rule is still enforced; this machine cannot demonstrate it.
    return;
  }

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-readonly-'));
  const target = path.join(parent, 'backups');
  fs.mkdirSync(target);
  fs.chmodSync(target, 0o500);        // readable, not writable

  try {
    assert.throws(
      () => setupService.complete(validPayload('unwritable', { backupFolder: target })),
      (err) => err.status === 400 && err.ruleId === 'OPS-001' && /another folder/i.test(err.message)
    );
    assert.equal(userRepository.countAll(), 0);
  } finally {
    fs.chmodSync(target, 0o700);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('a backup folder inside the application data directory is refused (OPS-001)', () => {
  const dir = temp.openMigrated('setup-inside');

  assert.throws(
    () => setupService.complete(validPayload('inside', { backupFolder: path.join(dir, 'backups') })),
    (err) => err.ruleId === 'OPS-001' && /outside/i.test(err.message)
  );
  // The data directory itself, and a path above it, are the same refusal and its absence.
  assert.equal(setupService.isInsideDataDir(dir), true);
  assert.equal(setupService.isInsideDataDir(path.join(dir, 'nested', 'deeper')), true);
  assert.equal(setupService.isInsideDataDir(os.tmpdir()), false);
});

test('a relative backup path is refused before anything touches the filesystem', () => {
  temp.openMigrated('setup-relative');
  assert.throws(
    () => setupService.complete(validPayload('relative', { backupFolder: 'backups' })),
    (err) => err.ruleId === 'OPS-001' && /full path/i.test(err.message)
  );
});

test('the backup folder is created when it does not exist, and proved writable', () => {
  temp.openMigrated('setup-mkdir');
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-mk-')), 'a', 'b', 'backups');
  assert.equal(fs.existsSync(target), false);

  setupService.complete(validPayload('mkdir', { backupFolder: target }));

  assert.equal(fs.existsSync(target), true, 'created');
  assert.equal(settingsService.get('backup_folder'), path.resolve(target));
  // The write probe cleans up after itself; an installation must not leave litter in
  // the operator's own folder.
  assert.deepEqual(fs.readdirSync(target), []);
});

// ── Validation of the wizard's own fields ───────────────────────────────────

test('every step validates before any of them is written', () => {
  temp.openMigrated('setup-validation');

  const refusals = [
    [{ taxMode: 'PERCENTAGE' }, 'TAX-001'],
    [{ store: { storeName: 'X' } }, 'VR-501'],
    [{ owner: { ...OWNER, username: 'ab' } }, 'VR-501'],
    [{ owner: { ...OWNER, fullName: '' } }, 'VR-501'],
    [{ owner: { ...OWNER, password: 'short' } }, 'VR-502'],
    [{ owner: { ...OWNER, pin: '123456' } }, 'VR-502'],
    [{ owner: { ...OWNER, pin: '11' } }, 'VR-502'],
  ];

  for (const [over, ruleId] of refusals) {
    assert.throws(
      () => setupService.complete(validPayload('validation', over)),
      (err) => err.status === 400 && err.ruleId === ruleId,
      `expected ${ruleId} for ${JSON.stringify(over)}`
    );
  }
  assert.equal(userRepository.countAll(), 0, 'nothing written by any refusal');
});

test('the owner PIN is optional', () => {
  temp.openMigrated('setup-nopin');
  const result = setupService.complete(validPayload('nopin', { owner: { ...OWNER, pin: null } }));
  assert.equal(result.owner.has_pin, false);
});

// ── The audit row (AUD-601) ─────────────────────────────────────────────────

test('completing setup is audited by an actor that does not exist yet (AUD-606)', () => {
  temp.openMigrated('setup-audit');
  setupService.complete(validPayload('audit'));

  const rows = auditService.list({ entityType: 'store_profile' });
  const row = rows.find((r) => r.action === 'INSTALLATION_SET_UP');
  assert.ok(row, 'the installation itself is on the trail');

  // There is genuinely no user when the row is written — the owner is created by the
  // same transaction. AUD-606's denormalised username is what makes that writable.
  assert.equal(row.actor_id, null);
  assert.equal(row.actor_username, 'setup');

  const after = JSON.parse(row.after_value);
  assert.equal(after.tax_mode, 'NON_VAT');
  assert.equal(after.owner_username, OWNER.username);
  assert.equal(after.settings_seeded, settingsService.KEYS.length);
  assert.equal(JSON.stringify(row).toLowerCase().includes('correct-horse'), false, 'no credential on the trail');
});

test.after(() => temp.cleanup());
