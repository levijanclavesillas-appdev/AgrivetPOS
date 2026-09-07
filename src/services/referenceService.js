'use strict';

// Categories, brands and units (VR-209, requirement 1).
//
// Soft delete only. A category with products, a unit that is some product's base unit
// and a brand on a sold item are all referenced by history — VR-206's reasoning is
// about products, but the reason is the same for the rows they point at: history does
// not move because somebody tidied a dropdown.

const db = require('../config/database');
const ids = require('../config/ids');
const clock = require('../config/clock');
const errors = require('./errors');
const auditService = require('./auditService');
const referenceRepository = require('../repositories/referenceRepository');

const KINDS = Object.freeze({
  categories: { singular: 'Category', entity: 'categories', labelField: 'name' },
  brands: { singular: 'Brand', entity: 'brands', labelField: 'name' },
  units: { singular: 'Unit', entity: 'units', labelField: 'code' },
});

function assertKind(kind) {
  if (!KINDS[kind]) throw new RangeError(`unknown reference kind: ${kind}`);
  return kind;
}

const text = (value, { max = 80 } = {}) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function list(kind, opts) {
  return referenceRepository.list(assertKind(kind), opts);
}

function get(kind, id) {
  const row = referenceRepository.findById(assertKind(kind), id);
  if (!row) throw errors.notFound(`No such ${KINDS[kind].singular.toLowerCase()}`);
  return row;
}

/** VR-209: unique and required. The columns collate NOCASE; this is the message. */
function assertLabelFree(kind, label, { exceptId = null } = {}) {
  const existing = referenceRepository.findByLabel(kind, label);
  if (existing && existing.id !== exceptId) {
    throw errors.conflict(`"${label}" already exists`, { ruleId: 'VR-209' });
  }
}

function create(kind, input, actor) {
  assertKind(kind);
  const at = clock.nowUtc();
  const row = { id: ids.uuidv7(), is_active: 1, created_at: at };

  if (kind === 'units') {
    // A unit code is what the whole UI labels quantities with (UOM-005), so it is
    // short, upper-cased and stable: KG, PC, SACK, L.
    const code = text(input.code, { max: 12 }).toUpperCase();
    if (code.length < 1) throw errors.badRequest('A unit code is required', { ruleId: 'VR-209' });
    if (!/^[A-Z0-9]+$/.test(code)) {
      throw errors.badRequest('A unit code is letters and digits only, such as KG or SACK', { ruleId: 'VR-209' });
    }
    assertLabelFree(kind, code);
    row.code = code;
    row.name = text(input.name, { max: 60 }) || code;
    // Whether a quantity in this unit may carry decimals. Kilos may; pieces may not,
    // and a UI that lets a cashier key 2.5 pieces has invented half a sack of feed.
    row.allows_fraction = input.allowsFraction ? 1 : 0;
  } else {
    const name = text(input.name, { max: 80 });
    if (name.length < 2) throw errors.badRequest(`A ${KINDS[kind].singular.toLowerCase()} name is required`, { ruleId: 'VR-209' });
    assertLabelFree(kind, name);
    row.name = name;

    if (kind === 'categories') {
      // PR-202 is v1.1, but the column is here and a value written now must be sane.
      row.max_discount_bp = normaliseCeiling(input.maxDiscountBp);
    }
  }

  return db.transaction(() => {
    const created = referenceRepository.insert(kind, row);
    auditService.write({
      actor,
      action: 'REFERENCE_DATA_CHANGED',
      entityType: kind,
      entityId: created.id,
      after: created,
      reason: `${KINDS[kind].singular} created`,
    });
    return created;
  });
}

function normaliseCeiling(value) {
  if (value === undefined || value === null || value === '') return null;
  const bp = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(bp) || bp < 0 || bp > 10000) {
    throw errors.badRequest('A category discount ceiling is 0 to 10000 basis points', { ruleId: 'PR-202' });
  }
  return bp;
}

function update(kind, id, changes, actor) {
  const current = get(kind, id);
  const fields = {};
  const before = {};
  const after = {};

  const move = (column, value) => {
    if (current[column] === value) return;
    fields[column] = value;
    before[column] = current[column];
    after[column] = value;
  };

  if (changes.name !== undefined) {
    const name = text(changes.name, { max: 80 });
    const min = kind === 'units' ? 1 : 2;
    if (name.length < min) throw errors.badRequest(`A ${KINDS[kind].singular.toLowerCase()} name is required`, { ruleId: 'VR-209' });
    if (kind !== 'units') assertLabelFree(kind, name, { exceptId: id });
    move('name', name);
  }
  if (kind === 'units' && changes.code !== undefined) {
    const code = text(changes.code, { max: 12 }).toUpperCase();
    if (!/^[A-Z0-9]+$/.test(code)) {
      throw errors.badRequest('A unit code is letters and digits only', { ruleId: 'VR-209' });
    }
    assertLabelFree(kind, code, { exceptId: id });
    move('code', code);
  }
  if (kind === 'units' && changes.allowsFraction !== undefined) {
    move('allows_fraction', changes.allowsFraction ? 1 : 0);
  }
  if (kind === 'categories' && changes.maxDiscountBp !== undefined) {
    move('max_discount_bp', normaliseCeiling(changes.maxDiscountBp));
  }
  if (changes.isActive !== undefined) {
    const active = changes.isActive ? 1 : 0;
    if (active === 0) assertDeactivatable(kind, id);
    move('is_active', active);
  }

  if (Object.keys(fields).length === 0) return current;

  return db.transaction(() => {
    const updated = referenceRepository.updateFields(kind, id, fields);
    auditService.write({
      actor,
      // A category's discount ceiling is a discount rule (PR-202), and AUD-601 lists
      // "discount rule change" by name — so that one change is filed where an auditor
      // looking for discount changes will actually find it, not under reference data.
      action: after.max_discount_bp !== undefined ? 'DISCOUNT_RULE_CHANGED' : 'REFERENCE_DATA_CHANGED',
      entityType: kind,
      entityId: id,
      before,
      after,
      reason: `${KINDS[kind].singular} modified`,
    });
    return updated;
  });
}

/**
 * A row still in use may not be switched off.
 *
 * Deactivating a unit that is some product's base unit would leave that product
 * unsellable with no message saying why — the failure would appear at the counter, on
 * a scan, as a product that simply does not work.
 */
function assertDeactivatable(kind, id) {
  const references = referenceRepository.referenceCount(kind, id);
  if (references > 0) {
    throw errors.conflict(
      `This ${KINDS[kind].singular.toLowerCase()} is used by ${references} product${references === 1 ? '' : 's'}. `
      + 'Move them first, or leave it active.',
      { ruleId: 'VR-206' }
    );
  }
}

/** VR-206 applied to the reference tables: there is no delete, only deactivation. */
function deactivate(kind, id, actor) {
  return update(kind, id, { isActive: false }, actor);
}

module.exports = { KINDS, assertKind, list, get, create, update, deactivate, assertDeactivatable };
