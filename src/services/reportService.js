'use strict';

// FR_6.1, FR_6.2 — the dashboard and the three v1.0 reports.
//
// Every figure here is a **read** over rows TASK-011, TASK-012 and TASK-013 already
// wrote. This file adds no business rule. What it adds is the obligation that the
// reads agree with each other, and that obligation is the whole task: RPT-101 says a
// daily report that does not reconcile is a defect, not a rounding artefact.
//
// ## The dashboard computes nothing
//
// Requirement 2 of TASK-016 is the one worth stating twice. Every tile figure comes
// from the **same function** as the report the tile links to — `dashboard()` calls
// `daily()`, `payments()`, `creditService.outstanding()` and `inventoryService
// .lowStock()` and reads their answers. There is no second arithmetic anywhere in this
// file for a number that also appears on a report. A tile that disagrees with the
// report behind it is worse than no tile, because it is the one people quote.
//
// ## Scope is enforced here, not hidden in the renderer
//
// TX-421 grants a CASHIER OWN_SHIFT. Hiding a control is a courtesy; the refusal is
// the control (SEC-6), so `assertShiftScope()` runs on every read and writes an audit
// row when it refuses. Until this task, OWN_SHIFT existed in the matrix and nothing
// consumed it.
//
// ## Voids
//
// RPT-106 excludes voided sales from net **everywhere**. The exclusion lives in the
// repository so it cannot be forgotten by a statement; what lives here is the header
// that says so out loud, and the count of what was excluded. A report that silently
// drops a void leaves an owner no way to know one happened. Voids are v1.1 (POS-401),
// so nothing writes that status yet — the reports handle it now because a report
// written to notice it later is a report that will be wrong in the meantime.

const clock = require('../config/clock');
const csv = require('../config/csv');
const money = require('./money');
const quantity = require('./quantity');
const errors = require('./errors');
const settingsService = require('./settingsService');
const permissions = require('./permissions');
const auditService = require('./auditService');
const storeProfileService = require('./storeProfileService');
const inventoryService = require('./inventoryService');
const creditService = require('./creditService');
const alertService = require('./alertService');
const reportRepository = require('../repositories/reportRepository');
const returnRepository = require('../repositories/returnRepository');

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// ── Range and scope ─────────────────────────────────────────────────────────

function assertDate(date, what) {
  if (!DATE_ONLY.test(String(date || ''))) {
    throw errors.badRequest(`${what} is a date in the form YYYY-MM-DD`, { ruleId: 'VR-102' });
  }
  return date;
}

/**
 * A date range in UTC, from Manila calendar dates (VR-102).
 *
 * The store thinks in Manila days; the database stores UTC. Getting this backwards
 * puts the last eight hours of every day into the next one, which is the kind of error
 * that only shows up when someone reconciles a month.
 */
function range({ from, to }) {
  const fromDate = assertDate(from, 'The start of the range');
  const toDate = assertDate(to || from, 'The end of the range');

  if (toDate < fromDate) {
    throw errors.badRequest('The end of the range is before its start.', { ruleId: 'RPT-106' });
  }
  const days = Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86400000) + 1;
  const maxDays = settingsService.get('report_max_range_days');
  if (days > maxDays) {
    throw errors.badRequest(`A report covers at most ${maxDays} days at a time.`, { ruleId: 'RPT-106' });
  }

  return {
    from_date: fromDate,
    to_date: toDate,
    days,
    fromAt: auditService.dayStartUtc(fromDate),
    toAt: auditService.dayEndUtc(toDate),
  };
}

/**
 * TX-421's OWN_SHIFT, enforced and audited.
 *
 * A CASHIER may read their own shift and no other. Asking for a shift that is not
 * theirs, or for the whole store, is refused with 403 — and the refusal is written to
 * the trail, because an attempt to read another till's takings is exactly the thing an
 * owner would want to see afterwards.
 */
function assertShiftScope(actor, shiftId, { what = 'this report' } = {}) {
  const level = permissions.grant(actor.role, 'TX-421');
  if (level !== permissions.OWN_SHIFT) return shiftId || null;

  const own = reportRepository.shiftsForUserInRange({
    userId: actor.id,
    fromAt: '0000-01-01T00:00:00.000Z',
    toAt: '9999-12-31T23:59:59.999Z',
  });

  const refuse = (reason) => {
    auditService.write({
      actor: { id: actor.id, username: actor.username },
      action: 'PERMISSION_REFUSED',
      entityType: 'report',
      entityId: shiftId || 'store',
      after: { requested_shift_id: shiftId || null, scope: permissions.OWN_SHIFT, role: actor.role },
      reason,
      shiftId: actor.shiftId || null,
    });
    throw errors.forbidden(
      `You can only see ${what} for your own shift. Ask the owner or a manager for the store's figures.`,
      { ruleId: 'TX-421', requiresRole: 'MANAGER' }
    );
  };

  if (!shiftId) {
    // Not silently narrowed to their own shift: a cashier who asks for the store's
    // figures and is handed their own, unlabelled, has been told something false.
    refuse('A cashier asked for a store-wide report (TX-421 is OWN_SHIFT)');
  }
  if (!own.includes(shiftId)) refuse('A cashier asked for another user’s shift');

  return shiftId;
}

/** RPT-106's header, on every report without exception. */
function header({ scope, shiftId, actor, extra = {} }) {
  const modes = reportRepository.taxModesInRange({ ...scope, shiftId });
  const voided = reportRepository.voidedCount({ ...scope, shiftId });

  return {
    from_date: scope.from_date,
    to_date: scope.to_date,
    days: scope.days,
    generated_at: clock.nowUtc(),
    generated_at_manila: clock.toManila(clock.nowUtc()),
    generated_by: actor ? actor.username : null,
    shift_id: shiftId || null,
    store_scope: shiftId ? 'ONE SHIFT' : 'WHOLE STORE',
    // The mode in force now, and every mode the range actually contains. They differ
    // the day after a store registers for VAT, and a header that printed only today's
    // mode would misdescribe every sale before the change.
    tax_mode: storeProfileService.taxMode(),
    tax_modes_in_range: modes,
    // RPT-106: stated, not assumed. "Voided sales are excluded" is printed whether or
    // not the range contains one, so its absence never has to be inferred.
    includes_voided: false,
    voided_excluded_count: voided.n,
    voided_excluded_centavos: voided.excluded_centavos,
    ...extra,
  };
}

// ── SCR-602 — daily sales (RPT-101, RPT-104) ────────────────────────────────

/**
 * The day, with its reconciliation shown rather than asserted.
 *
 * `gross − discounts − returns = net` and `net = SUM(tenders) − change` both appear on
 * the report as figures the reader can add up, and both are checked here. A mismatch
 * is returned as `reconciles: false` with the difference, not thrown: a report that
 * refuses to render is a report nobody can use to find out what went wrong.
 */
