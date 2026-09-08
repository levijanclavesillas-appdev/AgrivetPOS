'use strict';

// FR_2.1 / FR_2.2 — the catalog, built around one immutable base unit per product.
//
// The rule this file exists to enforce is UOM-001: stock on hand, every movement,
// average cost, valuation and every report are expressed in the base unit, and there
// is no second inventory figure. "10 sacks" is not a quantity here; it is 500 KG and
// a pack whose factor is 50,000 (UOM-002). legacy/PRD_v1.1.md §16 fixed the sack at
// 50 KG without ever saying which of the two the ledger held, which is how a store
// ends up with two different true answers to "how much feed is there".
//
// UOM-003 then freezes the base unit the moment a movement exists, because changing
// it does not convert history — it silently reinterprets it.

const db = require('../config/database');
const ids = require('../config/ids');
const clock = require('../config/clock');
const errors = require('./errors');
const quantity = require('./quantity');
const auditService = require('./auditService');
const permissions = require('./permissions');
const productRepository = require('../repositories/productRepository');
const referenceRepository = require('../repositories/referenceRepository');

const TAX_CLASSES = Object.freeze(['VATABLE', 'VAT_EXEMPT', 'ZERO_RATED']);
const PRICE_LEVELS = Object.freeze(['RETAIL', 'WHOLESALE', 'DEALER']);

const text = (value, { max = 200 } = {}) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// ── Validation (VR-201..VR-209) ─────────────────────────────────────────────

function validateSku(sku) {
  const trimmed = text(sku, { max: 40 }).toUpperCase();
  if (trimmed.length < 1) throw errors.badRequest('A SKU is required', { ruleId: 'VR-201' });
  if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(trimmed)) {
    throw errors.badRequest('A SKU is letters, digits, dot, dash or underscore', { ruleId: 'VR-201' });
  }
  return trimmed;
}

function validateName(name) {
  const trimmed = text(name, { max: 120 });
  if (trimmed.length < 2 || trimmed.length > 120) {
    throw errors.badRequest('A product name is 2 to 120 characters', { ruleId: 'VR-202' });
  }
  return trimmed;
}

function validateTaxClass(taxClass) {
  // VR-208 / TAX-003: required in *every* tax mode, not only VAT. The column is
  // populated in NONE and NON_VAT too, so switching mode is configuration rather than
  // a migration that has to invent a tax class for every existing product.
  const value = text(taxClass, { max: 20 }).toUpperCase() || 'VATABLE';
  if (!TAX_CLASSES.includes(value)) {
    throw errors.badRequest(`Tax class must be one of ${TAX_CLASSES.join(', ')}`, { ruleId: 'VR-208' });
  }
  return value;
}

/** VR-203, VR-204: money and quantity are non-negative integers, never floats. */
function validateCentavos(value, what, ruleId) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isInteger(n) || n < 0) {
    throw errors.badRequest(`${what} must be a whole number of centavos, zero or more`, { ruleId });
  }
  return n;
}

function validateMilli(value, what, ruleId) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isInteger(n) || n < 0) {
    throw errors.badRequest(`${what} must be a whole number of thousandths, zero or more`, { ruleId });
  }
  return n;
}

function assertExists(kind, id, what) {
  if (!id) throw errors.badRequest(`${what} is required`, { ruleId: 'VR-209' });
  const row = referenceRepository.findById(kind, id);
  if (!row) throw errors.badRequest(`No such ${what.toLowerCase()}`, { ruleId: 'VR-209' });
  if (!row.is_active) {
    throw errors.badRequest(`That ${what.toLowerCase()} is inactive`, { ruleId: 'VR-209' });
  }
  return row;
}

// ── Barcodes (VR-205) ───────────────────────────────────────────────────────

/**
 * GS1 reserves prefixes 02 and 20–29 for **restricted distribution and variable
 * measure** items — the in-store labels a deli scale prints, where digits that look
 * like part of the item number are actually a weight or a price.
 *
 * VR-205 puts these out of scope for v1.0 and requires them to be *rejected with a
 * clear message rather than misread*. That wording is the whole point: treated as a
 * plain code, every kilo of the same product scans as a different product, and the
 * catalog silently fills with one-off items nobody created.
 */
