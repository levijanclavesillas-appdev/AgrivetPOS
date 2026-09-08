'use strict';

// FR_4.1 / VR-301–VR-305 — the customer record.
//
// The credit account hangs off it and is owned by creditService; what is here is
// identity, type, price level and the two rules about removal: a transacted customer
// is never deleted (VR-304), and one carrying a balance is not even deactivated
// (VR-305). The second is the sharper of the two — switching off a farm that owes the
// store money hides the debt from every screen that filters to active customers.

const db = require('../config/database');
const ids = require('../config/ids');
const clock = require('../config/clock');
const errors = require('./errors');
const money = require('./money');
const auditService = require('./auditService');
const customerRepository = require('../repositories/customerRepository');
const creditRepository = require('../repositories/creditRepository');

const TYPES = Object.freeze(['WALK_IN', 'RETAIL', 'REGULAR', 'WHOLESALE', 'DEALER', 'FARM']);
const PRICE_LEVELS = Object.freeze(['RETAIL', 'WHOLESALE', 'DEALER']);

const text = (value, { max = 200 } = {}) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// ── Validation (VR-301, VR-302) ─────────────────────────────────────────────

function validateName(name) {
  const trimmed = text(name, { max: 120 });
  if (trimmed.length < 2 || trimmed.length > 120) {
    throw errors.badRequest('A customer name is 2 to 120 characters', { ruleId: 'VR-301' });
  }
  return trimmed;
}

/**
 * VR-302 — a Philippine mobile or landline, where one is given.
 *
 * Mobile: 09xx xxx xxxx, or +639xx xxx xxxx. Landline: an area code of 2 to 4 digits
 * and a 6 to 8 digit subscriber number, optionally with the (02) style parentheses.
 * Spaces, dashes and parentheses are how people actually write these down, so they are
 * stripped rather than refused — a validator that rejects "0917 123 4567" teaches the
 * counter to leave the field empty, which is worse than a loose pattern.
 */
const MOBILE = /^(?:\+?63|0)9\d{9}$/;
const LANDLINE = /^(?:\+?63)?\d{2,4}\d{6,8}$/;

function validateContact(contact) {
  const raw = text(contact, { max: 40 });
  if (!raw) return null;

  const digits = raw.replace(/[\s()\-.]/g, '');
  if (!MOBILE.test(digits) && !LANDLINE.test(digits)) {
    throw errors.badRequest(
      'That does not look like a Philippine mobile or landline number. '
      + 'A mobile is 09xx xxx xxxx; a landline is its area code and number.',
      { ruleId: 'VR-302' }
    );
  }
  return raw;
}

function validateType(type) {
  const value = text(type, { max: 20 }).toUpperCase() || 'RETAIL';
  if (!TYPES.includes(value)) {
    throw errors.badRequest(`Customer type must be one of ${TYPES.join(', ')}`, { ruleId: 'VR-301' });
  }
  return value;
}

function validatePriceLevel(level) {
  const value = text(level, { max: 20 }).toUpperCase() || 'RETAIL';
  if (!PRICE_LEVELS.includes(value)) {
    throw errors.badRequest(`Price level must be one of ${PRICE_LEVELS.join(', ')}`, { ruleId: 'PR-101' });
  }
  return value;
}

function assertCodeFree(code, { exceptId = null } = {}) {
  if (!code) return;
  const existing = customerRepository.findByCode(code);
  if (existing && existing.id !== exceptId) {
    throw errors.conflict(`The customer code "${code}" is already in use`, { ruleId: 'VR-301' });
  }
}

// ── The public shape ────────────────────────────────────────────────────────

