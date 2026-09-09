'use strict';

// The sale and its three child tables.
//
// POS-107: a completed sale is **immutable**. There is no update path and no delete
// path in this file — the only corrections are a void (POS-401) and a return
// (POS-301), both of which are v1.1 and both of which write *new* rows rather than
// editing these. TC-INT-34's sibling reads this source to prove the absence, as
// TC-INT-24 does for the inventory ledger.
//
// Three narrowly named exceptions live at the bottom of this file. Between them they
// touch five columns and nothing else:
//
//   `setStatus`      (TASK-020)  sales.status, for the two return statuses
//   `setReturnedQty` (TASK-020)  sale_items.returned_qty_milli
//   `setVoided`      (TASK-021)  sales.status, voided_at, voided_by, void_reason
//
// 006_sales.sql put every one of those columns there for exactly this. What they are
// deliberately *not* is a general `updateFields`: the difference between "the sale
// records what happened to it" and "the sale can be edited" is the whole of POS-107,
// and it is kept as the difference between three named methods and one open one.
//
// `setVoided` writes the status **and** the actor, timestamp and reason in one
// statement, and `setStatus` refuses `VOIDED` outright. POS-404 is why: a sale marked
// voided with nobody's name against it is the shape a shrinkage tool takes, and the
// way to keep the four columns together is to make it impossible to write one of them
// alone.

const db = require('../config/database');

const SALE_COLUMNS = `
  id, sale_no, customer_id, shift_id, status, price_level, tax_mode,
  subtotal_centavos, line_discount_centavos, txn_discount_centavos,
  statutory_discount_centavos, vatable_centavos, vat_exempt_centavos,
  zero_rated_centavos, vat_centavos, total_centavos, change_centavos,
  approved_by, voided_at, voided_by, void_reason, occurred_at, created_by
`;

const ITEM_COLUMNS = `
  id, sale_id, line_no, product_id, product_name_snapshot, qty_milli, sold_unit_id,
  sold_pack_factor_milli, unit_price_centavos, price_level_applied, unit_cost_centavos,
  discount_centavos, tax_class_snapshot, tax_centavos, line_total_centavos,
  batch_id, returned_qty_milli
`;

const TENDER_COLUMNS = 'id, sale_id, method, amount_centavos, reference_no, status, created_at';

const DISCOUNT_COLUMNS = `
  id, sale_id, sale_item_id, discount_type, original_centavos, discount_centavos,
  discount_bp, reason, applied_by, approved_by, statutory_id_type, statutory_id_no,
  statutory_name, created_at
`;

const columnList = (columns) => columns.trim().split(/,\s*/).join(', ');
const placeholders = (columns) => columns.trim().split(/,\s*/).map((c) => `@${c}`).join(', ');

// ── Writing (step 9 of §4.1) ────────────────────────────────────────────────

function insertSale(row) {
  db.get().prepare(`
    INSERT INTO sales (${columnList(SALE_COLUMNS)}) VALUES (${placeholders(SALE_COLUMNS)})
  `).run(row);
  return row;
}

function insertItem(row) {
  db.get().prepare(`
    INSERT INTO sale_items (${columnList(ITEM_COLUMNS)}) VALUES (${placeholders(ITEM_COLUMNS)})
  `).run(row);
  return row;
}

function insertTender(row) {
  db.get().prepare(`
    INSERT INTO sale_tenders (${columnList(TENDER_COLUMNS)}) VALUES (${placeholders(TENDER_COLUMNS)})
  `).run(row);
  return row;
}

function insertDiscount(row) {
  db.get().prepare(`
    INSERT INTO sale_discounts (${columnList(DISCOUNT_COLUMNS)}) VALUES (${placeholders(DISCOUNT_COLUMNS)})
  `).run(row);
  return row;
}

// ── Reading ─────────────────────────────────────────────────────────────────

function findById(id) {
  return db.get().prepare(`SELECT ${SALE_COLUMNS} FROM sales WHERE id = ?`).get(id) || null;
}

function findByNo(saleNo) {
  return db.get().prepare(`SELECT ${SALE_COLUMNS} FROM sales WHERE sale_no = ?`).get(saleNo) || null;
}

function itemsFor(saleId) {
  return db.get().prepare(`
    SELECT i.${columnList(ITEM_COLUMNS).split(', ').join(', i.')},
           u.code AS sold_unit_code, p.sku AS product_sku
      FROM sale_items i
      JOIN units u ON u.id = i.sold_unit_id
      JOIN products p ON p.id = i.product_id
     WHERE i.sale_id = ?
     ORDER BY i.line_no
  `).all(saleId);
}

function tendersFor(saleId) {
  return db.get()
    .prepare(`SELECT ${TENDER_COLUMNS} FROM sale_tenders WHERE sale_id = ? ORDER BY created_at, id`)
    .all(saleId);
}

function discountsFor(saleId) {
  return db.get()
    .prepare(`SELECT ${DISCOUNT_COLUMNS} FROM sale_discounts WHERE sale_id = ? ORDER BY created_at, id`)
    .all(saleId);
}

/**
 * POS-207 — a tender reference is unique per method per day.
 *
 * A warning rather than a constraint: the rule says the cashier must explicitly accept
 * it, because there are real cases (a customer paying two sales from one GCash
 * transfer) where the duplicate is correct. A UNIQUE index would refuse those.
 */
