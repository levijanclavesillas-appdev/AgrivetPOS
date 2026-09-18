'use strict';

// Restocking requests and their lines (TASK-072).
//
// The one method worth reading before the rest is `suggestionRows`. It answers, for
// every product the store might need to buy, four questions at once — what is on the
// shelf, what is already on its way, who sold it last and at what — and it answers them
// in **one statement**. Asking any of them per row is the N+1 that 002_catalog.sql:62
// already warns about for barcodes, and a buyer's list is exactly the place it would be
// paid two hundred times.
//
// `on_order` is the column the whole module exists for. INV-109 compares the shelf with
// the minimum and knows nothing about the forty sacks on a PENDING order, so a buyer who
// reads the low-stock list twice in a week orders them twice. Netting it off is PO-109.
//
// There is no general update path for a submitted or approved request. A DRAFT's lines
// are replaced wholesale (`replaceItems`), each transition writes the columns of that
// transition and no others, and the conversion writes only the two columns that say
// which order carried a line. PO-107: nothing in this file touches inventory_movements.

const db = require('../config/database');

// PO-102's two open statuses. An order that is DRAFT has not been sent to anybody, so
// nothing is coming from it; CANCELLED and RECEIVED have stopped coming.
const OPEN_PO_STATUSES = "('PENDING','PARTIALLY_RECEIVED')";

// A request in one of these is a question still being asked, so a product on it should
// not be asked for again on a second list.
const OPEN_REQUEST_STATUSES = "('DRAFT','SUBMITTED','APPROVED')";

/**
 * What is outstanding on open purchase orders, per product.
 *
 * Ordered less received, grouped once for the whole catalogue rather than asked per row.
 * purchase_order_items carries no received counter — PO-201's receipts are the record —
 * so the sum comes from goods_receipt_items by po_item_id, which idx_poitems_product and
 * the receipts' own keys make cheap.
 *
 * Over-receipt (PO-204) can make a line's outstanding negative; it is clamped to zero
 * here rather than in the caller, so "already coming" can never read as less than
 * nothing and quietly inflate a suggestion.
 */
const ON_ORDER = `
  SELECT poi.product_id AS product_id,
         SUM(MAX(0, poi.qty_milli - COALESCE((
           SELECT SUM(gi.received_qty_milli)
             FROM goods_receipt_items gi
            WHERE gi.po_item_id = poi.id
         ), 0))) AS on_order_milli
    FROM purchase_order_items poi
    JOIN purchase_orders po ON po.id = poi.po_id
   WHERE po.status IN ${OPEN_PO_STATUSES}
   GROUP BY poi.product_id
`;

/**
 * The most recent receipt of each product: who delivered it, and what they charged.
 *
 * This is the only "who do we buy this from" signal the schema carries — there is no
 * preferred_supplier_id and no product_suppliers table — so it is a default the buyer
 * can change, never an answer. ROW_NUMBER keeps it to one statement; the correlated
 * alternative is a second query per row.
 */
const LAST_RECEIPT = `
  SELECT gi.product_id AS product_id,
         gi.unit_cost_centavos AS last_cost_centavos,
         g.supplier_id AS last_supplier_id,
         g.received_at AS last_received_at,
         ROW_NUMBER() OVER (
           PARTITION BY gi.product_id ORDER BY g.received_at DESC, g.id DESC
         ) AS rn
    FROM goods_receipt_items gi
    JOIN goods_receipts g ON g.id = gi.gr_id
`;

/**
 * Every product the store might need to buy, with what it needs to decide.
 *
 * Two derivations, both carrying why they fired:
 *
 *   BELOW_MINIMUM  min_stock_milli > 0 and the shelf is at or under it — INV-109 exactly.
 *   OUT_OF_STOCK   no minimum set and nothing on the shelf.
 *
 * The second exists because `inventoryRepository.lowStock()` requires
 * `min_stock_milli > 0`, which is right for a list called *low stock* and wrong for a
 * buyer: a product nobody set a minimum on is invisible to every low-stock surface in
 * the application **including at zero**, and on a store stocked by hand that is most of
 * the catalogue. The buyer's question is "what is empty", and it has never been asked.
 *
 * INV-114's exclusion is kept in both: made to order is never low on stock.
 */
