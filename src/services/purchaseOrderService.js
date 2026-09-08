'use strict';

// FT-502 / PO-101–PO-105 — the purchase order and its lifecycle.
//
// **PO-103 is the rule that shapes this file: a purchase order moves no stock.** There
// is no call to inventoryService anywhere in it, and TC-INT-76 asserts that no PO
// operation writes a movement. A system where raising an order changes on hand is a
// system whose stock figure means "what we expect" rather than "what is on the shelf",
// and INV-101 has meant the second since TASK-007.
//
// PO-104 is the second: a DRAFT is edited freely, and once the order has been sent it
// is amended by a **new revision** rather than overwritten. The supplier has been told
// a number and is holding a printed copy of something; the store needs to be able to
// say which version that was. So `po_no` never changes, `revision` moves with it, and
// the superseded lines are written to the audit trail, which AUD-601 already requires
// to carry both values.

const db = require('../config/database');
const ids = require('../config/ids');
const clock = require('../config/clock');
const errors = require('./errors');
const money = require('./money');
const quantity = require('./quantity');
const auditService = require('./auditService');
const sequenceService = require('./sequenceService');
const supplierService = require('./supplierService');
const purchaseOrderRepository = require('../repositories/purchaseOrderRepository');
const productRepository = require('../repositories/productRepository');

/**
 * PO-102's machine, written out. Nothing else is legal, and `CANCELLED` is reachable
 * from `DRAFT` and `PENDING` only — which is also PO-105, because a PO with anything
 * received against it is no longer in either state.
 */
