'use strict';

// What to buy, asked for and approved — TASK-072, PO-107 to PO-109.
//
// **PO-107 is the sentence to keep in mind reading this file: a restocking request moves
// no stock and commits the store to nothing.** It is a question, not a document the
// supplier ever sees. Nothing here writes an inventory movement, and the only thing it
// ever creates is a DRAFT purchase order — which PO-103 says moves no stock either, and
// which the buyer still has to check and send at SCR-802.
//
// Three decisions are load-bearing.
//
//   **The suggestion nets off what is already on order (PO-109).** INV-109 compares the
//   shelf with the minimum and knows nothing about the forty sacks on a PENDING order, so
//   a buyer reading the low-stock list twice in a week orders them twice. This is the
//   whole reason the module exists, and `suggest()` is pure so it can be tested as
//   arithmetic rather than through a screen.
//
//   **The store's own figures are never inferred.** Where a product has no minimum, the
//   suggestion is null and the row asks. Inventing a number for a product nobody has
//   said how many of they want is how a module loses the buyer's trust in its other
//   columns — and the columns are what it is for.
//
//   **The conversion is all or nothing.** A half-converted request is a store that
//   ordered from two of its three suppliers and believes it ordered from three.

const db = require('../config/database');
const ids = require('../config/ids');
const clock = require('../config/clock');
const errors = require('./errors');
const auditService = require('./auditService');
const settingsService = require('./settingsService');
const sequenceService = require('./sequenceService');
const purchaseOrderService = require('./purchaseOrderService');
const restockRepository = require('../repositories/restockRepository');
const productRepository = require('../repositories/productRepository');
const userRepository = require('../repositories/userRepository');

const MAX_LINES = 500;

/**
 * PO-102's shape, applied to a request. ORDERED is reached only by `convert()`.
 *
 * A REJECTED request is final — it is answered by raising another, not by arguing with
 * the one that was refused, which keeps the refusal on the trail as something that
 * happened rather than something that was edited away.
 */
const TRANSITIONS = Object.freeze({
  DRAFT: ['SUBMITTED', 'APPROVED', 'CANCELLED'],
  SUBMITTED: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['ORDERED', 'CANCELLED'],
  REJECTED: [],
  ORDERED: [],
  CANCELLED: [],
});

const STATUS_LABELS = Object.freeze({
  DRAFT: 'Draft',
  SUBMITTED: 'Waiting for approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  ORDERED: 'Ordered',
  CANCELLED: 'Cancelled',
});

const MILLI = 1000;

// ── The arithmetic (PO-109) ─────────────────────────────────────────────────

/**
 * How much to suggest buying, in base-unit thousandths.
 *
 *   target = minimum × cover          what the store wants on the shelf
 *   suggested = target − on hand − on order
 *
 * Returns **null**, never zero, where the store has set no minimum: the two mean
 * different things to a buyer. Zero is "you have enough"; null is "nobody has said how
 * many of these you want", and only the second is a question the screen should ask.
 *
 * Clamped at zero, because a product with more on order than its target needs nothing —
 * and a negative suggestion would read as a quantity to un-order.
 *
 * Pure, and exported for the tests: this is the rule the module is judged on.
 */
function suggest({ minStockMilli, onHandMilli, onOrderMilli, cover }) {
  const min = Number(minStockMilli) || 0;
  if (min <= 0) return null;
  const target = min * (Number(cover) || 1);
  const have = (Number(onHandMilli) || 0) + (Number(onOrderMilli) || 0);
  return Math.max(0, Math.round(target - have));
}

function coverMultiplier() {
  return settingsService.get('restock_cover_multiplier') || 1;
}

function approvalRequired() {
  return Boolean(settingsService.get('restock_approval_required'));
}

/**
 * Whether there is anybody to ask.
 *
 * A store with one active user cannot produce two distinct actors, so requiring a second
 * would leave every request stuck at SUBMITTED for ever. It self-approves and says so on
 * the row — INV-112 takes exactly this view of a count nobody could double-check.
 */