function suggestionRows({ limit = 500 } = {}) {
  return db.get().prepare(`
    SELECT p.id AS product_id, p.sku, p.name, p.min_stock_milli, p.is_batch_tracked,
           p.avg_cost_centavos,
           COALESCE(i.qty_on_hand_milli, 0) AS qty_on_hand_milli,
           u.code AS base_unit_code,
           c.name AS category_name,
           b.name AS brand_name,
           COALESCE(oo.on_order_milli, 0) AS on_order_milli,
           lr.last_cost_centavos,
           lr.last_supplier_id,
           lr.last_received_at,
           s.name AS last_supplier_name,
           CASE WHEN p.min_stock_milli > 0 THEN 'BELOW_MINIMUM' ELSE 'OUT_OF_STOCK' END AS source,
           -- A product already on a request somebody is still deciding about is not a
           -- second thing to buy. Shown, flagged, and unticked by default.
           (SELECT COUNT(*) FROM restock_request_items ri
              JOIN restock_requests r ON r.id = ri.request_id
             WHERE ri.product_id = p.id
               AND r.status IN ${OPEN_REQUEST_STATUSES}) AS open_request_count
      FROM products p
      JOIN units u ON u.id = p.base_unit_id
      JOIN categories c ON c.id = p.category_id
      -- Left, not inner: VR-209 makes the brand optional, and an inner join would drop
      -- every unbranded product out of the buyer's list.
      LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN inventory i ON i.product_id = p.id
      LEFT JOIN (${ON_ORDER}) oo ON oo.product_id = p.id
      LEFT JOIN (${LAST_RECEIPT}) lr ON lr.product_id = p.id AND lr.rn = 1
      LEFT JOIN suppliers s ON s.id = lr.last_supplier_id
     WHERE p.is_active = 1
       AND p.is_stocked = 1
       AND (
         (p.min_stock_milli > 0 AND COALESCE(i.qty_on_hand_milli, 0) <= p.min_stock_milli)
         OR (p.min_stock_milli = 0 AND COALESCE(i.qty_on_hand_milli, 0) <= 0)
       )
     ORDER BY
       -- Emptiest first, measured as a fraction of what the store said it wants. A
       -- product at 0 of 50 is a worse problem than one at 48 of 50, and sorting by the
       -- raw shortfall would put the sack of feed above the sachet every time.
       CASE WHEN p.min_stock_milli > 0
            THEN (COALESCE(i.qty_on_hand_milli, 0) * 1.0) / p.min_stock_milli
            ELSE -1 END,
       p.name COLLATE NOCASE
     LIMIT @limit
  `).all({ limit });
}

/** The same figures for products the buyer picked by hand, which no derivation found. */
function contextFor(productIds) {
  if (productIds.length === 0) return [];
  const placeholders = productIds.map(() => '?').join(',');
  return db.get().prepare(`
    SELECT p.id AS product_id, p.sku, p.name, p.min_stock_milli, p.is_batch_tracked,
           p.avg_cost_centavos,
           COALESCE(i.qty_on_hand_milli, 0) AS qty_on_hand_milli,
           u.code AS base_unit_code,
           c.name AS category_name,
           b.name AS brand_name,
           COALESCE(oo.on_order_milli, 0) AS on_order_milli,
           lr.last_cost_centavos,
           lr.last_supplier_id,
           lr.last_received_at,
           s.name AS last_supplier_name,
           'ADDED' AS source,
           (SELECT COUNT(*) FROM restock_request_items ri
              JOIN restock_requests r ON r.id = ri.request_id
             WHERE ri.product_id = p.id
               AND r.status IN ${OPEN_REQUEST_STATUSES}) AS open_request_count
      FROM products p
      JOIN units u ON u.id = p.base_unit_id
      JOIN categories c ON c.id = p.category_id
      LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN inventory i ON i.product_id = p.id
      LEFT JOIN (${ON_ORDER}) oo ON oo.product_id = p.id
      LEFT JOIN (${LAST_RECEIPT}) lr ON lr.product_id = p.id AND lr.rn = 1
      LEFT JOIN suppliers s ON s.id = lr.last_supplier_id
     WHERE p.id IN (${placeholders})
  `).all(...productIds);
}

// ── The request itself ──────────────────────────────────────────────────────

const REQUEST_COLUMNS = `
  r.id, r.rr_no, r.status, r.note,
  r.requested_at, r.requested_by, r.submitted_at, r.submitted_by,
  r.decided_at, r.decided_by, r.decision_reason, r.self_approved,
  r.converted_at, r.cancelled_at, r.cancelled_by, r.cancel_reason,
  r.created_at, r.updated_at
`;

const REQUEST_FROM = `
  FROM restock_requests r
  LEFT JOIN users rq ON rq.id = r.requested_by
  LEFT JOIN users dc ON dc.id = r.decided_by
`;

const REQUEST_JOINED = `
  ${REQUEST_COLUMNS},
  rq.username AS requested_by_username,
  dc.username AS decided_by_username,
  (SELECT COUNT(*) FROM restock_request_items i WHERE i.request_id = r.id) AS line_count,
  (SELECT COUNT(*) FROM restock_request_items i
    WHERE i.request_id = r.id AND i.is_approved = 1) AS approved_count,
  (SELECT COUNT(*) FROM restock_request_items i
    WHERE i.request_id = r.id AND i.supplier_id IS NULL) AS no_supplier_count
`;

function findById(id) {
  return db.get().prepare(`SELECT ${REQUEST_JOINED} ${REQUEST_FROM} WHERE r.id = ?`).get(id);
}

function findByNo(rrNo) {
  return db.get().prepare(`SELECT ${REQUEST_JOINED} ${REQUEST_FROM} WHERE r.rr_no = ?`).get(rrNo);
}

