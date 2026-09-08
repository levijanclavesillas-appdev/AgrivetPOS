'use strict';

// FR_3.3–FR_3.6 — the sale transaction. The one endpoint where money, stock, credit
// and the till meet, and the reason the previous ten tasks exist.
//
// 05_TECH_SPEC.md §4.1 fixes twelve steps and their order, and the order is not
// decorative — several checks are only correct where they sit:
//
//   • prices are re-resolved (2) *before* stock is checked (3), because a line the
//     store cannot price is not a line whose stock matters;
//   • totals are recomputed (4) before tenders are counted (5), or the sale would be
//     balanced against a figure the client supplied;
//   • the sale number is allocated (8) after every validation, so a rollback consumes
//     no number (POS-108).
//
// **The client's computed totals are never persisted.** They are recomputed and
// compared, and a mismatch rejects the sale. That is how a stale price list in a
// renderer, or a tampered one, is caught rather than banked.
//
// INV-107 is why this is one function: the sale, its lines, its tenders, its inventory
// movements and its credit transaction commit together or not at all. Printing is
// deliberately outside the transaction (INT-1) — a printer failure must never roll
// back a committed sale.

const db = require('../config/database');
const ids = require('../config/ids');
const clock = require('../config/clock');
const errors = require('./errors');
const money = require('./money');
const quantity = require('./quantity');
const auditService = require('./auditService');
const pricingService = require('./pricingService');
const storeProfileService = require('./storeProfileService');
const inventoryService = require('./inventoryService');
const creditService = require('./creditService');
const shiftService = require('./shiftService');
const drawerService = require('./drawerService');
const sequenceService = require('./sequenceService');
const saleRepository = require('../repositories/saleRepository');
const productRepository = require('../repositories/productRepository');
const referenceRepository = require('../repositories/referenceRepository');
const customerRepository = require('../repositories/customerRepository');
const inventoryRepository = require('../repositories/inventoryRepository');

/** POS-201's tender types. STORE_CREDIT and OTHER exist in the schema for v1.1. */
const TENDERS = Object.freeze({
  CASH: { needsReference: false, mayOverTender: true, movesStock: false, inDrawer: true },
  GCASH: { needsReference: true, mayOverTender: false, movesStock: false, inDrawer: false },
  QRPH: { needsReference: true, mayOverTender: false, movesStock: false, inDrawer: false },
  CREDIT: { needsReference: false, mayOverTender: false, movesStock: false, inDrawer: false },
});

const TENDER_METHODS = Object.freeze(Object.keys(TENDERS));

const textOrNull = (value) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
};

// ── The endpoint ────────────────────────────────────────────────────────────

/**
 * Complete a sale.
 *
 * `input` is what the counter has: lines (product, quantity, optional pack and
 * discount), an optional customer, tenders, and — optionally — the totals the screen
 * showed, which are compared and discarded.
 */