function daily({ from, to = null, shiftId = null, lineLimit = 500 } = {}, actor = null) {
  const scope = range({ from, to });
  const shift = actor ? assertShiftScope(actor, shiftId, { what: 'the sales report' }) : shiftId;
  const q = { ...scope, shiftId: shift };

  const totals = reportRepository.dailyTotals(q);
  const tendered = reportRepository.tenderTotal(q);
  const profit = reportRepository.profitTotals(q);

  // TAX-004 / requirement 7: statutory and voluntary are separate claims — the store
  // deducts one and simply gave away the other — so they are added for the identity
  // and reported apart. A single "discounts" figure answers neither question.
  const voluntaryDiscounts = totals.line_discount_centavos + totals.txn_discount_centavos;
  const discounts = voluntaryDiscounts + totals.statutory_discount_centavos;
  // RPT-101's fourth term, no longer zero (TASK-020). It was rendered at zero from
  // TASK-016 precisely so the identity had somewhere to put a figure the day returns
  // existed, and this is that day.
  //
  // `returns_centavos` and the refunds are the same money seen from two sides — the
  // value of the goods that came back, and what was given back for them — and the
  // schema's CHECK makes them equal per row. That is what lets both halves of the
  // identity below use it: the sales half subtracts what was returned, and the tender
  // half subtracts what was refunded.
  const returned = returnRepository.returnTotals({ from: scope.fromAt, to: scope.toAt, shiftId: shift });
  const returns = returned.returns_centavos;
  const reconciledNet = totals.gross_centavos - discounts - returns;
  // Net of returns on both sides, or the two halves would be reconciling different
  // days: `net_centavos` is what the sales were, and a returned sack is no longer one.
  const netAfterReturns = totals.net_centavos - returns;
  const tenderNet = tendered - totals.change_centavos - returns;

  const grossProfit = profit.revenue_centavos - profit.cost_centavos;

  return {
    header: header({ scope, shiftId: shift, actor, extra: { report: 'DAILY_SALES', rule_id: 'RPT-101' } }),
    totals: {
      sale_count: totals.sale_count,
      gross_centavos: totals.gross_centavos,
      line_discount_centavos: totals.line_discount_centavos,
      txn_discount_centavos: totals.txn_discount_centavos,
      statutory_discount_centavos: totals.statutory_discount_centavos,
      voluntary_discount_centavos: voluntaryDiscounts,
      discount_centavos: discounts,
      returns_centavos: returns,
      return_count: returned.return_count,
      // Both figures, because the pair is the check. `net_centavos` is the day net of
      // returns; `gross_sales_net_centavos` is what was sold before any of it came
      // back, which is the figure a cashier's own arithmetic will produce.
      gross_sales_net_centavos: totals.net_centavos,
      net_centavos: netAfterReturns,
      vat_centavos: totals.vat_centavos,
      tendered_centavos: tendered,
      change_centavos: totals.change_centavos,
      refund_credit_centavos: returned.refund_credit_centavos,
      refund_cash_centavos: returned.refund_cash_centavos,
      refund_store_credit_centavos: returned.refund_store_credit_centavos,
    },
    // RPT-104, shipped in v1.0: the cost is the sale-line snapshot (MON-005), so
    // repricing or re-costing a product today cannot restate last week's margin.
    profit: {
      revenue_centavos: profit.revenue_centavos,
      cost_centavos: profit.cost_centavos,
      gross_profit_centavos: grossProfit,
      margin_bp: profit.revenue_centavos > 0
        ? Math.round((grossProfit * 10000) / profit.revenue_centavos)
        : 0,
      basis: 'Revenue net of VAT, less the cost snapshotted on each sale line (MON-005, RPT-104).',
    },
    reconciliation: {
      rule_id: 'RPT-101',
      // Printed as a sentence so the report carries its own arithmetic, per FR_6.2.
      statement: `${money.toDisplay(totals.gross_centavos)} gross`
        + ` − ${money.toDisplay(voluntaryDiscounts)} discounts`
        // Named in the sentence only where there is one, so a store that does not grant
        // the entitlement reads the identity it always read (TAX-004 ships off).
        + (totals.statutory_discount_centavos > 0
          ? ` − ${money.toDisplay(totals.statutory_discount_centavos)} statutory`
          : '')
        + ` − ${money.toDisplay(returns)} returns`
        + ` = ${money.toDisplay(reconciledNet)} net`,
      gross_less_discounts_centavos: reconciledNet,
      net_centavos: netAfterReturns,
      balances: reconciledNet === netAfterReturns,
      difference_centavos: reconciledNet - netAfterReturns,
      tender_statement: `${money.toDisplay(tendered)} tendered`
        + ` − ${money.toDisplay(totals.change_centavos)} change`
        + ` − ${money.toDisplay(returns)} refunded`
        + ` = ${money.toDisplay(tenderNet)}`,
      tenders_less_change_centavos: tenderNet,
      tenders_balance: tenderNet === netAfterReturns,
      tender_difference_centavos: tenderNet - netAfterReturns,
      reconciles: reconciledNet === netAfterReturns && tenderNet === netAfterReturns,
    },
    lines: reportRepository.dailyLines({ ...q, limit: lineLimit }).map((row) => ({
      product_id: row.product_id,
      product_name: row.product_name,
      qty_milli: row.qty_milli,
      qty_display: quantity.toDecimalString(row.qty_milli),
      line_count: row.line_count,
      discount_centavos: row.discount_centavos,
      line_total_centavos: row.line_total_centavos,
      revenue_centavos: row.revenue_centavos,
      cost_centavos: row.cost_centavos,
      gross_profit_centavos: row.revenue_centavos - row.cost_centavos,
    })),
    sales: reportRepository.salesInRange({ ...q, limit: 1000 }).map((row) => ({
      id: row.id,
      sale_no: row.sale_no,
      status: row.status,
      // A void is shown and marked, and its figures are out of every total above.
      excluded_from_net: row.status === 'VOIDED',
      occurred_at: row.occurred_at,
      occurred_at_manila: clock.toManila(row.occurred_at),
      cashier_username: row.cashier_username,
      customer_name: row.customer_name,
      tax_mode: row.tax_mode,
      total_centavos: row.total_centavos,
      change_centavos: row.change_centavos,
    })),
  };
}

// ── POS-404 — the void report ───────────────────────────────────────────────

/**
 * The voids of a range, which is the one report that looks *for* them.
 *
 * Every other report in this file filters voids out of a total. POS-404 draws the
 * distinction in its own sentence — a voided sale is "excluded from net sales **and**
 * included in a void report" — and this is the second half. Without it, "excluded"
 * quietly becomes "invisible", and a void nobody can list is a void nobody can audit.
 *
 * There is no reconciliation block, because there is nothing to reconcile: these
 * figures are in no total anywhere. What the report carries instead is the pair a
 * reader is actually checking — who rang it and who authorised undoing it (AUD-603) —
 * and the cash that went back out of the drawer.
 */
function voids({ from, to = null, shiftId = null, limit = 500 } = {}, actor = null) {
  const scope = range({ from, to });
  const shift = actor ? assertShiftScope(actor, shiftId, { what: 'the void report' }) : shiftId;

  const rows = voidService().listFor({ ...scope, fromAt: scope.fromAt, toAt: scope.toAt, shiftId: shift, limit });

  return {
    header: header({ scope, shiftId: shift, actor, extra: { report: 'VOIDS', rule_id: 'POS-404' } }),
    totals: {
      void_count: rows.length,
      voided_centavos: rows.reduce((sum, row) => sum + row.total_centavos, 0),
      cash_returned_centavos: rows.reduce((sum, row) => sum + row.cash_returned_centavos, 0),
      // POS-403 has no ordinary case, so this is not "how many needed a manager" but
      // "how many were done by somebody who was not already one" — which is the figure
      // an owner reading this report is looking for.
      authorised_by_another_count: rows.filter((row) => row.approved_by || row.voided_by !== row.cashier_username).length,
    },
    // POS-404, said rather than left to be inferred from a report that happens to
    // exist: the numbers below are still in the sequence, and none of them is missing.
    sequence_note: 'A voided sale keeps its receipt number (POS-108). These numbers are '
      + 'not reissued and the sequence has no gap where they sit.',
    voids: rows,
  };
}

// Required lazily: voidService reads reportRepository for this very query, and a
// top-level require in both directions is a cycle that resolves to an empty object in
// whichever file node happens to load second.
const voidService = () => require('./voidService');

