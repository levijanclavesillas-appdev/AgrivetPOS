'use strict';

// FT-503 / FT-504 — the goods receipt. PO-201 to PO-207.
//
// This is the half of purchasing that moves stock and sets cost, and both of those are
// permanent: the average cost this file writes is the figure every gross-profit report
// will read for ever (PO-203, INV-106, MON-004, RPT-104).
//
// Four rules do the work.
//
//   PO-202 — **only the sound received quantity increases stock.** The damaged
//   quantity is recorded on the line and posts nothing. Fifty sacks with three split
//   is forty-seven sacks of stock and a number the store can take to the supplier.
//
//   PO-203 — the average moves at the **actual** received cost, never the ordered one.
//   An order is what the store expected to pay; the delivery is what it paid.
//
//   PO-204 / PO-205 — more than was ordered, or a cost outside tolerance, each need
//   authorisation and are flagged on the receipt. A supplier's price rise must be
//   noticed rather than absorbed, because a mis-keyed cost destroys every margin
//   figure downstream and does it silently.
//
//   PO-206 — a posted receipt is immutable. There is no update path in the repository,
//   and the correction is an adjustment or a supplier return (INV-102's reasoning:
//   what actually happened, including the mistake, stays legible).
//
// INV-107 binds them: the receipt, its lines, its movements, the on-hand update, the
// average-cost update and the purchase order's new status commit together or not at
// all.

const db = require('../config/database');
const ids = require('../config/ids');
const clock = require('../config/clock');
const errors = require('./errors');
const money = require('./money');
const quantity = require('./quantity');
const permissions = require('./permissions');
const authService = require('./authService');
const auditService = require('./auditService');
const settingsService = require('./settingsService');
const sequenceService = require('./sequenceService');
const inventoryService = require('./inventoryService');
const supplierService = require('./supplierService');
const purchaseOrderService = require('./purchaseOrderService');
const goodsReceiptRepository = require('../repositories/goodsReceiptRepository');
const purchaseOrderRepository = require('../repositories/purchaseOrderRepository');
const productRepository = require('../repositories/productRepository');

/** Who may authorise PO-204 and PO-205. PO-205 names the manager; the owner is above. */
const AUTHORISING_ROLES = Object.freeze(['MANAGER', 'OWNER']);

const BASIS_POINTS = 10000;

const text = (value, { max = 200 } = {}) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const textOrNull = (value, opts) => text(value, opts) || null;

// ── PO-205's arithmetic ─────────────────────────────────────────────────────

/**
 * How far the actual cost is from the baseline, in basis points, unsigned.
 *
 * Unsigned deliberately: a cost that came in far *below* what was ordered is as much a
 * mis-key as one above it, and it inflates every margin the store will report until
 * somebody notices. The rule says "differs", and this is that word.
 */
function varianceBasisPoints(actualCentavos, baselineCentavos) {
  if (!baselineCentavos || baselineCentavos <= 0) return null;
  const delta = BigInt(Math.abs(actualCentavos - baselineCentavos)) * BigInt(BASIS_POINTS);
  return money.toSafeNumber(money.divRoundHalfUp(delta, BigInt(baselineCentavos)), 'cost variance');
}

// ── Authorisation (PO-204, PO-205, AUD-603) ─────────────────────────────────

/**
 * SEC-6's approver resolution — the username looked up, the **stored** role the one
 * that counts, a deactivated user authorising nothing.
 *
 * It lives in authService, where identity lives, and is shared with returns
 * (TASK-020). `roles: null` skips the role check so the refusal below can name PO-204
 * or PO-205 rather than AUD-603 in general — which rule was broken is the part the
 * person reading the screen needs.
 */
const resolveApprover = (approver) => authService.resolveApprover(approver, { roles: null });

/**
 * Whether the exception is authorised, and by whom.
 *
 * A manager or owner doing the receiving **is** the authority PO-204 and PO-205 ask
 * for; requiring a second, distinct person would make an over-receipt impossible in a
 * store where the manager unloads the van, which is most of them. This is the same
 * carve-out INV-108 already makes for a large adjustment, recorded the same way: the
 * trail says `self_authorised` explicitly, because "an owner did this himself" and "no
 * authorisation was needed" read identically otherwise.
 *
 * Where the receiver is not a manager — an inventory clerk holds TX-409 — AUD-603's
 * distinct actors apply in full.
 */
