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
const permissions = require('./permissions');
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
// Split like `productService.createWithin` and for the same reason: `TASK-026`'s
// cutover load creates customers inside its own transaction (`OPS-103`), and §8.3
// makes a nested one an error rather than a savepoint.
function createWithin(input, actor) {
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
}

const create = (input, actor) => db.transaction(() => createWithin(input, actor));

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
// ── PR-103 — the negotiated price (TASK-024) ────────────────────────────────

/**
 * Set what this customer pays for these products.
 *
 * `PR-103` is absolute: a customer price overrides every other level for that pair,
 * including a quantity break, so a farm that negotiated ₱58 a kilo pays ₱58 whether
 * they buy one sack or forty. That absoluteness is why this needs `TX-411` — it is a
 * selling price, not a customer detail, and `TX-413`'s "create or edit a customer"
 * reaches a cashier who should not be agreeing prices.
 *
 * Appended, never updated: a new row with today's stamp supersedes yesterday's, and
 * the old one stays so a receipt from March remains explicable. Setting a price to
 * null removes it — a new row cannot say "no price", so removal is a deletion of the
 * agreement rather than a price of zero, which would give the product away.
 */
function setPrices(customerId, prices, actor, session = actor, { reason = null } = {}) {
  if (!permissions.can(session, 'TX-411')) {
    throw errors.forbidden(
      'You do not have permission to agree a customer price.',
      { ruleId: 'TX-411', requiresRole: permissions.rolesHolding('TX-411').join(' or ') }
    );
  }

  const customer = customerRepository.findById(customerId);
  if (!customer) throw errors.notFound('No such customer');

  const wanted = Array.isArray(prices) ? prices : [];
  if (wanted.length === 0) {
    throw errors.badRequest('Send at least one product and price', { ruleId: 'PR-103' });
  }

  const at = clock.nowUtc();
  const productRepository = require('../repositories/productRepository');

  const resolved = wanted.map((entry, index) => {
    const product = productRepository.findById(entry.productId);
    if (!product) throw errors.notFound(`No such product on line ${index + 1}`);

    const raw = entry.priceCentavos;
    const price = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? '').trim(), 10);
    if (!Number.isInteger(price) || price < 0) {
      throw errors.badRequest(
        `${product.name} needs a whole number of centavos (MON-001).`,
        { ruleId: 'VR-203' }
      );
    }

    // PR-105 is not enforced here — a negotiated price below cost is a decision an
    // owner may make, and the rule places the authorisation *at the sale*, where the
    // cost of the day applies. What this does is say so, so nobody agrees one by
    // accident and discovers it at the counter with a queue behind them.
    const belowCost = product.avg_cost_centavos > 0 && price < product.avg_cost_centavos;

    return {
      product,
      price_centavos: price,
      note: text(entry.note, { max: 200 }) || null,
      below_cost: belowCost,
      before: (productRepository.customerPriceAt(customerId, product.id, at) || {}).price_centavos ?? null,
    };
  });

  return db.transaction(() => {
    for (const entry of resolved) {
      productRepository.insertCustomerPrice({
        id: ids.uuidv7(),
        customer_id: customerId,
        product_id: entry.product.id,
        price_centavos: entry.price_centavos,
        effective_from: at,
        note: entry.note,
        created_at: at,
        created_by: actor.id,
      });

      // AUD-601 names a price change without exception, and both values.
      auditService.write({
        actor,
        action: 'PRICE_CHANGED',
        entityType: 'customers',
        entityId: customerId,
        before: { product: entry.product.name, price_centavos: entry.before },
        after: {
          product: entry.product.name,
          price_centavos: entry.price_centavos,
          // PR-103's own consequence, recorded: this price beats the quantity break.
          overrides_quantity_break: true,
          below_average_cost: entry.below_cost,
        },
        reason: reason || entry.note || `Customer price agreed for ${entry.product.name}`,
      });
    }

    return {
      ...priceList(customerId),
      // Said back to the caller so the screen can warn at the moment of agreeing
      // rather than at the moment of selling.
      below_cost: resolved.filter((e) => e.below_cost).map((e) => ({
        product: e.product.name,
        price_centavos: e.price_centavos,
        avg_cost_centavos: e.product.avg_cost_centavos,
        message: `${money.toDisplay(e.price_centavos)} is below the `
          + `${money.toDisplay(e.product.avg_cost_centavos)} average cost. Selling at it will need `
          + 'a manager or owner every time (PR-105).',
      })),
    };
  });
}

/** What this customer has negotiated, newest per product (`SCR-402`'s block). */
function priceList(customerId, { at = null } = {}) {
  const customer = customerRepository.findById(customerId);
  if (!customer) throw errors.notFound('No such customer');
  const productRepository = require('../repositories/productRepository');
  const when = at || clock.nowUtc();

  return {
    customer: { id: customer.id, name: customer.name, price_level: customer.price_level },
    rule_id: 'PR-103',
    // PR-103 stated where the list is shown, because "overrides everything" is the
    // part somebody setting one has to understand.
    note: 'A customer price overrides every other level for that product, including a '
      + 'quantity break, however much they buy.',
    prices: productRepository.customerPricesFor(customerId, when).map((row) => ({
      product_id: row.product_id,
      sku: row.sku,
      product_name: row.product_name,
      base_unit_code: row.base_unit_code,
      price_centavos: row.price_centavos,
      effective_from: row.effective_from,
      note: row.note,
    })),
  };
}

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
  setPrices, priceList,
  TYPES, PRICE_LEVELS,
  validateName, validateContact, validateType, validatePriceLevel,
  toPublic, get, find, search, create, createWithin, update, deactivate,
  assertNoBalance, assertDeletable,
};