function complete(input, actor) {
  const {
    lines = [], customerId = null, tenders = [], transactionDiscountCentavos = 0,
    clientTotalCentavos = null, approver = null, acceptDuplicateReference = false,
    reason = null,
  } = input || {};

  if (!actor || !actor.id) throw new TypeError('a sale needs an acting user (POS-501)');
  if (!Array.isArray(lines) || lines.length === 0) {
    // POS-101: a sale requires at least one line with a positive quantity.
    throw errors.badRequest('A sale needs at least one line', { ruleId: 'POS-101' });
  }

  const at = clock.nowUtc();

  // One BEGIN IMMEDIATE for the whole operation (§4.1). Everything below either
  // commits together or leaves no trace.
  const result = db.transaction(() => {
    // ── 1. The shift is open and belongs to the actor (POS-501) ─────────────
    const shift = shiftService.requireOpenShift(actor, { action: 'complete a sale' });

    // POS-103: a customer is optional. Absent one the sale is a walk-in at retail.
    const customer = customerId ? customerRepository.findById(customerId) : null;
    if (customerId && !customer) throw errors.notFound('No such customer');
    if (customer && !customer.is_active) {
      throw errors.conflict(`${customer.name} is not an active customer.`, { ruleId: 'VR-304' });
    }
    const taxMode = storeProfileService.taxMode();

    // ── 2 and 4. Re-resolve prices and recompute every total (PR-101, MON-003,
    //             MON-006, TAX-002) ────────────────────────────────────────────
    //
    // The same computation the price-check endpoint runs, so what the screen previewed
    // and what the till charges cannot drift.
    // POS-102: resolved before pricing, because the price is per base unit and the
    // quantity has to be in base units before it can be multiplied by one.
    const resolvedLines = lines.map((line) => ({ line, ...resolveLineQuantity(line) }));

    const priced = pricingService.priceCart({
      lines: resolvedLines.map(({ line, qtyMilli }) => ({
        productId: line.productId,
        qtyMilli,
        discountCentavos: line.discountCentavos || 0,
      })),
      customer,
      taxMode,
      actorRole: actor.role,
      approverRole: approver ? approver.role : null,
      transactionDiscountCentavos,
      at,
    });

    // PR-105 and PR-203: anything still needing authorisation stops the sale here,
    // naming who can give it. The screen has already had the chance to ask.
    if (priced.requires_authorisation) {
      const first = priced.authorisations[0];
      throw errors.forbidden(first.message, {
        ruleId: first.rule_id, requiresRole: first.requires_role,
      });
    }

    // ── 3. Re-check stock per line, at commit time (INV-104) ────────────────
    //
    // Not at cart time. Between adding a line and confirming it, another sale on the
    // same machine may have taken the stock, and the cart's figure is a memory.
    assertStock(priced, taxMode);

    // The client's figures are compared here and never stored (§4.1's closing note).
    assertClientTotalMatches(clientTotalCentavos, priced.total_centavos);

    // ── 5, 6, 7. The tenders ────────────────────────────────────────────────
    const settled = settleTenders({
      tenders, totalCentavos: priced.total_centavos, customer, at,
      acceptDuplicateReference, approver, actor,
    });

    // ── 8. Allocate the sale number, after every validation (POS-108) ───────
    const saleNo = sequenceService.next('SALE', { at });

    // ── 9. The sale, its lines, its tenders, its discounts (MON-005) ────────
    const saleId = ids.uuidv7();
    const written = writeSale({
      saleId, saleNo, shift, customer, priced, resolvedLines, settled, taxMode, actor, approver, at, reason,
    });

    // ── 10. One inventory movement per line, and the on-hand update ─────────
    //
    // Through inventoryService.post, which joins this transaction rather than opening
    // its own — INV-101's balance and INV-107's document commit together.
    for (const line of priced.lines) {
      inventoryService.post({
        productId: line.product_id,
        type: 'SALE',
        qtyMilli: line.qty_milli,
        actor,
        referenceType: 'sale',
        referenceId: saleId,
        referenceNo: saleNo,
        occurredAt: at,
      });
    }

    // ── 11. The credit transaction, where credit was tendered (CR-103) ──────
    let creditTransaction = null;
    if (settled.creditCentavos > 0) {
      const dueAt = creditService.dueDateFor(settled.creditAccount, { at });
      creditTransaction = creditService.post({
        accountId: settled.creditAccount.id,
        type: 'CREDIT_SALE',
        amountCentavos: settled.creditCentavos,
        actor,
        documentNo: saleNo,
        saleId,
        dueAt,
        shiftId: shift.id,
        occurredAt: at,
      });
    }

    // ── 12. Audit rows for any override (AUD-603) ───────────────────────────
    if (settled.overLimit) {
      auditService.recordOverride({
        action: 'OVERRIDE_CREDIT_OVER_LIMIT',
        actor,
        approver,
        reason: settled.overLimit.reason,
        entityType: 'sales',
        entityId: saleId,
        before: {
          balance_centavos: settled.overLimit.balanceCentavos,
          credit_limit_centavos: settled.overLimit.limitCentavos,
        },
        after: {
          tender_centavos: settled.creditCentavos,
          balance_after_centavos: settled.overLimit.balanceCentavos + settled.creditCentavos,
        },
        shiftId: shift.id,
      });
    }

    return {
      saleId, saleNo, shift, priced, settled, creditTransaction, written, at, taxMode,
    };
  }, { immediate: true });

  // ── Outside the transaction (INT-1, POS-507) ──────────────────────────────
  //
  // The drawer is hardware. A pulse cannot be rolled back, and a stuck drawer must
  // never undo a sale that has already committed and taken the customer's money.
  let drawer = null;
  if (result.settled.cashCentavos > 0) {
    drawer = drawerService.pulse({
      reason: 'CASH_TENDER',
      shiftId: result.shift.id,
      actor,
      amountCentavos: result.settled.cashCentavos,
    });
  }

  return { ...get(result.saleId), drawer, warnings: result.settled.warnings };
}