function canBeApprovedByAnother() {
  // `list()` without includeInactive is the active users; `countAll()` would count the
  // deactivated ones too, and a store whose second user left is a one-person store.
  return userRepository.list().length > 1;
}

// ── Presenting ──────────────────────────────────────────────────────────────

function presentSuggestion(row, cover) {
  const suggested = suggest({
    minStockMilli: row.min_stock_milli,
    onHandMilli: row.qty_on_hand_milli,
    onOrderMilli: row.on_order_milli,
    cover,
  });
  return {
    product_id: row.product_id,
    sku: row.sku,
    name: row.name,
    category_name: row.category_name,
    brand_name: row.brand_name,
    base_unit_code: row.base_unit_code,
    is_batch_tracked: Boolean(row.is_batch_tracked),
    min_stock_milli: row.min_stock_milli,
    qty_on_hand_milli: row.qty_on_hand_milli,
    on_order_milli: row.on_order_milli,
    suggested_qty_milli: suggested,
    // The sum the screen shows beside the figure, so a buyer can see where it came from
    // rather than being handed a number.
    target_milli: row.min_stock_milli > 0 ? row.min_stock_milli * cover : null,
    last_cost_centavos: row.last_cost_centavos,
    last_supplier_id: row.last_supplier_id,
    last_supplier_name: row.last_supplier_name,
    last_received_at: row.last_received_at,
    avg_cost_centavos: row.avg_cost_centavos,
    source: row.source,
    // Already asked for on a request somebody is still deciding about.
    on_open_request: row.open_request_count > 0,
  };
}

function presentItem(row) {
  return {
    id: row.id,
    line_no: row.line_no,
    product_id: row.product_id,
    product_name: row.product_name_snapshot,
    sku: row.sku,
    base_unit_code: row.base_unit_code,
    is_batch_tracked: Boolean(row.is_batch_tracked),
    qty_milli: row.qty_milli,
    qty_display: row.qty_milli / MILLI,
    suggested_qty_milli: row.suggested_qty_milli,
    // What the shelf looked like when this was asked for, not what it looks like now.
    // A request read in three months is a question about a shelf that has moved since.
    on_hand_milli: row.on_hand_milli,
    on_order_milli: row.on_order_milli,
    min_stock_milli: row.min_stock_milli,
    supplier_id: row.supplier_id,
    supplier_name: row.supplier_name,
    unit_cost_centavos: row.unit_cost_centavos,
    is_approved: row.is_approved === null ? null : Boolean(row.is_approved),
    po_id: row.po_id,
    po_no: row.po_no,
    source: row.source,
    notes: row.notes,
  };
}

function toPublic(row, items) {
  const approvable = row.status === 'SUBMITTED' || (row.status === 'DRAFT' && !approvalRequired());
  return {
    id: row.id,
    rr_no: row.rr_no,
    status: row.status,
    status_label: STATUS_LABELS[row.status],
    note: row.note,
    requested_at: row.requested_at,
    requested_by_username: row.requested_by_username,
    submitted_at: row.submitted_at,
    decided_at: row.decided_at,
    decided_by_username: row.decided_by_username,
    decision_reason: row.decision_reason,
    self_approved: Boolean(row.self_approved),
    converted_at: row.converted_at,
    cancel_reason: row.cancel_reason,
    line_count: row.line_count,
    approved_count: row.approved_count,
    // A line with no supplier cannot be converted. Reported rather than dropped, so the
    // buyer is told which one needs naming instead of wondering why an order is short.
    no_supplier_count: row.no_supplier_count,
    // The server decides what may be done, and the screen draws what it is told —
    // SEC-6's reasoning applied to state rather than to permission.
    can_edit: row.status === 'DRAFT',
    can_submit: row.status === 'DRAFT',
    can_decide: approvable,
    can_convert: row.status === 'APPROVED',
    can_cancel: TRANSITIONS[row.status].includes('CANCELLED'),
    items: items ? items.map(presentItem) : undefined,
  };
}

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * The derived list: what the shelf says needs buying, before anybody edits it.
 *
 * One query for the catalogue, one pass in memory. The `on order` figure that makes this
 * worth having is joined in `suggestionRows`, not asked per row.
 */
