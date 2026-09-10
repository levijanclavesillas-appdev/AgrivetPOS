'use strict';

// FT-707 — the cutover. OPS-105, OPS-106, OPS-107.
//
// Hand entry works for a hundred and fifty products and does not work for eight
// hundred. More to the point it does not work for **opening credit balances**, which
// have to be reconciled against a notebook customer by customer — and a typo there is
// money somebody either loses or is asked for twice.
//
// ## The two rules that are expensive to get wrong
//
// **`OPS-106` — opening stock carries its cost.** A row without a unit cost is
// *rejected*, never defaulted to zero. Loaded at zero, `avg_cost_centavos` starts at
// zero and every gross-profit figure the store ever sees is wrong by the entire cost of
// goods, while looking perfectly plausible. Nobody finds that for months, and by then
// it cannot be repaired: `MON-005` snapshots the cost onto each sale line as it
// happens, so the wrong figure is already on every sale ever made.
//
// **`OPS-107` — opening balances are credit transactions, not a number on an account.**
// Dated at cutover and referencing "opening balance", so a statement reads from the
// beginning instead of starting mid-story with a figure nobody can source. `CR-103`
// derives a balance from its ledger, and a balance written straight onto the account
// would be a balance with nothing behind it — the first thing reconciliation would
// report as a break.
//
// ## Reusing `TASK-025`'s validation pass
//
// Requirement 1 says to reuse it rather than write a second one. What is genuinely
// reusable is the **shape**: a complete pass that writes nothing, returning a report
// the operator confirms, then a write that revalidates and refuses on anything.
// `importService`'s individual checks are about an archive — a manifest, a checksum,
// referential integrity between JSON files — and none of them means anything about a
// spreadsheet. So this file takes the structure and the vocabulary (`ok`, `problems`,
// `warnings`, `summary`), does its own row checks, and `run()` sequences the backup and
// the single transaction exactly as `importService.run` does. `SCR-706` renders both
// reports with the same components, which is the point: an operator learns one screen.
//
// ## Why every row is checked, not the first bad one
//
// An owner fixing a spreadsheet wants the whole list. Finding one error, fixing it,
// re-uploading and finding the next is how a cutover takes an afternoon instead of ten
// minutes — and how somebody gives up and keys it in by hand anyway.

const db = require('../config/database');
const clock = require('../config/clock');
const csv = require('../config/csv');
const errors = require('./errors');
const money = require('./money');
const permissions = require('./permissions');
const auditService = require('./auditService');
const backupService = require('./backupService');
const inventoryService = require('./inventoryService');
const creditService = require('./creditService');
const productService = require('./productService');
const batchService = require('./batchService');
const customerService = require('./customerService');
const productRepository = require('../repositories/productRepository');
const customerRepository = require('../repositories/customerRepository');
const referenceRepository = require('../repositories/referenceRepository');
const supplierRepository = require('../repositories/supplierRepository');

/**
 * The three files `OPS-105` names, and the columns a store would name them by.
 *
 * Requirement 2 asks for a downloadable template per file. It is generated from this
 * table rather than kept as three files on disk, so a column can never be added to the
 * validator and forgotten in the template — which would produce a template that fails
 * its own validation, and an owner with no way to tell which of the two was wrong.
 */
