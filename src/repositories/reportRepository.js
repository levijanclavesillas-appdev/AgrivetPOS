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
      -- TAX-004: the statutory discount is part of what was rung up and part of what
      -- came off, so it belongs in gross as well as in the discounts below. What is
      -- **not** in it is the VAT an exempt line was relieved of: the store never
      -- charged it, so it was never revenue and cannot be a discount off revenue.
      COALESCE(SUM(s.subtotal_centavos + s.line_discount_centavos + s.statutory_discount_centavos), 0)
                                                                    AS gross_centavos,
      COALESCE(SUM(s.line_discount_centavos), 0)                    AS line_discount_centavos,
      COALESCE(SUM(s.txn_discount_centavos), 0)                     AS txn_discount_centavos,
      COALESCE(SUM(s.statutory_discount_centavos), 0)               AS statutory_discount_centavos,
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

/**
 * The tenders behind one method's recorded total (`RPT-105`, requirement 8).
 *
 * A variance that can only be stated is a variance nobody can act on: the answer to
 * "we are ₱50 short" is a list somebody reads down until they find the ₱50. The same
 * filter as `tendersByMethod` — voids excluded, the same range — so the rows add up to
 * the figure they are drilling into, which is the only property that makes this useful.
 */
function tendersOfMethod({ fromAt, toAt, method, shiftId = null, limit = 500 }) {
  return db.get().prepare(`
    SELECT t.id, t.method, t.amount_centavos, t.reference_no, t.status,
           s.id AS sale_id, s.sale_no, s.occurred_at, s.total_centavos,
           u.username AS cashier
    FROM sale_tenders t
    JOIN sales s ON s.id = t.sale_id
    LEFT JOIN users u ON u.id = s.created_by
    WHERE ${NOT_VOIDED}
      AND t.method = @method
      AND s.occurred_at >= @fromAt AND s.occurred_at <= @toAt
      AND (@shiftId IS NULL OR s.shift_id = @shiftId)
    ORDER BY s.occurred_at, s.sale_no
    LIMIT @limit
  `).all({ fromAt, toAt, method, shiftId, limit });
}

// ── TASK-033 — the same arithmetic, grouped three more ways ────────────────
//
// Four of the five reports below are `dailyLines` with a different GROUP BY, and one
// of them — slow movers — is the opposite query from everything else in this file.
//
// **The shape they share is aggregate-then-join.** A breakdown by category could be
// written as `sale_items JOIN products JOIN categories GROUP BY category`, and at
// 100,000 lines that resolves the product of every line one line at a time. Summing by
// product first and joining the catalogue to the *result* does the same arithmetic with
// one catalogue lookup per product sold rather than one per line.
//
// **What the grouping key reads, and why it is not a snapshot.** MON-005 keeps money
// off the live product record and `sale_items` carries its own name, price and cost for
// exactly that reason. A category is not money: nothing snapshots it, and a sale line
// has no column that could answer "which category was this in last March". So the
// category on these rows is the product's category **now**, which means recategorising
// a product moves its history with it. That is a real limitation and the report says so
// in its own basis line rather than leaving a reader to discover it.

/** The period's sales summed per product, filtered once — the base of four reports. */
const PRODUCT_AGGREGATE = `
  SELECT
    i.product_id                           AS product_id,
    SUM(i.qty_milli)                       AS qty_milli,
    SUM(i.line_total_centavos)             AS line_total_centavos,
    SUM(i.discount_centavos)               AS discount_centavos,
    SUM(i.tax_centavos)                    AS tax_centavos,
    SUM(${LINE_NET_REVENUE})               AS revenue_centavos,
    SUM(${LINE_COST})                      AS cost_centavos,
    COUNT(*)                               AS line_count,
    COUNT(DISTINCT i.sale_id)              AS sale_count,
    MAX(s.occurred_at)                     AS last_sold_at
  FROM sale_items i
  JOIN sales s ON s.id = i.sale_id
  WHERE ${NOT_VOIDED}
    AND s.occurred_at >= @fromAt AND s.occurred_at <= @toAt
    AND (@shiftId IS NULL OR s.shift_id = @shiftId)
  GROUP BY i.product_id
`;

/** Requirement 1 — revenue, cost and margin by category (FT-605 applied per grouping). */
function salesByCategory({ fromAt, toAt, shiftId = null }) {
  return db.get().prepare(`
    SELECT
      c.id AS category_id, c.name AS category_name,
      COUNT(*)                       AS product_count,
      SUM(a.line_count)              AS line_count,
      SUM(a.line_total_centavos)     AS line_total_centavos,
      SUM(a.discount_centavos)       AS discount_centavos,
      SUM(a.tax_centavos)            AS tax_centavos,
      SUM(a.revenue_centavos)        AS revenue_centavos,
      SUM(a.cost_centavos)           AS cost_centavos
    FROM (${PRODUCT_AGGREGATE}) a
    JOIN products p   ON p.id = a.product_id
    JOIN categories c ON c.id = p.category_id
    GROUP BY c.id, c.name
    ORDER BY revenue_centavos DESC
  `).all({ fromAt, toAt, shiftId });
}