// ── SCR-603 — payments (RPT-102) ────────────────────────────────────────────

/** POS-206: what the column says, printed as the column says it. */
const NON_CASH = Object.freeze(['GCASH', 'QRPH', 'CREDIT', 'STORE_CREDIT', 'OTHER']);

function payments({ from, to = null, shiftId = null } = {}, actor = null) {
  const scope = range({ from, to });
  const shift = actor ? assertShiftScope(actor, shiftId, { what: 'the payments report' }) : shiftId;
  const q = { ...scope, shiftId: shift };

  const rows = reportRepository.tendersByMethod(q);
  const statuses = new Map(reportRepository.tenderStatuses(q).map((r) => [r.method, r.status]));
  const change = reportRepository.changeTotal(q);

  const tendered = rows.reduce((sum, row) => sum + row.amount_centavos, 0);
  // RPT-101's identity, restated per method. A payments report that showed only the
  // tendered figure would say the store took ₱100 in cash on a ₱62.50 sale — true of
  // the notes that crossed the counter, and wrong about every question anyone asks a
  // payments report. Both figures are shown: what was handed over, and what stayed.
  const net = tendered - change;

  return {
    header: header({ scope, shiftId: shift, actor, extra: { report: 'PAYMENTS', rule_id: 'RPT-102' } }),
    tendered_centavos: tendered,
    change_centavos: change,
    // The figure that reconciles to the daily report's net (RPT-101).
    total_centavos: net,
    methods: rows.map((row) => {
      // Change is only ever given in cash (MON-007), so it lands on that row alone.
      const rowChange = row.method === 'CASH' ? change : 0;
      const rowNet = row.amount_centavos - rowChange;

      return {
        method: row.method,
        tender_count: row.tender_count,
        sale_count: row.sale_count,
        amount_centavos: row.amount_centavos,
        change_centavos: rowChange,
        net_centavos: rowNet,
        share_bp: net > 0 ? Math.round((rowNet * 10000) / net) : 0,
        // POS-206: RECORDED means "the cashier saw it". No payment API confirms these,
        // so no report may imply one did.
        status: NON_CASH.includes(row.method) ? (statuses.get(row.method) || 'RECORDED') : null,
        recorded_label: NON_CASH.includes(row.method) ? 'RECORDED' : null,
      };
    }),
  };
}

// ── SCR-604 — inventory valuation (RPT-103) ─────────────────────────────────

/**
 * RPT-103, delegated whole to inventoryService.
 *
 * It already computes `SUM(qty_on_hand_milli × avg_cost_centavos)` at read time and
 * stamps its as-of. Re-implementing it here to add a header would be a second
 * arithmetic for a figure that already exists, which is the defect TC-INT-60 is about.
 */
function valuation(actor = null) {
  const at = clock.nowUtc();
  const inner = inventoryService.valuation();
  const today = clock.manilaDate(at);
  const scope = range({ from: today, to: today });

  return {
    header: {
      ...header({ scope, shiftId: null, actor, extra: { report: 'INVENTORY_VALUATION', rule_id: 'RPT-103' } }),
      // Valuation is a position, not a period. The range is today only because the
      // header contract asks for one; the figure is as of this instant.
      as_of: inner.as_of,
      as_of_manila: clock.toManila(inner.as_of),
      basis: 'Weighted average cost in the base unit, computed at read time (RPT-103, MON-004).',
    },
    total_value_centavos: inner.total_value_centavos,
    product_count: inner.products.length,
    products: inner.products,
  };
}

// ── SCR-607 — sales analysis (TASK-033, FT-602, FT-605) ─────────────────────
//
// Four groupings of one arithmetic. `daily()` above already sums revenue, cost and
// margin from the sale-line snapshot (RPT-104, MON-005); these group the same sums by
// category, by cashier, by product and by what moved, because "we took ₱48,000 today"
// is the figure the owner has and "which shelf and which till" is the one they buy and
// staff by.
//
// ## What these reconcile to, stated exactly rather than approximately
//
// TASK-033's first acceptance criterion asks that category and cashier totals "sum to
// the daily report's net". Only one of the two can, and the difference is worth being
// precise about rather than papering over:
//
//   * **A cashier's figures are sale-level.** A sale has one cashier, so summing
//     `total_centavos` by cashier gives the day's sales exactly. It reconciles to the
//     daily report's `gross_sales_net_centavos` — net before returns, because a return
//     is its own document with its own operator and is not the selling cashier's.
//   * **A category's figures are line-level.** A sale has as many categories as it has
//     lines, and the transaction discount, the change and the returns sit on the sale
//     rather than on any line. There is no honest way to split a ₱50 transaction
//     discount between feed and veterinary supplies, so this report does not invent
//     one: it reconciles to `profit.revenue_centavos` — revenue net of VAT, which is
//     the figure margin is computed from and the only one that is a sum of lines.
//
// Both checks are exact equalities computed here and printed on the report, in the
// shape RPT-101 and FR_6.2 ask for: the reader can add the column up.
//
// ## The grouping key is live, and the report says so
//
// MON-005 keeps money off the live product record, and every figure here obeys it. A
// **category** is not money and nothing snapshots it — no column on `sale_items` could
// answer "what was this product filed under last March". So the category on these rows
// is the product's category now, and recategorising a product moves its history with
// it. Stated in `basis` on the report rather than left for somebody to discover the
// month they reorganise the shelves.

const MOVER_BASIS = 'Revenue is net of VAT and cost is the sale-line snapshot (RPT-104, '
  + 'MON-005). Quantities are in each product’s own base unit (UOM-001).';

/** Margin in basis points, guarded against the empty range. */
const marginBp = (revenue, cost) => (revenue > 0
  ? Math.round(((revenue - cost) * 10000) / revenue)
  : 0);

const withProfit = (row) => ({
  revenue_centavos: row.revenue_centavos,
  cost_centavos: row.cost_centavos,
  gross_profit_centavos: row.revenue_centavos - row.cost_centavos,
  margin_bp: marginBp(row.revenue_centavos, row.cost_centavos),
});

/**
 * Requirement 1 — the shelves, ranked.
 *
 * Share is of revenue rather than of gross, so that the percentages beside a margin
 * are percentages of the same figure the margin was computed from.
 */
function byCategory({ from, to = null, shiftId = null } = {}, actor = null) {
  const scope = range({ from, to });
  const shift = actor ? assertShiftScope(actor, shiftId, { what: 'the category breakdown' }) : shiftId;
  const q = { ...scope, shiftId: shift };

  const rows = reportRepository.salesByCategory(q);
  const total = reportRepository.profitTotals(q);
  const grouped = rows.reduce((sum, row) => sum + row.revenue_centavos, 0);

  return {
    header: header({ scope, shiftId: shift, actor, extra: { report: 'SALES_BY_CATEGORY', rule_id: 'RPT-104' } }),
    totals: {
      category_count: rows.length,
      ...withProfit({ revenue_centavos: total.revenue_centavos, cost_centavos: total.cost_centavos }),
    },
    categories: rows.map((row) => ({
      category_id: row.category_id,
      category_name: row.category_name,
      product_count: row.product_count,
      line_count: row.line_count,
      discount_centavos: row.discount_centavos,
      ...withProfit(row),
      share_bp: total.revenue_centavos > 0
        ? Math.round((row.revenue_centavos * 10000) / total.revenue_centavos)
        : 0,
    })),
    // The check, printed. A grouping that loses a line loses it silently otherwise:
    // an INNER JOIN to a category is exactly the shape that drops a row.
    reconciliation: {
      rule_id: 'RPT-101',
      statement: `${money.toDisplay(grouped)} across ${rows.length} categor${rows.length === 1 ? 'y' : 'ies'}`
        + ` = ${money.toDisplay(total.revenue_centavos)} revenue on the daily report`,
      grouped_centavos: grouped,
      report_centavos: total.revenue_centavos,
      difference_centavos: grouped - total.revenue_centavos,
      balances: grouped === total.revenue_centavos,
    },
    basis: 'Revenue net of VAT, less the cost snapshotted on each sale line (RPT-104, MON-005). '
      + 'A category is read from the product as it is filed **today** — nothing snapshots it, '
      + 'so recategorising a product moves its history with it. Transaction discounts, change '
      + 'and returns belong to the sale rather than to any line, which is why this reconciles '
      + 'to revenue and not to net sales.',
  };
}