const KINDS = Object.freeze({
  products: {
    label: 'Products',
    required: ['sku', 'name', 'category', 'base_unit', 'retail_price'],
    // `batch_tracked` (TASK-029): the store's answer to Q-2 is per category, but it is
    // stored per product, and a cutover is the one moment the whole catalogue is being
    // typed anyway. Optional and defaulting to no, because a store that tracks nothing
    // by batch should not have to write "no" five hundred times.
    optional: ['brand', 'wholesale_price', 'dealer_price', 'tax_class', 'min_stock', 'barcode', 'batch_tracked'],
    example: [
      ['sku', 'name', 'category', 'base_unit', 'retail_price', 'brand', 'wholesale_price', 'dealer_price', 'tax_class', 'min_stock', 'barcode', 'batch_tracked'],
      ['HG-50', 'Hog Grower Pellets', 'Feeds', 'KG', '52.00', 'B-MEG', '50.00', '', 'VATABLE', '100', '4800012345678', ''],
      ['VET-AMOX', 'Amoxicillin 100ml', 'Veterinary', 'PC', '320.00', '', '', '', 'VATABLE', '5', '', 'yes'],
    ],
  },
  stock: {
    label: 'Opening stock',
    // OPS-106, as one line of configuration: `unit_cost` is in `required` and not in
    // `optional`, and that is the whole rule.
    required: ['sku', 'quantity', 'unit_cost'],
    // The batch columns are optional in the header and required in the row for a
    // batch-tracked product (INV-202, TASK-029). A store that tracks nothing by batch
    // never fills them in; one that does cannot load a vaccine without saying which
    // batch is on the shelf, because every sale of it will read that expiry date.
    optional: ['note', 'batch_no', 'expiry_date', 'supplier'],
    example: [
      ['sku', 'quantity', 'unit_cost', 'note', 'batch_no', 'expiry_date', 'supplier'],
      ['HG-50', '250', '39.00', 'Counted 1 Sep', '', '', ''],
      ['VET-AMOX', '12', '210.00', '', 'A-2291', '2027-03-31', 'Mindanao Vet Supply'],
    ],
  },
  balances: {
    label: 'Opening credit balances',
    required: ['customer', 'balance'],
    optional: ['code', 'contact_no', 'credit_limit', 'terms_days', 'note'],
    example: [
      ['customer', 'balance', 'code', 'contact_no', 'credit_limit', 'terms_days', 'note'],
      ['Sitio Maligaya Farm', '12500.00', 'MALIGAYA', '09171234567', '50000.00', '30', 'From the blue notebook'],
      ['Aling Nena', '850.00', '', '', '5000.00', '15', ''],
    ],
  },
});

const KIND_NAMES = Object.freeze(Object.keys(KINDS));

const text = (value, { max = 200 } = {}) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function template(kind) {
  const declared = KINDS[kind];
  if (!declared) {
    throw errors.badRequest(`A template is one of ${KIND_NAMES.join(', ')}`, { ruleId: 'OPS-105' });
  }
  return {
    kind,
    label: declared.label,
    file_name: `agrivet_opening_${kind}.csv`,
    required: declared.required,
    optional: declared.optional,
    csv: csv.stringify(declared.example),
  };
}

// ── Reading a figure a person typed ─────────────────────────────────────────

/**
 * A peso amount from a spreadsheet cell, in centavos (`MON-001`).
 *
 * Accepts what people actually type — `1,250.50`, `₱1250.5`, `1250` — and refuses
 * everything else rather than guessing. A cell this cannot read is a cell somebody
 * needs to look at, and a parser that reached for `parseFloat` would read `12.5.0` as
 * twelve pesos fifty and say nothing at all.
 *
 * Returns `null` for an empty cell, which the caller distinguishes from zero. That
 * distinction is `OPS-106`'s whole subject: a blank unit cost is a missing figure, and
 * a `0` is a claim that the goods cost nothing.
 */
function parseMoney(raw) {
  const cleaned = String(raw ?? '').trim().replace(/[₱,\s]/g, '');
  if (cleaned === '') return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return NaN;
  return Math.round(Number.parseFloat(cleaned) * 100);
}

/** A quantity in base units, as thousandths (`MON-002`). Blank is null, not zero. */
function parseQuantity(raw) {
  const cleaned = String(raw ?? '').trim().replace(/[,\s]/g, '');
  if (cleaned === '') return null;
  if (!/^-?\d+(\.\d{1,3})?$/.test(cleaned)) return NaN;
  return Math.round(Number.parseFloat(cleaned) * 1000);
}

// ── OPS-105 — the validation pass ───────────────────────────────────────────

/**
 * Check every row of every file, writing nothing.
 *
 * Requirement 7's "rehearsable" is this function being the *only* judge: `run()` calls
 * it and refuses on anything it reports, so validate-only and the load can never
 * disagree about whether a spreadsheet is loadable.
 */