/**
 * Requirement 2 — by cashier, at two grains in one query.
 *
 * The transaction count and the money taken belong to the **sale**; revenue and cost
 * belong to its **lines**. Joining the lines directly would multiply each sale total by
 * its line count, which is the classic way this report comes out four times too large.
 * The lines are therefore summed per sale first, in a derived table carrying the same
 * range filter, and joined back one-to-one.
 */
function salesByCashier({ fromAt, toAt, shiftId = null }) {
  return db.get().prepare(`
    SELECT
      s.created_by                            AS user_id,
      u.username                              AS cashier,
      u.role                                  AS role,
      COUNT(*)                                AS sale_count,
      COUNT(DISTINCT s.shift_id)              AS shift_count,
      SUM(s.total_centavos)                   AS net_centavos,
      SUM(s.line_discount_centavos + s.txn_discount_centavos) AS discount_centavos,
      SUM(s.statutory_discount_centavos)      AS statutory_discount_centavos,
      SUM(s.vat_centavos)                     AS vat_centavos,
      COALESCE(SUM(a.revenue_centavos), 0)    AS revenue_centavos,
      COALESCE(SUM(a.cost_centavos), 0)       AS cost_centavos,
      COALESCE(SUM(a.line_count), 0)          AS line_count
    FROM sales s
    LEFT JOIN users u ON u.id = s.created_by
    LEFT JOIN (
      SELECT i.sale_id,
             SUM(${LINE_NET_REVENUE}) AS revenue_centavos,
             SUM(${LINE_COST})        AS cost_centavos,
             COUNT(*)                 AS line_count
      FROM sale_items i
      JOIN sales s2 ON s2.id = i.sale_id
      WHERE s2.status <> 'VOIDED'
        AND s2.occurred_at >= @fromAt AND s2.occurred_at <= @toAt
        AND (@shiftId IS NULL OR s2.shift_id = @shiftId)
      GROUP BY i.sale_id
    ) a ON a.sale_id = s.id
    WHERE ${NOT_VOIDED}
      AND s.occurred_at >= @fromAt AND s.occurred_at <= @toAt
      AND (@shiftId IS NULL OR s.shift_id = @shiftId)
    GROUP BY s.created_by, u.username, u.role
    ORDER BY net_centavos DESC
  `).all({ fromAt, toAt, shiftId });
}

/**
 * Requirement 3 and 4 — by product, with the sort and the limit in the reader's hands.
 *
 * `dailyLines` is this query with both fixed: 500 rows, ordered by revenue. That is the
 * right default for a day's report and the wrong one for "what moved", which is asked
 * by units as often as by money — a sack of feed and a sachet of dewormer rank in
 * opposite orders, and the store uses one figure to reorder and the other to decide
 * what to stock more of.
 *
 * The sort is a whitelist mapped to SQL here rather than a string from the caller: an
 * ORDER BY built out of a query parameter is an injection, whatever the parameter
 * happens to contain today.
 */
const PRODUCT_SORTS = Object.freeze({
  revenue: 'a.revenue_centavos DESC',
  quantity: 'a.qty_milli DESC',
  profit: '(a.revenue_centavos - a.cost_centavos) DESC',
  transactions: 'a.sale_count DESC',
  name: 'p.name COLLATE NOCASE ASC',
});

function salesByProduct({ fromAt, toAt, shiftId = null, sort = 'revenue', limit = 100 }) {
  const order = PRODUCT_SORTS[sort] || PRODUCT_SORTS.revenue;
  return db.get().prepare(`
    SELECT
      p.id AS product_id, p.sku, p.name AS product_name, p.is_active,
      c.name AS category_name, un.code AS unit_code,
      a.qty_milli, a.line_count, a.sale_count,
      a.discount_centavos, a.line_total_centavos,
      a.revenue_centavos, a.cost_centavos,
      COALESCE(inv.qty_on_hand_milli, 0) AS qty_on_hand_milli
    FROM (${PRODUCT_AGGREGATE}) a
    JOIN products p    ON p.id = a.product_id
    JOIN categories c  ON c.id = p.category_id
    JOIN units un      ON un.id = p.base_unit_id
    LEFT JOIN inventory inv ON inv.product_id = p.id
    ORDER BY ${order}, p.name COLLATE NOCASE
    LIMIT @limit
  `).all({ fromAt, toAt, shiftId, limit });
}

