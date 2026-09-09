'use strict';

// 05_TECH_SPEC.md §4, the rows this task adds:
//
//   GET  /sales/:id/returnable   TX-406   what is left to give back, and POS-304's defaults
//   POST /sales/:id/returns      TX-406   POS-301 – POS-307
//   GET  /sales/:id/returns      TX-406   the returns against one sale
//   GET  /returns                TX-406   SCR-305's list
//   GET  /returns/:id            TX-406   one return and its lines
//
// `TX-406` is §10's "process a return", and it grants a cashier — which is the point.
// A return happens at the counter with the customer standing there, and a rule that
// needed a manager for every one of them would be a rule the store worked around by
// leaving the manager signed in. POS-304 and POS-307 are where a second person is
// actually required, and those are refusals from the service carrying the rule and the
// role, not a gate on the route.
//
// There is no PUT and no DELETE. A posted return is immutable for POS-206's reason
// applied to a second document: the correction is an inventory adjustment and, where
// money moved, a credit adjustment — both of which leave the mistake and its remedy
// standing side by side (INV-102).

const express = require('express');
const returnService = require('../services/returnService');
const errors = require('../services/errors');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const atTheCounter = [authenticate, requirePermission('TX-406')];

/**
 * SCR-305's opening question: what can still come back off this sale?
 *
 * Separate from `GET /sales/:id` because the answers are rules, not sale data —
 * POS-301's remaining quantity, POS-304's default per line and the sentence explaining
 * it, POS-307's window — and every one of them is computed server-side so the screen
 * cannot disagree with the refusal it would then get.
 */
router.get('/sales/:id/returnable', atTheCounter, (req, res, next) => {
  try {
    res.json(returnService.returnableFor(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.get('/sales/:id/returns', atTheCounter, (req, res, next) => {
  try {
    res.json(returnService.search({
      saleId: req.params.id, limit: req.query.limit, offset: req.query.offset,
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * The return. One transaction in returnService; this route parses, authorises,
 * delegates and serialises, and holds no rule of its own (05_TECH_SPEC.md §8.2).
 */
router.post('/sales/:id/returns', atTheCounter, (req, res, next) => {
  try {
    const body = req.body || {};
    res.status(201).json(returnService.post({
      saleId: req.params.id,
      lines: body.lines,
      reason: body.reason,
      notes: body.notes || null,
      // POS-304 and POS-307's authoriser, as a username. Resolved against the users
      // table server-side, because a body carrying `{ role: 'OWNER' }` is a claim
      // (SEC-6).
      approver: body.approver || null,
      approvalReason: body.approvalReason || null,
    }, req.session));
  } catch (err) {
    next(err);
  }
});

router.get('/returns', atTheCounter, (req, res, next) => {
  try {
    res.json(returnService.search({
      saleId: req.query.saleId,
      customerId: req.query.customerId,
      shiftId: req.query.shiftId,
      from: req.query.from,
      to: req.query.to,
      q: req.query.q,
      limit: req.query.limit,
      offset: req.query.offset,
    }));
  } catch (err) {
    next(err);
  }
});

router.get('/returns/:id', atTheCounter, (req, res, next) => {
  try {
    res.json(returnService.get(req.params.id));
  } catch (err) {
    next(err);
  }
});

for (const method of ['put', 'patch', 'delete']) {
  router[method]('/returns/:id', atTheCounter, (req, res, next) => {
    next(errors.conflict(
      'A posted return is never edited or deleted. Correct it with an inventory adjustment '
      + 'and, where money moved, a credit adjustment.',
      { ruleId: 'INV-102' }
    ));
  });
}

module.exports = router;