const VARIABLE_MEASURE_PREFIX = /^(02|2[0-9])/;

function classifyBarcode(raw) {
  const barcode = text(raw, { max: 48 }).replace(/\s+/g, '');

  if (barcode.length < 4) {
    return { ok: false, reason: 'A barcode is at least 4 characters.', ruleId: 'VR-205' };
  }
  if (!/^[0-9A-Za-z._-]+$/.test(barcode)) {
    return { ok: false, reason: 'A barcode is letters, digits, dot, dash or underscore.', ruleId: 'VR-205' };
  }
  if (/^\d{13}$/.test(barcode) && VARIABLE_MEASURE_PREFIX.test(barcode)) {
    return {
      ok: false,
      variableMeasure: true,
      ruleId: 'VR-205',
      reason:
        'This is a weight-embedded barcode — the kind a scale prints, where part of the '
        + 'number is the weight. Chachi Agrivet POS cannot read those yet, and storing it as '
        + 'an ordinary code would make every weighing scan as a different product. Use the '
        + "product's own barcode, or search for it by name.",
    };
  }
  return { ok: true, barcode };
}

function validateBarcode(raw) {
  const result = classifyBarcode(raw);
  if (!result.ok) throw errors.badRequest(result.reason, { ruleId: result.ruleId });
  return result.barcode;
}

// ── The public shape (TX-412, requirement 7) ────────────────────────────────

/**
 * A product as it leaves the server.
 *
 * Cost is **absent** for a session without TX-412, not null and not zero: 04_UX_SPEC.md
 * §3 says the field is absent rather than disabled, and a null would tell a cashier
 * there is a cost field they are not allowed to see, which is a different statement
 * from the one the rule makes. A caller with no session at all is treated as having no
 * grant — the safe direction.
 */
function toPublic(row, session = null, { barcodes = null, packs = null, prices = null } = {}) {
  if (!row) return null;
  const maySeeCost = Boolean(session) && permissions.can(session, 'TX-412');

  const product = {
    id: row.id,
    sku: row.sku,
    name: row.name,
    category: { id: row.category_id, name: row.category_name },
    brand: row.brand_id ? { id: row.brand_id, name: row.brand_name } : null,
    base_unit: {
      id: row.base_unit_id,
      code: row.base_unit_code,
      name: row.base_unit_name,
      allows_fraction: Boolean(row.base_unit_allows_fraction),
    },
    description: row.description,
    tax_class: row.tax_class,
    statutory_discount_eligible: Boolean(row.statutory_discount_eligible),
    min_stock_milli: row.min_stock_milli,
    min_stock_display: quantity.format(row.min_stock_milli, row.base_unit_code),
    // INV-101: read from the materialised figure the ledger maintains, never computed
    // here. SCR-201's list column, and what INV-109 is measured against.
    qty_on_hand_milli: row.qty_on_hand_milli ?? 0,
    qty_on_hand_display: quantity.format(row.qty_on_hand_milli ?? 0, row.base_unit_code),
    has_moved: Boolean(row.has_moved),
    // UOM-003: the base unit is immutable once anything has moved. Surfaced so the
    // editor can lock the field and say why, rather than discovering it at save.
    base_unit_locked: Boolean(row.has_moved),
    is_low_stock: Boolean(row.is_active) && row.min_stock_milli > 0
      && (row.qty_on_hand_milli ?? 0) <= row.min_stock_milli,
    is_batch_tracked: Boolean(row.is_batch_tracked),
    is_active: Boolean(row.is_active),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };

  if (maySeeCost) {
    product.avg_cost_centavos = row.avg_cost_centavos;
    product.avg_cost_as_of = row.avg_cost_as_of;
  }

  if (barcodes) product.barcodes = barcodes.map((b) => ({ id: b.id, barcode: b.barcode }));
  if (packs) {
    product.packs = packs.map((p) => ({
      id: p.id,
      unit: { id: p.unit_id, code: p.unit_code, name: p.unit_name },
      factor_milli: p.factor_milli,
      is_default_sell: Boolean(p.is_default_sell),
    }));
  }
  if (prices) product.prices = prices;

  return product;
}

