'use strict';

// Every read the reports make (RPT-101 – RPT-104, RPT-106).
//
// One rule shapes all of it: **reports read the snapshot, never the live product
// record** (MON-005). A product renamed or repriced this morning must not restate what
// a sale last March was worth, so nothing here joins to products, product_prices or
// the average cost for a historical figure. `sale_items` carries its own
// `product_name_snapshot`, `unit_price_centavos` and `unit_cost_centavos` precisely so
// that this file never has to.
//
// The second rule is RPT-106: voided sales are out of net in every report. That is
// expressed once, as NOT_VOIDED below, and every aggregate uses it — a filter repeated
// by hand in nine statements is a filter that will be missing from the tenth.
//
// Arithmetic here is integer centavos throughout (MON-001). Where a figure needs
// rounding — cost × quantity ÷ 1000 — SQLite's integer division truncates, so the
// half-up of MON-003 is written as `(x + 500) / 1000`. Both operands are non-negative
// by CHECK constraint, so truncation is floor and the identity holds.

const db = require('../config/database');

/** RPT-106, in one place. A void is out of net; it stays in the ledger. */
const NOT_VOIDED = `s.status <> 'VOIDED'`;

/**
 * The cost of a sale line, rounded once, half-up (MON-003, MON-004).
 *
 * saleService.present() computes the same figure in JavaScript for a single sale.
 * These two must agree to the centavo, and TC-INT-35's neighbour asserts that they do
 * — an aggregate that quietly rounds differently from the receipt is the kind of
 * discrepancy nobody finds until an owner adds up a month by hand.
 */
const LINE_COST = `((i.unit_cost_centavos * i.qty_milli) + 500) / 1000`;

/** Revenue net of VAT: the store's money, which the tax is not (TAX-002). */
const LINE_NET_REVENUE = `(i.line_total_centavos - i.tax_centavos)`;

// ── The daily sales report (RPT-101) ────────────────────────────────────────

/**
 * The reconciliation, as one row.
 *
 * `subtotal_centavos` is already net of line discounts (pricingService step 3), so
 * gross is reconstructed by adding them back rather than re-deriving it from the
 * lines. Those are two routes to the same number, and `reconcile()` below asserts they
 * meet — which is what makes RPT-101 a check rather than a claim.
 */
function dailyTotals({ fromAt, toAt, shiftId = null }) {
  return db.get().prepare(`
    SELECT
      COUNT(*)                                                      AS sale_count,
      COALESCE(SUM(s.subtotal_centavos + s.line_discount_centavos), 0) AS gross_centavos,
      COALESCE(SUM(s.line_discount_centavos), 0)                    AS line_discount_centavos,
      COALESCE(SUM(s.txn_discount_centavos), 0)                     AS txn_discount_centavos,
      COALESCE(SUM(s.total_centavos), 0)                            AS net_centavos,
      COALESCE(SUM(s.vat_centavos), 0)                              AS vat_centavos,
      COALESCE(SUM(s.change_centavos), 0)                           AS change_centavos
    FROM sales s
    WHERE ${NOT_VOIDED}
      AND s.occurred_at >= @fromAt AND s.occurred_at <= @toAt
      AND (@shiftId IS NULL OR s.shift_id = @shiftId)
  `).get({ fromAt, toAt, shiftId });
}

/**
 * POS-404's void report — the sales that were voided, and by whom.
 *
 * The one query in this file that looks *for* `VOIDED` rather than past it. Everything
 * else here filters voids out of a total; this is the report that exists so they are
 * not thereby out of sight, which is the difference POS-404 draws in its own sentence.
 */
function voidsInRange({ fromAt, toAt, shiftId = null, limit = 500 }) {
  return db.get().prepare(`
    SELECT
      s.id, s.sale_no, s.occurred_at, s.total_centavos, s.change_centavos,
      s.shift_id, s.void_reason, s.voided_at,
      c.name AS customer_name,
      u.username AS cashier_username,
      v.username AS voided_by_username,
      -- Who authorised the void, which is NOT sales.approved_by: that column records
      -- the approver of a discount or an over-limit credit at the time of sale, and
      -- reading it here would name the wrong person on any sale that had one.
      -- AUD-603's own row is the record of who released the void, so that is where
      -- this reads from. NULL where the person voiding already held TX-405 --
      -- recordOverride writes no row when the two actors would be one.
      (SELECT l.approver_username FROM audit_logs l
        WHERE l.entity_type = 'sales' AND l.entity_id = s.id
          AND l.action = 'OVERRIDE_SALE_VOID'
        ORDER BY l.occurred_at DESC LIMIT 1) AS approved_by_username,
      (SELECT COUNT(*) FROM sale_items i WHERE i.sale_id = s.id) AS line_count,
      -- What actually left the drawer again. Not the sale total: a sale settled part
      -- in GCash and part in cash returns only the cash, and a report that quoted the
      -- total would overstate every mixed-tender void.
      (SELECT COALESCE(SUM(t.amount_centavos), 0) FROM sale_tenders t
        WHERE t.sale_id = s.id AND t.method = 'CASH') AS cash_tendered_centavos
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN users u ON u.id = s.created_by
    LEFT JOIN users v ON v.id = s.voided_by
    WHERE s.status = 'VOIDED'
      AND s.occurred_at >= @fromAt AND s.occurred_at <= @toAt
      AND (@shiftId IS NULL OR s.shift_id = @shiftId)
    ORDER BY s.voided_at DESC, s.sale_no DESC
    LIMIT @limit
  `).all({ fromAt, toAt, shiftId, limit });
}

