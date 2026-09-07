'use strict';

// TAX-001: the store operates in exactly one tax mode, set at setup and changeable
// only by the owner with an audit record.
//
// 01_PRODUCT_BRIEF.md D-3 — the client asked for all three, so registration status is
// an installation choice rather than a build-time assumption. That is also what makes
// the product resellable to another agrivet store without a schema change: TAX-003
// populates tax_class in every mode, so switching mode is configuration, never a
// migration.

const db = require('../config/database');
const clock = require('../config/clock');
const ids = require('../config/ids');
const errors = require('./errors');
const auditService = require('./auditService');
const storeProfileRepository = require('../repositories/storeProfileRepository');

/**
 * The three modes, each with the one plain-language sentence SCR-001 shows beside it.
 * An operator choosing this at install is not a tax accountant, and "NON_VAT" on its
 * own is not a question anyone can answer.
 */
const TAX_MODES = Object.freeze({
  NONE: {
    label: 'Not registered',
    sentence: 'The store is not registered for tax. Prices are final and nothing is computed or printed.',
    computesTax: false,
  },
  NON_VAT: {
    label: 'Non-VAT (percentage tax)',
    sentence: 'The store pays percentage tax. Prices are final; no tax is split out on the printed record.',
    computesTax: false,
  },
  VAT: {
    label: 'VAT-registered',
    sentence: 'The store is VAT-registered. Selling prices include 12% VAT, and each line is broken '
      + 'down by its product\'s tax class.',
    computesTax: true,
  },
});

const MODES = Object.freeze(Object.keys(TAX_MODES));

/**
 * TAX-002: `NONE` and `NON_VAT` compute no tax at all — the selling price is the final
 * price and every sale line records `tax_amount_centavos = 0`.
 *
 * TASK-009 owns the VAT decomposition itself. This is the mode-level fact the rest of
 * the system branches on, and TC-UT-17 asserts it here so that the branch is decided
 * once rather than re-read from the mode string at each call site.
 */
function computesTax(mode) {
  assertMode(mode);
  return TAX_MODES[mode].computesTax;
}

function assertMode(mode) {
  if (!MODES.includes(mode)) {
    throw errors.badRequest(`Tax mode must be one of ${MODES.join(', ')}`, { ruleId: 'TAX-001' });
  }
  return mode;
}

function find() {
  return storeProfileRepository.find();
}

/** The profile, or a refusal — used where a caller cannot proceed without a store. */
function profile() {
  const row = find();
  if (!row) throw errors.conflict('The store is not set up yet.', { ruleId: 'FR_1.1' });
  return row;
}

/** The mode in force. Every tax decision in the product reads this, never a literal. */
function taxMode() {
  return profile().tax_mode;
}

function create({ storeName, address = null, contactNo = null, tin = null, taxMode: mode, currency = 'PHP' }, { at = clock.nowUtc() } = {}) {
  const name = typeof storeName === 'string' ? storeName.trim() : '';
  if (name.length < 2 || name.length > 120) {
    throw errors.badRequest('The store name is required', { ruleId: 'VR-501' });
  }
  assertMode(mode);

  if (storeProfileRepository.count() > 0) {
    throw errors.conflict('This installation already has a store profile.', { ruleId: 'FR_1.1' });
  }

  return storeProfileRepository.insert({
    id: ids.uuidv7(),
    store_name: name,
    address: typeof address === 'string' && address.trim() ? address.trim() : null,
    contact_no: typeof contactNo === 'string' && contactNo.trim() ? contactNo.trim() : null,
    tin: typeof tin === 'string' && tin.trim() ? tin.trim() : null,
    tax_mode: mode,
    currency,
    created_at: at,
  });
}

/**
 * Change the store's identity. TX-424; the tax mode is not settable here — it has its
 * own rule, its own permission and its own audit action, and folding it in would let a
 * TX-424 holder change it as a side effect of editing an address.
 */
function update(changes, actor) {
  const current = profile();
  const fields = {};
  const before = {};
  const after = {};

  const text = (value, { max = 200 } = {}) => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.slice(0, max) || null;
  };

  if (changes.storeName !== undefined) {
    const name = text(changes.storeName, { max: 120 });
    if (!name || name.length < 2) throw errors.badRequest('The store name is required', { ruleId: 'VR-501' });
    fields.store_name = name;
    before.store_name = current.store_name;
    after.store_name = name;
  }
  for (const [input, column] of [['address', 'address'], ['contactNo', 'contact_no'], ['tin', 'tin']]) {
    if (changes[input] === undefined) continue;
    fields[column] = text(changes[input]);
    before[column] = current[column];
    after[column] = fields[column];
  }

  if (Object.keys(fields).length === 0) return current;

  fields.updated_at = clock.nowUtc();
  fields.updated_by = actor && actor.id ? actor.id : null;

  return db.transaction(() => {
    const updated = storeProfileRepository.updateFields(current.id, fields);
    auditService.record({
      actor,
      action: 'STORE_PROFILE_CHANGED',
      entityType: 'store_profile',
      entityId: current.id,
      before,
      after,
    });
    return updated;
  });
}

/**
 * TAX-001: owner only, and audited with both values.
 *
 * The audit row is the point of the rule. A store that switches to VAT halfway through
 * a year has two different sets of figures in one ledger, and the only thing that makes
 * the earlier ones explicable afterwards is a dated row saying when it changed and who
 * changed it.
 */
function setTaxMode(mode, actor, { reason = null } = {}) {
  assertMode(mode);
  const current = profile();
  if (current.tax_mode === mode) return { profile: current, changed: false };

  // The change and its audit row commit together. TAX-001 requires the record; a mode
  // that moved without one leaves a ledger whose earlier figures nobody can explain.
  const updated = db.transaction(() => {
    const row = storeProfileRepository.updateFields(current.id, {
      tax_mode: mode,
      updated_at: clock.nowUtc(),
      updated_by: actor && actor.id ? actor.id : null,
    });
    auditService.record({
      actor,
      action: 'TAX_MODE_CHANGED',
      entityType: 'store_profile',
      entityId: current.id,
      before: { tax_mode: current.tax_mode },
      after: { tax_mode: mode },
      reason: reason || `Tax mode changed to ${TAX_MODES[mode].label}`,
    });
    return row;
  });

  return { profile: updated, changed: true, before: current.tax_mode };
}

module.exports = {
  TAX_MODES, MODES,
  assertMode, computesTax, find, profile, taxMode, create, update, setTaxMode,
};
