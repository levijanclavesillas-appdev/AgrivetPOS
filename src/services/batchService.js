'use strict';

// Batches, expiry status and FEFO allocation (TASK-029, INV-201–INV-205).
//
// Three ideas, and they are best read in this order.
//
// 1. **A batch has no quantity of its own** (INV-201). Its balance is the ledger's,
//    grouped by batch instead of by product, so it cannot disagree with on-hand. The
//    repository does that in one join and there is nothing here to maintain.
//
// 2. **Expiry status is arithmetic, not state** (INV-203). `statusOf` takes a date and
//    a threshold and returns a word. Nothing stores it, no job computes it, and a
//    batch becomes NEAR_EXPIRY at midnight in Manila without anything having run —
//    which is the same reasoning CR-107 applies to ageing, for the same reason.
//
// 3. **FEFO is an allocation, and it can fail** (INV-204, INV-205). `allocate` returns
//    the batches a quantity would come from, earliest expiry first, or refuses. It
//    never consumes anything itself: the caller is inside a transaction that also
//    writes a sale, and an allocator that posted its own movements would post them for
//    a sale that then failed a tender check.
//
// **There is no way to sell an expired batch through this file, and that is deliberate
// rather than unfinished.** INV-205 permits an owner override only where the store's
// own policy allows it; this store's does not (TASK-029), so `allocate` cannot see an
// expired batch and there is no parameter that would let it. Expired stock leaves by
// `expire`, which posts INV-103's EXPIRY movement.

const clock = require('../config/clock');
const ids = require('../config/ids');
const errors = require('./errors');
const quantity = require('./quantity');
const permissions = require('./permissions');
const auditService = require('./auditService');
const settingsService = require('./settingsService');
const batchRepository = require('../repositories/batchRepository');
const productRepository = require('../repositories/productRepository');
const supplierRepository = require('../repositories/supplierRepository');

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const STATUS = Object.freeze({ EXPIRED: 'EXPIRED', NEAR_EXPIRY: 'NEAR_EXPIRY', NORMAL: 'NORMAL' });

// Required by the inventoryService seam rather than imported from it: batchService is
// called *by* the sale and the receipt, and importing them back would be a cycle.
const inventoryService = () => require('./inventoryService');

/** Today, as a Manila day. Expiry is a date on a box (INV-203). */
function today(at = null) {
  return clock.manilaDate(at || clock.nowUtc());
}

function assertDate(value, what) {
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) {
    throw errors.badRequest(`${what} must be a date as YYYY-MM-DD`, { ruleId: 'INV-202' });
  }
  return value;
}

/** Manila-day arithmetic on date-only strings, which is all INV-203 needs. */
function addDays(date, days) {
  const ms = Date.UTC(
    Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)),
  ) + days * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  const at = (d) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((at(to) - at(from)) / 86400000);
}

/**
 * INV-203, and the whole of it.
 *
 * EXPIRED when the date has passed, NEAR_EXPIRY within the threshold, NORMAL
 * otherwise. **The boundaries are inclusive at both ends and that matters:** a batch
 * expiring today is not yet expired — a box marked "use by 30 June" is good on the
 * 30th — and a batch exactly `nearDays` out is already near, because a threshold that
 * excluded its own boundary would give the store one day less warning than the number
 * it configured.
 */
function statusOf(expiryDate, { asOfDate = null, nearDays = null } = {}) {
  assertDate(expiryDate, 'An expiry date');
  const asOf = asOfDate || today();
  const near = nearDays === null ? settingsService.get('near_expiry_days') : nearDays;

  if (expiryDate < asOf) return STATUS.EXPIRED;
  if (daysBetween(asOf, expiryDate) <= near) return STATUS.NEAR_EXPIRY;
  return STATUS.NORMAL;
}

/** A batch row with its derived status and the days left, for a screen or a report. */
function present(row, { asOfDate = null, nearDays = null } = {}) {
  if (!row) return null;
  const asOf = asOfDate || today();
  const near = nearDays === null ? settingsService.get('near_expiry_days') : nearDays;
  return {
    ...row,
    is_active: Boolean(row.is_active),
    expiry_status: statusOf(row.expiry_date, { asOfDate: asOf, nearDays: near }),
    days_to_expiry: daysBetween(asOf, row.expiry_date),
    // UOM-005: quantity.format refuses a quantity with no unit, which is why the
    // batch rows carry the product's base unit code through every read.
    qty_display: row.qty_milli === undefined || !row.base_unit_code
      ? undefined
      : quantity.format(row.qty_milli, row.base_unit_code),
  };
}

function assertBatchTracked(product) {
  if (!product.is_batch_tracked) {
    throw errors.badRequest(
      `${product.name} is not batch-tracked, so it has no batches`,
      { ruleId: 'INV-201' },
    );
  }
}

