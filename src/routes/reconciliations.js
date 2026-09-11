'use strict';

// 05_TECH_SPEC.md §4, added by TASK-032:
//
//   GET  /reconciliations        TX-421   what has been reconciled, and to when
//   POST /reconciliations        TX-421   RPT-105 — record a comparison
//
// **There is no PUT and no DELETE, and that absence is the rule.** A reconciliation
// records what somebody was shown and what they concluded; correcting one means
// reconciling the range again, which is a second row with a second reason. Editing the
// first would leave a figure on the trail that nobody ever judged — the same reasoning
// INV-102 applies to movements and AUD-605 to audit rows.
//
// **Nothing behind these routes writes to a sale or a tender.** That is `RPT-105`'s
// prohibition, and the way to keep it true is for the path that could break it not to
// exist: there is no route here that names a sale.

const express = require('express');
const reconciliationService = require('../services/reconciliationService');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const readSales = [authenticate, requirePermission('TX-421')];

const dateParam = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : null);

router.get('/reconciliations', readSales, (req, res, next) => {
  try {
    res.json(reconciliationService.history({
      method: req.query.method || null,
      limit: Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200),
      actor: req.session,
    }));
  } catch (err) {
    next(err);
  }
});

router.post('/reconciliations', readSales, (req, res, next) => {
  try {
    const body = req.body || {};
    res.status(201).json(reconciliationService.record({
      from: dateParam(body.from),
      to: dateParam(body.to),
      method: body.method,
      actualCentavos: body.actualCentavos,
      reference: body.reference || null,
      reason: body.reason || null,
    }, req.session));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