function validate({ products = null, stock = null, balances = null } = {}) {
  const problems = [];
  const warnings = [];
  const summary = {};

  const parsedProducts = products === null ? null : checkProducts(products, problems, warnings);

  // The stock file is checked against the product file *and* the catalogue, because at
  // cutover most of its SKUs do not exist yet — they are three rows above, in the other
  // file, in the same upload.
  // A map rather than a set (TASK-029): the stock file has to know whether a product
  // arriving in the *same* load is batch-tracked, and that product does not exist in
  // the catalogue yet to be asked.
  const arriving = new Map(parsedProducts
    ? parsedProducts.accepted.map((row) => [row.sku.toUpperCase(), row.input])
    : []);

  const parsed = {
    products: parsedProducts,
    stock: stock === null ? null : checkStock(stock, problems, warnings, arriving),
    balances: balances === null ? null : checkBalances(balances, problems, warnings),
  };

  for (const kind of KIND_NAMES) {
    if (!parsed[kind]) continue;
    summary[kind] = {
      label: KINDS[kind].label,
      rows: parsed[kind].rows.length,
      accepted: parsed[kind].accepted.length,
      rejected: parsed[kind].rows.length - parsed[kind].accepted.length,
    };
  }

  if (Object.keys(summary).length === 0) {
    problems.push({ line: null, rule_id: 'OPS-105', message: 'Send at least one file.' });
  }

  return {
    ok: problems.length === 0,
    rule_id: 'OPS-105',
    problems,
    warnings,
    summary,
    // What `run()` writes from, so the report and the load are one reading of one file
    // rather than two parses that might differ.
    parsed,
  };
}

/** A missing or misspelled column, reported once rather than once per row. */
function checkHeaders(kind, table, problems) {
  const declared = KINDS[kind];
  const missing = declared.required.filter((column) => !table.headers.includes(column));
  if (missing.length === 0) return true;

  problems.push({
    line: table.headerLine,
    rule_id: 'OPS-105',
    message: `The ${declared.label.toLowerCase()} file has no ${missing.join(' or ')} column. `
      + `It needs ${declared.required.join(', ')}`
      + (declared.optional.length ? `, and may also have ${declared.optional.join(', ')}.` : '.'),
  });
  return false;
}

