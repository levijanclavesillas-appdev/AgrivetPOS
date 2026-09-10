'use strict';

// 05_TECH_SPEC.md §4, added by TASK-029:
//
//   GET  /products/:id/batches   TX-422   INV-201 – INV-203, the shelf as batches
//   POST /batches/:id/expire     TX-407   INV-205, the only way expired stock leaves
//
// **There is no route that sells an expired batch, and none that edits a quantity.**
// Both absences are the enforcement, not an omission — the same reasoning as AUD-605's
// missing delete. INV-205 permits an override only where the store's own policy allows
// it and this store's does not, so no path exists to record such a sale; INV-201 makes
// a batch's quantity the ledger's own sum, so there is nothing here to set it to.
//
// A batch is created by a goods receipt and by the opening load, both of which already
// have their own routes. There is no POST /batches: a batch invented from a form is a
// batch with no delivery behind it, and its quantity would be zero for ever.

const express = require('express');
const batchService = require('../services/batchService');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const readInventory = [authenticate, requirePermission('TX-422')];
const writeOffStock = [authenticate, requirePermission('TX-407')];

/**
 * INV-201 – INV-203: every batch of one product, with its derived balance and status.
 *
 * `includeEmpty=true` is the recall's view rather than the shelf's — an exhausted batch
 * is still the batch a notice names, and INV-206 has to be able to find it. The default
 * is the shelf, because a shop looking for what it holds should not scroll past two
 * years of empties to find the three tins in front of it.
 */
router.get('/products/:id/batches', readInventory, (req, res, next) => {
  try {
    res.json({
      batches: batchService.listForProduct(req.params.id, {
        includeEmpty: req.query.includeEmpty === 'true',
        actor: req.session,
      }),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * INV-205's expected exit: the batch leaves by an EXPIRY movement (INV-103).
 *
 * A write-off and not a deletion — the ledger says why the stock went, so the store can
 * total what expiry cost it, and INV-201 still reconciles afterwards because the same
 * ledger is what both figures are read from.
 */
router.post('/batches/:id/expire', writeOffStock, (req, res, next) => {
  try {
    res.json(batchService.expire(req.params.id, {
      actor: req.session,
      reason: (req.body || {}).reason || null,
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * INV-206 — who has this batch.
 *
 * `TX-422`, the same grant that reads the batch list: a recall is an inventory question
 * whose answer happens to contain customer names, and gating it behind TX-413 would put
 * the one report a store runs in an emergency behind the permission least likely to be
 * held by whoever is in the shop when the notice arrives.
 */
router.get('/batches/:id/recall', readInventory, (req, res, next) => {
  try {
    res.json(batchService.recallFor(req.params.id, { actor: req.session }));
  } catch (err) {
    next(err);
  }
});

/** The same figures as the screen, as a file (TX-426 to export, TX-422 to read). */
router.get('/batches/:id/recall/export.csv',
  [authenticate, requirePermission('TX-426')], (req, res, next) => {
    try {
      const { csv, filename } = batchService.recallCsv(req.params.id, { actor: req.session });
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (err) {
      next(err);
    }
  });

module.exports = router;