// ── Step 3 — stock ──────────────────────────────────────────────────────────

/**
 * INV-104, checked per line against what is actually on hand right now.
 *
 * Refused before anything is written, with the figure the counter can act on. The
 * movement in step 10 would refuse too — inventoryService.post enforces the same rule
 * — but failing there would mean rolling back a sale that had already allocated a
 * number and written its lines, and the error would name a movement rather than a
 * product.
 */
function assertStock(priced) {
  const settingsService = require('./settingsService');
  const allowNegative = settingsService.get('allow_negative_stock');

  // Several lines may name the same product; the check is on the total taken.
  const wanted = new Map();
  for (const line of priced.lines) {
    wanted.set(line.product_id, (wanted.get(line.product_id) || 0) + line.qty_milli);
  }

  for (const [productId, qtyMilli] of wanted) {
    const onHand = inventoryRepository.qtyOnHand(productId);
    if (onHand >= qtyMilli || allowNegative) continue;

    const product = productRepository.findById(productId);
    throw errors.conflict(
      `Not enough ${product.name}. There is ${quantity.format(onHand, product.base_unit_code)} on hand `
      + `and this sale needs ${quantity.format(qtyMilli, product.base_unit_code)}.`,
      { ruleId: 'INV-104' }
    );
  }
}

/**
 * §4.1's closing note, as a check.
 *
 * The client may send what its screen showed. It is compared and discarded — never
 * stored — and a mismatch beyond zero rejects the sale. Sending nothing is permitted:
 * a caller that does not claim a total cannot claim a wrong one.
 */
function assertClientTotalMatches(clientTotalCentavos, serverTotalCentavos) {
  if (clientTotalCentavos === null || clientTotalCentavos === undefined) return;

  const claimed = typeof clientTotalCentavos === 'number'
    ? clientTotalCentavos
    : Number.parseInt(String(clientTotalCentavos).trim(), 10);

  if (claimed !== serverTotalCentavos) {
    throw errors.conflict(
      `The screen showed ${money.toDisplay(claimed)} but this sale comes to `
      + `${money.toDisplay(serverTotalCentavos)}. The price list may have changed. `
      + 'Check the cart and try again.',
      { ruleId: '05 §4.1' }
    );
  }
}

// ── Steps 5, 6, 7 — the tenders ─────────────────────────────────────────────

/**
 * POS-202 through POS-207, and CR-102/CR-104 for the credit part.
 *
 * Returns what step 9 needs to write and step 11 needs to post, plus any warnings the
 * caller has already accepted.
 */