function suggestions({ limit = 500 } = {}) {
  const cover = coverMultiplier();
  const rows = restockRepository.suggestionRows({ limit });
  return {
    cover_multiplier: cover,
    approval_required: approvalRequired(),
    products: rows.map((row) => presentSuggestion(row, cover)),
  };
}

/** The same figures for products a buyer picked by hand (the wormer nobody stocks). */
function contextFor(productIds) {
  const cover = coverMultiplier();
  const unique = [...new Set(productIds)].slice(0, MAX_LINES);
  return {
    cover_multiplier: cover,
    products: restockRepository.contextFor(unique).map((row) => presentSuggestion(row, cover)),
  };
}

function get(id) {
  const row = restockRepository.findById(id);
  if (!row) throw errors.notFound('No such restocking request');
  return toPublic(row, restockRepository.itemsFor(id));
}

function search({ status = null, open = false, limit = 50, offset = 0 } = {}) {
  const rows = restockRepository.search({ status, open, limit, offset });
  return {
    statuses: Object.entries(STATUS_LABELS).map(([code, label]) => ({ status: code, label })),
    total: restockRepository.countSearch({ status, open }),
    limit,
    offset,
    requests: rows.map((row) => toPublic(row, null)),
  };
}

// ── Raising and editing ─────────────────────────────────────────────────────

/**
 * Validate every line before a single row is written.
 *
 * The whole list refuses or the whole list is written — an unknown product on row 2 of
 * 200 must not leave a request half built, for the same reason TASK-071's bulk price
 * change validates before it writes.
 */
function resolveLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw errors.badRequest('A restocking request needs at least one product', { ruleId: 'PO-107' });
  }
  if (lines.length > MAX_LINES) {
    throw errors.badRequest(`A restocking request takes at most ${MAX_LINES} lines`, { ruleId: 'PO-107' });
  }

  const seen = new Set();
  return lines.map((line, index) => {
    const at = `line ${index + 1}`;
    const product = productRepository.findById(String(line.productId || ''));
    if (!product) throw errors.badRequest(`${at}: no such product`, { ruleId: 'PO-107' });
    if (!product.is_active) {
      throw errors.badRequest(`${at}: ${product.name} is not active`, { ruleId: 'INV-105' });
    }
    // INV-114: a made-to-order product is never low on stock, so it is never restocked.
    if (product.is_stocked === 0) {
      throw errors.badRequest(`${at}: ${product.name} is made to order and is not stocked`, { ruleId: 'INV-114' });
    }
    if (seen.has(product.id)) {
      throw errors.badRequest(`${at}: ${product.name} is on this request twice`, { ruleId: 'PO-107' });
    }
    seen.add(product.id);

    const qty = Number(line.qtyMilli);
    if (!Number.isInteger(qty) || qty <= 0) {
      throw errors.badRequest(`${at}: the quantity is a positive whole number of thousandths`, { ruleId: 'MON-002' });
    }
    const cost = line.unitCostCentavos === null || line.unitCostCentavos === undefined
      ? null : Number(line.unitCostCentavos);
    if (cost !== null && (!Number.isInteger(cost) || cost < 0)) {
      throw errors.badRequest(`${at}: the unit cost is a whole number of centavos, not negative`, { ruleId: 'MON-001' });
    }

    return {
      product,
      qtyMilli: qty,
      supplierId: line.supplierId ? String(line.supplierId) : null,
      unitCostCentavos: cost,
      suggestedQtyMilli: Number.isInteger(line.suggestedQtyMilli) ? line.suggestedQtyMilli : null,
      onHandMilli: Number.isInteger(line.onHandMilli) ? line.onHandMilli : null,
      onOrderMilli: Number.isInteger(line.onOrderMilli) ? line.onOrderMilli : null,
      minStockMilli: Number.isInteger(line.minStockMilli) ? line.minStockMilli : null,
      source: ['BELOW_MINIMUM', 'OUT_OF_STOCK', 'ADDED'].includes(line.source) ? line.source : 'ADDED',
      notes: line.notes ? String(line.notes).slice(0, 500) : null,
    };
  });
}