function authorisationFor({ actor, approver, exceptions }) {
  if (exceptions.length === 0) {
    return { required: false, selfAuthorised: false, approver: null };
  }

  const selfAuthorised = AUTHORISING_ROLES.includes(actor.role);
  if (selfAuthorised) {
    return { required: true, selfAuthorised: true, approver: null };
  }

  const resolved = resolveApprover(approver);
  if (!resolved) {
    throw errors.forbidden(
      `${exceptions.map((e) => e.message).join(' ')} A manager or owner must authorise this delivery.`,
      { ruleId: exceptions[0].ruleId, requiresRole: AUTHORISING_ROLES.join(' or ') }
    );
  }
  if (!AUTHORISING_ROLES.includes(resolved.role)) {
    throw errors.forbidden(
      `${resolved.username} is a ${resolved.role.toLowerCase()} and cannot authorise this delivery.`,
      { ruleId: exceptions[0].ruleId, requiresRole: AUTHORISING_ROLES.join(' or ') }
    );
  }
  if (resolved.id && actor.id && resolved.id === actor.id) {
    throw errors.forbidden('A delivery must be authorised by a different user.', { ruleId: 'AUD-603' });
  }

  return { required: true, selfAuthorised: false, approver: resolved };
}

// ── Resolving the lines (PO-201 to PO-205) ──────────────────────────────────