/**
 * Requirement 2 — the tills.
 *
 * `TX-421`'s OWN_SHIFT is the reason this report is interesting and the reason it is
 * guarded: a cashier asking for the store's breakdown is asking to read every other
 * till's takings, and `assertShiftScope` refuses it and writes the attempt down.
 */
function byCashier({ from, to = null, shiftId = null } = {}, actor = null) {
  const scope = range({ from, to });
  const shift = actor ? assertShiftScope(actor, shiftId, { what: 'the cashier breakdown' }) : shiftId;
  const q = { ...scope, shiftId: shift };

  const rows = reportRepository.salesByCashier(q);
  const totals = reportRepository.dailyTotals(q);
  const grouped = rows.reduce((sum, row) => sum + row.net_centavos, 0);
  const saleCount = rows.reduce((sum, row) => sum + row.sale_count, 0);

  return {
    header: header({ scope, shiftId: shift, actor, extra: { report: 'SALES_BY_CASHIER', rule_id: 'RPT-104' } }),
    totals: {
      cashier_count: rows.length,
      sale_count: saleCount,
      net_centavos: totals.net_centavos,
      average_sale_centavos: saleCount > 0 ? Math.round(totals.net_centavos / saleCount) : 0,
    },
    cashiers: rows.map((row) => ({
      user_id: row.user_id,
      cashier: row.cashier || 'unknown',
      role: row.role,
      sale_count: row.sale_count,
      shift_count: row.shift_count,
      line_count: row.line_count,
      net_centavos: row.net_centavos,
      discount_centavos: row.discount_centavos,
      statutory_discount_centavos: row.statutory_discount_centavos,
      vat_centavos: row.vat_centavos,
      // Requirement 2's second measure. Rounded to the centavo for display; the
      // division is of two integers the reader can check against the two columns
      // beside it.
      average_sale_centavos: row.sale_count > 0 ? Math.round(row.net_centavos / row.sale_count) : 0,
      ...withProfit(row),
      share_bp: totals.net_centavos > 0
        ? Math.round((row.net_centavos * 10000) / totals.net_centavos)
        : 0,
    })),
    reconciliation: {
      rule_id: 'RPT-101',
      statement: `${money.toDisplay(grouped)} across ${rows.length} cashier${rows.length === 1 ? '' : 's'}`
        + ` = ${money.toDisplay(totals.net_centavos)} of sales on the daily report, before returns`,
      grouped_centavos: grouped,
      report_centavos: totals.net_centavos,
      difference_centavos: grouped - totals.net_centavos,
      balances: grouped === totals.net_centavos,
    },
    basis: 'Sales are attributed to the user who rang them up. The figure is net sales '
      + 'before returns (RPT-101): a return is its own document with its own operator, and '
      + 'charging it back to the cashier who made the sale would report a refund as their '
      + 'mistake. Revenue and cost are the sale-line snapshots (RPT-104, MON-005).',
  };
}

/** Requirement 3 — `dailyLines` with the sort and the limit in the reader's hands. */
function byProduct({ from, to = null, shiftId = null, sort = 'revenue', limit = 100 } = {}, actor = null) {
  const scope = range({ from, to });
  const shift = actor ? assertShiftScope(actor, shiftId, { what: 'the product breakdown' }) : shiftId;
  const q = { ...scope, shiftId: shift };

  const chosen = Object.prototype.hasOwnProperty.call(reportRepository.PRODUCT_SORTS, sort)
    ? sort
    : 'revenue';
  const capped = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 1000);
  const rows = reportRepository.salesByProduct({ ...q, sort: chosen, limit: capped });
  const total = reportRepository.profitTotals(q);

  return {
    header: header({ scope, shiftId: shift, actor, extra: { report: 'SALES_BY_PRODUCT', rule_id: 'RPT-104' } }),
    sort: chosen,
    sorts: Object.keys(reportRepository.PRODUCT_SORTS),
    limit: capped,
    totals: {
      shown: rows.length,
      // What the limit hides, said out loud. A list of 100 rows that is silently the
      // top 100 of 5,000 is a list somebody will add up and disbelieve.
      ...withProfit(total),
      shown_revenue_centavos: rows.reduce((sum, row) => sum + row.revenue_centavos, 0),
    },
    products: rows.map(presentProductRow),
    basis: MOVER_BASIS,
  };
}

const presentProductRow = (row) => ({
  product_id: row.product_id,
  sku: row.sku,
  product_name: row.product_name,
  category_name: row.category_name,
  unit_code: row.unit_code,
  qty_milli: row.qty_milli,
  qty_display: quantity.format(row.qty_milli, row.unit_code),
  sale_count: row.sale_count,
  line_count: row.line_count,
  discount_centavos: row.discount_centavos,
  qty_on_hand_milli: row.qty_on_hand_milli,
  qty_on_hand_display: quantity.format(row.qty_on_hand_milli, row.unit_code),
  ...withProfit(row),
});

/**
 * Requirements 4, 5 and 6 — what is moving, what is not, and what to do about it.
 *
 * **Two rankings, shown as two rankings.** A sack of feed at ₱1,400 and a sachet at ₱35
 * sort in opposite orders by money and by units; the store reorders on the second and
 * decides what to stock more of on the first. Merging them into one "top sellers" list
 * answers neither question, so there is no merged list here.
 *
 * **The units ranking is partitioned by base unit** (UOM-001). Comparing 40 KG with 40
 * sachets is not a ranking, and the alternative — making the reader pick a unit before
 * they can see anything — hides the report behind a control nobody presses.
 *
 * **Slow movers are built from the catalogue outward**, which is the opposite direction
 * from every other query here, because a product that sold nothing has no sale line to
 * group. What makes a row actionable is what is sitting on the shelf and when it last
 * sold: 200 units of something last sold in March is a different problem from two.
 *
 * All three come from **one** query. They are three orderings of the same set — what
 * each product did in the period — and asking the database for it three times cost three
 * full aggregates over every sale line in the range, which measured at most of a
 * report's whole budget over a quarter. The ordering is done here; the arithmetic is
 * still entirely the repository's.
 */