/**
 * Create a batch (INV-202). Called by goods receipt and by the opening load, both of
 * which are already inside a transaction — so this opens none.
 *
 * `batch_no` is the supplier's own label and is required. Generating one would produce
 * an identifier the manufacturer's recall notice cannot match, which defeats INV-206.
 */
function create({
  productId, batchNo, supplierId, expiryDate, receivedDate = null,
  unitCostCentavos, grItemId = null, notes = null, actor, occurredAt = null,
}) {
  const product = productRepository.findById(productId);
  if (!product) throw errors.notFound('No such product');
  assertBatchTracked(product);

  const no = typeof batchNo === 'string' ? batchNo.trim() : '';
  if (!no) {
    throw errors.badRequest(
      `${product.name} is batch-tracked, so its batch number is required`,
      { ruleId: 'INV-202' },
    );
  }
  assertDate(expiryDate, 'An expiry date');

  const supplier = supplierRepository.findById(supplierId);
  if (!supplier) throw errors.notFound('No such supplier');

  if (batchRepository.findByNo(productId, no)) {
    throw errors.conflict(
      `${product.name} already has a batch ${no}`,
      { ruleId: 'INV-202' },
    );
  }

  const at = occurredAt || clock.nowUtc();
  const row = batchRepository.insert({
    id: ids.uuidv7(),
    product_id: productId,
    batch_no: no,
    supplier_id: supplierId,
    expiry_date: expiryDate,
    received_date: receivedDate || today(at),
    unit_cost_centavos: unitCostCentavos,
    gr_item_id: grItemId,
    notes,
    created_at: at,
    created_by: actor.id,
  });

  auditService.write({
    actor, action: 'BATCH_CREATE', entityType: 'product_batch', entityId: row.id,
    after: { batch_no: no, product: product.name, expiry_date: expiryDate },
  });

  return present(row);
}

/**
 * The batch a redelivery of the same batch number belongs to (INV-202).
 *
 * A mill delivering the rest of batch A-2291 a fortnight later is the same batch, not a
 * second one — INV-202's uniqueness per product says so, and creating a second would
 * split one recall into two. Returns the raw row, so the receipt can name its id.
 */
function findForReceipt(productId, batchNo) {
  const no = typeof batchNo === 'string' ? batchNo.trim() : '';
  if (!no) return null;
  return batchRepository.findByNo(productId, no);
}

/**
 * INV-204: what a quantity would come from, earliest non-expired expiry first.
 *
 * Returns `[{ batchId, batchNo, expiryDate, qtyMilli, unitCostCentavos }]` summing to
 * `qtyMilli`, spanning as many batches as it needs. **It consumes nothing** — the
 * caller posts the movements, inside whatever transaction it is already in.
 *
 * The refusal is where INV-205 lives. A product with 50 on hand and all of it expired
 * has nothing to allocate, and the error says so with the expiry date rather than
 * "insufficient stock" — because those are different problems and the second one sends
 * a clerk looking for stock that is sitting on the shelf in front of them.
 */
function allocate(productId, qtyMilli, { asOfDate = null, product = null } = {}) {
  quantity.assertMilli(qtyMilli, 'the quantity to allocate');
  if (qtyMilli <= 0) {
    throw errors.badRequest('A batch allocation needs a positive quantity', { ruleId: 'INV-204' });
  }
  const asOf = asOfDate || today();
  const candidates = batchRepository.fefoCandidates(productId, asOf);

  const allocations = [];
  let remaining = qtyMilli;
  for (const batch of candidates) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, batch.qty_milli);
    allocations.push({
      batchId: batch.id,
      batchNo: batch.batch_no,
      expiryDate: batch.expiry_date,
      qtyMilli: take,
      unitCostCentavos: batch.unit_cost_centavos,
    });
    remaining -= take;
  }

  if (remaining > 0) {
    const p = product || productRepository.findById(productId) || {};
    const name = p.name || 'this product';
    const unit = p.base_unit_code || 'units';
    const qty = (milli) => quantity.format(milli, unit);
    const expiredHere = batchRepository.expiredWithStock(asOf)
      .filter((b) => b.product_id === productId);
    const held = expiredHere.reduce((sum, b) => sum + b.qty_milli, 0);

    // INV-205, said out loud. Stock that exists and may not be sold is a different
    // answer from stock that is not there, and the clerk needs to be told which.
    if (held > 0) {
      throw errors.conflict(
        `${name}: ${qty(remaining)} short. ${qty(held)} is on the shelf but expired `
        + `(${expiredHere.map((b) => `${b.batch_no} on ${b.expiry_date}`).join(', ')}) `
        + 'and may not be sold.',
        { ruleId: 'INV-205' },
      );
    }
    throw errors.conflict(
      `${name}: only ${qty(qtyMilli - remaining)} available in batches, ${qty(qtyMilli)} needed`,
      { ruleId: 'INV-204' },
    );
  }

  return allocations;
}

