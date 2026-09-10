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
const csv = require('../config/csv');
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

/**
 * `INV-206` — the recall: given a batch, who has it.
 *
 * **A recall is not a report about stock, it is a list of people.** The output is a
 * customer, a sale, a date and a quantity, and the figure that matters is the one still
 * out there — what this batch gave a line, less whatever came back on it.
 *
 * Three things it says out loud rather than leaving to be worked out:
 *
 *   **What is still on the shelf**, beside the list, because half of acting on a recall
 *   is pulling the rest of it out of the shop and the other half is the telephone.
 *
 *   **The walk-ins**, counted. A batch sold to eleven farms and four walk-ins is eleven
 *   calls and four you cannot make, and a screen that omitted the second number would
 *   let a store believe it had reached everybody.
 *
 *   **Voided and returned sales as themselves.** Neither is dropped: a voided sale's
 *   goods may have left the shop with the customer, and a partially returned line has
 *   the unreturned part still out there. `POS-301`'s `returned_qty_milli` is the line's,
 *   so where a line spanned two batches the return is apportioned against this batch's
 *   share — the honest reading of a figure the schema keeps per line.
 *
 * `RPT-106`: the report states what it includes, in words, so a printed copy is
 * readable a year later without this comment.
 */
function recallFor(batchId, { actor = null } = {}) {
  if (actor && !permissions.can(actor, 'TX-422')) {
    throw errors.forbidden(
      'You do not have permission to read inventory.',
      { ruleId: 'TX-422', requiresRole: permissions.rolesHolding('TX-422').join(' or ') }
    );
  }

  const batch = batchRepository.withQuantity(batchId);
  if (!batch) throw errors.notFound('No such batch');

  const rows = batchRepository.recall(batchId);
  const unit = batch.base_unit_code;

  const sales = rows.map((row) => {
    // The line's return, apportioned to this batch's share of the line. A line of ten
    // that took six from here and had two returned gives this batch 1.2 back — the
    // schema keeps the return per line, and pretending otherwise would report more
    // still-out-there than the store ever sold from this batch.
    const returnedHere = row.returned_qty_milli > 0 && row.line_qty_milli > 0
      ? Math.round((row.returned_qty_milli * row.qty_milli) / row.line_qty_milli)
      : 0;
    const voided = row.status === 'VOIDED';
    const outstanding = voided ? row.qty_milli : Math.max(row.qty_milli - returnedHere, 0);

    return {
      sale_id: row.sale_id,
      sale_no: row.sale_no,
      status: row.status,
      occurred_at: row.occurred_at,
      occurred_at_manila: clock.toManila(row.occurred_at),
      cashier: row.cashier,
      customer_id: row.customer_id,
      // The two fields somebody with a telephone actually needs, and the honest answer
      // where there is nobody to ring.
      customer_name: row.customer_name,
      customer_contact_no: row.customer_contact_no,
      is_walk_in: !row.customer_id,
      product: row.product_name_snapshot,
      sku: row.sku,
      // What this batch gave this line — never the line's own quantity.
      qty_milli: row.qty_milli,
      qty_display: quantity.format(row.qty_milli, unit),
      returned_qty_milli: returnedHere,
      returned_display: returnedHere > 0 ? quantity.format(returnedHere, unit) : null,
      // Voided: the sale was reversed, and the goods may still have gone out of the
      // door. Counted as outstanding, and marked, so the store decides rather than the
      // report deciding for it.
      outstanding_qty_milli: outstanding,
      outstanding_display: quantity.format(outstanding, unit),
      is_voided: voided,
      is_returned: returnedHere > 0,
    };
  });

  const walkIns = sales.filter((sale) => sale.is_walk_in);
  const reachable = sales.filter((sale) => !sale.is_walk_in);
  const soldMilli = sales.reduce((sum, sale) => sum + sale.qty_milli, 0);
  const outstandingMilli = sales.reduce((sum, sale) => sum + sale.outstanding_qty_milli, 0);

  return {
    batch: present(batch),
    sales,
    summary: {
      sales_count: sales.length,
      // Customers rather than sales: one farm that bought three times is one telephone
      // call, and "eleven calls" is the figure somebody plans their morning around.
      customers_count: new Set(reachable.map((sale) => sale.customer_id)).size,
      walk_in_count: walkIns.length,
      walk_in_qty_milli: walkIns.reduce((sum, sale) => sum + sale.outstanding_qty_milli, 0),
      sold_milli: soldMilli,
      sold_display: quantity.format(soldMilli, unit),
      outstanding_milli: outstandingMilli,
      outstanding_display: quantity.format(outstandingMilli, unit),
      // What is still in the shop, which is the other half of acting on a recall.
      on_hand_milli: batch.qty_milli,
      on_hand_display: quantity.format(batch.qty_milli, unit),
    },
    // RPT-106: what this list includes, in the words a printed copy needs.
    basis: 'Every sale that took stock from this batch, including sales later voided '
      + '(the goods may have left the shop) and lines partly returned (what did not come '
      + 'back is still out there). Quantities are this batch\'s share of each line, not '
      + 'the whole line.',
  };
}

/**
 * The recall as a file, because the list is worked through by somebody with a telephone
 * and not by somebody at the machine (`04_UX_SPEC.md` §3).
 *
 * The same call the screen makes, so the two cannot disagree — a CSV built from a
 * second query is a CSV that eventually says something the screen does not.
 */
function recallCsv(batchId, { actor = null } = {}) {
  const report = recallFor(batchId, { actor });
  const rows = [
    ['sale_no', 'date', 'customer', 'contact_no', 'product', 'sku',
      'qty_from_this_batch', 'returned', 'still_out', 'status'],
    ...report.sales.map((sale) => [
      sale.sale_no,
      sale.occurred_at_manila,
      // The word, not an empty cell: a blank in a column of names reads as data that
      // failed to load, and this is the answer.
      sale.customer_name || 'Walk-in',
      sale.customer_contact_no || '',
      sale.product,
      sale.sku,
      sale.qty_display,
      sale.returned_display || '',
      sale.outstanding_display,
      sale.is_voided ? 'VOIDED' : sale.status,
    ]),
  ];

  return {
    csv: csv.stringify(rows),
    filename: `recall_${report.batch.product_sku}_${report.batch.batch_no}.csv`.replace(/[^\w.\-]/g, '_'),
    report,
  };
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
  recallFor,
  recallCsv,
  addDays,
  daysBetween,
  today,
};