function checkProducts(source, problems, warnings) {
  const table = csv.parseWithHeader(source);
  const accepted = [];
  if (!checkHeaders('products', table, problems)) return { rows: table.rows, accepted };

  const seenSku = new Map();

  for (const { line, values } of table.rows) {
    const reject = (message, ruleId = 'OPS-105') => problems.push({ line, rule_id: ruleId, message });

    const sku = text(values.sku, { max: 40 });
    const name = text(values.name);
    if (!sku) { reject('No SKU.'); continue; }
    if (!name) { reject(`${sku}: no name.`); continue; }

    // Twice over, because a file with the same SKU on two rows is a different mistake
    // from one repeating a product already entered by hand, and the two need different
    // sentences to fix.
    if (seenSku.has(sku.toUpperCase())) {
      reject(`${sku} is also on line ${seenSku.get(sku.toUpperCase())} of this file.`, 'VR-201');
      continue;
    }
    seenSku.set(sku.toUpperCase(), line);
    if (productRepository.findBySku(sku)) {
      reject(`${sku} is already in the catalogue.`, 'VR-201');
      continue;
    }

    // UOM-001: resolved by code, and it must exist. Requirement 5 asks for the row
    // number and the unit by name — "unknown unit" against a 500-row file is not
    // something anybody can act on.
    const unitCode = text(values.base_unit, { max: 20 }).toUpperCase();
    const unit = unitCode ? referenceRepository.findByLabel('units', unitCode) : null;
    if (!unit) {
      reject(
        `${sku}: this store has no unit "${unitCode || '(blank)'}". Add it under Products → `
        + 'Units first, or correct the spelling.',
        'UOM-001'
      );
      continue;
    }

    const categoryName = text(values.category, { max: 60 });
    const category = categoryName ? referenceRepository.findByLabel('categories', categoryName) : null;
    if (!category) {
      reject(
        `${sku}: this store has no category "${categoryName || '(blank)'}". Add it first — a `
        + 'category carries its own discount ceiling (PR-204), so it is not something to invent '
        + 'from a spreadsheet.',
        'VR-209'
      );
      continue;
    }

    const brandName = text(values.brand, { max: 60 });
    const brand = brandName ? referenceRepository.findByLabel('brands', brandName) : null;
    if (brandName && !brand) { reject(`${sku}: this store has no brand "${brandName}".`, 'VR-209'); continue; }

    const retail = parseMoney(values.retail_price);
    if (retail === null) {
      reject(`${sku}: no retail price. PR-102 does not let a product exist without one — it `
        + 'would be findable, scannable, and refuse at the counter in front of a customer.', 'PR-102');
      continue;
    }
    if (Number.isNaN(retail) || retail < 0) { reject(`${sku}: "${values.retail_price}" is not a price.`, 'VR-203'); continue; }

    const extra = {};
    let priceProblem = null;
    for (const [column, key] of [['wholesale_price', 'wholesalePriceCentavos'], ['dealer_price', 'dealerPriceCentavos']]) {
      const value = parseMoney(values[column]);
      if (value === null) continue;
      if (Number.isNaN(value) || value < 0) { priceProblem = `${sku}: "${values[column]}" is not a price.`; break; }
      extra[key] = value;
    }
    if (priceProblem) { reject(priceProblem, 'VR-203'); continue; }

    // TASK-029: what makes a product's stock arrive as identified batches. A word, not
    // a number — "yes" and "y" and "true" are what somebody types in a spreadsheet, and
    // anything else is no, because a typo must not silently turn batch tracking on for
    // a sack of feed and demand an expiry date the store cannot give.
    const batchTracked = /^(y|yes|true|1)$/i.test(text(values.batch_tracked, { max: 8 }));
    if (batchTracked) extra.isBatchTracked = true;

    const taxClass = text(values.tax_class, { max: 20 }).toUpperCase() || 'VATABLE';
    if (!productService.TAX_CLASSES.includes(taxClass)) {
      reject(`${sku}: "${values.tax_class}" is not a tax class. It is one of `
        + `${productService.TAX_CLASSES.join(', ')}.`, 'TAX-003');
      continue;
    }

    const minStock = parseQuantity(values.min_stock);
    if (Number.isNaN(minStock) || (minStock !== null && minStock < 0)) {
      reject(`${sku}: "${values.min_stock}" is not a minimum stock quantity.`, 'VR-204');
      continue;
    }

    const barcode = text(values.barcode, { max: 40 });
    if (barcode) {
      // Checked here rather than left to `createWithin`, because a barcode refusal
      // inside the transaction would abandon a load that validation had called clean —
      // and `OPS-105` is exactly the promise that it will not.
      const classified = productService.classifyBarcode(barcode);
      if (!classified.ok) { reject(`${sku}: ${classified.reason}`, classified.ruleId); continue; }
      const clash = productRepository.findByBarcode(classified.barcode);
      if (clash) { reject(`${sku}: barcode ${classified.barcode} is already on ${clash.sku}.`, 'VR-205'); continue; }
    }

    accepted.push({
      line,
      sku,
      input: {
        sku,
        name,
        categoryId: category.id,
        brandId: brand ? brand.id : null,
        baseUnitId: unit.id,
        taxClass,
        retailPriceCentavos: retail,
        minStockMilli: minStock === null ? 0 : minStock,
        barcodes: barcode ? [barcode] : [],
        ...extra,
      },
    });
  }

  return { rows: table.rows, accepted };
}

/** Returned instead of a batch when the row was rejected, so the caller can `continue`. */
const REJECTED = Symbol('rejected');

/**
 * `INV-202`'s three columns on an opening stock row, or null for a product that is not
 * batch-tracked.
 *
 * The supplier is part of a batch's identity and is `NOT NULL` on `product_batches` —
 * "who this came from" is half of what a recall notice is matched against — so it is
 * required here too, and resolved by code or by name the way every other reference in
 * this file is.
 *
 * An expiry date already in the past is a **warning and not a refusal**: a store does
 * have expired stock on its shelf at cutover, and the honest thing is to load it and
 * let `INV-205` refuse to sell it, rather than to make the opening figure lie by
 * leaving it out.
 */
