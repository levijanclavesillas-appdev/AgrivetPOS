'use strict';

// FT-501 / VR-401 — the supplier record.
//
// The whole of it is identity, contact and terms. What makes it worth a table is the
// question v1.0 could not answer: what did this supplier charge us last time. That is
// read off the receipts (PO-203's actual cost), not off the orders, and it is the
// figure a buyer checks before agreeing to a price on the phone.
//
// VR-304's reasoning applies here unchanged: a supplier who has delivered is history,
// so there is no delete — only deactivation, and only once nothing is outstanding.

const ids = require('../config/ids');
const clock = require('../config/clock');
const errors = require('./errors');
const auditService = require('./auditService');
const supplierRepository = require('../repositories/supplierRepository');
const purchaseOrderRepository = require('../repositories/purchaseOrderRepository');

const text = (value, { max = 200 } = {}) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const textOrNull = (value, opts) => text(value, opts) || null;

// ── Validation (VR-401) ─────────────────────────────────────────────────────

function validateName(name) {
  const trimmed = text(name, { max: 120 });
  if (trimmed.length < 2 || trimmed.length > 120) {
    throw errors.badRequest('A supplier name is 2 to 120 characters', { ruleId: 'VR-401' });
  }
  return trimmed;
}

/**
 * VR-401's uniqueness, checked here so the refusal is a sentence rather than a
 * constraint violation.
 *
 * NOCASE, because "B-MEG Feeds" and "b-meg feeds" are one account. A store that ends
 * up with both has two purchase histories for the same supplier and cannot see either
 * whole, which is precisely the thing this table exists to make possible.
 */
function assertNameFree(name, { exceptId = null } = {}) {
  const existing = supplierRepository.findByName(name);
  if (existing && existing.id !== exceptId) {
    throw errors.conflict(
      `There is already a supplier called "${existing.name}".`,
      { ruleId: 'VR-401' }
    );
  }
}

function assertCodeFree(code, { exceptId = null } = {}) {
  if (!code) return;
  const existing = supplierRepository.findByCode(code);
  if (existing && existing.id !== exceptId) {
    throw errors.conflict(`The supplier code "${code}" is already in use`, { ruleId: 'VR-401' });
  }
}

function validateTerms(days) {
  if (days === null || days === undefined || days === '') return 0;
  const n = Number.parseInt(days, 10);
  if (!Number.isInteger(n) || n < 0 || n > 365) {
    throw errors.badRequest('Payment terms are a whole number of days from 0 to 365', { ruleId: 'VR-401' });
  }
  return n;
}

// ── The public shape ────────────────────────────────────────────────────────

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    contact_person: row.contact_person,
    contact_no: row.contact_no,
    email: row.email,
    address: row.address,
    terms_days: row.terms_days,
    terms_label: row.terms_days === 0 ? 'Cash on delivery' : `${row.terms_days} days`,
    notes: row.notes,
    is_active: Boolean(row.is_active),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── Reading ─────────────────────────────────────────────────────────────────

function find(id) {
  return supplierRepository.findById(id);
}

function get(id) {
  const row = supplierRepository.findById(id);
  if (!row) throw errors.notFound('No such supplier');
  return toPublic(row);
}

function search(opts = {}) {
  const term = opts.q === null || opts.q === undefined ? null : text(opts.q, { max: 60 });
  const filters = { q: term || null, includeInactive: Boolean(opts.includeInactive) };
  const limit = Math.min(Math.max(Number.parseInt(opts.limit, 10) || 50, 1), 200);
  const offset = Math.max(Number.parseInt(opts.offset, 10) || 0, 0);

  return {
    total: supplierRepository.countSearch(filters),
    limit,
    offset,
    suppliers: supplierRepository.search({ ...filters, limit, offset }).map(toPublic),
  };
}

/** What this supplier last charged for a product (PO-203's actual, not the ordered). */
function lastCostFor(supplierId, productId) {
  return supplierRepository.lastCostFor(supplierId, productId);
}

// ── Writing ─────────────────────────────────────────────────────────────────

function create(input, actor) {
  const name = validateName(input.name);
  const code = textOrNull(input.code, { max: 24 });
  assertNameFree(name);
  assertCodeFree(code);

  const at = clock.nowUtc();
  const row = supplierRepository.insert({
    id: ids.uuidv7(),
    code,
    name,
    contact_person: textOrNull(input.contactPerson, { max: 120 }),
    contact_no: textOrNull(input.contactNo, { max: 40 }),
    email: textOrNull(input.email, { max: 120 }),
    address: textOrNull(input.address, { max: 300 }),
    terms_days: validateTerms(input.termsDays),
    notes: textOrNull(input.notes, { max: 500 }),
    is_active: 1,
    created_at: at,
    created_by: actor.id,
    updated_at: null,
    updated_by: null,
  });

  auditService.write({
    actor,
    action: 'SUPPLIER_CREATED',
    entityType: 'suppliers',
    entityId: row.id,
    after: { name: row.name, code: row.code, terms_days: row.terms_days },
  });

  return toPublic(row);
}