/**
 * Requirements 4, 5 and 6 in one pass — every product the movers report can rank.
 *
 * **Three rankings, one query, on purpose.** Fast by revenue, fast by units and slow are
 * three orderings of the same set: what each product did in the period, and what is
 * sitting on the shelf because of it. Written as three statements this cost three full
 * aggregates over every sale line in the range, which measured at 2.4 s over a quarter
 * of trading — most of a report's whole budget spent computing the same sums twice.
 *
 * **It reads from the catalogue outward, which is the opposite direction from every
 * other query in this file.** A product that sold nothing has no sale line, so grouping
 * sales can never produce it — and *products that sold nothing* is precisely what a
 * slow-mover report is for. So this starts at `products` and LEFT JOINs the period's
 * aggregate, and the rows with `NULL` on the right are the ones the report exists to
 * find.
 *
 * An inactive product is included **only if it sold** in the range: a discontinued line
 * is not a slow mover, it is a line the store already decided about, but the quarter it
 * was discontinued in still has its sales in it.
 *
 * `last_sold_at` comes from the ledger rather than from `sale_items`. INV-102 has
 * recorded every SALE movement since TASK-007 and `idx_move_product` makes "the most
 * recent one for this product" a seek, where the same question asked of the sales
 * history is a scan. It is also the figure that decides what a slow mover *is*: never
 * sold at all is a buying mistake, and sold well until March is something else.
 */
function moversOverview({ fromAt, toAt, shiftId = null }) {
  return db.get().prepare(`
    SELECT
      p.id AS product_id, p.sku, p.name AS product_name, p.created_at, p.is_active,
      p.avg_cost_centavos,
      c.name AS category_name, un.id AS unit_id, un.code AS unit_code,
      COALESCE(inv.qty_on_hand_milli, 0) AS qty_on_hand_milli,
      COALESCE(a.qty_milli, 0)           AS qty_milli,
      COALESCE(a.revenue_centavos, 0)    AS revenue_centavos,
      COALESCE(a.cost_centavos, 0)       AS cost_centavos,
      COALESCE(a.discount_centavos, 0)   AS discount_centavos,
      COALESCE(a.sale_count, 0)          AS sale_count,
      COALESCE(a.line_count, 0)          AS line_count,
      (SELECT MAX(m.occurred_at) FROM inventory_movements m
        WHERE m.product_id = p.id AND m.movement_type = 'SALE') AS last_sold_at
    FROM products p
    JOIN categories c ON c.id = p.category_id
    JOIN units un     ON un.id = p.base_unit_id
    LEFT JOIN inventory inv ON inv.product_id = p.id
    LEFT JOIN (${PRODUCT_AGGREGATE}) a ON a.product_id = p.id
    WHERE p.is_active = 1 OR a.product_id IS NOT NULL
  `).all({ fromAt, toAt, shiftId });
}

// ── TASK-033 — INV-102's ledger, read as a report (TX-422) ──────────────────
//
// **A decrease carries no cost, and no amount of querying will produce one.** INV-106
// costs a movement on the way *in* and never on the way out: a sale, a write-off or a
// negative adjustment consumes at the prevailing average, and `costing.applyMovement`
// uses that average without storing it on the row. So the ledger can say exactly how
// many kilos were damaged and cannot say what they were worth.
//
// Two columns rather than one, therefore. `costed_value_centavos` is summed from the
// cost the movement itself carries and is a fact; `estimated_value_centavos` prices the
// rest at the product's average cost **now** and is an estimate, named as one on the
// row and in the report's basis. Merging them into a single "value" would be the more
// comfortable report and the one that quietly changes every historical write-off the
// next time a delivery moves an average.

const MOVEMENT_VALUE = `
  CASE WHEN m.unit_cost_centavos IS NOT NULL
    THEN ((m.unit_cost_centavos * ABS(m.qty_milli)) + 500) / 1000
    ELSE 0 END`;

const MOVEMENT_ESTIMATE = `
  CASE WHEN m.unit_cost_centavos IS NULL
    THEN ((p.avg_cost_centavos * ABS(m.qty_milli)) + 500) / 1000
    ELSE 0 END`;

