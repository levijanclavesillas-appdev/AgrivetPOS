'use strict';

// FR_1.1 / SCR-001: a fresh installation configures itself in one guided pass —
// store identity, tax mode, the owner account with its recovery code, and the backup
// folder — and writes nothing until the last step.
//
// "Writes nothing until the last step" is the whole design. The wizard has no server
// state and no partial rows: killing the application at step 4 leaves a database that
// is still empty, so the next launch starts at step 1 rather than at a half-built
// installation nobody can reason about (SCR-001 *States*).

const fs = require('fs');
const path = require('path');
const os = require('os');

const db = require('../config/database');
const ids = require('../config/ids');
const clock = require('../config/clock');
const paths = require('../config/paths');
const errors = require('./errors');
const authService = require('./authService');
const auditService = require('./auditService');
const settingsService = require('./settingsService');
const storeProfileService = require('./storeProfileService');
const userRepository = require('../repositories/userRepository');
const storeProfileRepository = require('../repositories/storeProfileRepository');

/**
 * The actor on the rows the wizard writes.
 *
 * There is genuinely no user yet — the owner is created by the same transaction that
 * records its creation — so the audit row names 'setup' with a null id. AUD-606
 * denormalises the username for exactly this reason: the trail has to be writable
 * before the users table has anyone in it.
 */
const SETUP_ACTOR = Object.freeze({ id: null, username: 'setup' });

const STEPS = Object.freeze(['store', 'tax', 'owner', 'recovery', 'backup']);

// ── Is setup needed? ────────────────────────────────────────────────────────

/**
 * An installation is set up when it has a store profile **and** an active owner.
 *
 * Both, not either. A database with a profile and no owner cannot be signed into, and
 * one with an owner and no profile has no tax mode, so either half alone is a state
 * the wizard must finish rather than a state to serve the application from.
 */
function isComplete() {
  return storeProfileRepository.count() > 0 && userRepository.countActiveOwners() > 0;
}

/**
 * What the wizard needs before anyone has authenticated, and what SCR-101 needs
 * afterwards.
 *
 * Deliberately readable without a session: it is called by the renderer to decide
 * which screen to show, and by the login screen for the store name. It carries no
 * figure that is not already printed on the store's own door.
 */
function status() {
  const complete = isComplete();
  const profile = complete ? storeProfileRepository.find() : null;
  return {
    required: !complete,
    steps: STEPS,
    tax_modes: Object.entries(storeProfileService.TAX_MODES).map(([value, mode]) => ({
      value, label: mode.label, sentence: mode.sentence,
    })),
    suggested_backup_folder: complete ? null : suggestBackupFolder(),
    store_name: profile ? profile.store_name : null,
    tax_mode: profile ? profile.tax_mode : null,
  };
}

/**
 * Every route that is not the wizard refuses while setup is outstanding
 * (requirement 1). Expressed as a service call so the middleware holds no rule.
 */
function assertComplete() {
  if (!isComplete()) {
    throw errors.setupRequired('This installation is not set up yet. Finish the setup wizard first.');
  }
}

function assertNotComplete() {
  if (isComplete()) {
    throw errors.conflict(
      'This installation is already set up. Change these figures in Settings instead.',
      { ruleId: 'FR_1.1' }
    );
  }
}

// ── Backup folder (OPS-001) ─────────────────────────────────────────────────

/**
 * A first suggestion for the picker — the user's Documents folder, which is outside
 * the application data directory and survives an uninstall.
 *
 * OPS-001's "defaults outside the application data directory" is not a preference. A
 * backup inside the folder the database lives in is lost to the same deleted folder,
 * the same failed disk and the same uninstaller as the thing it was backing up.
 */
function suggestBackupFolder() {
  return path.join(os.homedir(), 'Documents', 'ChachiAgrivetPOS Backups');
}