function movers({
  from, to = null, shiftId = null, top = 10, maxRevenueCentavos = 0, slowLimit = 200,
} = {}, actor = null) {
  const scope = range({ from, to });
  const shift = actor ? assertShiftScope(actor, shiftId, { what: 'the movers report' }) : shiftId;

  const cappedTop = Math.min(Math.max(Number.parseInt(top, 10) || 10, 1), 100);
  const threshold = Math.max(Number.parseInt(maxRevenueCentavos, 10) || 0, 0);
  const cappedSlow = Math.min(Math.max(Number.parseInt(slowLimit, 10) || 200, 1), 1000);

  const all = reportRepository.moversOverview({ ...scope, shiftId: shift });
  const sold = all.filter((row) => row.line_count > 0);

  const byRevenue = [...sold]
    .sort((a, b) => b.revenue_centavos - a.revenue_centavos || a.product_name.localeCompare(b.product_name))
    .slice(0, cappedTop);

  // One ranking per base unit, in the order the store sells most money of — so the unit
  // that matters is first and the long tail of units is still there underneath.
  const units = new Map();
  for (const row of sold) {
    if (!units.has(row.unit_id)) {
      units.set(row.unit_id, { unit_code: row.unit_code, revenue_centavos: 0, rows: [] });
    }
    const group = units.get(row.unit_id);
    group.revenue_centavos += row.revenue_centavos;
    group.rows.push(row);
  }

  const byUnits = [...units.values()]
    .sort((a, b) => b.revenue_centavos - a.revenue_centavos || a.unit_code.localeCompare(b.unit_code))
    .map((group) => ({
      unit_code: group.unit_code,
      revenue_centavos: group.revenue_centavos,
      products: group.rows
        .sort((a, b) => b.qty_milli - a.qty_milli || a.product_name.localeCompare(b.product_name))
        .slice(0, cappedTop)
        .map((row, index) => ({ rank: index + 1, ...presentProductRow(row) })),
    }));

  // An inactive product is not a slow mover — it is a line the store already decided
  // about. It stays in the rankings above, because the quarter it was discontinued in
  // still has its sales in it.
  const slow = all
    .filter((row) => row.is_active === 1 && row.revenue_centavos <= threshold)
    .sort((a, b) => a.revenue_centavos - b.revenue_centavos
      || b.qty_on_hand_milli - a.qty_on_hand_milli
      || a.product_name.localeCompare(b.product_name))
    .slice(0, cappedSlow);

  return {
    header: header({ scope, shiftId: shift, actor, extra: { report: 'MOVERS', rule_id: 'RPT-104' } }),
    top: cappedTop,
    by_revenue: byRevenue.map((row, index) => ({ rank: index + 1, ...presentProductRow(row) })),
    by_units: byUnits,
    units_note: 'Ranked within each base unit, not across them: 40 KG of feed and 40 sachets '
      + 'of dewormer are not 40 of the same thing (UOM-001).',
    slow: slow.map((row) => presentSlowRow(row, scope)),
    slow_threshold_centavos: threshold,
    slow_note: threshold === 0
      ? 'Products that sold nothing at all in this range.'
      : `Products that sold ${money.toDisplay(threshold)} or less in this range, including nothing at all.`,
    basis: MOVER_BASIS,
  };
}

/**
 * A slow mover, with the two figures that decide what to do about it.
 *
 * Requirement 5's flag: a product created inside the range has not had the range to sell
 * in, so it is marked rather than counted against. Judging a line stocked last Tuesday
 * by a quarter's sales is how a report teaches a store to ignore it.
 */
function presentSlowRow(row, scope) {
  const newInRange = row.created_at >= scope.fromAt && row.created_at <= scope.toAt;
  return {
    product_id: row.product_id,
    sku: row.sku,
    product_name: row.product_name,
    category_name: row.category_name,
    unit_code: row.unit_code,
    qty_milli: row.qty_milli,
    qty_display: quantity.format(row.qty_milli, row.unit_code),
    sale_count: row.sale_count,
    revenue_centavos: row.revenue_centavos,
    cost_centavos: row.cost_centavos,
    qty_on_hand_milli: row.qty_on_hand_milli,
    qty_on_hand_display: quantity.format(row.qty_on_hand_milli, row.unit_code),
    // What the shelf is worth at today's average (RPT-103's basis, not a sale-line
    // snapshot — there is no sale to snapshot).
    on_hand_value_centavos: row.qty_on_hand_milli >= 0
      ? money.mulQty(row.avg_cost_centavos, row.qty_on_hand_milli)
      // INV-104 lets a shelf go negative where the store allows it, and a negative
      // quantity is worth a negative amount rather than a thrown error.
      : -money.mulQty(row.avg_cost_centavos, -row.qty_on_hand_milli),
    last_sold_at: row.last_sold_at,
    last_sold_at_manila: row.last_sold_at ? clock.toManila(row.last_sold_at) : null,
    never_sold: row.last_sold_at === null,
    new_in_range: newInRange,
    // The sentence a reader acts on, rather than three columns they have to combine.
    verdict: newInRange
      ? 'Added during this range — too new to judge'
      : (row.last_sold_at === null
        ? 'Never sold'
        : `Last sold ${clock.manilaDate(row.last_sold_at)}`),
  };
}

// ── SCR-608 — movement analysis (TASK-033, INV-102, INV-103, TX-422) ────────
//
// **This is an inventory report and not a sales one, and the split is the point.** Every
// increase and decrease has been append-only and typed since TASK-007 — RECEIPT, SALE,
// DAMAGE, EXPIRY, COUNT_VARIANCE, INTERNAL_USE and the rest — and nothing has ever
// summarised them, so a store cannot see that it wrote ₱18,000 of damage off this
// quarter. TX-422 rather than TX-421: the person who needs this is the inventory clerk,
// who has no business reading the day's takings.
//
// ## The honest limitation, on the report rather than in a comment
//
// INV-106 costs a movement on the way **in** and never on the way out. A sale, a damage
// write-off or a negative adjustment consumes at the prevailing average, and that
// average is used and not stored. So the ledger knows exactly how many kilos were
// damaged and does not know what they were worth.
//
// The report therefore carries two value columns and never one: what the movements
// themselves cost, which is a fact, and what the rest would be worth at today's average
// cost, which is an estimate that moves the next time a delivery changes an average. A
// single merged figure would be the more comfortable report and the one that silently
// restates last quarter's write-offs.
//
// ## The reconciliation
//
// INV-101 makes on-hand a materialised sum of this ledger, so opening plus the range's
// net must equal closing, and closing at *now* must equal what the rest of the system
// reads as stock. That is what makes this a report rather than a list.

const MOVEMENT_LABELS = Object.freeze({
  OPENING: 'Opening stock', RECEIPT: 'Goods received', SALE: 'Sold',
  SALE_VOID: 'Sale voided', CUSTOMER_RETURN: 'Customer return',
  SUPPLIER_RETURN: 'Returned to supplier', ADJUSTMENT: 'Adjustment',
  DAMAGE: 'Damaged', EXPIRY: 'Expired', INTERNAL_USE: 'Internal use',
  COUNT_VARIANCE: 'Stock count variance', BREAK_BULK: 'Break bulk',
});