function toPublic(row, { credit = null } = {}) {
  if (!row) return null;
  const customer = {
    id: row.id,
    code: row.code,
    name: row.name,
    contact_no: row.contact_no,
    address: row.address,
    customer_type: row.customer_type,
    price_level: row.price_level,
    is_credit_eligible: Boolean(row.is_credit_eligible),
    is_active: Boolean(row.is_active),
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (credit) customer.credit = credit;
  return customer;
}

// ── Reading ─────────────────────────────────────────────────────────────────

function get(id, { withCredit = true } = {}) {
  const row = customerRepository.findById(id);
  if (!row) throw errors.notFound('No such customer');
  // Required lazily: creditService reads customers, so importing it at module load
  // would close the cycle. This is the only direction that needs it.
  const creditService = require('./creditService');
  return toPublic(row, { credit: withCredit ? creditService.summaryFor(row) : null });
}

function find(id) {
  return customerRepository.findById(id);
}

function search(opts = {}) {
  const term = opts.q === null || opts.q === undefined ? null : text(opts.q, { max: 60 });
  const filters = {
    q: term || null,
    includeInactive: Boolean(opts.includeInactive),
    creditOnly: Boolean(opts.creditOnly),
  };
  const limit = Math.min(Math.max(Number.parseInt(opts.limit, 10) || 50, 1), 200);
  const offset = Math.max(Number.parseInt(opts.offset, 10) || 0, 0);
  const creditService = require('./creditService');

  return {
    total: customerRepository.countSearch(filters),
    limit,
    offset,
    customers: customerRepository.search({ ...filters, limit, offset })
      .map((row) => toPublic(row, { credit: creditService.summaryFor(row) })),
  };
}

// ── Writing ─────────────────────────────────────────────────────────────────

/**
 * Create a customer, and the credit account where they are credit-eligible.
 *
 * VR-303: a credit-eligible customer **must** have a limit and terms, so the account
 * is created in the same transaction rather than left to a second screen. A customer
 * marked eligible with no account is a credit tender that fails at the counter for a
 * reason nobody can see.
 */
function create(input, actor) {
  const at = clock.nowUtc();
  const name = validateName(input.name);
  const code = text(input.code, { max: 30 }).toUpperCase() || null;
  const contact = validateContact(input.contactNo);
  const type = validateType(input.customerType);
  const priceLevel = validatePriceLevel(input.priceLevel);
  const eligible = Boolean(input.isCreditEligible);

  assertCodeFree(code);

  // A walk-in is the anonymous counter customer; CR-102 says one may not buy on credit,
  // so the two flags cannot both be set.
  if (eligible && type === 'WALK_IN') {
    throw errors.badRequest(
      'A walk-in customer cannot be credit-eligible. Register them properly to give them credit.',
      { ruleId: 'CR-102' }
    );
  }

  const creditService = require('./creditService');
  const terms = eligible ? creditService.validateTerms(input.termsDays) : 0;
  const limit = eligible ? creditService.validateLimit(input.creditLimitCentavos) : 0;

  return db.transaction(() => {
    const row = customerRepository.insert({
      id: ids.uuidv7(),
      code,
      name,
      contact_no: contact,
      address: text(input.address, { max: 200 }) || null,
      customer_type: type,
      price_level: priceLevel,
      is_credit_eligible: eligible ? 1 : 0,
      is_active: 1,
      notes: text(input.notes, { max: 500 }) || null,
      created_at: at,
      created_by: actor.id || null,
    });

    if (eligible) {
      creditService.openAccount(row.id, { limitCentavos: limit, termsDays: terms, at });
    }

    auditService.write({
      actor,
      action: 'CUSTOMER_CREATED',
      entityType: 'customers',
      entityId: row.id,
      after: {
        name: row.name, code: row.code, customer_type: type, price_level: priceLevel,
        is_credit_eligible: eligible, credit_limit_centavos: limit, terms_days: terms,
      },
    });

    return get(row.id);
  });
}

function update(id, changes, actor) {
  const current = customerRepository.findById(id);
  if (!current) throw errors.notFound('No such customer');

  const creditService = require('./creditService');
  const fields = {};
  const before = {};
  const after = {};

  const move = (column, value) => {
    if (current[column] === value) return;
    fields[column] = value;
    before[column] = current[column];
    after[column] = value;
  };

  if (changes.name !== undefined) move('name', validateName(changes.name));
  if (changes.code !== undefined) {
    const code = text(changes.code, { max: 30 }).toUpperCase() || null;
    assertCodeFree(code, { exceptId: id });
    move('code', code);
  }
  if (changes.contactNo !== undefined) move('contact_no', validateContact(changes.contactNo));
  if (changes.address !== undefined) move('address', text(changes.address, { max: 200 }) || null);
  if (changes.customerType !== undefined) move('customer_type', validateType(changes.customerType));
  if (changes.priceLevel !== undefined) move('price_level', validatePriceLevel(changes.priceLevel));
  if (changes.notes !== undefined) move('notes', text(changes.notes, { max: 500 }) || null);

  if (changes.isCreditEligible !== undefined) {
    const eligible = Boolean(changes.isCreditEligible);
    if (eligible && current.customer_type === 'WALK_IN') {
      throw errors.badRequest('A walk-in customer cannot be credit-eligible.', { ruleId: 'CR-102' });
    }
    if (!eligible) assertNoBalance(id, 'withdraw credit from');
    move('is_credit_eligible', eligible ? 1 : 0);
  }

  if (changes.isActive !== undefined) {
    if (!changes.isActive) assertNoBalance(id, 'deactivate');
    move('is_active', changes.isActive ? 1 : 0);
  }

  if (Object.keys(fields).length === 0) return get(id);

  const at = clock.nowUtc();
  fields.updated_at = at;
  fields.updated_by = actor.id || null;

  return db.transaction(() => {
    customerRepository.updateFields(id, fields);

    // Becoming eligible needs an account, with the limit and terms VR-303 requires.
    if (after.is_credit_eligible === 1 && !creditRepository.findAccountByCustomer(id)) {
      creditService.openAccount(id, {
        limitCentavos: creditService.validateLimit(changes.creditLimitCentavos),
        termsDays: creditService.validateTerms(changes.termsDays),
        at,
      });
    }

    auditService.write({
      actor,
      action: changes.isActive === false ? 'CUSTOMER_DEACTIVATED' : 'CUSTOMER_MODIFIED',
      entityType: 'customers',
      entityId: id,
      before,
      after,
    });

    return get(id);
  });
}

/**
 * VR-305 — a customer with a non-zero balance may not be deactivated.
 *
 * Either direction: an outstanding debt would disappear from every screen that filters
 * to active customers, and a store credit the customer is owed (CR-108) would too.
 */
function assertNoBalance(customerId, verb) {
  const account = creditRepository.findAccountByCustomer(customerId);
  if (!account || account.balance_centavos === 0) return;

  const owed = account.balance_centavos > 0;
  throw errors.conflict(
    owed
      ? `This customer still owes ${money.toDisplay(account.balance_centavos)}. `
        + `Collect or write off the balance before you ${verb} them.`
      : `This customer holds ${money.toDisplay(-account.balance_centavos)} in store credit. `
        + `Settle it before you ${verb} them.`,
    { ruleId: 'VR-305' }
  );
}

/** VR-304 — deactivation is the only removal for a customer who has transacted. */
function deactivate(id, actor) {
  return update(id, { isActive: false }, actor);
}

function assertDeletable(id) {
  const transactions = customerRepository.transactionCount(id);
  if (transactions > 0) {
    throw errors.conflict(
      `This customer has ${transactions} transaction${transactions === 1 ? '' : 's'} on record and `
      + 'cannot be deleted. Deactivate them instead.',
      { ruleId: 'VR-304' }
    );
  }
}

module.exports = {
  TYPES, PRICE_LEVELS,
  validateName, validateContact, validateType, validatePriceLevel,
  toPublic, get, find, search, create, update, deactivate,
  assertNoBalance, assertDeletable,
};
