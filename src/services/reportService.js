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

  const discounts = totals.line_discount_centavos + totals.txn_discount_centavos;
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
        + ` − ${money.toDisplay(discounts)} discounts`
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
      tile('CREDIT_OUTSTANDING', 'Credit outstanding', money.toDisplay(credit.total_balance_centavos),
        credit.total_balance_centavos, 'credit', 'CR-103'),
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
function csvCell(value) {
  if (value === null || value === undefined) return '""';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

const csvRow = (cells) => cells.map(csvCell).join(',');

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

const REPORTS = Object.freeze({ daily, payments, valuation: (p, a) => valuation(a) });

function build(report, params, actor) {
  const fn = REPORTS[report];
  if (!fn) throw errors.badRequest(`No such report: ${report}`, { ruleId: 'RPT-106' });
  return fn(params, actor);
}

module.exports = {
  NON_CASH,
  range, assertShiftScope, header,
  daily, payments, valuation, dashboard, build, exportCsv,
  // Named for the tests that drive one piece at a time.
  csvCell, pesos,
};