function movements({ from, to = null, type = null, limit = 500 } = {}, actor = null) {
  const scope = range({ from, to });
  const wanted = type && Object.prototype.hasOwnProperty.call(MOVEMENT_LABELS, type) ? type : null;

  const types = reportRepository.movementsByType(scope);
  const rows = reportRepository.movementsByProduct({
    ...scope, type: wanted, limit: Math.min(Math.max(Number.parseInt(limit, 10) || 500, 1), 2000),
  });

  // INV-101, as arithmetic rather than as a claim.
  const opening = reportRepository.ledgerBalanceAt({ at: beforeInstant(scope.fromAt) });
  const closing = reportRepository.ledgerBalanceAt({ at: scope.toAt });
  const net = types.reduce((sum, row) => sum + row.net_milli, 0);
  const onHand = reportRepository.onHandTotal();
  const endsInThePast = scope.toAt < clock.nowUtc();
  const perProduct = reportRepository.ledgerBalancesByProduct(scope);
  const outOfBalance = perProduct.filter((row) => row.opening_milli + row.net_milli !== row.closing_milli);

  return {
    header: header({ scope, shiftId: null, actor, extra: { report: 'MOVEMENTS', rule_id: 'INV-102' } }),
    filter_type: wanted,
    types: types.map((row) => ({
      movement_type: row.movement_type,
      label: MOVEMENT_LABELS[row.movement_type] || row.movement_type,
      movement_count: row.movement_count,
      product_count: row.product_count,
      net_milli: row.net_milli,
      // INV-103's declared direction, so a reader can see at a glance that DAMAGE only
      // ever takes stock away and ADJUSTMENT goes both ways.
      direction: row.increase_milli > 0 && row.decrease_milli > 0 ? 'BOTH'
        : (row.increase_milli > 0 ? 'IN' : 'OUT'),
      costed_value_centavos: row.costed_value_centavos,
      estimated_value_centavos: row.estimated_value_centavos,
      value_centavos: row.costed_value_centavos + row.estimated_value_centavos,
      uncosted_count: row.uncosted_count,
      // Which of the two figures above the reader is looking at, per row rather than
      // once at the bottom: RECEIPT is entirely fact, DAMAGE is entirely estimate, and
      // ADJUSTMENT is a mix.
      value_basis: row.uncosted_count === 0 ? 'MOVEMENT_COST'
        : (row.uncosted_count === row.movement_count ? 'ESTIMATE_AT_CURRENT_AVERAGE' : 'MIXED'),
    })),
    products: rows.map((row) => ({
      product_id: row.product_id,
      movement_type: row.movement_type,
      label: MOVEMENT_LABELS[row.movement_type] || row.movement_type,
      sku: row.sku,
      product_name: row.product_name,
      category_name: row.category_name,
      unit_code: row.unit_code,
      increase_milli: row.increase_milli,
      decrease_milli: row.decrease_milli,
      net_milli: row.net_milli,
      net_display: quantity.format(row.net_milli, row.unit_code),
      costed_value_centavos: row.costed_value_centavos,
      estimated_value_centavos: row.estimated_value_centavos,
      value_centavos: row.costed_value_centavos + row.estimated_value_centavos,
    })),
    reconciliation: {
      rule_id: 'INV-101',
      statement: `${quantity.toDecimalString(opening)} on hand at the start`
        + ` ${net < 0 ? '−' : '+'} ${quantity.toDecimalString(Math.abs(net))} moved`
        + ` = ${quantity.toDecimalString(closing)} at the end`,
      opening_milli: opening,
      net_milli: net,
      closing_milli: closing,
      balances: opening + net === closing,
      difference_milli: (opening + net) - closing,
      // INV-101's other half: the ledger and the materialised figure the POS reads are
      // the same number, or one of them is wrong. Only checkable where the range runs
      // up to now — a range that ended last month says nothing about today's shelf.
      on_hand_total_milli: onHand,
      matches_on_hand: endsInThePast ? null : closing === onHand,
      products_checked: perProduct.length,
      products_out_of_balance: outOfBalance.length,
      // Quantities across products are in different base units and are shown summed
      // only because this identity is about the ledger's own arithmetic, not about a
      // quantity of anything (UOM-001). The figure that means something per product is
      // in the table above.
      units_note: 'These totals add quantities across base units. They are a check on the '
        + 'ledger’s arithmetic (INV-101) and not a quantity of anything — 40 KG and 40 '
        + 'sachets are not 80 of the same thing (UOM-001).',
    },
    value_basis: 'A movement carries a cost only where INV-106 sets one — opening stock, a '
      + 'receipt, an adjustment. Everything else consumes stock at the average prevailing at '
      + 'the time, which is used and not stored, so it is valued here at the product’s '
      + 'average cost **today**. That column is an estimate and moves when an average does.',
  };
}

/**
 * One millisecond before the range, for the opening balance.
 *
 * `< fromAt` would do for the per-product query, and does there. Here the balance is a
 * `<=` so that both ends of the identity are written the same way, and the instant
 * before the range is the one that makes them agree.
 */
const beforeInstant = (at) => new Date(Date.parse(at) - 1).toISOString();

// ── SCR-601 — the dashboard (FR_6.1) ────────────────────────────────────────

/**
 * Seven tiles, each one a figure lifted from the report behind it.
 *
 * The seventh is gross profit. `01_PRODUCT_BRIEF.md` §6 metric 5 makes "the owner can
 * state yesterday's gross profit" a week-1 success criterion for v1.0, while FR_6.1
 * listed six tiles and RPT-104 was marked v1.1 — the three disagreed. Resolved in
 * favour of the metric: the cost snapshot has been on every sale line since TASK-011,
 * so the figure costs a join, and a v1.0 that cannot answer "did we make money
 * yesterday" fails its own success criteria on the day it ships.
 */
function dashboard({ date = null } = {}, actor = null) {
  const at = clock.nowUtc();
  const day = date ? assertDate(date, 'The dashboard date') : clock.manilaDate(at);

  const shiftId = actor && permissions.grant(actor.role, 'TX-421') === permissions.OWN_SHIFT
    ? ownShiftFor(actor, day)
    : null;

  // The same calls the reports make. Not similar calls — the same ones.
  const sales = daily({ from: day, shiftId, lineLimit: 5 }, actor);
  const paid = payments({ from: day, shiftId }, actor);
  const credit = creditService.outstanding({ now: at });
  const low = inventoryService.lowStock({ limit: 1 });

  const overdue = credit.accounts.filter((a) => a.ageing_status === 'OVERDUE').length;

  return {
    date: day,
    as_of: at,
    as_of_manila: clock.toManila(at),
    scope: shiftId ? 'OWN_SHIFT' : 'WHOLE STORE',
    shift_id: shiftId,
    alerts: alertService.list({ now: at }),
    tiles: [
      tile('GROSS_SALES', "Today's gross sales", money.toDisplay(sales.totals.gross_centavos),
        sales.totals.gross_centavos, 'daily', 'RPT-101'),
      tile('TRANSACTIONS', 'Transactions', String(sales.totals.sale_count),
        sales.totals.sale_count, 'daily', 'RPT-101'),
      // Net of change, so the mix agrees with the gross-sales tile beside it rather
      // than overstating cash by every peso handed back.
      tile('PAYMENT_MIX', 'Payment mix', mixSummary(paid),
        paid.total_centavos, 'payments', 'RPT-102', { methods: paid.methods }),
      // CR-108, requirement 7: **what the farms owe**, not that figure netted against
      // the store credit the shop is holding for other people. The two are a debt and a
      // liability — one is money to collect, the other money already spent by somebody
      // who has not taken the goods yet — and a single netted figure answers neither.
      // The liability travels with the tile rather than beside it, so a dashboard that
      // shows one has the other.
      tile('CREDIT_OUTSTANDING', 'Credit outstanding', money.toDisplay(credit.total_receivable_centavos),
        credit.total_receivable_centavos, 'credit', 'CR-103',
        // Not `rule_id` — that names the tile's own rule, and `extra` spreads last.
        { store_credit_centavos: credit.total_store_credit_centavos, store_credit_rule_id: 'CR-108' }),
      tile('OVERDUE_ACCOUNTS', 'Overdue accounts', String(overdue), overdue, 'credit', 'CR-107'),
      tile('LOW_STOCK', 'Low stock', String(low.total), low.total, 'inventory', 'INV-109'),
      // The seventh — see the note above.
      tile('GROSS_PROFIT', 'Gross profit', money.toDisplay(sales.profit.gross_profit_centavos),
        sales.profit.gross_profit_centavos, 'daily', 'RPT-104',
        { margin_bp: sales.profit.margin_bp, basis: sales.profit.basis }),
    ],
  };
}

