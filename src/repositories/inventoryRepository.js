'use strict';

// The ledger and the materialised on-hand figure.
//
// INV-102: append-only. As with audit_logs, the control is the absence of the code —
// there is no update and no delete on inventory_movements anywhere in this file, and
// TC-INT-24 reads the source to prove it rather than trusting the convention.
//
// The one UPDATE here is on `inventory`, which is a derived running balance rather than
// a record of anything. It is reachable only from inventoryService, inside the same
// transaction as the movement that justifies it (INV-101).

const db = require('../config/database');

const MOVEMENT_COLUMNS = `
  id, product_id, movement_type, qty_milli, balance_after_milli, unit_cost_centavos,
  reference_type, reference_id, reference_no, reason, corrects_movement_id,
  batch_id, is_negative_stock, occurred_at, created_by
`;

// ── On hand (INV-101) ───────────────────────────────────────────────────────

/**
 * The on-hand row, or null where the product has never moved.
 *
 * Null is not zero by accident: a product with no row has no history, which is a
 * different state from one that has moved back to zero, and the ledger view says so.
 */
function findOnHand(productId) {
  return db.get()
    .prepare('SELECT product_id, qty_on_hand_milli, updated_at FROM inventory WHERE product_id = ?')
    .get(productId) || null;
}

function qtyOnHand(productId) {
  const row = findOnHand(productId);
  return row ? row.qty_on_hand_milli : 0;
}

/**
 * Write the derived balance. Private to the movement service by convention and by
 * name — nothing else in the application calls this, and TC-INT-20 is what would
 * catch it if something did.
 */
function upsertOnHand({ productId, qtyOnHandMilli, updatedAt }) {
  db.get().prepare(`
    INSERT INTO inventory (product_id, qty_on_hand_milli, updated_at)
    VALUES (@productId, @qtyOnHandMilli, @updatedAt)
    ON CONFLICT(product_id) DO UPDATE SET
      qty_on_hand_milli = @qtyOnHandMilli, updated_at = @updatedAt
  `).run({ productId, qtyOnHandMilli, updatedAt });
  return findOnHand(productId);
}

// ── Movements (INV-102, INV-103) ────────────────────────────────────────────

function insertMovement(row) {
  db.get().prepare(`
    INSERT INTO inventory_movements (${MOVEMENT_COLUMNS})
    VALUES (@id, @product_id, @movement_type, @qty_milli, @balance_after_milli,
            @unit_cost_centavos, @reference_type, @reference_id, @reference_no,
            @reason, @corrects_movement_id, @batch_id, @is_negative_stock,
            @occurred_at, @created_by)
  `).run(row);
  return row;
}

function findMovement(id) {
  return db.get().prepare(`SELECT ${MOVEMENT_COLUMNS} FROM inventory_movements WHERE id = ?`).get(id) || null;
}

/**
 * The per-product ledger (requirement 8), newest first.
 *
 * The id tiebreak matters: several movements of one sale share a timestamp to the
 * millisecond, and UUIDv7 orders them by creation within it (VR-101). Without it
 * SQLite is free to return them in a different order between runs, and a running
 * balance column that jumps around is worse than none.
 */
function movementsFor(productId, { limit = 100, offset = 0, from = null, to = null, type = null } = {}) {
  return db.get().prepare(`
    SELECT m.${MOVEMENT_COLUMNS.trim().split(/,\s*/).join(', m.')},
           u.username AS created_by_username,
           c.id AS corrected_by_id
      FROM inventory_movements m
      LEFT JOIN users u ON u.id = m.created_by
      LEFT JOIN inventory_movements c ON c.corrects_movement_id = m.id
     WHERE m.product_id = @productId
       AND (@type IS NULL OR m.movement_type = @type)
       AND (@from IS NULL OR m.occurred_at >= @from)
       AND (@to   IS NULL OR m.occurred_at <= @to)
     ORDER BY m.occurred_at DESC, m.id DESC
     LIMIT @limit OFFSET @offset
  `).all({ productId, limit, offset, from, to, type });
}

function countMovementsFor(productId, { from = null, to = null, type = null } = {}) {
  return db.get().prepare(`
    SELECT COUNT(*) AS n FROM inventory_movements
     WHERE product_id = @productId
       AND (@type IS NULL OR movement_type = @type)
       AND (@from IS NULL OR occurred_at >= @from)
       AND (@to   IS NULL OR occurred_at <= @to)
  `).get({ productId, from, to, type }).n;
}

/** Movements written against one source document — the INV-107 commit, read back. */
function movementsForReference(referenceType, referenceId) {
  return db.get().prepare(`
    SELECT ${MOVEMENT_COLUMNS} FROM inventory_movements
     WHERE reference_type = ? AND reference_id = ?
     ORDER BY occurred_at, id
  `).all(referenceType, referenceId);
}

