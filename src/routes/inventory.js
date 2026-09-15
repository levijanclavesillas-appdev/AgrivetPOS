'use strict';

// 05_TECH_SPEC.md §4:
//
//   GET  /inventory/:productId/movements   TX-422   the ledger view
//   POST /inventory/adjustments            TX-407   INV-108
//
// /inventory/low-stock and /inventory/valuation are not in §4's table — add the rows.
// FR_2.6 requires the low-stock list and SCR-604 shows it; RPT-103 requires valuation.
//
// There is no route that writes an on-hand figure. INV-101 makes on-hand a consequence
// of the ledger, and the absence of the endpoint is how that is enforced at the edge —
// the same reasoning as AUD-605's missing delete.

const express = require('express');
const inventoryService = require('../services/inventoryService');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const readInventory = [authenticate, requirePermission('TX-422')];
// TASK-056: one product's stock is what the counter shows as "stock after" — the cashier's
// by TX-401 too, so a PIN session can sell. The reports stay behind TX-422 alone.
const stockAtCounter = [authenticate, requirePermission(['TX-422', 'TX-401'])];
const postAdjustment = [authenticate, requirePermission('TX-407')];

// Before /:productId, or "low-stock" is read as a product id.
router.get('/inventory/low-stock', readInventory, (req, res, next) => {
  try {
    res.json(inventoryService.lowStock({ limit: req.query.limit, offset: req.query.offset }));
  } catch (err) {
    next(err);
  }
});

router.get('/inventory/valuation', readInventory, (req, res, next) => {
  try {
    res.json(inventoryService.valuation());
  } catch (err) {
    next(err);
  }
});

/**
 * The INV-101 invariant, exposed so it can be asked rather than assumed.
 *
 * Owner-only under TX-427: a non-empty answer means the ledger and the balance
 * disagree, which is a restore-or-repair conversation, not a report.
 */
router.get('/inventory/reconciliation', [authenticate, requirePermission('TX-427')], (req, res, next) => {
  try {
    res.json(inventoryService.reconcile());
  } catch (err) {
    next(err);
  }
});

router.get('/inventory/:productId', stockAtCounter, (req, res, next) => {
  try {
    res.json({ on_hand: inventoryService.onHand(req.params.productId) });
  } catch (err) {
    next(err);
  }
});

router.get('/inventory/:productId/movements', readInventory, (req, res, next) => {
  try {
    res.json(inventoryService.ledger(req.params.productId, {
      limit: req.query.limit,
      offset: req.query.offset,
      from: req.query.from || null,
      to: req.query.to || null,
      type: req.query.type || null,
    }));
  } catch (err) {
    next(err);
  }
});

/** The configured reason list (INV-108), so SCR-203 does not hard-code it. */
router.get('/inventory/meta/adjustment-reasons', postAdjustment, (req, res, next) => {
  try {
    res.json({
      reasons: inventoryService.adjustmentReasons(),
      types: inventoryService.TYPE_NAMES.map((name) => ({
        value: name, label: inventoryService.describe(name),
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/inventory/adjustments', postAdjustment, (req, res, next) => {
  try {
    const {
      productId, qtyMilli, reason, notes = null, unitCostCentavos = null, approver = null, batchId = null,
    } = req.body || {};

    // The approver was proved by middleware/auth.js from the approval the owner gave
    // at SCR-203's authorisation panel; the body's own claim never reaches here.
    res.status(201).json(inventoryService.adjust({
      productId, qtyMilli, reason, notes, unitCostCentavos, batchId,
      actor: req.session,
      approver,
    }, req.session));
  } catch (err) {
    next(err);
  }
});

/** INV-102: a correction is a compensating movement, never an edit. */
router.post('/inventory/movements/:id/correct', postAdjustment, (req, res, next) => {
  try {
    const { reason } = req.body || {};
    res.status(201).json(inventoryService.correct(req.params.id, { actor: req.session, reason }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
