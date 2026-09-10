'use strict';

// 05_TECH_SPEC.md §4:
//
//   GET /reports/dashboard             TX-421   SCR-601 — FR_6.1
//   GET /reports/daily?from=&to=       TX-421   SCR-602 — FR_6.2, RPT-101
//   GET /reports/payments?from=&to=    TX-421   SCR-603 — RPT-102
//   GET /reports/voids?from=&to=       TX-421   POS-404 — the one report that looks for them
//   GET /reports/inventory/valuation   TX-422   SCR-604 — RPT-103
//   GET /reports/:report/export.csv    TX-426   the same figures, as a file
//
// Read-only. Nothing in this file writes anything but the AUD-601 row an export
// leaves, and that is written by the service, not here.
//
// TX-421 is where the middleware stops being enough. It grants a CASHIER `OWN_SHIFT`,
// so `requirePermission` lets them through and reportService decides which shift they
// may actually see (SEC-6). The scope check is server-side and audited; hiding the
// control in the renderer is a courtesy on top of it, never instead of it.

const express = require('express');
const reportService = require('../services/reportService');
const creditService = require('../services/creditService');
const permissions = require('../services/permissions');
const alertService = require('../services/alertService');
const errors = require('../services/errors');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const readSales = [authenticate, requirePermission('TX-421')];
const readInventory = [authenticate, requirePermission('TX-422')];
const exportData = [authenticate, requirePermission('TX-426')];

const dateParam = (value) => (value ? String(value) : null);
const shiftParam = (value) => (value ? String(value) : null);

router.get('/reports/dashboard', readSales, (req, res, next) => {
  try {
    res.json(reportService.dashboard({ date: dateParam(req.query.date) }, req.session));
  } catch (err) {
    next(err);
  }
});

/** OPS-007's list on its own, so the shell can refresh alerts without a full dashboard. */
router.get('/reports/alerts', readSales, (req, res, next) => {
  try {
    res.json(alertService.list());
  } catch (err) {
    next(err);
  }
});

router.get('/reports/daily', readSales, (req, res, next) => {
  try {
    res.json(reportService.daily({
      from: dateParam(req.query.from) || dateParam(req.query.date),
      to: dateParam(req.query.to),
      shiftId: shiftParam(req.query.shiftId),
    }, req.session));
  } catch (err) {
    next(err);
  }
});

router.get('/reports/payments', readSales, (req, res, next) => {
  try {
    res.json(reportService.payments({
      from: dateParam(req.query.from) || dateParam(req.query.date),
      to: dateParam(req.query.to),
      shiftId: shiftParam(req.query.shiftId),
    }, req.session));
  } catch (err) {
    next(err);
  }
});

/**
 * POS-404's second half.
 *
 * Every other report here filters voids out of a total; this one lists them, because
 * "excluded from net sales" and "invisible" are different things and the rule says so
 * in the same sentence.
 */
router.get('/reports/voids', readSales, (req, res, next) => {
  try {
    res.json(reportService.voids({
      from: dateParam(req.query.from) || dateParam(req.query.date),
      to: dateParam(req.query.to),
      shiftId: shiftParam(req.query.shiftId),
    }, req.session));
  } catch (err) {
    next(err);
  }
});

/**
 * `FT-406` — the receivable, in `CR-301`'s four buckets.
 *
 * Before `/reports/:report`, or the path parameter swallows it — the same ordering the
 * valuation route needs, for the same reason.
 */
router.get('/reports/ageing', readSales, (req, res, next) => {
  try {
    res.json(creditService.ageingReport({
      includeZero: req.query.includeZero === 'true',
      // The scope check the middleware cannot make: TX-421 grants a cashier OWN_SHIFT,
      // and the receivable has no shift to scope it to.
      actor: req.session,
    }));
  } catch (err) {
    next(err);
  }
});

/** The receivable as a file. TX-426 to export, TX-421 to read what is in it. */
router.get('/reports/ageing/export.csv', exportData, (req, res, next) => {
  try {
    if (!permissions.can(req.session, 'TX-421')) {
      throw errors.forbidden(
        `You do not have permission to ${permissions.describe('TX-421').toLowerCase()}.`,
        { ruleId: 'TX-421' }
      );
    }
    const { csv, filename } = creditService.ageingCsv({
      includeZero: req.query.includeZero === 'true',
      actor: req.session,
    });
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

// Before /reports/:report/export.csv, or the path parameter swallows it.
router.get('/reports/inventory/valuation', readInventory, (req, res, next) => {
  try {
    res.json(reportService.valuation(req.session));
  } catch (err) {
    next(err);
  }
});

/**
 * TX-426 — the same figures as a file.
 *
 * The valuation export needs TX-422 as well as TX-426, because the export permission
 * says a role may take data out, not which data it may see. Checked here rather than
 * folded into one middleware, so that the reason a role is refused stays legible.
 */
router.get('/reports/:report/export.csv', exportData, (req, res, next) => {
  try {
    const report = String(req.params.report);
    const needed = report === 'valuation' ? 'TX-422' : 'TX-421';

    if (!permissions.can(req.session, needed)) {
      throw errors.forbidden(
        `You do not have permission to ${permissions.describe(needed).toLowerCase()}.`,
        { ruleId: needed }
      );
    }

    const { csv, filename } = reportService.exportCsv(report, {
      from: dateParam(req.query.from) || dateParam(req.query.date),
      to: dateParam(req.query.to),
      shiftId: shiftParam(req.query.shiftId),
    }, req.session);

    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