function batchDetails({ values, sku, batchTracked, reject, warnings, line }) {
  const batchNo = text(values.batch_no, { max: 60 });
  const expiry = text(values.expiry_date, { max: 10 });
  const supplierName = text(values.supplier, { max: 120 });

  if (!batchTracked) {
    // The other direction of the same rule: a batch on a product that does not track
    // them is a column somebody filled in by copying the row above, and loading it
    // would put a batch number on stock nothing can ever match it to.
    if (batchNo || expiry || supplierName) {
      reject(`${sku}: this product is not batch-tracked, so it takes no batch number, `
        + 'expiry date or supplier. Either clear those cells or mark the product '
        + 'batch_tracked in the product file.', 'INV-201');
      return REJECTED;
    }
    return null;
  }

  const missing = [];
  if (!batchNo) missing.push('a batch number');
  if (!expiry) missing.push('an expiry date');
  if (!supplierName) missing.push('a supplier');
  if (missing.length > 0) {
    reject(`${sku} is batch-tracked, so its opening stock needs ${missing.join(', ')}. `
      + 'Every sale of it reads that expiry date, and a recall is matched on the batch '
      + "number and the supplier's name.", 'INV-202');
    return REJECTED;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || Number.isNaN(Date.parse(`${expiry}T00:00:00Z`))) {
    reject(`${sku}: "${values.expiry_date}" is not an expiry date. Write it as YYYY-MM-DD, `
      + 'as 2027-03-31.', 'INV-202');
    return REJECTED;
  }

  const supplier = supplierRepository.findByCode(supplierName.toUpperCase())
    || supplierRepository.findByName(supplierName);
  if (!supplier) {
    reject(`${sku}: this store has no supplier "${supplierName}". Add it under Buying → `
      + 'Suppliers first, or correct the spelling.', 'VR-401');
    return REJECTED;
  }

  if (expiry < batchService.today()) {
    warnings.push({
      line,
      rule_id: 'INV-205',
      message: `${sku} batch ${batchNo} expired on ${expiry}. It will load, and it cannot be `
        + 'sold — write it off from the batch list once the load is done.',
    });
  }

  return { batchNo, expiryDate: expiry, supplierId: supplier.id };
}

function checkStock(source, problems, warnings, arriving) {
  const table = csv.parseWithHeader(source);
  const accepted = [];
  if (!checkHeaders('stock', table, problems)) return { rows: table.rows, accepted };

  const seenSku = new Map();

  for (const { line, values } of table.rows) {
    const reject = (message, ruleId = 'OPS-106') => problems.push({ line, rule_id: ruleId, message });

    const sku = text(values.sku, { max: 40 });
    if (!sku) { reject('No SKU.', 'OPS-105'); continue; }
    if (seenSku.has(sku.toUpperCase())) {
      reject(`${sku} is also on line ${seenSku.get(sku.toUpperCase())}. Put the whole opening `
        + 'quantity on one row — two OPENING movements for one product is a stock history that '
        + 'reads as a delivery nobody made.', 'OPS-105');
      continue;
    }
    seenSku.set(sku.toUpperCase(), line);

    const arrivingInput = arriving.get(sku.toUpperCase()) || null;
    const existing = arrivingInput ? null : productRepository.findBySku(sku);
    if (!arrivingInput && !existing) {
      reject(`${sku} is not in the catalogue and not in the product file.`, 'OPS-105');
      continue;
    }
    const batchTracked = arrivingInput
      ? Boolean(arrivingInput.isBatchTracked)
      : Boolean(existing.is_batch_tracked);

    const qty = parseQuantity(values.quantity);
    if (qty === null) { reject(`${sku}: no opening quantity.`, 'OPS-105'); continue; }
    if (Number.isNaN(qty) || qty <= 0) {
      reject(`${sku}: "${values.quantity}" is not an opening quantity. A product the store has `
        + 'none of is simply left out of this file.', 'MON-002');
      continue;
    }

    // ── OPS-106, the expensive one ──
    //
    // A blank cost is rejected, never defaulted. The refusal says what it costs to get
    // wrong, because "unit_cost is required" reads like form validation and this is not
    // one — somebody who cannot find the cost needs to know that filling it in later is
    // not an option MON-005 leaves open.
    const cost = parseMoney(values.unit_cost);
    if (cost === null) {
      reject(
        `${sku}: no unit cost. Opening stock has to carry what it cost, or every profit figure `
        + 'this store ever reports is wrong by the cost of the goods — and it cannot be '
        + 'corrected afterwards, because each sale keeps the cost that applied when it was made. '
        + 'Find the cost and put it in.',
        'OPS-106'
      );
      continue;
    }
    if (Number.isNaN(cost) || cost < 0) { reject(`${sku}: "${values.unit_cost}" is not a cost.`, 'VR-203'); continue; }
    if (cost === 0) {
      // Zero is a claim rather than a gap, so it is allowed — a store does receive free
      // samples — but it is said out loud, because it is also exactly what a mis-keyed
      // cell looks like.
      warnings.push({
        line,
        rule_id: 'OPS-106',
        message: `${sku} is loaded at a cost of zero, so every sale of it will report the whole `
          + 'price as profit. If that is not right, fix it before loading.',
      });
    }

    // ── INV-202 — batch-tracked stock arrives as a batch, or not at all ──
    //
    // Checked here rather than at load, for OPS-105's reason: a validation that passed
    // and a load that then refused half way through would leave the store with part of
    // its shelf in the system and no way to tell which part. The message names the
    // columns, because a store filling in its first opening file has not met them.
    const batch = batchDetails({ values, sku, batchTracked, reject, warnings, line });
    if (batch === REJECTED) continue;

    accepted.push({
      line, sku, qtyMilli: qty, unitCostCentavos: cost, note: text(values.note) || null,
      batch,
    });
  }

  return { rows: table.rows, accepted };
}