/** The whole product, as SCR-202's five tabs need it. */
function detail(row, session, { at = clock.nowUtc() } = {}) {
  const prices = productRepository.currentPrices(row.id, at);
  return toPublic(row, session, {
    barcodes: productRepository.barcodesFor(row.id),
    packs: productRepository.packsFor(row.id),
    prices: {
      RETAIL: prices.RETAIL ? prices.RETAIL.price_centavos : null,
      WHOLESALE: prices.WHOLESALE ? prices.WHOLESALE.price_centavos : null,
      DEALER: prices.DEALER ? prices.DEALER.price_centavos : null,
      effective: Object.fromEntries(
        PRICE_LEVELS.map((level) => [level, prices[level] ? prices[level].effective_from : null])
      ),
    },
  });
}

// ── Price resolution (PR-101 levels 3–4, PR-102) ────────────────────────────

/**
 * The price a level actually charges — PR-101's precedence and PR-102's fall-through.
 *
 * Delegated to pricingService, which owns the four-level chain (TASK-009). This
 * signature stays because the catalog screens call it with a level rather than a
 * customer, but there is exactly one resolver in the product: two would drift, and the
 * day they disagreed the counter and the report would each be sure they were right.
 */
function resolvePrice(productId, level = 'RETAIL', { at = clock.nowUtc() } = {}) {
  const pricingService = require('./pricingService');
  const wanted = text(level, { max: 20 }).toUpperCase() || 'RETAIL';
  const resolved = pricingService.resolvePrice({
    productId, customer: { price_level: wanted }, at,
  });
  return { ...resolved, level: resolved.requested_level };
}

function isSellable(productId, { at = clock.nowUtc() } = {}) {
  return Boolean(productRepository.priceAt(productId, 'RETAIL', at));
}

// ── Reading ─────────────────────────────────────────────────────────────────

function get(id, session) {
  const row = productRepository.findById(id);
  if (!row) throw errors.notFound('No such product');
  return detail(row, session);
}

function search({ q = null, categoryId = null, includeInactive = false, limit = 50, offset = 0 } = {}, session) {
  const term = q === null || q === undefined ? null : text(q, { max: 60 });
  const filters = { q: term || null, categoryId: categoryId || null, includeInactive };
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const skip = Math.max(Number.parseInt(offset, 10) || 0, 0);

  const rows = productRepository.search({ ...filters, limit: size, offset: skip });
  const at = clock.nowUtc();

  return {
    total: productRepository.countSearch(filters),
    limit: size,
    offset: skip,
    products: rows.map((row) => {
      const product = toPublic(row, session);
      const retail = productRepository.priceAt(row.id, 'RETAIL', at);
      product.retail_price_centavos = retail ? retail.price_centavos : null;
      product.is_sellable = Boolean(retail);
      return product;
    }),
  };
}

/**
 * A scan (FR_3.1, NFR_1.2).
 *
 * TC-INT-30: an unknown barcode is **not** a 404 the UI swallows. The counter has the
 * physical item in hand and the useful answer is "attach this code to a product" —
 * so an unknown-but-valid code comes back as an offer, and only a code this version
 * cannot read at all is refused.
 */
function findByBarcode(rawCode, session) {
  const classified = classifyBarcode(rawCode);

  if (!classified.ok) {
    // A weight-embedded code is a refusal, not an attach-offer: attaching it would
    // bind one weighing's label to a product forever.
    throw errors.badRequest(classified.reason, { ruleId: classified.ruleId });
  }

  const row = productRepository.findByBarcode(classified.barcode);
  if (row) return { found: true, product: detail(row, session), barcode: classified.barcode };

  return {
    found: false,
    barcode: classified.barcode,
    // What the renderer needs to offer the attach without a second round trip.
    offer: {
      action: 'ATTACH_BARCODE',
      message: 'That barcode is not in the catalog yet. Search for the product and attach it.',
      rule_id: 'VR-205',
    },
  };
}