const tile = (key, label, display, value, report, ruleId, extra = {}) => ({
  key, label, display, value_centavos: value, report, rule_id: ruleId, ...extra,
});

/** A cashier's dashboard shows their own shift, and says so (TX-421 OWN_SHIFT). */
function ownShiftFor(actor, day) {
  const shifts = reportRepository.shiftsForUserInRange({
    userId: actor.id,
    fromAt: auditService.dayStartUtc(day),
    toAt: auditService.dayEndUtc(day),
  });
  if (shifts.length === 0) {
    throw errors.conflict(
      'You have no shift on this day, so there are no figures to show you.',
      { ruleId: 'POS-501' }
    );
  }
  return shifts[0];
}

const mixSummary = (paid) => (paid.methods.length === 0
  ? 'No payments yet'
  : paid.methods.map((m) => `${m.method} ${money.toDisplay(m.net_centavos)}`).join(' · '));

// ── Export (TX-426, AUD-601) ────────────────────────────────────────────────

/** RFC 4180: quote everything, double an embedded quote. Same rule as SCR-703's. */
// The CSV writer moved to `config/csv.js` with TASK-026, which needed a **reader** —
// and a reader written against a different understanding of the format from the writer
// is how a store ends up with an export it cannot re-import. Kept as local names so
// every call site below reads as it did.
const csvCell = csv.cell;

const csvRow = csv.row;

/**
 * A report as CSV, figure for figure with the screen.
 *
 * The header block is written as rows rather than dropped, because RPT-106's
 * disclosure travels with the file: a CSV mailed to a bookkeeper with no date range
 * and no statement about voids is a spreadsheet of numbers nobody can date.
 *
 * Money is written in **pesos with two decimals**, formatted from the same centavo
 * integer the screen displays. That is the figure a reader compares (TC-INT-63), and
 * TASK-016's criterion is that the export matches the screen — not the storage.
 */
const pesos = (centavos) => (centavos / 100).toFixed(2);

/** One product row, identical in three exports, so they cannot drift apart. */
const productCells = (row) => [
  row.sku, row.product_name, row.category_name, row.unit_code, row.qty_display,
  row.sale_count, pesos(row.revenue_centavos), pesos(row.cost_centavos),
  pesos(row.gross_profit_centavos), (row.margin_bp / 100).toFixed(2), row.qty_on_hand_display,
];

function headerRows(head) {
  return [
    csvRow(['Report', head.report]),
    csvRow(['Range', `${head.from_date} to ${head.to_date}`]),
    csvRow(['Scope', head.store_scope + (head.shift_id ? ` (${head.shift_id})` : '')]),
    csvRow(['Tax mode', head.tax_mode]),
    csvRow(['Tax modes in range', head.tax_modes_in_range.join(' ') || head.tax_mode]),
    csvRow(['Voided sales included', head.includes_voided ? 'YES' : 'NO']),
    csvRow(['Voided sales excluded', `${head.voided_excluded_count} (${pesos(head.voided_excluded_centavos)})`]),
    csvRow(['Generated', head.generated_at_manila]),
    csvRow(['Generated by', head.generated_by]),
    '',
  ];
}