function isInsideDataDir(folder) {
  const dataDir = path.resolve(paths.dataDir());
  const target = path.resolve(folder);
  const relative = path.relative(dataDir, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Validate the folder and prove it writable, before anything is written to the
 * database.
 *
 * Proving it means writing a file and deleting it. A permission bit says what the
 * filesystem believes; a full disk, a disconnected USB drive and a synced folder that
 * has gone read-only all pass that check and fail the first real backup — which the
 * operator would then discover on the day they needed one.
 *
 * This runs *outside* the completion transaction on purpose: a filesystem probe is not
 * rolled back by a SQLite rollback, so it happens first and its failure means nothing
 * has been attempted at all.
 */
function validateBackupFolder(folder) {
  const text = typeof folder === 'string' ? folder.trim() : '';
  if (!text) {
    throw errors.badRequest('Choose a folder for automatic backups.', { ruleId: 'OPS-001' });
  }
  if (!path.isAbsolute(text)) {
    throw errors.badRequest('The backup folder must be a full path.', { ruleId: 'OPS-001' });
  }
  if (isInsideDataDir(text)) {
    throw errors.badRequest(
      'The backup folder must be outside the application data folder, so that a backup '
      + 'survives losing the folder the database is in. Choose another drive or your '
      + 'Documents folder.',
      { ruleId: 'OPS-001' }
    );
  }

  try {
    fs.mkdirSync(text, { recursive: true });
  } catch (err) {
    throw errors.badRequest(
      `That folder could not be created (${err.code || err.message}). Choose one you can write to.`,
      { ruleId: 'OPS-001' }
    );
  }

  const probe = path.join(text, `.agrivet-write-test-${Date.now()}`);
  try {
    fs.writeFileSync(probe, 'chachi agrivet pos backup folder check');
    fs.rmSync(probe, { force: true });
  } catch (err) {
    throw errors.badRequest(
      `That folder is not writable (${err.code || err.message}). Backups would fail silently, `
      + 'so setup cannot finish with it. Choose another folder.',
      { ruleId: 'OPS-001' }
    );
  }

  return path.resolve(text);
}

// ── Completion (requirement 6) ──────────────────────────────────────────────

/**
 * Finish the wizard: one store profile, one owner, the full seeded settings, in one
 * transaction.
 *
 * Everything that can be refused is refused before `db.transaction` opens — validation
 * and the filesystem probe both — so the transaction contains only writes and there is
 * no path on which it half-succeeds.
 *
 * The recovery code is in the return value and nowhere else. It is generated here,
 * stored bcrypt-hashed (SEC-5), and cannot be produced again: the wizard shows it once
 * behind an explicit acknowledgement, and a forgotten one is replaced through
 * `POST /auth/recover`, never re-read.
 */
function complete({ store = {}, taxMode, owner = {}, backupFolder, acknowledgedRecoveryCode = false } = {}) {
  assertNotComplete();

  // Step 2 (TAX-001) and step 3 (VR-501, VR-502), refused before any work.
  storeProfileService.assertMode(taxMode);
  const username = authService.validateUsername(owner.username);
  authService.validatePassword(owner.password);
  if (owner.pin !== undefined && owner.pin !== null && owner.pin !== '') authService.validatePin(owner.pin);

  const fullName = typeof owner.fullName === 'string' ? owner.fullName.trim() : '';
  if (fullName.length < 2) {
    throw errors.badRequest("The owner's full name is required", { ruleId: 'VR-501' });
  }

  // SEC-5: the code is useless if the person holding it has not written it down, and
  // there is no second chance to be shown it. The acknowledgement is a requirement of
  // the rule, so it is enforced on the server, not by the checkbox alone.
  if (acknowledgedRecoveryCode !== true) {
    throw errors.badRequest(
      'Confirm that you have written the recovery code down. It is shown once and cannot '
      + 'be shown again.',
      { ruleId: 'SEC-5' }
    );
  }

  const folder = validateBackupFolder(backupFolder);
  const recoveryCode = authService.generateRecoveryCode();
  const at = clock.nowUtc();

  const result = db.transaction(() => {
    const profile = storeProfileService.create({
      storeName: store.storeName,
      address: store.address,
      contactNo: store.contactNo,
      tin: store.tin,
      taxMode,
    }, { at });

    const ownerRow = userRepository.insert({
      id: ids.uuidv7(),
      username,
      full_name: fullName,
      password_hash: authService.hashSecretValue(owner.password),
      pin_hash: owner.pin ? authService.hashSecretValue(owner.pin) : null,
      role: 'OWNER',
      recovery_code_hash: authService.hashSecretValue(recoveryCode),
      is_active: 1,
      created_at: at,
      created_by: null,          // nobody created the first owner; the installation did
    });

    const seeded = settingsService.seedDefaults({
      at,
      by: ownerRow.id,
      overrides: { backup_folder: folder },
    });

    auditService.write({
      actor: SETUP_ACTOR,
      action: 'INSTALLATION_SET_UP',
      entityType: 'store_profile',
      entityId: profile.id,
      after: {
        store_name: profile.store_name,
        tax_mode: profile.tax_mode,
        owner_username: ownerRow.username,
        backup_folder: folder,
        settings_seeded: seeded.length,
      },
      reason: 'First-run setup wizard completed (FR_1.1)',
    });

    return { profile, owner: authService.toPublic(ownerRow), settingsSeeded: seeded.length };
  });

  return { ...result, recoveryCode, backupFolder: folder };
}

module.exports = {
  SETUP_ACTOR, STEPS,
  isComplete, status, assertComplete, assertNotComplete,
  suggestBackupFolder, isInsideDataDir, validateBackupFolder, complete,
};