function resolveLines({ input, order, orderLines }) {
  const lines = Array.isArray(input) ? input : [];
  if (lines.length === 0) {
    throw errors.badRequest('A delivery needs at least one line', { ruleId: 'PO-201' });
  }

  const tolerance = settingsService.get('cost_variance_tolerance_bp');
  const byId = new Map(orderLines.map((line) => [line.id, line]));
  const seen = new Set();

  return lines.map((line, index) => {
    const orderLine = line.poItemId ? byId.get(line.poItemId) : null;
    if (line.poItemId && !orderLine) {
      throw errors.badRequest(
        `Line ${index + 1} is not a line on ${order ? order.po_no : 'this order'}`,
        { ruleId: 'PO-201' }
      );
    }

    const productId = orderLine ? orderLine.product_id : line.productId;
    const product = productRepository.findById(productId);
    if (!product) throw errors.notFound(`No such product on line ${index + 1}`);
    if (!product.is_active && !orderLine) {
      throw errors.conflict(
        `${product.name} is deactivated and cannot be received.`,
        { ruleId: 'VR-206' }
      );
    }
    if (seen.has(product.id)) {
      throw errors.badRequest(
        `${product.name} is on this delivery twice. Put the whole quantity on one line.`,
        { ruleId: 'PO-201' }
      );
    }
    seen.add(product.id);

    // PO-201: what the van actually brought, and how much of it was unsound.
    const receivedQtyMilli = Number.parseInt(line.receivedQtyMilli, 10);
    if (!Number.isInteger(receivedQtyMilli) || receivedQtyMilli <= 0) {
      throw errors.badRequest(
        `Line ${index + 1} needs a received quantity greater than zero. `
        + 'A line that did not arrive is left off the delivery.',
        { ruleId: 'MON-002' }
      );
    }
    quantity.assertMilli(receivedQtyMilli, 'received quantity');

    const damagedQtyMilli = line.damagedQtyMilli === undefined || line.damagedQtyMilli === null
      ? 0
      : Number.parseInt(line.damagedQtyMilli, 10);
    if (!Number.isInteger(damagedQtyMilli) || damagedQtyMilli < 0) {
      throw errors.badRequest(`Line ${index + 1} has an unusable damaged quantity`, { ruleId: 'PO-202' });
    }
    if (damagedQtyMilli > receivedQtyMilli) {
      throw errors.badRequest(
        `Line ${index + 1} says more arrived damaged than arrived at all. `
        + 'The damaged quantity is part of what was received, not extra to it.',
        { ruleId: 'PO-202' }
      );
    }

    // PO-202 — the figure that becomes stock.
    const soundQtyMilli = receivedQtyMilli - damagedQtyMilli;

    const unitCostCentavos = Number.parseInt(line.unitCostCentavos, 10);
    if (!Number.isInteger(unitCostCentavos) || unitCostCentavos < 0) {
      throw errors.badRequest(
        `Line ${index + 1} needs the unit cost actually charged`,
        { ruleId: 'PO-203' }
      );
    }
    money.assertCentavos(unitCostCentavos, 'received unit cost');

    const packFactor = line.packFactorMilli === undefined || line.packFactorMilli === null
      ? (orderLine ? orderLine.order_pack_factor_milli : 1000)
      : Number.parseInt(line.packFactorMilli, 10);
    if (!Number.isInteger(packFactor) || packFactor <= 0) {
      throw errors.badRequest(`Line ${index + 1} has an unusable pack size`, { ruleId: 'UOM-002' });
    }

    // ── PO-204: more than was ordered, counting what earlier deliveries brought ──
    const orderedQtyMilli = orderLine ? orderLine.qty_milli : 0;
    const alreadyReceived = orderLine ? orderLine.received_qty_milli : 0;
    const isOverReceipt = Boolean(orderLine) && (alreadyReceived + receivedQtyMilli) > orderedQtyMilli;

    // ── PO-205: a cost outside tolerance of what it was measured against ──
    //
    // Against the ordered cost where there is an order. On a direct receipt there is
    // no ordered cost, and PO-207 says a direct receipt "follows every other receipt
    // rule" — so the baseline is the product's prevailing average, which is the only
    // other figure that says what this store has been paying. A product that has never
    // been costed has no baseline and the check does not apply; there is nothing yet
    // to be a variance from.
    const orderedUnitCost = orderLine ? orderLine.unit_cost_centavos : null;
    const baseline = orderedUnitCost !== null && orderedUnitCost > 0
      ? orderedUnitCost
      : (product.avg_cost_centavos > 0 ? product.avg_cost_centavos : null);
    const baselineSource = orderedUnitCost !== null && orderedUnitCost > 0
      ? 'ordered cost'
      : (baseline ? 'average cost' : null);
    const varianceBp = baseline === null ? null : varianceBasisPoints(unitCostCentavos, baseline);
    const isCostVariance = varianceBp !== null && varianceBp > tolerance;

    return {
      product,
      orderLine,
      line_no: index + 1,
      po_item_id: orderLine ? orderLine.id : null,
      product_id: product.id,
      product_name_snapshot: product.name,
      ordered_qty_milli: orderedQtyMilli,
      received_qty_milli: receivedQtyMilli,
      damaged_qty_milli: damagedQtyMilli,
      sound_qty_milli: soundQtyMilli,
      receive_unit_id: textOrNull(line.receiveUnitId, { max: 40 })
        || (orderLine ? orderLine.order_unit_id : null),
      receive_pack_factor_milli: packFactor,
      unit_cost_centavos: unitCostCentavos,
      ordered_unit_cost_centavos: orderedUnitCost,
      cost_variance_bp: varianceBp,
      // MON-003 — rounded once. The value that entered stock, so the receipt ties to
      // the inventory ledger; what the store *owes* is the received quantity at this
      // cost less whatever the damaged goods are credited for, which is FT-505's
      // question in v1.2 and is derivable from the columns beside this one.
      line_total_centavos: money.mulQty(unitCostCentavos, soundQtyMilli),
      is_over_receipt: isOverReceipt,
      is_cost_variance: isCostVariance,
      baseline_centavos: baseline,
      baseline_source: baselineSource,
      batch_no: textOrNull(line.batchNo, { max: 60 }),
      expiry_date: textOrNull(line.expiryDate, { max: 40 }),
      damage_note: textOrNull(line.damageNote, { max: 200 }),
    };
  });
}

/** The exceptions on a delivery, as sentences the authorisation panel can show. */
function exceptionsFor(resolved) {
  const out = [];

  const over = resolved.filter((line) => line.is_over_receipt);
  if (over.length > 0) {
    out.push({
      ruleId: 'PO-204',
      kind: 'OVER_RECEIPT',
      message: over.map((line) => {
        const excess = (line.orderLine.received_qty_milli + line.received_qty_milli) - line.ordered_qty_milli;
        return `${line.product_name_snapshot}: `
          + `${quantity.format(excess, line.product.base_unit_code)} more than was ordered.`;
      }).join(' '),
      lines: over.map((line) => line.line_no),
    });
  }

  const varied = resolved.filter((line) => line.is_cost_variance);
  if (varied.length > 0) {
    out.push({
      ruleId: 'PO-205',
      kind: 'COST_VARIANCE',
      message: varied.map((line) => {
        const direction = line.unit_cost_centavos > line.baseline_centavos ? 'above' : 'below';
        return `${line.product_name_snapshot}: ${money.toDisplay(line.unit_cost_centavos)} is `
          + `${(line.cost_variance_bp / 100).toFixed(1)}% ${direction} the `
          + `${line.baseline_source} of ${money.toDisplay(line.baseline_centavos)}.`;
      }).join(' '),
      lines: varied.map((line) => line.line_no),
    });
  }

  return out;
}

