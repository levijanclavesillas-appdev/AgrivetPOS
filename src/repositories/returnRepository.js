'use strict';

// Sales returns and their lines.
//
// POS-107's absence, once more: there is no `updateFields`, no delete, and no path of
// any kind that changes a posted return. The status CHECK admits one value, so there is
// no draft to edit either. A return that was wrong is corrected by an inventory
// adjustment and, where money moved, a credit adjustment — both of which leave the
// mistake and its remedy standing side by side (INV-102).

const db = require('../config/database');

const COLUMNS = `
  r.id, r.return_no, r.sale_id, r.customer_id, r.shift_id, r.status, r.reason, r.notes,
  r.total_centavos, r.refund_credit_centavos, r.refund_cash_centavos,
  r.refund_store_credit_centavos, r.credit_txn_id, r.beyond_window, r.approved_by,
  r.approval_reason, r.occurred_at, r.created_at, r.created_by
`;

const JOINED = `
  ${COLUMNS},
  s.sale_no, s.occurred_at AS sale_occurred_at,
  c.name AS customer_name, c.code AS customer_code,
  u.username AS created_by_username,
  a.username AS approved_by_username
`;

const FROM = `
  FROM sale_returns r
  JOIN sales s ON s.id = r.sale_id
  LEFT JOIN customers c ON c.id = r.customer_id
  LEFT JOIN users u ON u.id = r.created_by
  LEFT JOIN users a ON a.id = r.approved_by
`;

function findById(id) {
  return db.get().prepare(`SELECT ${JOINED} ${FROM} WHERE r.id = ?`).get(id) || null;
}

function findByNo(returnNo) {
  return db.get().prepare(`SELECT ${JOINED} ${FROM} WHERE r.return_no = ?`).get(returnNo) || null;
}

function countAll() {
  return db.get().prepare('SELECT COUNT(*) AS n FROM sale_returns').get().n;
}

const SEARCH_WHERE = `
  WHERE (@saleId IS NULL OR r.sale_id = @saleId)
    AND (@customerId IS NULL OR r.customer_id = @customerId)
    AND (@shiftId IS NULL OR r.shift_id = @shiftId)
    AND (@from IS NULL OR r.occurred_at >= @from)
    AND (@to IS NULL OR r.occurred_at <= @to)
    AND (@q IS NULL
         OR r.return_no LIKE @like COLLATE NOCASE
         OR s.sale_no LIKE @like COLLATE NOCASE
         OR c.name LIKE @like COLLATE NOCASE)
`;

function search({
  saleId = null, customerId = null, shiftId = null, from = null, to = null,
  q = null, limit = 50, offset = 0,
} = {}) {
  return db.get().prepare(`
    SELECT ${JOINED},
           (SELECT COUNT(*) FROM sale_return_items i WHERE i.return_id = r.id) AS line_count
    ${FROM}
    ${SEARCH_WHERE}
     ORDER BY r.occurred_at DESC, r.id DESC
     LIMIT @limit OFFSET @offset
  `).all({ saleId, customerId, shiftId, from, to, q, like: q ? `%${q}%` : null, limit, offset });
}

function countSearch({ saleId = null, customerId = null, shiftId = null, from = null, to = null, q = null } = {}) {
  return db.get().prepare(`SELECT COUNT(*) AS n ${FROM} ${SEARCH_WHERE}`)
    .get({ saleId, customerId, shiftId, from, to, q, like: q ? `%${q}%` : null }).n;
}

function insert(row) {
  const keys = Object.keys(row);
  db.get().prepare(`
    INSERT INTO sale_returns (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})
  `).run(row);
  return findById(row.id);
}

function insertItem(row) {
  const keys = Object.keys(row);
  db.get().prepare(`
    INSERT INTO sale_return_items (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})
  `).run(row);
  return row;
}