function exportCsv(report, params, actor) {
  const built = build(report, params, actor);
  const lines = headerRows(built.header);

  if (report === 'daily') {
    lines.push(csvRow(['Figure', 'Amount']));
    for (const [label, value] of [
      ['Gross', built.totals.gross_centavos],
      ['Line discounts', built.totals.line_discount_centavos],
      ['Transaction discounts', built.totals.txn_discount_centavos],
      // TAX-004: its own row. An accountant reading this file is reading it to find
      // exactly this figure, and it is not derivable from a merged total.
      ['Statutory discounts', built.totals.statutory_discount_centavos],
      ['Returns', built.totals.returns_centavos],
      ['  refunded off a balance', built.totals.refund_credit_centavos],
      ['  refunded in cash', built.totals.refund_cash_centavos],
      ['  held as store credit', built.totals.refund_store_credit_centavos],
      ['Net', built.totals.net_centavos],
      ['VAT', built.totals.vat_centavos],
      ['Tendered', built.totals.tendered_centavos],
      ['Change', built.totals.change_centavos],
      ['Cost of goods sold', built.profit.cost_centavos],
      ['Gross profit', built.profit.gross_profit_centavos],
    ]) lines.push(csvRow([label, pesos(value)]));

    lines.push(csvRow(['Transactions', built.totals.sale_count]));
    lines.push(csvRow(['Reconciles', built.reconciliation.reconciles ? 'YES' : 'NO']));
    lines.push(csvRow(['Reconciliation', built.reconciliation.statement]));
    lines.push(csvRow(['Tender reconciliation', built.reconciliation.tender_statement]));
    lines.push('');
    lines.push(csvRow(['Product', 'Quantity', 'Lines', 'Discount', 'Revenue', 'Cost', 'Gross profit']));
    for (const row of built.lines) {
      lines.push(csvRow([
        row.product_name, row.qty_display, row.line_count,
        pesos(row.discount_centavos), pesos(row.revenue_centavos),
        pesos(row.cost_centavos), pesos(row.gross_profit_centavos),
      ]));
    }
  }

  if (report === 'payments') {
    lines.push(csvRow(['Method', 'Status', 'Tenders', 'Sales', 'Tendered', 'Change', 'Net', 'Share %']));
    for (const row of built.methods) {
      lines.push(csvRow([
        row.method, row.recorded_label || '', row.tender_count, row.sale_count,
        pesos(row.amount_centavos), pesos(row.change_centavos), pesos(row.net_centavos),
        (row.share_bp / 100).toFixed(2),
      ]));
    }
    lines.push(csvRow([
      'TOTAL', '', '', '', pesos(built.tendered_centavos), pesos(built.change_centavos),
      pesos(built.total_centavos), '100.00',
    ]));
  }

  if (report === 'voids') {
    lines.push(csvRow(['Voids', built.totals.void_count]));
    lines.push(csvRow(['Value voided', pesos(built.totals.voided_centavos)]));
    lines.push(csvRow(['Cash returned', pesos(built.totals.cash_returned_centavos)]));
    lines.push(csvRow(['Sequence', built.sequence_note]));
    lines.push('');
    lines.push(csvRow([
      'Receipt', 'Rung up', 'Voided', 'Cashier', 'Voided by', 'Authorised by',
      'Customer', 'Total', 'Cash returned', 'Reason',
    ]));
    for (const row of built.voids) {
      lines.push(csvRow([
        row.sale_no, row.occurred_at_manila, row.voided_at_manila,
        row.cashier_username, row.voided_by, row.approved_by || '',
        row.customer_name || '', pesos(row.total_centavos),
        pesos(row.cash_returned_centavos), row.reason || '',
      ]));
    }
  }

  if (report === 'valuation') {
    lines.push(csvRow(['As of', built.header.as_of_manila]));
    lines.push('');
    lines.push(csvRow(['SKU', 'Product', 'On hand', 'Average cost', 'Value']));
    for (const row of built.products) {
      lines.push(csvRow([
        row.sku, row.name, row.qty_on_hand_display,
        pesos(row.avg_cost_centavos), pesos(row.value_centavos),
      ]));
    }
    lines.push(csvRow(['TOTAL', '', '', '', pesos(built.total_value_centavos)]));
  }

  // TASK-033, requirement 9. Four groupings and a ledger, each written with the same
  // columns the screen shows and in the same order, because TASK-016's criterion is
  // that the file matches the screen rather than the storage.
  if (report === 'by-category') {
    lines.push(csvRow(['Reconciles', built.reconciliation.balances ? 'YES' : 'NO']));
    lines.push(csvRow(['Reconciliation', built.reconciliation.statement]));
    lines.push(csvRow(['Basis', built.basis]));
    lines.push('');
    lines.push(csvRow(['Category', 'Products', 'Lines', 'Discount', 'Revenue', 'Cost', 'Gross profit', 'Margin %', 'Share %']));
    for (const row of built.categories) {
      lines.push(csvRow([
        row.category_name, row.product_count, row.line_count, pesos(row.discount_centavos),
        pesos(row.revenue_centavos), pesos(row.cost_centavos), pesos(row.gross_profit_centavos),
        (row.margin_bp / 100).toFixed(2), (row.share_bp / 100).toFixed(2),
      ]));
    }
    lines.push(csvRow([
      'TOTAL', built.totals.category_count, '', '',
      pesos(built.totals.revenue_centavos), pesos(built.totals.cost_centavos),
      pesos(built.totals.gross_profit_centavos), (built.totals.margin_bp / 100).toFixed(2), '100.00',
    ]));
  }

  if (report === 'by-cashier') {
    lines.push(csvRow(['Reconciles', built.reconciliation.balances ? 'YES' : 'NO']));
    lines.push(csvRow(['Reconciliation', built.reconciliation.statement]));
    lines.push(csvRow(['Basis', built.basis]));
    lines.push('');
    lines.push(csvRow(['Cashier', 'Role', 'Shifts', 'Transactions', 'Net sales', 'Average sale', 'Discounts', 'Revenue', 'Cost', 'Gross profit', 'Margin %', 'Share %']));
    for (const row of built.cashiers) {
      lines.push(csvRow([
        row.cashier, row.role || '', row.shift_count, row.sale_count,
        pesos(row.net_centavos), pesos(row.average_sale_centavos), pesos(row.discount_centavos),
        pesos(row.revenue_centavos), pesos(row.cost_centavos), pesos(row.gross_profit_centavos),
        (row.margin_bp / 100).toFixed(2), (row.share_bp / 100).toFixed(2),
      ]));
    }
    lines.push(csvRow([
      'TOTAL', '', '', built.totals.sale_count, pesos(built.totals.net_centavos),
      pesos(built.totals.average_sale_centavos), '', '', '', '', '', '100.00',
    ]));
  }

  if (report === 'by-product') {
    lines.push(csvRow(['Sorted by', built.sort]));
    lines.push(csvRow(['Rows shown', `${built.totals.shown} (limit ${built.limit})`]));
    // What the limit hides, in the file as on the screen: a reader adding the revenue
    // column up needs to know it is not the whole range.
    lines.push(csvRow(['Revenue shown', pesos(built.totals.shown_revenue_centavos)]));
    lines.push(csvRow(['Revenue in range', pesos(built.totals.revenue_centavos)]));
    lines.push('');
    lines.push(csvRow(['SKU', 'Product', 'Category', 'Unit', 'Quantity', 'Transactions', 'Revenue', 'Cost', 'Gross profit', 'Margin %', 'On hand']));
    for (const row of built.products) lines.push(csvRow(productCells(row)));
  }

  if (report === 'movers') {
    lines.push(csvRow(['Ranking', `Top ${built.top}`]));
    lines.push(csvRow(['Units note', built.units_note]));
    lines.push('');
    lines.push(csvRow(['FAST — BY REVENUE']));
    lines.push(csvRow(['Rank', 'SKU', 'Product', 'Category', 'Unit', 'Quantity', 'Transactions', 'Revenue', 'Cost', 'Gross profit', 'Margin %', 'On hand']));
    for (const row of built.by_revenue) lines.push(csvRow([row.rank, ...productCells(row)]));

    for (const group of built.by_units) {
      lines.push('');
      lines.push(csvRow([`FAST — BY UNITS (${group.unit_code})`]));
      lines.push(csvRow(['Rank', 'SKU', 'Product', 'Category', 'Unit', 'Quantity', 'Transactions', 'Revenue', 'Cost', 'Gross profit', 'Margin %', 'On hand']));
      for (const row of group.products) lines.push(csvRow([row.rank, ...productCells(row)]));
    }

    lines.push('');
    lines.push(csvRow(['SLOW', built.slow_note]));
    lines.push(csvRow(['SKU', 'Product', 'Category', 'Unit', 'Sold in range', 'Revenue', 'On hand', 'Value on hand', 'Last sold', 'Verdict']));
    for (const row of built.slow) {
      lines.push(csvRow([
        row.sku, row.product_name, row.category_name, row.unit_code,
        row.qty_display, pesos(row.revenue_centavos), row.qty_on_hand_display,
        pesos(row.on_hand_value_centavos), row.last_sold_at_manila || '', row.verdict,
      ]));
    }
  }

  if (report === 'movements') {
    lines.push(csvRow(['Reconciles', built.reconciliation.balances ? 'YES' : 'NO']));
    lines.push(csvRow(['Reconciliation', built.reconciliation.statement]));
    lines.push(csvRow(['Value basis', built.value_basis]));
    lines.push('');
    lines.push(csvRow(['Type', 'Movements', 'Products', 'Direction', 'Costed value', 'Estimated value', 'Total value', 'Value basis']));
    for (const row of built.types) {
      lines.push(csvRow([
        row.label, row.movement_count, row.product_count, row.direction,
        pesos(row.costed_value_centavos), pesos(row.estimated_value_centavos),
        pesos(row.value_centavos), row.value_basis,
      ]));
    }
    lines.push('');
    lines.push(csvRow(['SKU', 'Product', 'Category', 'Type', 'Unit', 'In', 'Out', 'Net', 'Costed value', 'Estimated value']));
    for (const row of built.products) {
      lines.push(csvRow([
        row.sku, row.product_name, row.category_name, row.label, row.unit_code,
        quantity.toDecimalString(row.increase_milli), quantity.toDecimalString(row.decrease_milli),
        quantity.toDecimalString(row.net_milli),
        pesos(row.costed_value_centavos), pesos(row.estimated_value_centavos),
      ]));
    }
  }

  // AUD-601: an export is a copy of the store's figures leaving the machine.
  auditService.write({
    actor: { id: actor.id, username: actor.username },
    action: 'DATA_EXPORTED',
    entityType: 'report',
    entityId: report,
    after: {
      report,
      range: `${built.header.from_date}..${built.header.to_date}`,
      shift_id: built.header.shift_id,
    },
    reason: null,
    shiftId: actor.shiftId || null,
  });

  return {
    csv: `${lines.join('\r\n')}\r\n`,
    filename: `${report}-${built.header.from_date}${built.header.from_date === built.header.to_date ? '' : `_${built.header.to_date}`}.csv`,
    report,
  };
}

const REPORTS = Object.freeze({
  daily, payments, voids, valuation: (p, a) => valuation(a),
  // TASK-033. Named here so `/reports/:report/export.csv` serves them from the same
  // build — requirement 9 asks for CSV on all of them, and a second export path is a
  // second place for RPT-106's header block to go missing.
  'by-category': byCategory, 'by-cashier': byCashier, 'by-product': byProduct,
  movers, movements,
});

function build(report, params, actor) {
  const fn = REPORTS[report];
  if (!fn) throw errors.badRequest(`No such report: ${report}`, { ruleId: 'RPT-106' });
  return fn(params, actor);
}

module.exports = {
  NON_CASH,
  range, assertShiftScope, header,
  daily, payments, voids, valuation, dashboard, build, exportCsv,
  // TASK-033
  byCategory, byCashier, byProduct, movers, movements, MOVEMENT_LABELS,
  // Named for the tests that drive one piece at a time.
  csvCell, pesos,
};