function update(id, input, actor) {
  const before = supplierRepository.findById(id);
  if (!before) throw errors.notFound('No such supplier');

  const fields = { updated_at: clock.nowUtc(), updated_by: actor.id };

  if (input.name !== undefined) {
    fields.name = validateName(input.name);
    assertNameFree(fields.name, { exceptId: id });
  }
  if (input.code !== undefined) {
    fields.code = textOrNull(input.code, { max: 24 });
    assertCodeFree(fields.code, { exceptId: id });
  }
  if (input.contactPerson !== undefined) fields.contact_person = textOrNull(input.contactPerson, { max: 120 });
  if (input.contactNo !== undefined) fields.contact_no = textOrNull(input.contactNo, { max: 40 });
  if (input.email !== undefined) fields.email = textOrNull(input.email, { max: 120 });
  if (input.address !== undefined) fields.address = textOrNull(input.address, { max: 300 });
  if (input.termsDays !== undefined) fields.terms_days = validateTerms(input.termsDays);
  if (input.notes !== undefined) fields.notes = textOrNull(input.notes, { max: 500 });

  const row = supplierRepository.updateFields(id, fields);

  // AUD-601 wants both values, and only the fields that actually moved: a row saying
  // every column changed because the form posted all of them is a row nobody can read.
  const changed = {};
  for (const key of Object.keys(fields)) {
    if (key === 'updated_at' || key === 'updated_by') continue;
    if (before[key] !== row[key]) changed[key] = { from: before[key], to: row[key] };
  }

  if (Object.keys(changed).length > 0) {
    auditService.write({
      actor,
      action: 'SUPPLIER_MODIFIED',
      entityType: 'suppliers',
      entityId: id,
      before: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.from])),
      after: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.to])),
    });
  }

  return toPublic(row);
}

/**
 * Deactivate, never delete (VR-401's sibling of VR-304).
 *
 * Refused while an order is still open, on VR-305's reasoning: switching off a supplier
 * the store is still waiting on hides the outstanding delivery from every screen that
 * filters to active suppliers, and the goods turn up anyway.
 */
function deactivate(id, actor) {
  const before = supplierRepository.findById(id);
  if (!before) throw errors.notFound('No such supplier');
  if (!before.is_active) return toPublic(before);

  const open = purchaseOrderRepository.countSearch({ supplierId: id, open: true });
  if (open > 0) {
    throw errors.conflict(
      `${before.name} has ${open} order${open === 1 ? '' : 's'} still outstanding. `
      + 'Receive or cancel them before deactivating the supplier.',
      { ruleId: 'VR-401' }
    );
  }

  const row = supplierRepository.updateFields(id, {
    is_active: 0, updated_at: clock.nowUtc(), updated_by: actor.id,
  });

  auditService.write({
    actor,
    action: 'SUPPLIER_DEACTIVATED',
    entityType: 'suppliers',
    entityId: id,
    before: { is_active: true },
    after: { is_active: false, transaction_count: supplierRepository.transactionCount(id) },
  });

  return toPublic(row);
}

function reactivate(id, actor) {
  const before = supplierRepository.findById(id);
  if (!before) throw errors.notFound('No such supplier');
  if (before.is_active) return toPublic(before);

  const row = supplierRepository.updateFields(id, {
    is_active: 1, updated_at: clock.nowUtc(), updated_by: actor.id,
  });

  auditService.write({
    actor,
    action: 'SUPPLIER_MODIFIED',
    entityType: 'suppliers',
    entityId: id,
    before: { is_active: false },
    after: { is_active: true },
  });

  return toPublic(row);
}

/** The supplier a document must hang off — active, and present. */
function requireActive(supplierId, { ruleId = 'PO-101' } = {}) {
  const row = supplierRepository.findById(supplierId);
  if (!row) throw errors.notFound('No such supplier');
  if (!row.is_active) {
    throw errors.conflict(`${row.name} is deactivated. Reactivate the supplier first.`, { ruleId });
  }
  return row;
}

module.exports = {
  validateName, assertNameFree, assertCodeFree, validateTerms, toPublic,
  find, get, search, lastCostFor, create, update, deactivate, reactivate, requireActive,
};
