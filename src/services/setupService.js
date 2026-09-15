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
const industries = require('../config/industries');
const hosting = require('../config/hosting');
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
    // TASK-062: the wizard asks for the setup code, and does not ask for a backup folder.
    hosted: hosting.isHosted(),
    setup_code_required: hosting.isHosted() && !complete,
    store_name: profile ? profile.store_name : null,
    tax_mode: profile ? profile.tax_mode : null,
    // TASK-053: what kind of store — the sign-in screen's "Chachi POS (Pharmacy)", the
    // rail's icon and a new product's ticks. Before setup, the choices the wizard offers.
    product_name: industries.PRODUCT_NAME,
    industry: profile ? industries.describe(profile.industry) : null,
    industries: complete ? null : industries.catalogue(),
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

// ── The setup code of a hosted copy (TASK-062) ─────────────────────────────

/**
 * On the internet, "the first person to open the wizard becomes the owner" means the first
 * person to find the address. A hosted copy is started with a one-time code that Chachi's
 * gives the store's owner; without it nothing in the wizard writes. Wrong codes are
 * counted, and after five in fifteen minutes the wizard stops listening for a while — the
 * code is sixteen characters, so this is about noise more than guessing.
 */
const CODE_TRIES = 5;
const CODE_WINDOW_MS = 15 * 60 * 1000;
let codeFailures = [];

function assertSetupCode(given) {
  if (!hosting.isHosted()) return;
  if (!hosting.setupCode()) {
    throw errors.forbidden(
      'This hosted POS has not been given a setup code yet. Ask Chachi\'s to finish setting it up.',
      { ruleId: 'SEC-8' }
    );
  }
  const now = Date.now();
  codeFailures = codeFailures.filter((at) => now - at < CODE_WINDOW_MS);
  if (codeFailures.length >= CODE_TRIES) {
    const minutes = Math.ceil((CODE_WINDOW_MS - (now - codeFailures[0])) / 60000);
    throw errors.locked(
      `Too many wrong setup codes. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      { ruleId: 'SEC-8' }
    );
  }
  if (!hosting.setupCodeMatches(given)) {
    codeFailures.push(now);
    throw errors.forbidden(
      'That setup code is not right. It is the code Chachi\'s sent with this store\'s address.',
      { ruleId: 'SEC-8' }
    );
  }
  codeFailures = [];
}

/** For the tests: a fresh count of wrong codes. */
function resetSetupCodeFailures() { codeFailures = []; }

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
  // TASK-062: a hosted copy's backups go to its own volume, and are not a choice.
  if (hosting.isHosted()) return hosting.backupDir();
  // On Android the app knows where shared storage is and the server does not, so the
  // app says (TASK-049). The rule the wizard enforces is the same: outside the data folder.
  if (process.env.AGRIVET_BACKUP_SUGGESTION) return process.env.AGRIVET_BACKUP_SUGGESTION;
  return path.join(os.homedir(), 'Documents', 'ChachiPOS Backups');
}

/**
 * OPS-001's placement rule, and a proof that the folder is writable.
 *
 * The placement half lives in settingsService's registry, so the wizard and
 * `PUT /settings` cannot disagree about where a backup may go — they did, and a store
 * could move its backups inside the folder being backed up the day after install. The
 * write probe stays here: the wizard is the one caller that must fail before anything
 * has been created, and a folder that cannot be written to is not a folder anybody
 * should finish an installation on.
 */
function validateBackupFolder(folder) {
  const text = typeof folder === 'string' ? folder.trim() : '';
  if (!text) {
    throw errors.badRequest('Choose a folder for automatic backups.', { ruleId: 'OPS-001' });
  }
  settingsService.validateBackupFolder(text);

  const probe = path.join(text, `.agrivet-write-test-${Date.now()}`);
  try {
    fs.writeFileSync(probe, 'chachi pharmacy pos backup folder check');
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
function complete({ store = {}, taxMode, owner = {}, backupFolder, acknowledgedRecoveryCode = false, industry, setupCode } = {}) {
  assertNotComplete();
  assertSetupCode(setupCode);

  // Step 1's industry (TASK-053), step 2 (TAX-001) and step 3 (VR-501, VR-502), refused
  // before any work.
  storeProfileService.assertIndustry(industry);
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

  const folder = validateBackupFolder(hosting.isHosted() ? hosting.backupDir() : backupFolder);
  const recoveryCode = authService.generateRecoveryCode();
  const at = clock.nowUtc();

  const result = db.transaction(() => {
    const profile = storeProfileService.create({
      storeName: store.storeName,
      address: store.address,
      contactNo: store.contactNo,
      tin: store.tin,
      taxMode,
      industry,
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
      // TASK-062: a hosted copy prints through the browser — the printer is in the store,
      // not beside the server.
      overrides: { backup_folder: folder, ...(hosting.isHosted() ? { printer_transport: 'BROWSER' } : {}) },
      // TASK-053: the defaults a store of this kind would otherwise change on day one.
      industry,
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
  isComplete, status, assertComplete, assertNotComplete, assertSetupCode, resetSetupCodeFailures,
  suggestBackupFolder, isInsideDataDir: paths.isInsideDataDir, validateBackupFolder, complete,
};