// ── Writing ─────────────────────────────────────────────────────────────────

/**
 * Create a product, with its first prices, barcodes and packs, in one transaction.
 *
 * Retail is required at creation (PR-102). A product that exists but cannot be sold is
 * a trap: it is findable, scannable and refuses at the counter, in front of a customer.
 */
function create(input, actor, session = actor) {
  const at = clock.nowUtc();
  const sku = validateSku(input.sku);
  const name = validateName(input.name);
  const taxClass = validateTaxClass(input.taxClass);

  if (productRepository.findBySku(sku)) {
    throw errors.conflict(`The SKU "${sku}" is already used by another product`, { ruleId: 'VR-201' });
  }

  const category = assertExists('categories', input.categoryId, 'Category');
  const baseUnit = assertExists('units', input.baseUnitId, 'Base unit');
  if (input.brandId) assertExists('brands', input.brandId, 'Brand');

  const retail = validateCentavos(input.retailPriceCentavos, 'The retail price', 'VR-203');
  const minStock = input.minStockMilli === undefined ? 0 : validateMilli(input.minStockMilli, 'Minimum stock', 'VR-204');
  const avgCost = input.avgCostCentavos === undefined ? 0 : validateCentavos(input.avgCostCentavos, 'The average cost', 'VR-203');

  if (avgCost > 0) assertMayChangeCost(session);

  const barcodes = (input.barcodes || []).map(validateBarcode);
  const packs = (input.packs || []).map((pack) => normalisePack(pack, baseUnit));

  return db.transaction(() => {
    const row = productRepository.insert({
      id: ids.uuidv7(),
      sku,
      name,
      category_id: category.id,
      brand_id: input.brandId || null,
      base_unit_id: baseUnit.id,
      description: text(input.description, { max: 500 }) || null,
      tax_class: taxClass,
      statutory_discount_eligible: input.statutoryDiscountEligible ? 1 : 0,
      avg_cost_centavos: avgCost,
      avg_cost_as_of: avgCost > 0 ? at : null,
      min_stock_milli: minStock,
      is_batch_tracked: input.isBatchTracked ? 1 : 0,
      is_active: 1,
      created_at: at,
      created_by: actor.id || null,
    });

    for (const barcode of barcodes) attachBarcodeRow(row.id, barcode, at);
    for (const pack of packs) addPackRow(row.id, pack, at);
    writePrice(row.id, 'RETAIL', retail, { at, actor });

    for (const level of ['WHOLESALE', 'DEALER']) {
      const key = `${level.toLowerCase()}PriceCentavos`;
      if (input[key] === undefined || input[key] === null || input[key] === '') continue;
      writePrice(row.id, level, validateCentavos(input[key], `The ${level.toLowerCase()} price`, 'VR-203'), { at, actor });
    }

    auditService.write({
      actor,
      action: 'PRODUCT_CREATED',
      entityType: 'products',
      entityId: row.id,
      after: { sku, name, category: category.name, base_unit: baseUnit.code, tax_class: taxClass, retail_price_centavos: retail },
    });

    return detail(productRepository.findById(row.id), session, { at });
  });
}

/**
 * Change a product. Identity, units, stock threshold and status here; prices and cost
 * have their own paths, because TX-411 and TX-412 are not TX-410.
 */