/**
 * MON-004's other half: the cost a line snapshots when it spanned several batches.
 *
 * The weighted average of what it actually took, rounded once. Six sacks at ₱300 and
 * four at ₱320 is ₱308 — not ₱310, which is what averaging the two batch costs without
 * their quantities would give, and which would misstate the margin on every split line.
 */
function blendedCostCentavos(allocations) {
  const totalQty = allocations.reduce((sum, a) => sum + a.qtyMilli, 0);
  if (totalQty <= 0) return 0;
  const value = allocations.reduce(
    (sum, a) => sum + BigInt(a.qtyMilli) * BigInt(a.unitCostCentavos), 0n,
  );
  // Half-up, once, in BigInt — the thousandths cancel against the quantity denominator
  // exactly as costing.computeMovingAverage does it.
  const q = BigInt(totalQty);
  return Number((value + q / 2n) / q);
}

/** Every batch of a product, with balances and derived status. */
function listForProduct(productId, { includeEmpty = false, actor = null } = {}) {
  if (actor && !permissions.can(actor, 'TX-422')) {
    throw errors.forbidden(
      'You do not have permission to read inventory.',
      { ruleId: 'TX-422', requiresRole: permissions.rolesHolding('TX-422').join(' or ') },
    );
  }
  const product = productRepository.findById(productId);
  if (!product) throw errors.notFound('No such product');
  assertBatchTracked(product);

  const nearDays = settingsService.get('near_expiry_days');
  const asOf = today();
  return batchRepository.forProduct(productId, { includeEmpty })
    .map((row) => present(row, { asOfDate: asOf, nearDays }));
}

/** OPS-007's sweep, and the recall's entry point from an alert. */
function nearExpiry({ limit = 200 } = {}) {
  const nearDays = settingsService.get('near_expiry_days');
  const asOf = today();
  return batchRepository.nearExpiry(asOf, addDays(asOf, nearDays), { limit })
    .map((row) => present(row, { asOfDate: asOf, nearDays }));
}

function expired({ limit = 200 } = {}) {
  const asOf = today();
  const nearDays = settingsService.get('near_expiry_days');
  return batchRepository.expiredWithStock(asOf, { limit })
    .map((row) => present(row, { asOfDate: asOf, nearDays }));
}

/**
 * INV-205's expected exit: write the batch off by an EXPIRY movement.
 *
 * Not a deletion and not an adjustment. INV-103 declared EXPIRY in 003_inventory.sql
 * and this is the first thing to write one — the ledger then says *why* the stock left,
 * which an ADJUSTMENT would not, and a store can total what it lost to expiry.
 */
function expire(batchId, { actor, reason = null, occurredAt = null }) {
  if (!permissions.can(actor, 'TX-407')) {
    throw errors.forbidden(
      'You do not have permission to write stock off.',
      { ruleId: 'TX-407', requiresRole: permissions.rolesHolding('TX-407').join(' or ') },
    );
  }
  const batch = batchRepository.withQuantity(batchId);
  if (!batch) throw errors.notFound('No such batch');

  if (batch.qty_milli <= 0) {
    throw errors.conflict(
      `Batch ${batch.batch_no} holds no stock`,
      { ruleId: 'INV-205' },
    );
  }

  const at = occurredAt || clock.nowUtc();
  const movement = inventoryService().post({
    productId: batch.product_id,
    type: 'EXPIRY',
    qtyMilli: batch.qty_milli,
    batchId: batch.id,
    actor,
    reason: reason || `Batch ${batch.batch_no} expired ${batch.expiry_date}`,
    referenceType: 'product_batch',
    referenceId: batch.id,
    referenceNo: batch.batch_no,
    occurredAt: at,
  });

  batchRepository.deactivate({ id: batch.id, updatedAt: at, updatedBy: actor.id });

  auditService.write({
    actor, action: 'BATCH_EXPIRE', entityType: 'product_batch', entityId: batch.id,
    before: { qty_milli: batch.qty_milli },
    after: { qty_milli: 0, expiry_date: batch.expiry_date },
    reason: reason || null,
  });

  return { batch: present(batchRepository.withQuantity(batch.id)), movement };
}

module.exports = {
  STATUS,
  statusOf,
  present,
  create,
  findForReceipt,
  allocate,
  blendedCostCentavos,
  listForProduct,
  nearExpiry,
  expired,
  expire,
  addDays,
  daysBetween,
  today,
};