function checkBalances(source, problems, warnings) {
  const table = csv.parseWithHeader(source);
  const accepted = [];
  if (!checkHeaders('balances', table, problems)) return { rows: table.rows, accepted };

  const seenName = new Map();
  const seenCode = new Map();

  for (const { line, values } of table.rows) {
    const reject = (message, ruleId = 'OPS-107') => problems.push({ line, rule_id: ruleId, message });

    const name = text(values.customer, { max: 120 });
    if (!name) { reject('No customer name.', 'OPS-105'); continue; }

    const key = name.toLowerCase();
    if (seenName.has(key)) {
      reject(`${name} is also on line ${seenName.get(key)}. One opening balance per customer — `
        + 'two would post as two transactions and the statement would read as a purchase.', 'OPS-107');
      continue;
    }
    seenName.set(key, line);

    const code = text(values.code, { max: 30 }).toUpperCase() || null;
    if (code && seenCode.has(code)) {
      reject(`${name}: the code ${code} is also on line ${seenCode.get(code)}.`, 'VR-301');
      continue;
    }
    if (code) seenCode.set(code, line);

    // An existing customer is matched by code first and by name second, because a code
    // is what the store chose to be unique and a name is what somebody typed. Matched,
    // rather than refused: a cutover file naming a customer already registered by hand
    // should give them their balance, not fail.
    const byCode = code ? customerRepository.findByCode(code) : null;
    const byName = customerRepository.findByName(name);
    if (byCode && byName && byCode.id !== byName.id) {
      reject(`${name}: the code ${code} belongs to ${byCode.name}. One of the two is wrong.`, 'VR-301');
      continue;
    }
    const existing = byCode || byName;

    const balance = parseMoney(values.balance);
    if (balance === null) { reject(`${name}: no opening balance.`, 'OPS-107'); continue; }
    if (Number.isNaN(balance)) { reject(`${name}: "${values.balance}" is not an amount.`, 'MON-001'); continue; }
    if (balance < 0) {
      reject(
        `${name}: an opening balance is what the customer owes, so it is not negative. A customer `
        + 'the store owes holds store credit, which is created by a return or an overpayment and '
        + 'not by a cutover file (CR-108).',
        'OPS-107'
      );
      continue;
    }

    const limit = parseMoney(values.credit_limit);
    if (Number.isNaN(limit) || (limit !== null && limit < 0)) {
      reject(`${name}: "${values.credit_limit}" is not a credit limit.`, 'CR-101');
      continue;
    }

    const termsRaw = text(values.terms_days, { max: 10 });
    const terms = termsRaw === '' ? 0 : Number.parseInt(termsRaw, 10);
    if (!Number.isInteger(terms) || terms < 0 || (termsRaw !== '' && String(terms) !== termsRaw)) {
      reject(`${name}: "${termsRaw}" is not a number of days.`, 'CR-105');
      continue;
    }
    if (terms !== 0 && !creditService.TERMS_DAYS.includes(terms)) {
      reject(`${name}: terms are ${creditService.TERMS_DAYS.join(', ')} days, not ${terms}.`, 'CR-105');
      continue;
    }

    if (balance > 0 && limit !== null && limit > 0 && balance > limit) {
      // Not a refusal: the notebook says what it says, and a farm over its limit at
      // cutover is a real and common state. Refusing it would make the operator round
      // the limit up to get the load through, which is a worse record than the truth.
      // Said out loud, because it is also what a misplaced decimal point looks like.
      warnings.push({
        line,
        rule_id: 'CR-104',
        message: `${name} opens at ${money.toDisplay(balance)}, above the `
          + `${money.toDisplay(limit)} limit on the same row. They will be over their limit from `
          + 'the first day and unable to buy on credit until they pay something down.',
      });
    }

    accepted.push({
      line,
      name,
      code,
      contactNo: text(values.contact_no, { max: 40 }) || null,
      balanceCentavos: balance,
      creditLimitCentavos: limit === null ? 0 : limit,
      termsDays: terms,
      note: text(values.note) || null,
      existingId: existing ? existing.id : null,
    });
  }

  return { rows: table.rows, accepted };
}