/** Requirement 7 — quantity and value by INV-103 type, for the whole store. */
function movementsByType({ fromAt, toAt }) {
  return db.get().prepare(`
    SELECT
      m.movement_type,
      COUNT(*)                                   AS movement_count,
      COUNT(DISTINCT m.product_id)               AS product_count,
      SUM(CASE WHEN m.qty_milli > 0 THEN m.qty_milli ELSE 0 END)  AS increase_milli,
      SUM(CASE WHEN m.qty_milli < 0 THEN -m.qty_milli ELSE 0 END) AS decrease_milli,
      SUM(m.qty_milli)                           AS net_milli,
      SUM(${MOVEMENT_VALUE})                     AS costed_value_centavos,
      SUM(${MOVEMENT_ESTIMATE})                  AS estimated_value_centavos,
      SUM(CASE WHEN m.unit_cost_centavos IS NULL THEN 1 ELSE 0 END) AS uncosted_count
    FROM inventory_movements m
    JOIN products p ON p.id = m.product_id
    WHERE m.occurred_at >= @fromAt AND m.occurred_at <= @toAt
    GROUP BY m.movement_type
    ORDER BY movement_count DESC
  `).all({ fromAt, toAt });
}

/**
 * The same, per product and per type — the grain at which a quantity means anything.
 *
 * UOM-001 is why there is no store-wide quantity total on the type rows above: 40 KG of
 * feed and 40 sachets of dewormer add up to 80 of nothing. A product's own base unit is
 * the only scope in which a quantity can be summed, so it is the scope this returns.
 */
function movementsByProduct({ fromAt, toAt, type = null, limit = 500 }) {
  return db.get().prepare(`
    SELECT
      m.product_id, m.movement_type,
      p.sku, p.name AS product_name, un.code AS unit_code, c.name AS category_name,
      COUNT(*)                                   AS movement_count,
      SUM(CASE WHEN m.qty_milli > 0 THEN m.qty_milli ELSE 0 END)  AS increase_milli,
      SUM(CASE WHEN m.qty_milli < 0 THEN -m.qty_milli ELSE 0 END) AS decrease_milli,
      SUM(m.qty_milli)                           AS net_milli,
      SUM(${MOVEMENT_VALUE})                     AS costed_value_centavos,
      SUM(${MOVEMENT_ESTIMATE})                  AS estimated_value_centavos
    FROM inventory_movements m
    JOIN products p   ON p.id = m.product_id
    JOIN categories c ON c.id = p.category_id
    JOIN units un     ON un.id = p.base_unit_id
    WHERE m.occurred_at >= @fromAt AND m.occurred_at <= @toAt
      AND (@type IS NULL OR m.movement_type = @type)
    GROUP BY m.product_id, m.movement_type
    ORDER BY ABS(SUM(m.qty_milli)) DESC, p.name COLLATE NOCASE
    LIMIT @limit
  `).all({ fromAt, toAt, type, limit });
}

/**
 * Requirement 8's anchor: the ledger's own balance at an instant.
 *
 * INV-101 makes on-hand a materialised SUM of this table, so the balance at any moment
 * is the sum of everything posted up to it. Opening plus the range's net must equal
 * closing, and closing at *now* must equal the on-hand figure the rest of the system
 * reads — which is what turns this report from a list of numbers into a check.
 */
function ledgerBalanceAt({ at, productId = null }) {
  return db.get().prepare(`
    SELECT COALESCE(SUM(m.qty_milli), 0) AS qty_milli
    FROM inventory_movements m
    WHERE m.occurred_at <= @at
      AND (@productId IS NULL OR m.product_id = @productId)
  `).get({ at, productId }).qty_milli;
}

/** The materialised figure the ledger has to agree with (INV-101). */
function onHandTotal() {
  return db.get().prepare(
    'SELECT COALESCE(SUM(qty_on_hand_milli), 0) AS qty_milli FROM inventory'
  ).get().qty_milli;
}

/** Per-product opening and closing, for the products a range actually touched. */
function ledgerBalancesByProduct({ fromAt, toAt }) {
  return db.get().prepare(`
    SELECT
      touched.product_id,
      COALESCE((SELECT SUM(b.qty_milli) FROM inventory_movements b
                 WHERE b.product_id = touched.product_id AND b.occurred_at < @fromAt), 0) AS opening_milli,
      COALESCE((SELECT SUM(c.qty_milli) FROM inventory_movements c
                 WHERE c.product_id = touched.product_id AND c.occurred_at <= @toAt), 0)  AS closing_milli,
      touched.net_milli
    FROM (
      SELECT m.product_id, SUM(m.qty_milli) AS net_milli
      FROM inventory_movements m
      WHERE m.occurred_at >= @fromAt AND m.occurred_at <= @toAt
      GROUP BY m.product_id
    ) touched
  `).all({ fromAt, toAt });
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
  tendersByMethod, tenderStatuses, tendersOfMethod, changeTotal,
  shiftsForUserInRange, shiftOwner,
  // TASK-033
  PRODUCT_SORTS, salesByCategory, salesByCashier, salesByProduct, moversOverview,
  movementsByType, movementsByProduct, ledgerBalanceAt, ledgerBalancesByProduct, onHandTotal,
};
