'use strict';

// 05_TECH_SPEC.md §4:
//
//   POST /sales             TX-401   **the transaction** — FR_3.5
//   GET  /sales/:id         TX-401   the receipt view
//
// POST /sales/price-check lives in routes/pricing.js with the engine it calls.
//
// There is no PUT and no DELETE. POS-107 makes a completed sale immutable, and the
// absence of the route is how that is enforced at the edge — the corrections are a
// void (TASK-021) and a return (TASK-020), both of which write new rows.

const express = require('express');
const saleService = require('../services/saleService');
const sequenceService = require('../services/sequenceService');
const errors = require('../services/errors');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const atTheCounter = [authenticate, requirePermission('TX-401')];

/**
 * The one contract that matters.
 *
 * Everything in FR_3.5 happens inside one transaction in saleService; this route
 * parses, authorises, delegates and serialises, and holds no rule of its own
 * (05_TECH_SPEC.md §8.2).
 */
router.post('/sales', atTheCounter, (req, res, next) => {
  try {
    const body = req.body || {};
    const result = saleService.complete({
      lines: body.lines,
      customerId: body.customerId || null,
      tenders: body.tenders,
      transactionDiscountCentavos: body.transactionDiscountCentavos || 0,
      // Compared against the server's figure and discarded. §4.1's closing note: a
      // stale price list in a renderer is caught rather than banked.
      clientTotalCentavos: body.clientTotalCentavos ?? null,
      approver: body.approver || null,
      acceptDuplicateReference: body.acceptDuplicateReference === true,
      reason: body.reason || null,
    }, req.session);

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/** POS-108's run for today, so "are there gaps in today's sale numbers" is answerable. */
router.get('/sales/sequence-audit', [authenticate, requirePermission('TX-421')], (req, res, next) => {
  try {
    res.json(sequenceService.auditDay('SALE'));
  } catch (err) {
    next(err);
  }
});

router.get('/sales/:id', atTheCounter, (req, res, next) => {
  try {
    res.json(saleService.get(req.params.id));
  } catch (err) {
    next(err);
  }
});

for (const method of ['put', 'patch', 'delete']) {
  router[method]('/sales/:id', atTheCounter, (req, res, next) => {
    next(errors.conflict(
      'A completed sale is never edited or deleted. Correct it with a void or a return.',
      { ruleId: 'POS-107' }
    ));
  });
}

module.exports = router;