function update(id, changes, actor, session = actor) {
  const current = productRepository.findById(id);
  if (!current) throw errors.notFound('No such product');

  const at = clock.nowUtc();
  const fields = {};
  const before = {};
  const after = {};

  const move = (column, value, label = column) => {
    if (current[column] === value) return;
    fields[column] = value;
    before[label] = current[column];
    after[label] = value;
  };

  if (changes.sku !== undefined) {
    const sku = validateSku(changes.sku);
    const clash = productRepository.findBySku(sku);
    if (clash && clash.id !== id) {
      throw errors.conflict(`The SKU "${sku}" is already used by another product`, { ruleId: 'VR-201' });
    }
    move('sku', sku);
  }
  if (changes.name !== undefined) move('name', validateName(changes.name));
  if (changes.description !== undefined) move('description', text(changes.description, { max: 500 }) || null);
  if (changes.taxClass !== undefined) move('tax_class', validateTaxClass(changes.taxClass));
  if (changes.statutoryDiscountEligible !== undefined) {
    move('statutory_discount_eligible', changes.statutoryDiscountEligible ? 1 : 0);
  }
  if (changes.isBatchTracked !== undefined) move('is_batch_tracked', changes.isBatchTracked ? 1 : 0);
  if (changes.minStockMilli !== undefined) {
    move('min_stock_milli', validateMilli(changes.minStockMilli, 'Minimum stock', 'VR-204'));
  }
  if (changes.categoryId !== undefined) move('category_id', assertExists('categories', changes.categoryId, 'Category').id);
  if (changes.brandId !== undefined) {
    move('brand_id', changes.brandId ? assertExists('brands', changes.brandId, 'Brand').id : null);
  }
  if (changes.baseUnitId !== undefined) {
    const unit = assertExists('units', changes.baseUnitId, 'Base unit');
    if (unit.id !== current.base_unit_id) assertBaseUnitChangeable(id);
    move('base_unit_id', unit.id);
  }
  if (changes.isActive !== undefined) move('is_active', changes.isActive ? 1 : 0);

  if (Object.keys(fields).length === 0) return detail(current, session, { at });

  fields.updated_at = at;
  fields.updated_by = actor.id || null;

  return db.transaction(() => {
    const updated = productRepository.updateFields(id, fields);
    auditService.write({
      actor,
      action: changes.isActive === false ? 'PRODUCT_DEACTIVATED' : 'PRODUCT_MODIFIED',
      entityType: 'products',
      entityId: id,
      before,
      after,
    });
    return detail(updated, session, { at });
  });
}

/**
 * UOM-003 — the base unit is immutable once any inventory movement exists.
 *
 * Not a convenience restriction. Changing KG to SACK does not convert the 4,500 that
 * is already in the ledger; it reinterprets four and a half tonnes of feed as four and
 * a half thousand sacks. The correction path the rule gives is a new product and a
 * transfer adjustment, and the message says so, because a refusal the operator cannot
 * act on just gets worked around.
 */
function assertBaseUnitChangeable(productId) {
  const movements = productRepository.countMovements(productId);
  if (movements === 0) return;

  throw errors.conflict(
    `This product has ${movements} stock movement${movements === 1 ? '' : 's'} recorded, so its `
    + 'base unit is fixed. Every movement, the average cost and every report are expressed in it, '
    + 'and changing it now would silently reinterpret all of them. To correct it, create a new '
    + 'product with the right unit and move the stock across with an adjustment.',
    { ruleId: 'UOM-003' }
  );
}

/**
 * VR-206: a product referenced by history is deactivated, never deleted. There is no
 * delete path in this service at all — the absence is the control, as with AUD-605.
 */
function deactivate(id, actor, session = actor) {
  return update(id, { isActive: false }, actor, session);
}

// ── Barcodes ────────────────────────────────────────────────────────────────

function attachBarcodeRow(productId, barcode, at) {
  const existing = productRepository.findBarcode(barcode);
  if (existing) {
    // Globally unique across products (VR-205): the same physical code cannot mean two
    // things at one counter.
    throw errors.conflict(
      existing.product_id === productId
        ? 'That barcode is already on this product.'
        : 'That barcode is already attached to another product.',
      { ruleId: 'VR-205' }
    );
  }
  return productRepository.insertBarcode({
    id: ids.uuidv7(), product_id: productId, barcode, created_at: at,
  });
}

function attachBarcode(productId, rawCode, actor) {
  const product = productRepository.findById(productId);
  if (!product) throw errors.notFound('No such product');
  const barcode = validateBarcode(rawCode);
  const at = clock.nowUtc();

  return db.transaction(() => {
    attachBarcodeRow(productId, barcode, at);
    auditService.write({
      actor,
      action: 'BARCODE_ATTACHED',
      entityType: 'products',
      entityId: productId,
      after: { barcode },
    });
    return productRepository.barcodesFor(productId).map((b) => ({ id: b.id, barcode: b.barcode }));
  });
}