function writeLines(requestId, resolved) {
  resolved.forEach((line, index) => {
    restockRepository.insertItem({
      id: ids.uuidv7(),
      request_id: requestId,
      line_no: index + 1,
      product_id: line.product.id,
      product_name_snapshot: line.product.name,
      qty_milli: line.qtyMilli,
      suggested_qty_milli: line.suggestedQtyMilli,
      on_hand_milli: line.onHandMilli,
      on_order_milli: line.onOrderMilli,
      min_stock_milli: line.minStockMilli,
      supplier_id: line.supplierId,
      unit_cost_centavos: line.unitCostCentavos,
      source: line.source,
      notes: line.notes,
    });
  });
}

const auditLines = (resolved) => resolved.map((l) => ({
  product: l.product.name, qty_milli: l.qtyMilli, supplier_id: l.supplierId,
}));

function create(input, actor) {
  const resolved = resolveLines(input.lines);
  const at = clock.nowUtc();

  return db.transaction(() => {
    // Allocated inside the transaction, so a rollback frees the number (VR-103).
    const rrNo = sequenceService.next('RESTOCK_REQUEST', { at });
    const row = restockRepository.insert({
      id: ids.uuidv7(),
      rr_no: rrNo,
      status: 'DRAFT',
      note: input.note ? String(input.note).slice(0, 500) : null,
      requested_at: at,
      requested_by: actor.id,
      created_at: at,
      created_by: actor.id,
    });
    writeLines(row.id, resolved);

    auditService.write({
      actor,
      action: 'RESTOCK_REQUEST_RAISED',
      entityType: 'restock_requests',
      entityId: row.id,
      after: { rr_no: rrNo, line_count: resolved.length, lines: auditLines(resolved) },
    });
    return get(row.id);
  });
}

/** A DRAFT is edited in place; its lines are replaced wholesale. */
function update(id, input, actor) {
  const existing = restockRepository.findById(id);
  if (!existing) throw errors.notFound('No such restocking request');
  if (existing.status !== 'DRAFT') {
    throw errors.conflict(
      `This request is ${STATUS_LABELS[existing.status].toLowerCase()} and can no longer be edited.`,
      { ruleId: 'PO-107' }
    );
  }
  const resolved = resolveLines(input.lines);
  const at = clock.nowUtc();

  return db.transaction(() => {
    restockRepository.deleteItems(id);
    writeLines(id, resolved);
    if (input.note !== undefined) {
      restockRepository.updateFields(id, {
        note: input.note ? String(input.note).slice(0, 500) : null,
      }, at, actor.id);
    }
    auditService.write({
      actor,
      action: 'RESTOCK_REQUEST_MODIFIED',
      entityType: 'restock_requests',
      entityId: id,
      after: { rr_no: existing.rr_no, line_count: resolved.length, lines: auditLines(resolved) },
    });
    return get(id);
  });
}

// ── The ask, and the answer ─────────────────────────────────────────────────

function assertTransition(row, to) {
  if (!TRANSITIONS[row.status].includes(to)) {
    throw errors.conflict(
      `A request that is ${STATUS_LABELS[row.status].toLowerCase()} cannot become ${STATUS_LABELS[to].toLowerCase()}.`,
      { ruleId: 'PO-107' }
    );
  }
}