function settleTenders({
  tenders, totalCentavos, customer, at, acceptDuplicateReference, approver, actor,
}) {
  if (!Array.isArray(tenders) || tenders.length === 0) {
    throw errors.badRequest('A sale needs at least one payment', { ruleId: 'POS-204' });
  }

  const warnings = [];
  const normalised = [];
  let cashCentavos = 0;
  let creditCentavos = 0;

  for (const [index, tender] of tenders.entries()) {
    const method = String(tender.method || '').toUpperCase();
    if (!TENDER_METHODS.includes(method)) {
      throw errors.badRequest(
        `Payment ${index + 1} must be one of ${TENDER_METHODS.join(', ')}`,
        { ruleId: 'POS-201' }
      );
    }

    const amount = typeof tender.amountCentavos === 'number'
      ? tender.amountCentavos
      : Number.parseInt(String(tender.amountCentavos ?? '').trim(), 10);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw errors.badRequest(`Payment ${index + 1} must be a positive amount`, { ruleId: 'POS-201' });
    }

    const declared = TENDERS[method];
    const referenceNo = textOrNull(tender.referenceNo);

    // ── 6. GCASH and QRPH require a reference (POS-205) ─────────────────────
    if (declared.needsReference) {
      if (!referenceNo) {
        // Never generated and never defaulted: an auto-filled reference is a receipt
        // that says a payment was traced when nobody traced it.
        throw errors.badRequest(
          `A ${method} payment needs its reference number. Read it from the customer's screen.`,
          { ruleId: 'POS-205' }
        );
      }

      // POS-207: a duplicate for the same method that day warns and must be accepted.
      const duplicates = saleRepository.referenceUsedToday({
        method,
        referenceNo,
        fromAt: dayStart(at),
        toAt: dayEnd(at),
      });

      if (duplicates.length > 0 && !acceptDuplicateReference) {
        throw errors.conflict(
          `${method} reference ${referenceNo} was already used today on `
          + `${duplicates.map((d) => d.sale_no).join(', ')}. Double-keying the same reference is the `
          + 'common till error. Confirm this is a second, genuine payment to continue.',
          { ruleId: 'POS-207' }
        );
      }
      if (duplicates.length > 0) {
        warnings.push({
          rule_id: 'POS-207',
          message: `${method} reference ${referenceNo} was also used on `
            + `${duplicates.map((d) => d.sale_no).join(', ')} today; accepted by the cashier.`,
        });
      }
    }

    if (method === 'CASH') cashCentavos += amount;
    if (method === 'CREDIT') creditCentavos += amount;

    normalised.push({
      method,
      amountCentavos: amount,
      referenceNo: declared.needsReference ? referenceNo : referenceNo || null,
    });
  }

  // ── 5. SUM(tenders) >= total (POS-204) ────────────────────────────────────
  const tendered = normalised.reduce((sum, t) => sum + t.amountCentavos, 0);
  if (tendered < totalCentavos) {
    throw errors.badRequest(
      `${money.toDisplay(tendered)} does not cover ${money.toDisplay(totalCentavos)}. `
      + `${money.toDisplay(totalCentavos - tendered)} is still due.`,
      { ruleId: 'POS-204' }
    );
  }

  // POS-203 / MON-007: only cash may over-tender, and change is cash only.
  const over = tendered - totalCentavos;
  if (over > 0 && over > cashCentavos) {
    throw errors.badRequest(
      'Only cash may be over-tendered. Reduce the non-cash payments to the amount due.',
      { ruleId: 'POS-203' }
    );
  }

  // ── 7. Credit: eligible, and within limit or approved (CR-102, CR-104) ────
  let creditAccount = null;
  let overLimit = null;

  if (creditCentavos > 0) {
    const { account } = creditService.assertCreditEligible(customer ? customer.id : null);
    creditAccount = account;

    const available = creditService.available(account);
    if (creditCentavos > available) {
      // CR-104: blocked, releasable only by a manager or owner override recorded with
      // actor and reason (AUD-603).
      if (!approver || !['MANAGER', 'OWNER'].includes(approver.role)) {
        throw errors.forbidden(
          `${customer.name} has ${money.toDisplay(available)} of credit available and this sale `
          + `needs ${money.toDisplay(creditCentavos)}. A manager or owner must authorise going over `
          + 'the limit.',
          { ruleId: 'CR-104', requiresRole: 'MANAGER or OWNER' }
        );
      }
      if (approver.id && actor.id && approver.id === actor.id) {
        throw errors.forbidden(
          'An over-limit credit sale must be authorised by a different user.',
          { ruleId: 'AUD-603' }
        );
      }

      overLimit = {
        balanceCentavos: account.balance_centavos,
        limitCentavos: account.credit_limit_centavos,
        availableCentavos: available,
        reason: textOrNull(approver.reason)
          || `Over-limit credit authorised by ${approver.username}`,
      };
    }
  }

  return {
    tenders: normalised,
    tenderedCentavos: tendered,
    changeCentavos: over,
    cashCentavos,
    creditCentavos,
    creditAccount,
    overLimit,
    warnings,
  };
}