function detachBarcode(productId, barcodeId, actor) {
  const rows = productRepository.barcodesFor(productId);
  const row = rows.find((b) => b.id === barcodeId);
  if (!row) throw errors.notFound('No such barcode on this product');

  return db.transaction(() => {
    productRepository.deleteBarcode(barcodeId);
    auditService.write({
      actor,
      action: 'BARCODE_DETACHED',
      entityType: 'products',
      entityId: productId,
      before: { barcode: row.barcode },
    });
    return productRepository.barcodesFor(productId).map((b) => ({ id: b.id, barcode: b.barcode }));
  });
}

// ── Packs (UOM-002, VR-207) ─────────────────────────────────────────────────

function normalisePack(pack, baseUnit) {
  const unit = assertExists('units', pack.unitId, 'Pack unit');
  if (unit.id === baseUnit.id) {
    throw errors.badRequest(
      `A pack cannot be in the base unit itself. ${baseUnit.code} is already how stock is counted.`,
      { ruleId: 'UOM-002' }
    );
  }

  // VR-207: positive and non-zero. A factor of 0 makes one sack equal no kilos, and
  // every sale of it would deduct nothing while taking the customer's money.
  const factor = typeof pack.factorMilli === 'number'
    ? pack.factorMilli
    : Number.parseInt(String(pack.factorMilli ?? '').trim(), 10);

  if (!Number.isInteger(factor) || factor <= 0) {
    throw errors.badRequest(
      `A pack factor is a positive whole number of thousandths of ${baseUnit.code}. `
      + `One ${unit.code} of 50 ${baseUnit.code} is 50000.`,
      { ruleId: 'VR-207' }
    );
  }

  return { unitId: unit.id, unitCode: unit.code, factorMilli: factor, isDefaultSell: Boolean(pack.isDefaultSell) };
}

function addPackRow(productId, pack, at) {
  const existing = productRepository.packsFor(productId);
  if (existing.some((p) => p.unit_id === pack.unitId)) {
    throw errors.conflict(`This product already has a ${pack.unitCode} pack`, { ruleId: 'UOM-002' });
  }
  if (pack.isDefaultSell) productRepository.clearDefaultPack(productId);

  return productRepository.insertPack({
    id: ids.uuidv7(),
    product_id: productId,
    unit_id: pack.unitId,
    factor_milli: pack.factorMilli,
    is_default_sell: pack.isDefaultSell ? 1 : 0,
    created_at: at,
  });
}

function addPack(productId, input, actor) {
  const product = productRepository.findById(productId);
  if (!product) throw errors.notFound('No such product');

  const baseUnit = referenceRepository.findById('units', product.base_unit_id);
  const pack = normalisePack(input, baseUnit);
  const at = clock.nowUtc();

  return db.transaction(() => {
    addPackRow(productId, pack, at);
    auditService.write({
      actor,
      action: 'PRODUCT_MODIFIED',
      entityType: 'products',
      entityId: productId,
      after: { pack_unit: pack.unitCode, factor_milli: pack.factorMilli },
      reason: `Pack added: 1 ${pack.unitCode} = ${quantity.format(pack.factorMilli, baseUnit.code)}`,
    });
    return productRepository.packsFor(productId);
  });
}

function removePack(productId, packId, actor) {
  const packs = productRepository.packsFor(productId);
  const pack = packs.find((p) => p.id === packId);
  if (!pack) throw errors.notFound('No such pack on this product');

  return db.transaction(() => {
    productRepository.deletePack(packId);
    auditService.write({
      actor,
      action: 'PRODUCT_MODIFIED',
      entityType: 'products',
      entityId: productId,
      before: { pack_unit: pack.unit_code, factor_milli: pack.factor_milli },
      reason: 'Pack removed',
    });
    return productRepository.packsFor(productId);
  });
}

// ── Prices (TX-411) and cost (TX-412) ───────────────────────────────────────