function submit(id, actor) {
  const row = restockRepository.findById(id);
  if (!row) throw errors.notFound('No such restocking request');
  if (row.line_count === 0) {
    throw errors.badRequest('A request with no lines has nothing to ask for', { ruleId: 'PO-107' });
  }
  const at = clock.nowUtc();

  // Nobody to ask: the store has one active user, so the request is approved on the spot
  // and the row says it approved itself. This is a property of the store's staffing, not
  // a setting somebody switched off.
  if (!canBeApprovedByAnother() || !approvalRequired()) {
    return decide(id, {
      approve: true,
      selfApproved: !canBeApprovedByAnother(),
      itemDecisions: null,
    }, actor, { from: 'DRAFT' });
  }

  assertTransition(row, 'SUBMITTED');
  return db.transaction(() => {
    restockRepository.updateFields(id, {
      status: 'SUBMITTED', submitted_at: at, submitted_by: actor.id,
    }, at, actor.id);
    auditService.write({
      actor,
      action: 'RESTOCK_REQUEST_SUBMITTED',
      entityType: 'restock_requests',
      entityId: id,
      after: { rr_no: row.rr_no, line_count: row.line_count },
    });
    return get(id);
  });
}

/**
 * Approve or reject, per line.
 *
 * `itemDecisions` is a map of line id to boolean; a line the approver said nothing about
 * is approved, because the ordinary case is an owner striking two things off a list of
 * eleven rather than ticking nine.
 *
 * AUD-603: the requester and the approver are distinct actors, and the refusal to be
 * both is the rule, not a convention — except on a single-user store, where it is
 * impossible and is recorded as such rather than quietly allowed.
 */
function decide(id, { approve, reason = null, itemDecisions = null, selfApproved = false }, actor, opts = {}) {
  const row = restockRepository.findById(id);
  if (!row) throw errors.notFound('No such restocking request');

  const from = opts.from || row.status;
  if (from !== row.status) {
    throw errors.conflict('This request has moved on since it was read.', { ruleId: 'PO-107' });
  }
  assertTransition(row, approve ? 'APPROVED' : 'REJECTED');

  if (!approve && !String(reason || '').trim()) {
    throw errors.badRequest('A rejection says why', { ruleId: 'AUD-601' });
  }

  // AUD-603. A store with a second active user must use them; one without cannot.
  const isSelf = selfApproved || !canBeApprovedByAnother();
  if (approve && !isSelf && approvalRequired() && row.status === 'SUBMITTED'
      && row.requested_by && row.requested_by === actor.id) {
    throw errors.conflict(
      'A restocking request is approved by somebody other than the person who raised it.',
      { ruleId: 'AUD-603' }
    );
  }

  const at = clock.nowUtc();
  const items = restockRepository.itemsFor(id);

  return db.transaction(() => {
    let approvedCount = 0;
    for (const item of items) {
      const decided = approve
        ? (itemDecisions && Object.prototype.hasOwnProperty.call(itemDecisions, item.id)
          ? Boolean(itemDecisions[item.id])
          : true)
        : false;
      restockRepository.setApproved(item.id, decided);
      if (decided) approvedCount += 1;
    }

    if (approve && approvedCount === 0) {
      throw errors.badRequest(
        'Approving nothing is a rejection. Reject the request, with a reason.',
        { ruleId: 'AUD-601' }
      );
    }

    restockRepository.updateFields(id, {
      status: approve ? 'APPROVED' : 'REJECTED',
      decided_at: at,
      decided_by: actor.id,
      decision_reason: reason ? String(reason).slice(0, 500) : null,
      self_approved: isSelf ? 1 : 0,
    }, at, actor.id);

    auditService.write({
      actor,
      action: approve ? 'RESTOCK_REQUEST_APPROVED' : 'RESTOCK_REQUEST_REJECTED',
      entityType: 'restock_requests',
      entityId: id,
      after: {
        rr_no: row.rr_no,
        approved_lines: approvedCount,
        of_lines: items.length,
        self_approved: isSelf,
        reason: reason || null,
      },
    });
    return get(id);
  });
}

function cancel(id, reason, actor) {
  const row = restockRepository.findById(id);
  if (!row) throw errors.notFound('No such restocking request');
  assertTransition(row, 'CANCELLED');
  if (!String(reason || '').trim()) {
    throw errors.badRequest('Cancelling a request says why', { ruleId: 'AUD-601' });
  }
  const at = clock.nowUtc();
  return db.transaction(() => {
    restockRepository.updateFields(id, {
      status: 'CANCELLED', cancelled_at: at, cancelled_by: actor.id,
      cancel_reason: String(reason).slice(0, 500),
    }, at, actor.id);
    auditService.write({
      actor,
      action: 'RESTOCK_REQUEST_CANCELLED',
      entityType: 'restock_requests',
      entityId: id,
      after: { rr_no: row.rr_no, reason: String(reason).slice(0, 500) },
    });
    return get(id);
  });
}