const dayStart = (at) => `${clock.manilaDate(at)}T00:00:00.000Z`;
const dayEnd = (at) => {
  const next = new Date(Date.parse(`${clock.manilaDate(at)}T00:00:00.000Z`) + 86400000);
  return next.toISOString();
};

// ── Step 9 — writing it down ────────────────────────────────────────────────

function writeSale({ saleId, saleNo, shift, customer, priced, resolvedLines, settled, taxMode, actor, approver, at, reason }) {
  const summary = priced.tax_summary || {
    vatable_sales_centavos: 0, vat_exempt_sales_centavos: 0, zero_rated_sales_centavos: 0,
  };

  saleRepository.insertSale({
    id: saleId,
    sale_no: saleNo,
    customer_id: customer ? customer.id : null,
    shift_id: shift.id,
    status: 'COMPLETED',
    price_level: priced.customer_price_level,
    // RPT-106: the mode in force is snapshotted, so a report of an old day states the
    // treatment that actually applied rather than today's.
    tax_mode: taxMode,
    subtotal_centavos: priced.subtotal_centavos,
    line_discount_centavos: priced.line_discount_centavos,
    txn_discount_centavos: priced.transaction_discount_centavos,
    statutory_discount_centavos: 0,          // TAX-004 is v1.1
    vatable_centavos: summary.vatable_sales_centavos,
    vat_exempt_centavos: summary.vat_exempt_sales_centavos,
    zero_rated_centavos: summary.zero_rated_sales_centavos,
    vat_centavos: priced.tax_amount_centavos,
    total_centavos: priced.total_centavos,
    change_centavos: settled.changeCentavos,
    approved_by: approver && approver.id ? approver.id : null,
    voided_at: null,
    voided_by: null,
    void_reason: null,
    occurred_at: at,
    created_by: actor.id,
  });

  const items = priced.lines.map((line, index) => {
    const product = productRepository.findById(line.product_id);
    const item = {
      id: ids.uuidv7(),
      sale_id: saleId,
      line_no: index + 1,
      product_id: line.product_id,
      // MON-005: the product's own name is snapshotted. A product renamed next month
      // must not change what a receipt from March says was sold.
      product_name_snapshot: product.name,
      qty_milli: line.qty_milli,
      // What the cashier actually picked, and the factor the server resolved for it.
      sold_unit_id: resolvedLines[index].soldUnitId,
      sold_pack_factor_milli: resolvedLines[index].packFactorMilli,
      unit_price_centavos: line.unit_price_centavos,
      price_level_applied: line.price_level,
      // The cost snapshot RPT-104 reads. Changing a product's cost afterwards does not
      // change this sale's gross profit — TC-INT-35.
      unit_cost_centavos: product.avg_cost_centavos,
      discount_centavos: line.line_discount_centavos + line.transaction_discount_centavos,
      tax_class_snapshot: line.tax_class,
      tax_centavos: line.tax_amount_centavos,
      line_total_centavos: line.amount_centavos,
      batch_id: null,
      returned_qty_milli: 0,
    };
    saleRepository.insertItem(item);
    return item;
  });

  const tenders = settled.tenders.map((tender) => {
    const row = {
      id: ids.uuidv7(),
      sale_id: saleId,
      method: tender.method,
      amount_centavos: tender.amountCentavos,
      reference_no: tender.referenceNo,
      // POS-206: RECORDED means "the cashier saw it". Nothing here ever says verified.
      status: 'RECORDED',
      created_at: at,
    };
    saleRepository.insertTender(row);
    return row;
  });

  // PR-204: every manual discount records its line, the original, the amount and the
  // percentage, the acting user, the approving user, and the timestamp.
  const discounts = [];
  priced.lines.forEach((line, index) => {
    if (line.line_discount_centavos <= 0) return;
    const row = {
      id: ids.uuidv7(),
      sale_id: saleId,
      sale_item_id: items[index].id,
      discount_type: 'MANUAL_LINE',
      original_centavos: line.gross_centavos,
      discount_centavos: line.line_discount_centavos,
      discount_bp: pricingService.basisPoints(line.line_discount_centavos, line.gross_centavos),
      reason: reason || null,
      applied_by: actor.id,
      approved_by: approver && approver.id ? approver.id : null,
      statutory_id_type: null,
      statutory_id_no: null,
      statutory_name: null,
      created_at: at,
    };
    saleRepository.insertDiscount(row);
    discounts.push(row);
  });

  if (priced.transaction_discount_centavos > 0) {
    const row = {
      id: ids.uuidv7(),
      sale_id: saleId,
      sale_item_id: null,                     // NULL = transaction level
      discount_type: 'MANUAL_TXN',
      original_centavos: priced.subtotal_centavos,
      discount_centavos: priced.transaction_discount_centavos,
      discount_bp: pricingService.basisPoints(priced.transaction_discount_centavos, priced.subtotal_centavos),
      reason: reason || null,
      applied_by: actor.id,
      approved_by: approver && approver.id ? approver.id : null,
      statutory_id_type: null,
      statutory_id_no: null,
      statutory_name: null,
      created_at: at,
    };
    saleRepository.insertDiscount(row);
    discounts.push(row);
  }

  return { items, tenders, discounts };
}