/** The other side of RPT-101: net = SUM(tenders) − change. */
function tenderTotal({ fromAt, toAt, shiftId = null }) {
  return db.get().prepare(`
    SELECT COALESCE(SUM(t.amount_centavos), 0) AS tendered_centavos
    FROM sale_tenders t
    JOIN sales s ON s.id = t.sale_id
    WHERE ${NOT_VOIDED}
      AND s.occurred_at >= @fromAt AND s.occurred_at <= @toAt
      AND (@shiftId IS NULL OR s.shift_id = @shiftId)
  `).get({ fromAt, toAt, shiftId }).tendered_centavos;
}

/**
 * Gross profit over the range (RPT-104), from the snapshot and nothing else.
 *
 * Revenue is net of VAT because output VAT is the Bureau's money, not the store's;
 * counting it as margin would overstate profit by 12% of every VATable line.
 */
function profitTotals({ fromAt, toAt, shiftId = null }) {
  return db.get().prepare(`
    SELECT
      COALESCE(SUM(${LINE_NET_REVENUE}), 0) AS revenue_centavos,
      COALESCE(SUM(${LINE_COST}), 0)        AS cost_centavos
    FROM sale_items i
    JOIN sales s ON s.id = i.sale_id
    WHERE ${NOT_VOIDED}
      AND s.occurred_at >= @fromAt AND s.occurred_at <= @toAt
      AND (@shiftId IS NULL OR s.shift_id = @shiftId)
  `).get({ fromAt, toAt, shiftId });
}

/** The lines behind the day, by product, for the report body and its CSV. */
function dailyLines({ fromAt, toAt, shiftId = null, limit = 500 }) {
  return db.get().prepare(`
    SELECT
      i.product_id,
      i.product_name_snapshot                AS product_name,
      SUM(i.qty_milli)                       AS qty_milli,
      SUM(i.line_total_centavos)             AS line_total_centavos,
      SUM(i.discount_centavos)               AS discount_centavos,
      SUM(i.tax_centavos)                    AS tax_centavos,
      SUM(${LINE_NET_REVENUE})               AS revenue_centavos,
      SUM(${LINE_COST})                      AS cost_centavos,
      COUNT(*)                               AS line_count
    FROM sale_items i
    JOIN sales s ON s.id = i.sale_id
    WHERE ${NOT_VOIDED}
      AND s.occurred_at >= @fromAt AND s.occurred_at <= @toAt
      AND (@shiftId IS NULL OR s.shift_id = @shiftId)
    GROUP BY i.product_id, i.product_name_snapshot
    ORDER BY revenue_centavos DESC
    LIMIT @limit
  `).all({ fromAt, toAt, shiftId, limit });
}

/**
 * The sales themselves, for the report's transaction list.
 *
 * Voided sales are returned here **on purpose** and flagged: RPT-106 excludes them
 * from net, not from sight. A day's report that simply omits a void gives an owner no
 * way to see that one happened.
 */
function salesInRange({ fromAt, toAt, shiftId = null, limit = 1000 }) {
  return db.get().prepare(`
    SELECT
      s.id, s.sale_no, s.status, s.occurred_at, s.tax_mode, s.price_level,
      s.subtotal_centavos, s.line_discount_centavos, s.txn_discount_centavos,
      s.vat_centavos, s.total_centavos, s.change_centavos,
      s.customer_id, c.name AS customer_name,
      u.username AS cashier_username, s.shift_id
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN users u     ON u.id = s.created_by
    WHERE s.occurred_at >= @fromAt AND s.occurred_at <= @toAt
      AND (@shiftId IS NULL OR s.shift_id = @shiftId)
    ORDER BY s.occurred_at
    LIMIT @limit
  `).all({ fromAt, toAt, shiftId, limit });
}