// ── PO-108: it becomes orders ───────────────────────────────────────────────

/**
 * One DRAFT purchase order per distinct supplier, in one transaction.
 *
 * **All of it or none of it.** A half-converted request is a store that ordered from two
 * of its three suppliers and believes it ordered from three — and unlike a half-written
 * document, that one is only discovered when the third supplier's van does not come.
 *
 * Lines with no supplier are left on the request and named in the result. They are not a
 * failure: a product the store has never received has nobody to derive a supplier from,
 * and the buyer names one and converts again. Lines the approver struck off are skipped
 * for the same reason they were struck off.
 */
function convert(id, actor) {
  const row = restockRepository.findById(id);
  if (!row) throw errors.notFound('No such restocking request');
  assertTransition(row, 'ORDERED');

  const items = restockRepository.itemsFor(id);
  const approved = items.filter((i) => i.is_approved === 1);
  const convertible = approved.filter((i) => i.supplier_id && !i.po_id);
  const unsupplied = approved.filter((i) => !i.supplier_id);

  if (convertible.length === 0) {
    throw errors.badRequest(
      unsupplied.length
        ? `No approved line names a supplier. ${unsupplied.length} line(s) need one before this can become an order.`
        : 'There is nothing approved on this request to order.',
      { ruleId: 'PO-108' }
    );
  }

  const bySupplier = new Map();
  for (const item of convertible) {
    if (!bySupplier.has(item.supplier_id)) bySupplier.set(item.supplier_id, []);
    bySupplier.get(item.supplier_id).push(item);
  }

  const at = clock.nowUtc();

  return db.transaction(() => {
    const created = [];
    for (const [supplierId, supplierItems] of bySupplier) {
      // Raised through the same path SCR-802 uses, so a converted order is in every way
      // an ordinary DRAFT: freely editable, and sent by a person who has read it.
      // `createWithin`, not `create`: §8.3 forbids a nested transaction, and PO-108 wants
      // every order for this request written as one unit — see its note on that function.
      const po = purchaseOrderService.createWithin({
        supplierId,
        notes: `From restocking request ${row.rr_no}`,
        lines: supplierItems.map((item) => ({
          productId: item.product_id,
          qtyMilli: item.qty_milli,
          // A product never received has no last cost; the order opens at zero and the
          // buyer fills it in, which is what SCR-802 is for.
          unitCostCentavos: item.unit_cost_centavos ?? 0,
        })),
      }, actor, { at });

      // PO-108: each line cites the order that carried it. The order's lines come back
      // in the order they were sent, so they pair by index.
      po.lines.forEach((poLine, index) => {
        restockRepository.setOrdered(supplierItems[index].id, { poId: po.id, poItemId: poLine.id });
      });
      created.push({
        id: po.id, po_no: po.po_no, supplier_name: po.supplier.name, line_count: po.lines.length,
      });
    }

    restockRepository.updateFields(id, { status: 'ORDERED', converted_at: at }, at, actor.id);

    auditService.write({
      actor,
      action: 'RESTOCK_REQUEST_ORDERED',
      entityType: 'restock_requests',
      entityId: id,
      after: {
        rr_no: row.rr_no,
        orders: created.map((o) => o.po_no),
        lines_converted: convertible.length,
        lines_without_supplier: unsupplied.length,
      },
    });

    return {
      request: get(id),
      purchase_orders: created,
      // Said plainly rather than left for the buyer to notice an order is short.
      lines_without_supplier: unsupplied.map((i) => i.product_name_snapshot),
    };
  });
}

module.exports = {
  TRANSITIONS, STATUS_LABELS, MAX_LINES,
  suggest, suggestions, contextFor,
  get, search, create, update, submit, decide, cancel, convert,
};