/**
 * POS-102 / UOM-002 — a line quantity is entered in the base unit or in a defined
 * pack, and the ledger stores base.
 *
 * The pack is resolved **server-side from product_packs**, by unit. A client-supplied
 * conversion factor is a client-supplied price in disguise: send a factor of 1 for a
 * sack and buy fifty kilos for the price of one. §4.1 step 2 says never trust the
 * client for a price, and a factor multiplies one.
 *
 * A pack whose unit does not allow fractions must be a whole number of packs. That
 * check exists because the alternative failure is silent: `qtyMilli: 4` against a sack
 * means four thousandths of a sack, which prices and sells cleanly at 0.2 KG and looks
 * like nothing wrong until the day's takings are counted. It was written after
 * exactly that mistake in this project's own end-to-end test.
 */
function resolveLineQuantity(line) {
  const raw = typeof line.qtyMilli === 'number'
    ? line.qtyMilli
    : Number.parseInt(String(line.qtyMilli ?? '').trim(), 10);

  if (!Number.isInteger(raw) || raw <= 0) {
    throw errors.badRequest('Each line needs a positive quantity', { ruleId: 'POS-101' });
  }

  const packUnitId = line.packUnitId || line.soldUnitId || null;
  const product = productRepository.findById(line.productId);
  if (!product) throw errors.notFound('No such product on this line');

  // No pack named, or the base unit named: the quantity is already in base units.
  if (!packUnitId || packUnitId === product.base_unit_id) {
    assertFractionAllowed(raw, product.base_unit_allows_fraction, product.base_unit_code);
    return { qtyMilli: raw, soldUnitId: product.base_unit_id, packFactorMilli: 1000 };
  }

  const pack = productRepository.packsFor(line.productId).find((p) => p.unit_id === packUnitId);
  if (!pack) {
    throw errors.badRequest(
      `${product.name} has no ${packUnitId} pack defined. Sell it in ${product.base_unit_code}, `
      + 'or add the pack to the product first.',
      { ruleId: 'UOM-002' }
    );
  }

  const unit = referenceRepository.findById('units', pack.unit_id);
  assertFractionAllowed(raw, unit.allows_fraction, unit.code);

  return {
    qtyMilli: quantity.toBaseUnits(raw, pack.factor_milli),
    soldUnitId: pack.unit_id,
    packFactorMilli: pack.factor_milli,
  };
}