// ── OPS-103 — backup first, then one transaction ────────────────────────────

/**
 * Load the files.
 *
 * The same order `importService.run` uses and for the same reasons: validate in full,
 * take a **verified** backup, then write everything in one transaction. A cutover that
 * half-loaded is worse than one that did not run at all, because nobody can tell by
 * looking which products got their stock and which did not — and the only way to find
 * out is to count eight hundred products.
 */
function run({ products = null, stock = null, balances = null, cutoverAt = null, reason = null } = {}, actor) {
  if (!permissions.can(actor, 'TX-427')) {
    throw errors.forbidden(
      'You do not have permission to load opening data.',
      { ruleId: 'TX-427', requiresRole: permissions.rolesHolding('TX-427').join(' or ') }
    );
  }

  const checked = validate({ products, stock, balances });
  if (!checked.ok) {
    throw errors.badRequest(
      `${checked.problems.length} row${checked.problems.length === 1 ? '' : 's'} cannot be loaded. `
      + 'Nothing has been written — fix the spreadsheet and try again.',
      { ruleId: checked.problems[0].rule_id }
    );
  }

  const backup = backupService.run({ trigger: 'PRE_IMPORT', actor });
  if (!backup.ok) {
    throw errors.conflict(
      `The pre-load backup could not be taken (${backup.error}) so the load has not run. A backup `
      + 'is the only way back from a cutover that turns out to have been wrong, and a cutover is '
      + 'the one moment a store cannot re-key from memory (OPS-103).',
      { ruleId: 'OPS-103' }
    );
  }

  // OPS-107: the balances are dated at cutover — the day the notebook was closed, which
  // the owner chooses and which is usually not today. A date with no time is taken as
  // midnight, because a cutover is a day rather than a moment.
  const now = clock.nowUtc();
  const cutover = cutoverAt ? `${String(cutoverAt).slice(0, 10)}T00:00:00.000Z` : now;

  const loaded = db.transaction(() => {
    const counts = { products: 0, stock: 0, customers: 0, balances: 0 };
    const bySku = new Map();

    for (const row of checked.parsed.products ? checked.parsed.products.accepted : []) {
      const created = productService.createWithin(row.input, actor);
      bySku.set(row.sku.toUpperCase(), created.id);
      counts.products += 1;
    }

    // ── OPS-106 — one OPENING movement per row, carrying its own cost ──
    const stockRows = checked.parsed.stock ? checked.parsed.stock.accepted : [];
    for (const row of stockRows) {
      const productId = bySku.get(row.sku.toUpperCase()) || productRepository.findBySku(row.sku).id;

      // ── INV-202 — the store's existing shelf becomes identified batches ──
      //
      // The only other place a batch is born (goods receipt is the first). Without this
      // a store that tracks vaccines by batch could not load its opening stock at all:
      // INV-201 refuses an unbatched movement of a batch-tracked product, and rightly.
      //
      // `findForReceipt` first, for the same reason the receipt uses it: a batch number
      // that already exists is the same batch, and a second row for it would split one
      // recall in two.
      let batchId = null;
      if (row.batch) {
        const existingBatch = batchService.findForReceipt(productId, row.batch.batchNo);
        batchId = existingBatch ? existingBatch.id : batchService.create({
          productId,
          batchNo: row.batch.batchNo,
          supplierId: row.batch.supplierId,
          expiryDate: row.batch.expiryDate,
          receivedDate: batchService.today(cutover),
          unitCostCentavos: row.unitCostCentavos,
          notes: 'Opening load at cutover',
          actor,
          occurredAt: cutover,
        }).id;
      }

      inventoryService.post({
        productId,
        type: 'OPENING',
        qtyMilli: row.qtyMilli,
        batchId,
        // The figure the whole rule is about. `INV-106` moves the average on the way
        // in, so on a product with nothing on hand this *is* what `avg_cost_centavos`
        // becomes.
        unitCostCentavos: row.unitCostCentavos,
        actor,
        reason: row.note || 'Opening stock at cutover',
        referenceType: 'opening_load',
        referenceNo: 'OPENING',
        occurredAt: cutover,
      });
      counts.stock += 1;
    }

    // ── OPS-107 — one credit transaction per balance, dated at cutover ──
    const balanceRows = checked.parsed.balances ? checked.parsed.balances.accepted : [];
    for (const row of balanceRows) {
      let customerId = row.existingId;
      if (!customerId) {
        customerId = customerService.createWithin({
          name: row.name,
          code: row.code,
          contactNo: row.contactNo,
          customerType: 'FARM',
          priceLevel: 'RETAIL',
          isCreditEligible: true,
          creditLimitCentavos: row.creditLimitCentavos,
          termsDays: row.termsDays,
          notes: row.note,
        }, actor).id;
        counts.customers += 1;
      }

      const account = creditService.accountFor(customerId)
        || creditService.openAccount(customerId, {
          limitCentavos: row.creditLimitCentavos, termsDays: row.termsDays, at: cutover,
        });

      // A customer with nothing owing still gets their account, so the store can sell to
      // them on credit from the first day. They do not get a transaction: a zero-peso
      // opening line is a line that says nothing and has to be explained forever.
      if (row.balanceCentavos === 0) continue;

      creditService.post({
        accountId: account.id,
        type: 'OPENING',
        amountCentavos: row.balanceCentavos,
        actor,
        // OPS-107's own words, in the document number, so a statement's first line says
        // where the figure came from instead of showing a bare amount against a
        // generated reference nobody can trace to anything.
        documentNo: 'OPENING-BALANCE',
        reason: row.note || 'Opening balance at cutover',
        dueAt: creditService.dueDateFor(account, { at: cutover }),
        occurredAt: cutover,
      });
      counts.balances += 1;
    }

    auditService.write({
      actor,
      action: 'DATA_IMPORTED',
      entityType: 'opening_load',
      entityId: cutover.slice(0, 10),
      before: { pre_load_backup: backup.file_name },
      after: {
        cutover_at: cutover,
        products: counts.products,
        opening_stock_rows: counts.stock,
        customers_created: counts.customers,
        opening_balances: counts.balances,
        // OPS-106, recorded: what the store started from, not merely that a load
        // happened. Six months on, "was the opening stock valued at all?" is a question
        // somebody will ask, and this is the answer.
        opening_stock_value_centavos: stockRows.reduce(
          (sum, row) => sum + money.mulQty(row.unitCostCentavos, row.qtyMilli), 0
        ),
        opening_balance_total_centavos: balanceRows.reduce((sum, row) => sum + row.balanceCentavos, 0),
      },
      reason: reason || 'Opening data loaded at cutover',
    });

    return counts;
  }, { immediate: true });

  // Requirement 8: computed after the load and reported with it. A cutover that says
  // "1,200 rows loaded" and does not say whether the ledgers agree is a cutover nobody
  // can sign off — and the moment to find a break is now, while the pre-load backup is
  // still the store's whole history.
  const inventory = inventoryService.reconcile();
  const credit = creditService.reconcile();

  return {
    ok: true,
    rule_id: 'OPS-105',
    pre_load_backup: {
      file_name: backup.file_name,
      file_path: backup.file_path,
      verified: backup.verified,
    },
    cutover_at: cutover,
    loaded,
    warnings: checked.warnings,
    reconciliation: {
      inventory_balances: inventory.ok,
      credit_balances: credit.ok,
      breaks: [...inventory.breaks, ...credit.breaks],
      // As a sentence, because "true" is not what somebody signing off a cutover is
      // looking for.
      statement: inventory.ok && credit.ok
        ? 'Stock on hand reconciles to the movement ledger and every credit balance reconciles '
          + 'to its transactions (INV-101, CR-103).'
        : 'The ledgers do not reconcile after this load. Restore the pre-load backup named above '
          + 'and report it — this should not be possible.',
    },
  };
}

module.exports = {
  KINDS, KIND_NAMES,
  template, parseMoney, parseQuantity,
  validate, run,
};