function referenceUsedToday({ method, referenceNo, fromAt, toAt }) {
  return db.get().prepare(`
    SELECT t.id, t.sale_id, t.amount_centavos, s.sale_no, s.occurred_at
      FROM sale_tenders t
      JOIN sales s ON s.id = t.sale_id
     WHERE t.method = @method
       AND t.reference_no = @referenceNo
       AND s.occurred_at >= @fromAt AND s.occurred_at <= @toAt
     ORDER BY s.occurred_at
  `).all({ method, referenceNo, fromAt, toAt });
}

function listForShift(shiftId) {
  return db.get()
    .prepare(`SELECT ${SALE_COLUMNS} FROM sales WHERE shift_id = ? ORDER BY occurred_at, sale_no`)
    .all(shiftId);
}

const SEARCH_WHERE = `
  WHERE (@from IS NULL OR s.occurred_at >= @from)
    AND (@to IS NULL OR s.occurred_at <= @to)
    AND (@customerId IS NULL OR s.customer_id = @customerId)
    AND (@shiftId IS NULL OR s.shift_id = @shiftId)
    AND (@status IS NULL OR s.status = @status)
    AND (@returnable = 0 OR s.status IN ('COMPLETED','PARTIALLY_RETURNED'))
    AND (@q IS NULL
         OR s.sale_no LIKE @like COLLATE NOCASE
         OR c.name LIKE @like COLLATE NOCASE)
`;

/**
 * The sale lookup SCR-305 reads.
 *
 * `returnable` is the filter a counter actually wants — a voided or fully returned
 * sale has nothing left to give back — expressed as a flag rather than making the
 * screen keep its own copy of which two statuses those are.
 */
function search({
  from = null, to = null, customerId = null, shiftId = null,
  q = null, status = null, returnable = false, limit = 50, offset = 0,
} = {}) {
  return db.get().prepare(`
    SELECT ${SALE_COLUMNS.trim().split(/,\s*/).map((c) => `s.${c}`).join(', ')},
           c.name AS customer_name, u.username AS created_by_username
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      LEFT JOIN users u ON u.id = s.created_by
    ${SEARCH_WHERE}
     ORDER BY s.occurred_at DESC, s.sale_no DESC
     LIMIT @limit OFFSET @offset
  `).all({
    from, to, customerId, shiftId, status, q, like: q ? `%${q}%` : null,
    returnable: returnable ? 1 : 0, limit, offset,
  });
}

function countSearch({
  from = null, to = null, customerId = null, shiftId = null,
  q = null, status = null, returnable = false,
} = {}) {
  return db.get().prepare(`
    SELECT COUNT(*) AS n
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
    ${SEARCH_WHERE}
  `).get({
    from, to, customerId, shiftId, status, q, like: q ? `%${q}%` : null,
    returnable: returnable ? 1 : 0,
  }).n;
}

function countAll() {
  return db.get().prepare('SELECT COUNT(*) AS n FROM sales').get().n;
}

// ── POS-301's two columns, and only those two ───────────────────────────────

/**
 * Move a sale between the statuses POS-107's machine allows after COMPLETED.
 *
 * The status list is repeated here rather than imported, because this is the layer
 * that writes it and a repository that would accept any string is a repository that
 * makes the CHECK constraint the only thing standing between the ledger and a typo.
 *
 * `VOIDED` is deliberately **not** on it. It has three companion columns that POS-401
 * requires to be written with it, and `setVoided` below is the only way to reach it.
 */
const SETTABLE_STATUSES = Object.freeze(['PARTIALLY_RETURNED', 'RETURNED']);

function setStatus(saleId, status) {
  if (!SETTABLE_STATUSES.includes(status)) {
    throw new RangeError(`a sale is not moved to ${status} from here (POS-107)`);
  }
  db.get().prepare('UPDATE sales SET status = ? WHERE id = ?').run(status, saleId);
  return findById(saleId);
}

/**
 * POS-401's four columns, written together or not at all.
 *
 * One statement rather than a status change followed by three stamps: there is no
 * moment in which the ledger holds a voided sale that nobody voided. The reason is
 * required here rather than defaulted, because POS-401 names it alongside the actor
 * and the timestamp, and a void with no reason is the row an auditor cannot use.
 */
function setVoided(saleId, { voidedAt, voidedBy, reason }) {
  if (!voidedAt || !voidedBy || !reason) {
    throw new TypeError('a void records the actor, the time and the reason (POS-401)');
  }
  db.get().prepare(`
    UPDATE sales SET status = 'VOIDED', voided_at = ?, voided_by = ?, void_reason = ?
     WHERE id = ?
  `).run(voidedAt, voidedBy, reason, saleId);
  return findById(saleId);
}

/**
 * POS-301's running total of what has come back on one line.
 *
 * Set to an absolute figure rather than incremented: the caller has just computed what
 * the line's cumulative returned quantity is, and an increment is a second way of
 * arriving at the same number that can disagree with the first.
 */
function setReturnedQty(saleItemId, qtyMilli) {
  if (!Number.isInteger(qtyMilli) || qtyMilli < 0) {
    throw new RangeError('a returned quantity is whole thousandths, zero or more (MON-002)');
  }
  db.get().prepare('UPDATE sale_items SET returned_qty_milli = ? WHERE id = ?')
    .run(qtyMilli, saleItemId);
}

function findItem(saleItemId) {
  return db.get().prepare(`SELECT ${columnList(ITEM_COLUMNS)} FROM sale_items WHERE id = ?`)
    .get(saleItemId) || null;
}

module.exports = {
  SETTABLE_STATUSES,
  insertSale, insertItem, insertTender, insertDiscount,
  findById, findByNo, itemsFor, findItem, tendersFor, discountsFor,
  referenceUsedToday, listForShift, search, countSearch, countAll,
  setStatus, setVoided, setReturnedQty,
};