function itemsFor(returnId) {
  return db.get().prepare(`
    SELECT i.*, p.sku, u.code AS base_unit_code
      FROM sale_return_items i
      JOIN products p ON p.id = i.product_id
      JOIN units u ON u.id = p.base_unit_id
     WHERE i.return_id = ?
     ORDER BY i.line_no
  `).all(returnId);
}

/**
 * How much of one sale line has already come back, summed from the returns.
 *
 * `sale_items.returned_qty_milli` holds the same figure, and this is what it is
 * checked against: INV-101's reasoning applied to a third table. The stored column is
 * what every screen reads, and TC-INT-81 proves the two agree after repeated partial
 * returns — a materialised counter nobody reconciles is a counter that drifts.
 */
function returnedQtyFor(saleItemId) {
  return db.get().prepare(`
    SELECT COALESCE(SUM(qty_milli), 0) AS n FROM sale_return_items WHERE sale_item_id = ?
  `).get(saleItemId).n;
}

/**
 * What has already been refunded against one sale line, and how much of it was tax.
 *
 * Both, because both are apportioned the same way and the last return of a line
 * refunds the remainder rather than a proportion — see `refundFor` in returnService.
 * A caller that had only the total would have to re-derive the tax by a second method.
 */
function refundedFor(saleItemId) {
  return db.get().prepare(`
    SELECT COALESCE(SUM(line_total_centavos), 0) AS line_total_centavos,
           COALESCE(SUM(tax_centavos), 0) AS tax_centavos
      FROM sale_return_items WHERE sale_item_id = ?
  `).get(saleItemId);
}

/**
 * What earlier returns of this sale have already sent to the credit ledger.
 *
 * POS-305 refunds "by the same means as the original tender", so the amount a sale can
 * put back on a customer's account is bounded by what it put on there in the first
 * place. Both credit columns are summed because they are one ledger seen either side
 * of zero: reducing a balance and creating store credit are the same `RETURN_CREDIT`
 * row (CR-108), and only the customer's balance at the time decides which it looked
 * like.
 */
function creditRefundedForSale(saleId) {
  return db.get().prepare(`
    SELECT COALESCE(SUM(refund_credit_centavos + refund_store_credit_centavos), 0) AS n
      FROM sale_returns WHERE sale_id = ?
  `).get(saleId).n;
}

/** Every line of every return against one sale, for the sale's own view. */
function itemsForSale(saleId) {
  return db.get().prepare(`
    SELECT i.*, r.return_no, r.occurred_at
      FROM sale_return_items i
      JOIN sale_returns r ON r.id = i.return_id
     WHERE r.sale_id = ?
     ORDER BY r.occurred_at, i.line_no
  `).all(saleId);
}

/**
 * RPT-101's fourth term, over a date range.
 *
 * Both figures are returned because they must be equal — the value returned and the
 * refund paid out are the same money seen from two sides — and a report that states
 * one while the other has drifted is a report that reconciles to nothing. The schema's
 * CHECK enforces it per row; this is what lets a test assert it in aggregate.
 */
function returnTotals({ from = null, to = null, shiftId = null } = {}) {
  return db.get().prepare(`
    SELECT COUNT(*) AS return_count,
           COALESCE(SUM(total_centavos), 0) AS returns_centavos,
           COALESCE(SUM(refund_credit_centavos), 0) AS refund_credit_centavos,
           COALESCE(SUM(refund_cash_centavos), 0) AS refund_cash_centavos,
           COALESCE(SUM(refund_store_credit_centavos), 0) AS refund_store_credit_centavos
      FROM sale_returns
     WHERE (@from IS NULL OR occurred_at >= @from)
       AND (@to IS NULL OR occurred_at <= @to)
       AND (@shiftId IS NULL OR shift_id = @shiftId)
  `).get({ from, to, shiftId });
}

module.exports = {
  findById, findByNo, countAll, search, countSearch,
  insert, insertItem, itemsFor, itemsForSale,
  returnedQtyFor, refundedFor, creditRefundedForSale, returnTotals,
};