// ── The public shape ────────────────────────────────────────────────────────

function presentLine(row) {
  return {
    id: row.id,
    line_no: row.line_no,
    po_item_id: row.po_item_id,
    product_id: row.product_id,
    sku: row.sku,
    product_name: row.product_name_snapshot,
    base_unit_code: row.base_unit_code,
    receive_unit_code: row.receive_unit_code,
    ordered_qty_milli: row.ordered_qty_milli,
    ordered_display: quantity.format(row.ordered_qty_milli, row.base_unit_code),
    received_qty_milli: row.received_qty_milli,
    received_display: quantity.format(row.received_qty_milli, row.base_unit_code),
    damaged_qty_milli: row.damaged_qty_milli,
    damaged_display: quantity.format(row.damaged_qty_milli, row.base_unit_code),
    sound_qty_milli: row.sound_qty_milli,
    sound_display: quantity.format(row.sound_qty_milli, row.base_unit_code),
    unit_cost_centavos: row.unit_cost_centavos,
    ordered_unit_cost_centavos: row.ordered_unit_cost_centavos,
    cost_variance_bp: row.cost_variance_bp,
    line_total_centavos: row.line_total_centavos,
    is_over_receipt: Boolean(row.is_over_receipt),
    is_cost_variance: Boolean(row.is_cost_variance),
    batch_no: row.batch_no,
    expiry_date: row.expiry_date,
    damage_note: row.damage_note,
    // PO-202, said out loud on the line rather than left to be inferred from three
    // numbers: this is the figure that became stock, and this is the one that did not.
    movement_id: row.movement_id,
    posted_to_stock: Boolean(row.movement_id),
  };
}

function toPublic(row, { lines = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    gr_no: row.gr_no,
    po_id: row.po_id,
    po_no: row.po_no,
    supplier: { id: row.supplier_id, name: row.supplier_name, code: row.supplier_code },
    supplier_dr_no: row.supplier_dr_no,
    invoice_no: row.invoice_no,
    status: row.status,
    // PO-206, said in the payload so a screen never offers an edit button it would
    // then have to explain away.
    is_immutable: true,
    total_centavos: row.total_centavos,
    has_over_receipt: Boolean(row.has_over_receipt),
    has_cost_variance: Boolean(row.has_cost_variance),
    approved_by: row.approved_by_username || null,
    approval_reason: row.approval_reason,
    notes: row.notes,
    received_at: row.received_at,
    received_at_manila: clock.toManila(row.received_at),
    created_by: row.created_by_username || row.created_by,
    line_count: row.line_count ?? (lines ? lines.length : null),
    ...(lines ? { lines: lines.map(presentLine) } : {}),
  };
}

// ── Reading ─────────────────────────────────────────────────────────────────

function get(id) {
  const row = goodsReceiptRepository.findById(id);
  if (!row) throw errors.notFound('No such goods receipt');
  return toPublic(row, { lines: goodsReceiptRepository.itemsFor(id) });
}

function search(opts = {}) {
  const filters = {
    supplierId: textOrNull(opts.supplierId, { max: 40 }),
    poId: textOrNull(opts.poId, { max: 40 }),
    q: textOrNull(opts.q, { max: 60 }),
    from: textOrNull(opts.from, { max: 40 }),
    to: textOrNull(opts.to, { max: 40 }),
    flaggedOnly: opts.flaggedOnly === true || opts.flaggedOnly === 'true',
  };
  const limit = Math.min(Math.max(Number.parseInt(opts.limit, 10) || 50, 1), 200);
  const offset = Math.max(Number.parseInt(opts.offset, 10) || 0, 0);

  return {
    total: goodsReceiptRepository.countSearch(filters),
    limit,
    offset,
    goods_receipts: goodsReceiptRepository.search({ ...filters, limit, offset }).map((row) => toPublic(row)),
  };
}