function assertFractionAllowed(qtyMilli, allowsFraction, unitCode) {
  if (allowsFraction || qtyMilli % 1000 === 0) return;
  throw errors.badRequest(
    `${unitCode} cannot be sold in parts. Enter a whole number of ${unitCode}, or sell by weight.`,
    { ruleId: 'UOM-002' }
  );
}

// ── Reading ─────────────────────────────────────────────────────────────────

function get(saleId) {
  const sale = saleRepository.findById(saleId);
  if (!sale) throw errors.notFound('No such sale');
  return present(sale);
}

function getByNo(saleNo) {
  const sale = saleRepository.findByNo(saleNo);
  if (!sale) throw errors.notFound('No such sale');
  return present(sale);
}

function present(sale) {
  const items = saleRepository.itemsFor(sale.id);
  const tenders = saleRepository.tendersFor(sale.id);

  return {
    sale: {
      id: sale.id,
      sale_no: sale.sale_no,
      status: sale.status,
      customer_id: sale.customer_id,
      shift_id: sale.shift_id,
      price_level: sale.price_level,
      tax_mode: sale.tax_mode,
      subtotal_centavos: sale.subtotal_centavos,
      line_discount_centavos: sale.line_discount_centavos,
      txn_discount_centavos: sale.txn_discount_centavos,
      vatable_centavos: sale.vatable_centavos,
      vat_exempt_centavos: sale.vat_exempt_centavos,
      zero_rated_centavos: sale.zero_rated_centavos,
      vat_centavos: sale.vat_centavos,
      total_centavos: sale.total_centavos,
      change_centavos: sale.change_centavos,
      approved_by: sale.approved_by,
      occurred_at: sale.occurred_at,
      occurred_at_manila: clock.toManila(sale.occurred_at),
      created_by: sale.created_by,
    },
    items: items.map((item) => ({
      line_no: item.line_no,
      product_id: item.product_id,
      sku: item.product_sku,
      name: item.product_name_snapshot,
      qty_milli: item.qty_milli,
      qty_display: quantity.format(item.qty_milli, item.sold_unit_code),
      unit_price_centavos: item.unit_price_centavos,
      price_level_applied: item.price_level_applied,
      unit_cost_centavos: item.unit_cost_centavos,
      discount_centavos: item.discount_centavos,
      tax_class: item.tax_class_snapshot,
      tax_centavos: item.tax_centavos,
      line_total_centavos: item.line_total_centavos,
    })),
    tenders: tenders.map((tender) => ({
      method: tender.method,
      amount_centavos: tender.amount_centavos,
      reference_no: tender.reference_no,
      // POS-206: never displayed, printed or reported as anything but RECORDED.
      status: tender.status,
    })),
    // RPT-104 reads the snapshot, never the live product record.
    gross_profit_centavos: items.reduce(
      (sum, item) => sum + item.line_total_centavos - item.tax_centavos
        - money.toSafeNumber(money.divRoundHalfUp(BigInt(item.unit_cost_centavos) * BigInt(item.qty_milli), 1000n), 'line cost'),
      0
    ),
  };
}

function forShift(shiftId) {
  return saleRepository.listForShift(shiftId).map((sale) => present(sale).sale);
}

module.exports = {
  TENDERS, TENDER_METHODS,
  complete, get, getByNo, present, forShift,
  assertClientTotalMatches, settleTenders, resolveLineQuantity,
};
