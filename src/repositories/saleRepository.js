'use strict';

// The sale and its three child tables.
//
// POS-107: a completed sale is **immutable**. There is no update path and no delete
// path in this file — the only corrections are a void (POS-401) and a return
// (POS-301), both of which are v1.1 and both of which write *new* rows rather than
// editing these. TC-INT-34's sibling reads this source to prove the absence, as
// TC-INT-24 does for the inventory ledger.
//
// The one exception, deliberately not written here: voiding sets sales.status and the
// voided_* columns. That is TASK-021's, and it will add a narrowly named method that
// touches those columns and nothing else — not a general update.

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

function search({ from = null, to = null, customerId = null, shiftId = null, limit = 50, offset = 0 } = {}) {
  return db.get().prepare(`
    SELECT ${SALE_COLUMNS} FROM sales
     WHERE (@from IS NULL OR occurred_at >= @from)
       AND (@to IS NULL OR occurred_at <= @to)
       AND (@customerId IS NULL OR customer_id = @customerId)
       AND (@shiftId IS NULL OR shift_id = @shiftId)
     ORDER BY occurred_at DESC, sale_no DESC
     LIMIT @limit OFFSET @offset
  `).all({ from, to, customerId, shiftId, limit, offset });
}

function countAll() {
  return db.get().prepare('SELECT COUNT(*) AS n FROM sales').get().n;
}

module.exports = {
  insertSale, insertItem, insertTender, insertDiscount,
  findById, findByNo, itemsFor, tendersFor, discountsFor,
  referenceUsedToday, listForShift, search, countAll,
};