const STATUSES = Object.freeze(['DRAFT', 'PENDING', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED']);

const TRANSITIONS = Object.freeze({
  DRAFT: ['PENDING', 'CANCELLED'],
  PENDING: ['PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
  PARTIALLY_RECEIVED: ['RECEIVED'],
  RECEIVED: [],
  CANCELLED: [],
});

const STATUS_LABELS = Object.freeze({
  DRAFT: 'Draft',
  PENDING: 'Sent to supplier',
  PARTIALLY_RECEIVED: 'Partly received',
  RECEIVED: 'Received',
  CANCELLED: 'Cancelled',
});

/** The two states in which the order is still awaiting goods. */
const OPEN_STATUSES = Object.freeze(['PENDING', 'PARTIALLY_RECEIVED']);

const text = (value, { max = 200 } = {}) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const textOrNull = (value, opts) => text(value, opts) || null;

function assertTransition(from, to, { ruleId = 'PO-102' } = {}) {
  if (!STATUSES.includes(to)) throw new RangeError(`unknown purchase order status: ${to} (PO-102)`);
  if (!TRANSITIONS[from].includes(to)) {
    throw errors.conflict(
      `A ${STATUS_LABELS[from].toLowerCase()} order cannot become ${STATUS_LABELS[to].toLowerCase()}.`,
      { ruleId }
    );
  }
  return to;
}

// ── Lines ───────────────────────────────────────────────────────────────────

/**
 * Validate and cost the lines an order is raised or amended with.
 *
 * Quantities are base-unit thousandths (MON-002); the pack the buyer actually ordered
 * in is recorded beside them (UOM-002) so the screen can say "50 SACK" rather than
 * "2,500 KG", and the ledger figure stays the base-unit one. The line total is rounded
 * exactly once, at the line (MON-003).
 */
function resolveLines(input) {
  const lines = Array.isArray(input) ? input : [];
  if (lines.length === 0) {
    throw errors.badRequest('A purchase order needs at least one line', { ruleId: 'PO-101' });
  }

  const seen = new Set();
  return lines.map((line, index) => {
    const product = productRepository.findById(line.productId);
    if (!product) throw errors.notFound(`No such product on line ${index + 1}`);
    if (!product.is_active) {
      throw errors.conflict(
        `${product.name} is deactivated and cannot be ordered.`,
        { ruleId: 'VR-206' }
      );
    }
    if (seen.has(product.id)) {
      // Two lines for the same product make "how much of this is outstanding"
      // ambiguous on receipt, and the buyer meant one line with a bigger number.
      throw errors.badRequest(
        `${product.name} is on this order twice. Put the whole quantity on one line.`,
        { ruleId: 'PO-101' }
      );
    }
    seen.add(product.id);

    const qtyMilli = Number.parseInt(line.qtyMilli, 10);
    if (!Number.isInteger(qtyMilli) || qtyMilli <= 0) {
      throw errors.badRequest(
        `Line ${index + 1} needs a quantity greater than zero`,
        { ruleId: 'MON-002' }
      );
    }
    quantity.assertMilli(qtyMilli, 'ordered quantity');

    const unitCostCentavos = Number.parseInt(line.unitCostCentavos, 10);
    if (!Number.isInteger(unitCostCentavos) || unitCostCentavos < 0) {
      throw errors.badRequest(
        `Line ${index + 1} needs a unit cost of zero or more`,
        { ruleId: 'MON-001' }
      );
    }
    money.assertCentavos(unitCostCentavos, 'ordered unit cost');

    const packFactor = line.packFactorMilli === undefined || line.packFactorMilli === null
      ? 1000
      : Number.parseInt(line.packFactorMilli, 10);
    if (!Number.isInteger(packFactor) || packFactor <= 0) {
      throw errors.badRequest(`Line ${index + 1} has an unusable pack size`, { ruleId: 'UOM-002' });
    }

    return {
      product,
      line_no: index + 1,
      product_id: product.id,
      product_name_snapshot: product.name,
      qty_milli: qtyMilli,
      order_unit_id: textOrNull(line.orderUnitId, { max: 40 }),
      order_pack_factor_milli: packFactor,
      unit_cost_centavos: unitCostCentavos,
      // MON-003 — rounded once, here, and never re-derived from a displayed figure.
      line_total_centavos: money.mulQty(unitCostCentavos, qtyMilli),
      notes: textOrNull(line.notes, { max: 200 }),
    };
  });
}

function writeLines(poId, resolved) {
  purchaseOrderRepository.deleteItems(poId);
  for (const line of resolved) {
    purchaseOrderRepository.insertItem({
      id: ids.uuidv7(),
      po_id: poId,
      line_no: line.line_no,
      product_id: line.product_id,
      product_name_snapshot: line.product_name_snapshot,
      qty_milli: line.qty_milli,
      order_unit_id: line.order_unit_id,
      order_pack_factor_milli: line.order_pack_factor_milli,
      unit_cost_centavos: line.unit_cost_centavos,
      line_total_centavos: line.line_total_centavos,
      notes: line.notes,
    });
  }
  return resolved.reduce((sum, line) => sum + line.line_total_centavos, 0);
}

/**
 * Whether the lines actually moved.
 *
 * PO-104 raises a revision because the supplier is holding a copy of something
 * different. A PUT that posts the form back unchanged has not made that true, and a
 * revision counter that climbs every time somebody opens the screen tells the store
 * nothing about which version the mill has.
 */
function linesDiffer(beforeLines, resolved) {
  if (!resolved) return false;
  if (beforeLines.length !== resolved.length) return true;
  return resolved.some((line, index) => {
    const was = beforeLines[index];
    return was.product_id !== line.product_id
      || was.qty_milli !== line.qty_milli
      || was.unit_cost_centavos !== line.unit_cost_centavos;
  });
}

/** The line shape the audit trail keeps, so a superseded revision stays readable. */
const auditLines = (resolved) => resolved.map((line) => ({
  product: line.product_name_snapshot,
  qty_milli: line.qty_milli,
  unit_cost_centavos: line.unit_cost_centavos,
  line_total_centavos: line.line_total_centavos,
}));

// ── The public shape ────────────────────────────────────────────────────────

function presentLine(row) {
  const outstanding = Math.max(row.qty_milli - row.received_qty_milli, 0);
  return {
    id: row.id,
    line_no: row.line_no,
    product_id: row.product_id,
    sku: row.sku,
    product_name: row.product_name_snapshot,
    base_unit_code: row.base_unit_code,
    order_unit_code: row.order_unit_code,
    order_pack_factor_milli: row.order_pack_factor_milli,
    qty_milli: row.qty_milli,
    qty_display: quantity.format(row.qty_milli, row.base_unit_code),
    unit_cost_centavos: row.unit_cost_centavos,
    line_total_centavos: row.line_total_centavos,
    received_qty_milli: row.received_qty_milli,
    received_display: quantity.format(row.received_qty_milli, row.base_unit_code),
    damaged_qty_milli: row.damaged_qty_milli,
    outstanding_qty_milli: outstanding,
    outstanding_display: quantity.format(outstanding, row.base_unit_code),
    is_complete: row.received_qty_milli >= row.qty_milli,
    notes: row.notes,
  };
}

function toPublic(row, { lines = null, receipts = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    po_no: row.po_no,
    revision: row.revision,
    // "PO-20260908-000014 rev 2" — the sentence both sides of a phone call can use.
    reference_label: row.revision > 1 ? `${row.po_no} rev ${row.revision}` : row.po_no,
    supplier: {
      id: row.supplier_id,
      name: row.supplier_name,
      code: row.supplier_code,
      terms_days: row.supplier_terms_days,
    },
    status: row.status,
    status_label: STATUS_LABELS[row.status],
    is_open: OPEN_STATUSES.includes(row.status),
    // PO-104 and PO-105, answered by the server rather than re-derived by a screen
    // that would then be wrong the day either rule changed.
    can_edit: row.status === 'DRAFT',
    can_amend: row.status === 'PENDING',
    can_submit: row.status === 'DRAFT',
    can_cancel: TRANSITIONS[row.status].includes('CANCELLED'),
    can_receive: OPEN_STATUSES.includes(row.status),
    ordered_at: row.ordered_at,
    expected_at: row.expected_at,
    reference_no: row.reference_no,
    notes: row.notes,
    total_centavos: row.total_centavos,
    line_count: row.line_count ?? (lines ? lines.length : null),
    submitted_at: row.submitted_at,
    cancelled_at: row.cancelled_at,
    cancel_reason: row.cancel_reason,
    completed_at: row.completed_at,
    created_at: row.created_at,
    ...(lines ? { lines: lines.map(presentLine) } : {}),
    ...(receipts ? { receipts } : {}),
  };
}

// ── Reading ─────────────────────────────────────────────────────────────────

function find(id) {
  return purchaseOrderRepository.findById(id);
}

function get(id) {
  const row = purchaseOrderRepository.findById(id);
  if (!row) throw errors.notFound('No such purchase order');
  return toPublic(row, {
    lines: purchaseOrderRepository.itemsFor(id),
    receipts: purchaseOrderRepository.receiptsFor(id),
  });
}

function search(opts = {}) {
  const filters = {
    supplierId: textOrNull(opts.supplierId, { max: 40 }),
    status: opts.status && STATUSES.includes(String(opts.status).toUpperCase())
      ? String(opts.status).toUpperCase()
      : null,
    open: opts.open === true || opts.open === 'true',
    q: textOrNull(opts.q, { max: 60 }),
    from: textOrNull(opts.from, { max: 40 }),
    to: textOrNull(opts.to, { max: 40 }),
  };
  const limit = Math.min(Math.max(Number.parseInt(opts.limit, 10) || 50, 1), 200);
  const offset = Math.max(Number.parseInt(opts.offset, 10) || 0, 0);

  return {
    // The enumerations the list filters are built from, served rather than copied
    // into the screen — a screen with its own copy of a list the server validates
    // against is wrong the day the list changes (the reasoning behind TC-UI-07).
    statuses: STATUSES.map((status) => ({ status, label: STATUS_LABELS[status] })),
    total: purchaseOrderRepository.countSearch(filters),
    limit,
    offset,
    purchase_orders: purchaseOrderRepository.search({ ...filters, limit, offset })
      .map((row) => toPublic(row)),
  };
}

// ── Raising and editing (PO-101, PO-104) ────────────────────────────────────

function create(input, actor) {
  const supplier = supplierService.requireActive(input.supplierId);
  const resolved = resolveLines(input.lines);
  const at = clock.nowUtc();

  return db.transaction(() => {
    // Allocated inside the transaction, so a rollback frees the number (VR-103).
    const poNo = sequenceService.next('PURCHASE_ORDER', { at });

    const row = purchaseOrderRepository.insert({
      id: ids.uuidv7(),
      po_no: poNo,
      supplier_id: supplier.id,
      status: 'DRAFT',
      revision: 1,
      ordered_at: null,
      expected_at: textOrNull(input.expectedAt, { max: 40 }),
      reference_no: textOrNull(input.referenceNo, { max: 60 }),
      notes: textOrNull(input.notes, { max: 500 }),
      total_centavos: 0,
      submitted_at: null, submitted_by: null,
      cancelled_at: null, cancelled_by: null, cancel_reason: null,
      completed_at: null,
      created_at: at,
      created_by: actor.id,
      updated_at: null, updated_by: null,
    });

    const total = writeLines(row.id, resolved);
    purchaseOrderRepository.updateFields(row.id, { total_centavos: total });

    auditService.write({
      actor,
      action: 'PURCHASE_ORDER_CREATED',
      entityType: 'purchase_orders',
      entityId: row.id,
      after: {
        po_no: poNo, supplier: supplier.name, revision: 1,
        total_centavos: total, lines: auditLines(resolved),
      },
    });

    return get(row.id);
  });
}

/**
 * PO-104's two halves, in one call.
 *
 * A `DRAFT` is edited in place: nobody outside the store has seen it. A `PENDING`
 * order is **amended** — same number, next revision — and the superseded lines go to
 * the audit trail, because the supplier is holding a copy of the previous one.
 * Anything else is refused: an order already being delivered against is not something
 * to re-write underneath the delivery.
 */
function update(id, input, actor) {
  const before = purchaseOrderRepository.findById(id);
  if (!before) throw errors.notFound('No such purchase order');

  if (before.status !== 'DRAFT' && before.status !== 'PENDING') {
    throw errors.conflict(
      `${before.po_no} is ${STATUS_LABELS[before.status].toLowerCase()} and can no longer be changed. `
      + 'Raise a new order for anything further.',
      { ruleId: 'PO-104' }
    );
  }

  const beforeLines = purchaseOrderRepository.itemsFor(id);
  const resolved = input.lines === undefined
    ? null
    : resolveLines(input.lines);

  const at = clock.nowUtc();
  const fields = { updated_at: at, updated_by: actor.id };
  if (input.expectedAt !== undefined) fields.expected_at = textOrNull(input.expectedAt, { max: 40 });
  if (input.referenceNo !== undefined) fields.reference_no = textOrNull(input.referenceNo, { max: 60 });
  if (input.notes !== undefined) fields.notes = textOrNull(input.notes, { max: 500 });

  // What the supplier was told: the lines, the date they were promised for, and the
  // number they file it under. `notes` is not among them — it is the store's own
  // annotation, and raising a revision over it would mean ringing the mill to tell
  // them about a note they have never seen.
  const supplierFacing =
    linesDiffer(beforeLines, resolved)
    || (fields.expected_at !== undefined && fields.expected_at !== before.expected_at)
    || (fields.reference_no !== undefined && fields.reference_no !== before.reference_no);

  const amending = before.status === 'PENDING' && supplierFacing;

  return db.transaction(() => {
    if (resolved) {
      fields.total_centavos = writeLines(id, resolved);
    }
    if (amending) {
      // The number the supplier was told stays; the revision moves.
      fields.revision = before.revision + 1;
    }

    const row = purchaseOrderRepository.updateFields(id, fields);

    auditService.write({
      actor,
      action: amending ? 'PURCHASE_ORDER_AMENDED' : 'PURCHASE_ORDER_MODIFIED',
      entityType: 'purchase_orders',
      entityId: id,
      before: {
        revision: before.revision,
        total_centavos: before.total_centavos,
        lines: beforeLines.map((line) => ({
          product: line.product_name_snapshot,
          qty_milli: line.qty_milli,
          unit_cost_centavos: line.unit_cost_centavos,
          line_total_centavos: line.line_total_centavos,
        })),
      },
      after: {
        revision: row.revision,
        total_centavos: row.total_centavos,
        lines: resolved ? auditLines(resolved) : 'unchanged',
      },
      reason: amending
        ? textOrNull(input.reason, { max: 200 })
          || `Amended to revision ${row.revision} after the order was sent`
        : null,
    });

    return get(id);
  });
}

// ── The lifecycle (PO-102, PO-105) ──────────────────────────────────────────

/** DRAFT → PENDING. The order has been sent; from here it is amended, not edited. */
function submit(id, actor) {
  const before = purchaseOrderRepository.findById(id);
  if (!before) throw errors.notFound('No such purchase order');
  assertTransition(before.status, 'PENDING');

  const lines = purchaseOrderRepository.itemsFor(id);
  if (lines.length === 0) {
    throw errors.badRequest('An order with no lines cannot be sent', { ruleId: 'PO-101' });
  }

  const at = clock.nowUtc();

  return db.transaction(() => {
    const row = purchaseOrderRepository.updateFields(id, {
      status: 'PENDING',
      ordered_at: at,
      submitted_at: at,
      submitted_by: actor.id,
      updated_at: at,
      updated_by: actor.id,
    });

    auditService.write({
      actor,
      action: 'PURCHASE_ORDER_SUBMITTED',
      entityType: 'purchase_orders',
      entityId: id,
      before: { status: before.status },
      after: {
        status: row.status, po_no: row.po_no, revision: row.revision,
        total_centavos: row.total_centavos, line_count: lines.length,
      },
    });

    return get(id);
  });
}

/**
 * PO-105 — cancellable until something has been received, and not afterwards.
 *
 * The status machine already forbids it: a PO with a receipt against it is
 * `PARTIALLY_RECEIVED` or `RECEIVED`, and `CANCELLED` is reachable from neither. The
 * receipt count is checked as well, so the refusal is the rule's own sentence rather
 * than a statement about states, and so that the rule holds even if the status were
 * ever wrong.
 */
function cancel(id, { reason = null } = {}, actor) {
  const before = purchaseOrderRepository.findById(id);
  if (!before) throw errors.notFound('No such purchase order');

  const received = purchaseOrderRepository.receiptCount(id);
  if (received > 0) {
    throw errors.conflict(
      `${before.po_no} has already had goods delivered against it and cannot be cancelled. `
      + 'Return the delivery to the supplier instead.',
      { ruleId: 'PO-105' }
    );
  }

  assertTransition(before.status, 'CANCELLED', { ruleId: 'PO-105' });

  const why = textOrNull(reason, { max: 200 });
  if (!why) {
    throw errors.badRequest('Say why the order is being cancelled', { ruleId: 'PO-102' });
  }

  const at = clock.nowUtc();

  return db.transaction(() => {
    const row = purchaseOrderRepository.updateFields(id, {
      status: 'CANCELLED',
      cancelled_at: at,
      cancelled_by: actor.id,
      cancel_reason: why,
      updated_at: at,
      updated_by: actor.id,
    });

    auditService.write({
      actor,
      action: 'PURCHASE_ORDER_CANCELLED',
      entityType: 'purchase_orders',
      entityId: id,
      before: { status: before.status },
      after: { status: row.status, po_no: row.po_no },
      reason: why,
    });

    return get(id);
  });
}

/**
 * Move the status on after a receipt has been written — called by goodsReceiptService
 * inside the receipt's own transaction (INV-107).
 *
 * The status is **derived** from what the receipts add up to rather than incremented,
 * for INV-101's reason applied to a different figure: a stored "how much has arrived"
 * is a second number that must agree with the receipts, and it drifts on exactly the
 * rollback the transaction exists to survive.
 */
function refreshStatusAfterReceipt(poId, actor, { at = clock.nowUtc() } = {}) {
  const order = purchaseOrderRepository.findById(poId);
  if (!order) throw errors.notFound('No such purchase order');

  const lines = purchaseOrderRepository.itemsFor(poId);
  const complete = lines.every((line) => line.received_qty_milli >= line.qty_milli);
  const anything = lines.some((line) => line.received_qty_milli > 0);

  const next = complete ? 'RECEIVED' : (anything ? 'PARTIALLY_RECEIVED' : order.status);
  if (next === order.status) return order;

  assertTransition(order.status, next);
  return purchaseOrderRepository.updateFields(poId, {
    status: next,
    completed_at: next === 'RECEIVED' ? at : null,
    updated_at: at,
    updated_by: actor.id,
  });
}

module.exports = {
  STATUSES, TRANSITIONS, STATUS_LABELS, OPEN_STATUSES,
  assertTransition, resolveLines, linesDiffer, presentLine, toPublic,
  find, get, search, create, update, submit, cancel, refreshStatusAfterReceipt,
};