/**
 * The filter both list queries share.
 *
 * The bindings are built beside the clause that uses them rather than passed wholesale:
 * better-sqlite3 refuses a named parameter the statement does not mention, so a `status`
 * of null must be absent from the object and not merely null in it.
 */
function listWhere({ status, open }) {
  const where = [];
  const params = {};
  if (status) { where.push('r.status = @status'); params.status = status; }
  if (open) where.push(`r.status IN ${OPEN_REQUEST_STATUSES}`);
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function search({ status = null, open = false, limit = 50, offset = 0 } = {}) {
  const { clause, params } = listWhere({ status, open });
  return db.get().prepare(`
    SELECT ${REQUEST_JOINED} ${REQUEST_FROM} ${clause}
     ORDER BY r.requested_at DESC, r.rr_no DESC
     LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset });
}

function countSearch({ status = null, open = false } = {}) {
  const { clause, params } = listWhere({ status, open });
  const stmt = db.get().prepare(`SELECT COUNT(*) AS n FROM restock_requests r ${clause}`);
  return (Object.keys(params).length ? stmt.get(params) : stmt.get()).n;
}

function insert(row) {
  db.get().prepare(`
    INSERT INTO restock_requests (id, rr_no, status, note, requested_at, requested_by,
                                  created_at, created_by)
    VALUES (@id, @rr_no, @status, @note, @requested_at, @requested_by, @created_at, @created_by)
  `).run(row);
  return findById(row.id);
}

const REQUEST_FIELDS = new Set([
  'status', 'note', 'submitted_at', 'submitted_by', 'decided_at', 'decided_by',
  'decision_reason', 'self_approved', 'converted_at', 'cancelled_at', 'cancelled_by',
  'cancel_reason',
]);

function updateFields(id, changes, at, actorId) {
  const keys = Object.keys(changes).filter((k) => REQUEST_FIELDS.has(k));
  if (keys.length === 0) return findById(id);
  db.get().prepare(`
    UPDATE restock_requests SET ${keys.map((k) => `${k} = @${k}`).join(', ')},
           updated_at = @updated_at, updated_by = @updated_by
     WHERE id = @id
  `).run({ ...changes, id, updated_at: at, updated_by: actorId });
  return findById(id);
}

// ── Its lines ───────────────────────────────────────────────────────────────

const ITEM_JOINED = `
  i.id, i.request_id, i.line_no, i.product_id, i.product_name_snapshot,
  i.qty_milli, i.suggested_qty_milli, i.on_hand_milli, i.on_order_milli,
  i.min_stock_milli, i.supplier_id, i.unit_cost_centavos, i.is_approved,
  i.po_id, i.po_item_id, i.source, i.notes,
  p.sku, p.is_batch_tracked,
  u.code AS base_unit_code,
  s.name AS supplier_name,
  po.po_no
`;

function itemsFor(requestId) {
  return db.get().prepare(`
    SELECT ${ITEM_JOINED}
      FROM restock_request_items i
      JOIN products p ON p.id = i.product_id
      JOIN units u ON u.id = p.base_unit_id
      LEFT JOIN suppliers s ON s.id = i.supplier_id
      LEFT JOIN purchase_orders po ON po.id = i.po_id
     WHERE i.request_id = ?
     ORDER BY i.line_no
  `).all(requestId);
}

function deleteItems(requestId) {
  db.get().prepare('DELETE FROM restock_request_items WHERE request_id = ?').run(requestId);
}

function insertItem(row) {
  db.get().prepare(`
    INSERT INTO restock_request_items
      (id, request_id, line_no, product_id, product_name_snapshot, qty_milli,
       suggested_qty_milli, on_hand_milli, on_order_milli, min_stock_milli,
       supplier_id, unit_cost_centavos, source, notes)
    VALUES
      (@id, @request_id, @line_no, @product_id, @product_name_snapshot, @qty_milli,
       @suggested_qty_milli, @on_hand_milli, @on_order_milli, @min_stock_milli,
       @supplier_id, @unit_cost_centavos, @source, @notes)
  `).run(row);
}

/** Per-line approval (AUD-603's two actors are on the request, not repeated per line). */
function setApproved(itemId, isApproved) {
  db.get().prepare('UPDATE restock_request_items SET is_approved = ? WHERE id = ?')
    .run(isApproved === null ? null : (isApproved ? 1 : 0), itemId);
}

/** PO-108: which order carried this line. Written only by the conversion. */
function setOrdered(itemId, { poId, poItemId }) {
  db.get().prepare('UPDATE restock_request_items SET po_id = ?, po_item_id = ? WHERE id = ?')
    .run(poId, poItemId, itemId);
}

module.exports = {
  OPEN_PO_STATUSES, OPEN_REQUEST_STATUSES,
  suggestionRows, contextFor,
  findById, findByNo, search, countSearch, insert, updateFields,
  itemsFor, deleteItems, insertItem, setApproved, setOrdered,
};
