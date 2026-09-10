'use strict';

// A throwaway database per test. The application resolves its path from
// paths.dataDir(); tests bypass that with an explicit path so several databases can
// exist inside one test file.

const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../../config/database');
const migrate = require('../../config/migrate');
const secrets = require('../../config/secrets');

const made = [];

function freshDir(label = 'agrivet') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  made.push(dir);
  return dir;
}

/**
 * Open an empty database at a new path. Nothing is migrated.
 *
 * The data directory moves with it, so session.key (SEC-7) is written into the
 * throwaway directory and not into the developer's real one.
 */
function openEmpty(label) {
  db.close();
  const dir = freshDir(label);
  process.env.AGRIVET_DATA_DIR = dir;
  secrets.reset();
  db.open({ path: path.join(dir, 'agrivet.db') });
  return dir;
}

/**
 * Close and reopen the same database, as an application restart would.
 *
 * SEC-3 requires a lockout to survive this, which is why it is a helper and not an
 * inline detail of one test.
 */
function reopen(dir) {
  db.close();
  secrets.reset();
  db.open({ path: path.join(dir, 'agrivet.db') });
}

/** Open a database and bring it to the current schema version. */
function openMigrated(label) {
  const dir = openEmpty(label);
  migrate.migrate();
  return dir;
}

function cleanup() {
  db.close();
  secrets.reset();
  delete process.env.AGRIVET_DATA_DIR;
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

/** The system actor a first-run setup uses before any user exists (TASK-004). */
const SETUP_ACTOR = require('../../services/setupService').SETUP_ACTOR;

/**
 * Bring a migrated database to "installed": a store profile and the seeded settings.
 *
 * Most cases need an installation rather than a wizard — the setup gate refuses every
 * route until one exists (FR_1.1), so a test that skips this is testing the gate
 * whether it meant to or not. Cases that *are* about the wizard use a bare
 * openMigrated() and drive setupService themselves.
 */
function seedStore({ storeName = 'Test Agrivet Supply', taxMode = 'NONE', withOwner = true } = {}) {
  const storeProfileService = require('../../services/storeProfileService');
  const settingsService = require('../../services/settingsService');
  const userRepository = require('../../repositories/userRepository');

  const profile = storeProfileService.create({ storeName, taxMode });
  settingsService.seedDefaults();

  // setupService.isComplete() is profile AND active owner, so an installation without
  // one is still behind the gate. Cases that seed their own owner pass withOwner:false
  // rather than end up with two, which would quietly disarm VR-503.
  if (withOwner && userRepository.countActiveOwners() === 0) {
    seedUser({ username: 'installowner', role: 'OWNER', fullName: 'Install Owner' });
  }
  return profile;
}

/**
 * The reference rows every product needs: a category, a brand, and KG / SACK / PC.
 *
 * Returned by kind so a case can say `cat.categories.feeds.id` rather than carrying
 * six ids around.
 */
function seedCatalog(actor = SETUP_ACTOR) {
  const referenceService = require('../../services/referenceService');
  const make = (kind, input) => referenceService.create(kind, input, actor);

  return {
    category: make('categories', { name: 'Feeds' }),
    otherCategory: make('categories', { name: 'Veterinary' }),
    brand: make('brands', { name: 'B-MEG' }),
    kg: make('units', { code: 'KG', name: 'Kilogram', allowsFraction: true }),
    sack: make('units', { code: 'SACK', name: 'Sack', allowsFraction: false }),
    piece: make('units', { code: 'PC', name: 'Piece', allowsFraction: false }),
  };
}

/**
 * A supplier, which batch-tracked stock cannot exist without.
 *
 * INV-202 names the supplier as part of a batch's identity, so from TASK-029 any
 * fixture that stocks a batch-tracked product needs one. Shared rather than repeated,
 * because a test that invents its own supplier per file makes the purchasing reports
 * read differently in each.
 */
function seedSupplier({ name = 'Mindanao Feed Mill', code = 'MFM' } = {}, actor) {
  // No SETUP_ACTOR default: its id is null and suppliers.created_by is NOT NULL, so
  // defaulting would trade a clear message here for SQLITE_CONSTRAINT_NOTNULL raised
  // inside a before-hook, which is what it cost the first time.
  if (!actor || !actor.id) {
    throw new TypeError('seedSupplier needs a real user — suppliers.created_by is NOT NULL');
  }
  const supplierService = require('../../services/supplierService');
  return supplierService.create({ name, code }, actor);
}

/**
 * Stock a batch-tracked product the way a delivery would: a batch, then a RECEIPT
 * movement naming it (INV-201, INV-202).
 *
 * `expiryDate` defaults far enough out to read NORMAL against the 90-day default, so a
 * fixture that does not care about expiry does not accidentally test it.
 */
function seedBatch({
  product, supplier, qtyMilli, unitCostCentavos, batchNo = null, expiryDate = null, actor,
}) {
  if (!actor || !actor.id) {
    throw new TypeError('seedBatch needs a real user — product_batches.created_by is NOT NULL');
  }
  const batchService = require('../../services/batchService');
  const inventoryService = require('../../services/inventoryService');
  const batch = batchService.create({
    productId: product.id,
    batchNo: batchNo || `B-${String(product.sku || 'X').slice(-4)}-1`,
    supplierId: supplier.id,
    expiryDate: expiryDate || batchService.addDays(batchService.today(), 400),
    unitCostCentavos,
    actor,
  });
  const posted = inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli, unitCostCentavos,
    batchId: batch.id, actor,
  });
  return { batch, movement: posted.movement };
}

/** Create a user directly through the service, as an administrator would. */
function seedUser({ username, role = 'CASHIER', password = 'correct-horse-battery', pin = null, fullName = null }) {
  const userService = require('../../services/userService');
  return userService.create(
    { username, fullName: fullName || username, password, role, pin },
    SETUP_ACTOR
  );
}

module.exports = {
  freshDir, openEmpty, openMigrated, reopen, cleanup,
  seedStore, seedCatalog, seedSupplier, seedBatch, seedUser, SETUP_ACTOR,
};