/** Every delivery of one product — what it has cost, from whom, and when. */
function historyForProduct(productId, { limit = 50, offset = 0 } = {}) {
  const product = productRepository.findById(productId);
  if (!product) throw errors.notFound('No such product');
  return {
    product: { id: product.id, sku: product.sku, name: product.name },
    receipts: goodsReceiptRepository.historyForProduct(productId, { limit, offset }),
  };
}

// ── Posting (PO-201 to PO-207, INV-107) ─────────────────────────────────────

/**
 * Post a delivery.
 *
 * One transaction: the receipt, its lines, the RECEIPT movements, the on-hand figures,
 * the average costs and the order's new status commit together or not at all
 * (INV-107). A half-posted delivery is a stock figure nobody can reconcile.
 */
function post(input, actor) {
  if (!permissions.can(actor, 'TX-409')) {
    throw errors.forbidden(
      'You do not have permission to receive goods.',
      { ruleId: 'TX-409', requiresRole: permissions.rolesHolding('TX-409').join(' or ') }
    );
  }

  // ── Which order, if any (PO-207) ──
  const order = input.poId ? purchaseOrderRepository.findById(input.poId) : null;
  if (input.poId && !order) throw errors.notFound('No such purchase order');

  if (order && !purchaseOrderService.OPEN_STATUSES.includes(order.status)) {
    throw errors.conflict(
      `${order.po_no} is ${purchaseOrderService.STATUS_LABELS[order.status].toLowerCase()} `
      + 'and is not awaiting a delivery.',
      { ruleId: 'PO-102' }
    );
  }

  // PO-207 — a direct receipt still requires a supplier. Where there is an order the
  // supplier is the order's, and is not the caller's to disagree with.
  const supplier = order
    ? supplierService.requireActive(order.supplier_id, { ruleId: 'PO-207' })
    : supplierService.requireActive(input.supplierId, { ruleId: 'PO-207' });

  const orderLines = order ? purchaseOrderRepository.itemsFor(order.id) : [];
  const resolved = resolveLines({ input: input.lines, order, orderLines });

  const exceptions = exceptionsFor(resolved);
  const authorisation = authorisationFor({ actor, approver: input.approver, exceptions });
  const approvalReason = textOrNull(input.approvalReason, { max: 200 });

  const at = textOrNull(input.receivedAt, { max: 40 }) || clock.nowUtc();

  // Known before anything is written, so the header goes in complete: PO-206 makes a
  // posted receipt immutable, and a row that has to be updated once to become correct
  // is a row with a moment in which it was not.
  const total = resolved.reduce((sum, line) => sum + line.line_total_centavos, 0);

  return db.transaction(() => {
    const grNo = sequenceService.next('GOODS_RECEIPT', { at });
    const grId = ids.uuidv7();

    const header = goodsReceiptRepository.insert({
      id: grId,
      gr_no: grNo,
      po_id: order ? order.id : null,
      supplier_id: supplier.id,
      supplier_dr_no: textOrNull(input.supplierDrNo, { max: 60 }),
      invoice_no: textOrNull(input.invoiceNo, { max: 60 }),
      status: 'POSTED',
      total_centavos: total,
      has_over_receipt: resolved.some((line) => line.is_over_receipt) ? 1 : 0,
      has_cost_variance: resolved.some((line) => line.is_cost_variance) ? 1 : 0,
      approved_by: authorisation.approver ? authorisation.approver.id : null,
      approval_reason: exceptions.length > 0
        ? approvalReason || exceptions.map((e) => e.message).join(' ')
        : null,
      notes: textOrNull(input.notes, { max: 500 }),
      received_at: at,
      created_at: clock.nowUtc(),
      created_by: actor.id,
    });

    const posted = [];

    for (const line of resolved) {
      // ── PO-202 — the sound quantity, and only the sound quantity ──
      //
      // A line that arrived entirely broken is recorded and posts nothing. There is no
      // movement of zero: INV-103 refuses one, and rightly — a movement of nothing sits
      // in the ledger looking like a lost quantity.
      let movement = null;
      if (line.sound_qty_milli > 0) {
        movement = inventoryService.post({
          productId: line.product_id,
          type: 'RECEIPT',
          qtyMilli: line.sound_qty_milli,
          // PO-203 — the **actual** cost. This is the figure every gross-profit report
          // will read for ever, and the ordered cost is not it.
          unitCostCentavos: line.unit_cost_centavos,
          actor,
          referenceType: 'goods_receipt',
          referenceId: grId,
          referenceNo: grNo,
          occurredAt: at,
        });
      }

      goodsReceiptRepository.insertItem({
        id: ids.uuidv7(),
        gr_id: grId,
        line_no: line.line_no,
        po_item_id: line.po_item_id,
        product_id: line.product_id,
        product_name_snapshot: line.product_name_snapshot,
        ordered_qty_milli: line.ordered_qty_milli,
        received_qty_milli: line.received_qty_milli,
        damaged_qty_milli: line.damaged_qty_milli,
        sound_qty_milli: line.sound_qty_milli,
        receive_unit_id: line.receive_unit_id,
        receive_pack_factor_milli: line.receive_pack_factor_milli,
        unit_cost_centavos: line.unit_cost_centavos,
        ordered_unit_cost_centavos: line.ordered_unit_cost_centavos,
        cost_variance_bp: line.cost_variance_bp,
        line_total_centavos: line.line_total_centavos,
        is_over_receipt: line.is_over_receipt ? 1 : 0,
        is_cost_variance: line.is_cost_variance ? 1 : 0,
        batch_no: line.batch_no,
        expiry_date: line.expiry_date,
        movement_id: movement ? movement.movement.id : null,
        damage_note: line.damage_note,
      });

      posted.push({
        product: line.product_name_snapshot,
        received_qty_milli: line.received_qty_milli,
        damaged_qty_milli: line.damaged_qty_milli,
        sound_qty_milli: line.sound_qty_milli,
        unit_cost_centavos: line.unit_cost_centavos,
        ordered_unit_cost_centavos: line.ordered_unit_cost_centavos,
        avg_cost_centavos: movement ? movement.avgCostCentavos : null,
        movement_id: movement ? movement.movement.id : null,
      });
    }

    // ── PO-102: the order's new status, derived from the receipts ──
    let orderAfter = null;
    if (order) {
      orderAfter = purchaseOrderService.refreshStatusAfterReceipt(order.id, actor, { at });
    }

    auditService.write({
      actor,
      approver: authorisation.approver,
      action: 'GOODS_RECEIVED',
      entityType: 'goods_receipts',
      entityId: grId,
      before: order
        ? { po_no: order.po_no, po_status: order.status }
        : null,
      after: {
        gr_no: grNo,
        supplier: supplier.name,
        po_no: order ? order.po_no : null,
        po_status: orderAfter ? orderAfter.status : null,
        total_centavos: total,
        lines: posted,
        over_receipt: header.has_over_receipt === 1,
        cost_variance: header.has_cost_variance === 1,
        authorisation_required: authorisation.required,
        // Recorded explicitly, as INV-108's is: "a manager did this himself" and
        // "no authorisation was needed" read identically otherwise.
        self_authorised: authorisation.selfAuthorised,
      },
      reason: exceptions.length > 0
        ? approvalReason || exceptions.map((e) => e.message).join(' ')
        : null,
    });

    // AUD-603's own row, one per override, and only where a second person actually
    // authorised it — `recordOverride` refuses an approver who is the actor, which is
    // the whole point of the two columns.
    if (authorisation.approver) {
      for (const exception of exceptions) {
        auditService.recordOverride({
          action: exception.kind === 'OVER_RECEIPT'
            ? 'OVERRIDE_OVER_RECEIPT'
            : 'OVERRIDE_COST_VARIANCE',
          actor,
          approver: authorisation.approver,
          reason: approvalReason || exception.message,
          entityType: 'goods_receipts',
          entityId: grId,
          after: { gr_no: grNo, rule_id: exception.ruleId, lines: exception.lines },
        });
      }
    }

    return {
      ...get(grId),
      purchase_order: orderAfter
        ? { id: orderAfter.id, po_no: orderAfter.po_no, status: orderAfter.status }
        : null,
      authorisation: {
        required: authorisation.required,
        self_authorised: authorisation.selfAuthorised,
        authorised_by: authorisation.approver ? authorisation.approver.username : null,
        exceptions,
      },
    };
  });
}

module.exports = {
  AUTHORISING_ROLES, BASIS_POINTS,
  varianceBasisPoints, resolveApprover, authorisationFor, resolveLines, exceptionsFor,
  presentLine, toPublic, get, search, historyForProduct, post,
};
