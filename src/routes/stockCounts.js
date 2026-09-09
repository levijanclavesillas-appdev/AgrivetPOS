'use strict';

// 05_TECH_SPEC.md §4, the rows this task adds:
//
//   GET  /stock-counts                  TX-407   SCR-205's list
//   POST /stock-counts                  TX-407   INV-110 — opens and freezes
//   GET  /stock-counts/:id              TX-407   the session and its lines
//   PUT  /stock-counts/:id/lines        TX-407   counted quantities, saveable in progress
//   POST /stock-counts/:id/approve      TX-408   INV-112
//   POST /stock-counts/:id/post         TX-407   INV-111, INV-113
//   POST /stock-counts/:id/cancel       TX-407   abandoned rather than posted
//   GET  /stock-counts/:id/variance     TX-422   requirement 8's report
//
// **Counting is `TX-407` and approving is `TX-408`, and the split is the control.**
// §10 grants `TX-407` — "post an inventory adjustment" — to the owner, the manager and
// the inventory clerk, which is exactly the set who walk the aisles with a clipboard.
// `TX-408` — "approve a stock count" — is the owner and the manager alone. A clerk may
// therefore count and may not release what they counted, which is `INV-112` expressed
// in the permission matrix rather than only in a service.
//
// Posting stays on `TX-407` rather than `TX-408`: by then a second person has already
// approved it, and requiring the approver to also be the one who presses post would
// mean a manager walking back to the terminal for a clerk's stocktake.
//
// There is no DELETE. A posted count is immutable (INV-102) and an abandoned one is
// cancelled with a reason, because "this count was given up on" is itself a fact worth
// keeping — a store that abandons three counts in a row has a problem the trail should
// show.

const express = require('express');
const stockCountService = require('../services/stockCountService');
const errors = require('../services/errors');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const counting = [authenticate, requirePermission('TX-407')];
const approving = [authenticate, requirePermission('TX-408')];
const reading = [authenticate, requirePermission('TX-422')];

router.get('/stock-counts', counting, (req, res, next) => {
  try {
    res.json(stockCountService.search({
      status: req.query.status,
      openOnly: req.query.openOnly,
      categoryId: req.query.categoryId,
      from: req.query.from,
      to: req.query.to,
      limit: req.query.limit,
      offset: req.query.offset,
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * INV-110 — opening freezes the expected quantity of everything in scope.
 *
 * The freeze is the whole operation. Everything this session ever says about a
 * variance is relative to the instant this call commits, which is why the session, its
 * number and every one of its lines are written in one transaction.
 */
router.post('/stock-counts', counting, (req, res, next) => {
  try {
    const body = req.body || {};
    res.status(201).json(stockCountService.open({
      scope: body.scope,
      categoryId: body.categoryId || null,
      notes: body.notes || null,
    }, req.session));
  } catch (err) {
    next(err);
  }
});

router.get('/stock-counts/:id', counting, (req, res, next) => {
  try {
    res.json(stockCountService.get(req.params.id, {
      varyingOnly: req.query.varyingOnly === 'true',
      uncountedOnly: req.query.uncountedOnly === 'true',
      limit: req.query.limit,
      offset: req.query.offset,
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * The counted quantities, in batches and repeatedly.
 *
 * `PUT` rather than `POST` because it is idempotent per product: sending the same
 * line twice leaves the same figure, which is what a screen doing a background save
 * every few seconds needs. A `countedMilli` of `null` clears the line back to
 * uncounted — see the note in the service about why blank and zero are different.
 */
router.put('/stock-counts/:id/lines', counting, (req, res, next) => {
  try {
    res.json(stockCountService.record(req.params.id, { lines: (req.body || {}).lines }, req.session));
  } catch (err) {
    next(err);
  }
});

/**
 * INV-112 — the second pair of eyes.
 *
 * Behind `TX-408`, so the clerk who counted cannot reach it at all; the service then
 * refuses on *identity*, because a manager who counted the shelves themselves is still
 * the counter. Where the store has no second active user the rule is waived and the
 * response says so rather than the control silently succeeding.
 */
router.post('/stock-counts/:id/approve', approving, (req, res, next) => {
  try {
    res.json(stockCountService.approve(req.params.id, {
      approver: (req.body || {}).approver || null,
    }, req.session));
  } catch (err) {
    next(err);
  }
});

/**
 * INV-111 and INV-113 — the movements, and who may post an old count.
 *
 * One transaction in the service. This route parses, authorises, delegates and
 * serialises, and holds no rule of its own (05_TECH_SPEC.md §8.2).
 */
router.post('/stock-counts/:id/post', counting, (req, res, next) => {
  try {
    const body = req.body || {};
    res.status(201).json(stockCountService.post(req.params.id, {
      // INV-113's owner, as a username, resolved against the users table server-side
      // (SEC-6). Ignored where the session is inside the window.
      approver: body.approver || null,
      reason: body.reason || null,
    }, req.session));
  } catch (err) {
    next(err);
  }
});

router.post('/stock-counts/:id/cancel', counting, (req, res, next) => {
  try {
    res.json(stockCountService.cancel(req.params.id, { reason: (req.body || {}).reason }, req.session));
  } catch (err) {
    next(err);
  }
});

/**
 * Requirement 8's report — by product, at average cost, with a total.
 *
 * `TX-422` rather than `TX-407`: this is an inventory report, and a cashier who may
 * read the valuation may read what a count found. Writing one still needs `TX-407`.
 */
router.get('/stock-counts/:id/variance', reading, (req, res, next) => {
  try {
    res.json(stockCountService.varianceReport(req.params.id));
  } catch (err) {
    next(err);
  }
});

for (const method of ['delete', 'patch']) {
  router[method]('/stock-counts/:id', counting, (req, res, next) => {
    next(errors.conflict(
      'A stock count is never deleted. A count in progress is cancelled with a reason; a '
      + 'posted one is immutable, and its correction is an adjustment citing it.',
      { ruleId: 'INV-102' }
    ));
  });
}

module.exports = router;