function writePrice(productId, level, priceCentavos, { at, actor, effectiveFrom = null }) {
  return productRepository.insertPrice({
    id: ids.uuidv7(),
    product_id: productId,
    price_level: level,
    price_centavos: priceCentavos,
    // A price row is never updated — a new row supersedes the old, so the history of
    // what this product cost on any past day survives (MON-005's reasoning, applied to
    // the price list rather than to the sale line).
    effective_from: effectiveFrom || at,
    created_at: at,
    created_by: actor.id || null,
  });
}

/**
 * Set one or more price levels. TX-411, which a manager holds and an inventory clerk
 * does not — TX-410 lets them create the product, not decide what it sells for.
 */
function setPrices(productId, levels, actor, session = actor, { effectiveFrom = null, reason = null } = {}) {
  const product = productRepository.findById(productId);
  if (!product) throw errors.notFound('No such product');

  const at = clock.nowUtc();
  const wanted = Object.keys(levels).map((level) => text(level, { max: 20 }).toUpperCase());
  for (const level of wanted) {
    if (!PRICE_LEVELS.includes(level)) {
      throw errors.badRequest(`Price level must be one of ${PRICE_LEVELS.join(', ')}`, { ruleId: 'PR-101' });
    }
  }

  const stamp = effectiveFrom || at;
  const changes = [];

  for (const level of wanted) {
    const raw = levels[level] ?? levels[level.toLowerCase()];
    const price = validateCentavos(raw, `The ${level.toLowerCase()} price`, 'VR-203');
    const currentRow = productRepository.priceAt(productId, level, at);
    if (currentRow && currentRow.price_centavos === price) continue;
    changes.push({ level, price, before: currentRow ? currentRow.price_centavos : null });
  }

  if (changes.length === 0) return detail(product, session, { at });

  return db.transaction(() => {
    for (const change of changes) {
      writePrice(productId, change.level, change.price, { at, actor, effectiveFrom: stamp });
      auditService.write({
        actor,
        action: 'PRICE_CHANGED',
        entityType: 'products',
        entityId: productId,
        before: { [change.level]: change.before },
        after: { [change.level]: change.price },
        reason: reason || `${change.level} price changed`,
      });
    }
    return detail(productRepository.findById(productId), session, { at });
  });
}

function assertMayChangeCost(session) {
  if (session && permissions.can(session, 'TX-412')) return;
  throw errors.forbidden(
    'Only the owner may see or change a product cost.',
    { ruleId: 'TX-412', requiresRole: 'OWNER' }
  );
}

/**
 * Set the average cost by hand.
 *
 * TASK-007 maintains this figure automatically from receipts (MON-004), and that is
 * the path a running store uses. This one exists for the opening load and for a
 * correction, both of which are owner-only and audited, because the cost is what every
 * margin figure in the product is measured against.
 */
function setCost(productId, avgCostCentavos, actor, session = actor, { reason = null } = {}) {
  assertMayChangeCost(session);

  const product = productRepository.findById(productId);
  if (!product) throw errors.notFound('No such product');

  const cost = validateCentavos(avgCostCentavos, 'The average cost', 'VR-203');
  if (cost === product.avg_cost_centavos) return detail(product, session);

  const at = clock.nowUtc();
  return db.transaction(() => {
    const updated = productRepository.updateFields(productId, {
      avg_cost_centavos: cost, avg_cost_as_of: at, updated_at: at, updated_by: actor.id || null,
    });
    auditService.write({
      actor,
      action: 'COST_CHANGED',
      entityType: 'products',
      entityId: productId,
      before: { avg_cost_centavos: product.avg_cost_centavos },
      after: { avg_cost_centavos: cost },
      reason: reason || 'Average cost set manually',
    });
    return detail(updated, session, { at });
  });
}

module.exports = {
  TAX_CLASSES, PRICE_LEVELS,
  validateSku, validateName, validateTaxClass, validateBarcode, classifyBarcode,
  toPublic, detail, resolvePrice, isSellable,
  get, search, findByBarcode,
  create, update, deactivate, assertBaseUnitChangeable,
  attachBarcode, detachBarcode, addPack, removePack, normalisePack,
  setPrices, setCost, assertMayChangeCost,
};