/** The tax modes actually in force across the range — RPT-106's header line. */
function taxModesInRange({ fromAt, toAt, shiftId = null }) {
  return db.get().prepare(`
    SELECT DISTINCT s.tax_mode
    FROM sales s
    WHERE s.occurred_at >= @fromAt AND s.occurred_at <= @toAt
      AND (@shiftId IS NULL OR s.shift_id = @shiftId)
    ORDER BY s.tax_mode
  `).all({ fromAt, toAt, shiftId }).map((row) => row.tax_mode);
}

/** How many voided sales the range contains, so the header can say so honestly. */
function voidedCount({ fromAt, toAt, shiftId = null }) {
  return db.get().prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(s.total_centavos), 0) AS excluded_centavos
    FROM sales s
    WHERE s.status = 'VOIDED'
      AND s.occurred_at >= @fromAt AND s.occurred_at <= @toAt
      AND (@shiftId IS NULL OR s.shift_id = @shiftId)
  `).get({ fromAt, toAt, shiftId });
}

// ── The payment report (RPT-102) ────────────────────────────────────────────

function tendersByMethod({ fromAt, toAt, shiftId = null }) {
  return db.get().prepare(`
    SELECT
      t.method,
      COUNT(*)                            AS tender_count,
      SUM(t.amount_centavos)              AS amount_centavos,
      COUNT(DISTINCT t.sale_id)           AS sale_count
    FROM sale_tenders t
    JOIN sales s ON s.id = t.sale_id
    WHERE ${NOT_VOIDED}
      AND s.occurred_at >= @fromAt AND s.occurred_at <= @toAt
      AND (@shiftId IS NULL OR s.shift_id = @shiftId)
    GROUP BY t.method
    ORDER BY amount_centavos DESC
  `).all({ fromAt, toAt, shiftId });
}

/**
 * The change given across the range, which is always cash (MON-007).
 *
 * It cannot be summed alongside the per-method groups: change lives on the sale, and a
 * split-tender sale would have its change counted once per tender row. So it is one
 * scalar, subtracted from the cash line by the service.
 */
function changeTotal({ fromAt, toAt, shiftId = null }) {
  return db.get().prepare(`
    SELECT COALESCE(SUM(s.change_centavos), 0) AS change_centavos
    FROM sales s
    WHERE ${NOT_VOIDED}
      AND s.occurred_at >= @fromAt AND s.occurred_at <= @toAt
      AND (@shiftId IS NULL OR s.shift_id = @shiftId)
  `).get({ fromAt, toAt, shiftId }).change_centavos;
}

/**
 * POS-206's column, read from the table rather than assumed.
 *
 * `sale_tenders.status` admits exactly one value by CHECK, so this can only ever
 * return RECORDED — and that is the point. The report prints what the column says, so
 * that if a future migration ever widened the CHECK the report would tell the truth
 * about it instead of continuing to print a hard-coded word.
 */
function tenderStatuses({ fromAt, toAt, shiftId = null }) {
  return db.get().prepare(`
    SELECT DISTINCT t.method, t.status
    FROM sale_tenders t
    JOIN sales s ON s.id = t.sale_id
    WHERE ${NOT_VOIDED}
      AND s.occurred_at >= @fromAt AND s.occurred_at <= @toAt
      AND (@shiftId IS NULL OR s.shift_id = @shiftId)
  `).all({ fromAt, toAt, shiftId });
}

// ── The dashboard's counts ──────────────────────────────────────────────────

/** The shift a cashier is scoped to (TX-421 OWN_SHIFT), whether open or closed. */
function shiftsForUserInRange({ userId, fromAt, toAt }) {
  return db.get().prepare(`
    SELECT id FROM cashier_shifts
    WHERE user_id = @userId AND opened_at <= @toAt
      AND (closed_at IS NULL OR closed_at >= @fromAt)
    ORDER BY opened_at DESC
  `).all({ userId, fromAt, toAt }).map((row) => row.id);
}

function shiftOwner(shiftId) {
  const row = db.get().prepare('SELECT user_id FROM cashier_shifts WHERE id = ?').get(shiftId);
  return row ? row.user_id : null;
}

module.exports = {
  NOT_VOIDED, LINE_COST, LINE_NET_REVENUE, voidsInRange,
  dailyTotals, tenderTotal, profitTotals, dailyLines, salesInRange,
  taxModesInRange, voidedCount,
  tendersByMethod, tenderStatuses, changeTotal,
  shiftsForUserInRange, shiftOwner,
};