// ── Reconciliation (INV-101, TC-INT-20) ─────────────────────────────────────

/**
 * Every product where the materialised balance disagrees with its ledger.
 *
 * An empty result is the invariant FR_2.4 states. This is a query rather than a
 * per-product check because the guard has to be cheap enough to run after every E2E
 * day, and because "which products" is the first question when it is not empty.
 */
function reconciliationBreaks() {
  return db.get().prepare(`
    SELECT p.id AS product_id, p.sku, p.name,
           COALESCE(i.qty_on_hand_milli, 0) AS on_hand_milli,
           COALESCE(m.ledger_milli, 0)      AS ledger_milli,
           COALESCE(i.qty_on_hand_milli, 0) - COALESCE(m.ledger_milli, 0) AS difference_milli
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id
      LEFT JOIN (
        SELECT product_id, SUM(qty_milli) AS ledger_milli
          FROM inventory_movements GROUP BY product_id
      ) m ON m.product_id = p.id
     WHERE COALESCE(i.qty_on_hand_milli, 0) <> COALESCE(m.ledger_milli, 0)
     ORDER BY p.sku
  `).all();
}

/** The last movement's balance_after, for asserting the running balance is coherent. */
function lastBalance(productId) {
  const row = db.get().prepare(`
    SELECT balance_after_milli FROM inventory_movements
     WHERE product_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1
  `).get(productId);
  return row ? row.balance_after_milli : null;
}

// ── Low stock (INV-109) and valuation (RPT-103) ─────────────────────────────

/**
 * INV-109: `qty_on_hand_milli <= min_stock_milli` and active, computed at read time.
 *
 * Never a stored flag. A flag has to be recomputed by something, and the something is
 * always missed on one path — the product then sits below its minimum with nothing
 * saying so, which is the failure FR_2.6 is about.
 *
 * A product with a minimum of zero is excluded: "low stock" for something the store
 * has not set a threshold on would put every zero-stock product in the list forever.
 */
function lowStock({ limit = 200, offset = 0 } = {}) {
  return db.get().prepare(`
    SELECT p.id AS product_id, p.sku, p.name, p.min_stock_milli,
           COALESCE(i.qty_on_hand_milli, 0) AS qty_on_hand_milli,
           u.code AS base_unit_code,
           c.name AS category_name,
           -- Left, not inner: VR-209 makes the brand optional, and an inner join here
           -- would drop every unbranded product out of the low-stock list.
           b.name AS brand_name,
           -- SCR-201's row action for SCR-206: the low-stock view is the same table
           -- under a filter, and a button that vanished when the filter was applied
           -- would read as a missing feature rather than as a filter.
           p.is_batch_tracked
      FROM products p
      JOIN units u ON u.id = p.base_unit_id
      JOIN categories c ON c.id = p.category_id
      LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN inventory i ON i.product_id = p.id
     WHERE p.is_active = 1
       AND p.min_stock_milli > 0
       AND COALESCE(i.qty_on_hand_milli, 0) <= p.min_stock_milli
     ORDER BY (COALESCE(i.qty_on_hand_milli, 0) - p.min_stock_milli), p.name COLLATE NOCASE
     LIMIT @limit OFFSET @offset
  `).all({ limit, offset });
}

function countLowStock() {
  return db.get().prepare(`
    SELECT COUNT(*) AS n
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id
     WHERE p.is_active = 1 AND p.min_stock_milli > 0
       AND COALESCE(i.qty_on_hand_milli, 0) <= p.min_stock_milli
  `).get().n;
}

/**
 * RPT-103: valuation is computed at read time from on-hand and average cost.
 *
 * INV-105: an inactive product keeps its stock, history and valuation. It is included
 * here and flagged, not filtered out — withdrawing a product does not make the sacks
 * in the stockroom stop being worth anything.
 */
function valuationRows() {
  return db.get().prepare(`
    SELECT p.id AS product_id, p.sku, p.name, p.is_active, p.avg_cost_centavos,
           COALESCE(i.qty_on_hand_milli, 0) AS qty_on_hand_milli,
           u.code AS base_unit_code
      FROM products p
      JOIN units u ON u.id = p.base_unit_id
      LEFT JOIN inventory i ON i.product_id = p.id
     WHERE COALESCE(i.qty_on_hand_milli, 0) <> 0
     ORDER BY p.name COLLATE NOCASE
  `).all();
}

module.exports = {
  findOnHand, qtyOnHand, upsertOnHand,
  insertMovement, findMovement, movementsFor, countMovementsFor, movementsForReference,
  reconciliationBreaks, lastBalance,
  lowStock, countLowStock, valuationRows,
};
