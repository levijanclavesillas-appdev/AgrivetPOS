'use strict';

// 05_TECH_SPEC.md §4, the rows TASK-072 adds:
//
//   GET           /restock/suggestions          TX-409   INV-109, PO-109
//   POST          /restock/context              TX-409   PO-109 — the same figures, for picked products
//   GET  POST     /restock-requests             TX-409   PO-107
//   GET  PUT      /restock-requests/:id         TX-409   PO-107
//   POST          /restock-requests/:id/submit  TX-409   PO-107
//   POST          /restock-requests/:id/decide  TX-409   AUD-601, AUD-603
//   POST          /restock-requests/:id/cancel  TX-409   AUD-601
//   POST          /restock-requests/:id/orders  TX-409   PO-108
//
// **`TX-409`, and deliberately not `TX-422`.** The low-stock endpoint this borrows its
// predicate from is behind TX-422 ("view inventory reports"), which a cashier holds at
// VIEW. But the output of this module is a purchase order, purchasing.js:12-21 has
// already settled that raising one is TX-409, and 04_UX_SPEC.md:120 records what happens
// when the two are split: "a reorder list the stock role cannot open is a reorder list
// nobody reads." TX-409's roles are exactly right — owner, manager, inventory clerk, and
// never a cashier.
//
// Nothing here is a write to stock. PO-107: a restocking request moves no stock and
// commits the store to nothing; the only thing any of these routes creates is a DRAFT
// purchase order, which PO-103 says moves no stock either.

const express = require('express');
const restockService = require('../services/restockService');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const restock = [authenticate, requirePermission('TX-409')];

// ── The derived list (INV-109 widened, PO-109) ──────────────────────────────

router.get('/restock/suggestions', restock, (req, res, next) => {
  try {
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 500, 500);
    res.json(restockService.suggestions({ limit }));
  } catch (err) {
    next(err);
  }
});

/**
 * The same figures for products the buyer picked by hand.
 *
 * A POST because the list of ids is the buyer's working list and can be long enough to
 * embarrass a query string — not because it writes anything. It does not.
 */
router.post('/restock/context', restock, (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.productIds) ? req.body.productIds.map(String) : [];
    res.json(restockService.contextFor(ids));
  } catch (err) {
    next(err);
  }
});

// ── The request ─────────────────────────────────────────────────────────────

router.get('/restock-requests', restock, (req, res, next) => {
  try {
    res.json(restockService.search({
      status: req.query.status || null,
      open: req.query.open === 'true',
      limit: Math.min(Number.parseInt(req.query.limit, 10) || 50, 200),
      offset: Number.parseInt(req.query.offset, 10) || 0,
    }));
  } catch (err) {
    next(err);
  }
});

// Declared before '/restock-requests/:id' so the word is never read as an id — the same
// ordering products.js needs for '/products/prices'.
router.post('/restock-requests', restock, (req, res, next) => {
  try {
    res.status(201).json({ request: restockService.create(req.body || {}, req.session) });
  } catch (err) {
    next(err);
  }
});

router.get('/restock-requests/:id', restock, (req, res, next) => {
  try {
    res.json({ request: restockService.get(req.params.id) });
  } catch (err) {
    next(err);
  }
});

router.put('/restock-requests/:id', restock, (req, res, next) => {
  try {
    res.json({ request: restockService.update(req.params.id, req.body || {}, req.session) });
  } catch (err) {
    next(err);
  }
});

router.post('/restock-requests/:id/submit', restock, (req, res, next) => {
  try {
    res.json({ request: restockService.submit(req.params.id, req.session) });
  } catch (err) {
    next(err);
  }
});

router.post('/restock-requests/:id/decide', restock, (req, res, next) => {
  try {
    res.json({
      request: restockService.decide(req.params.id, {
        approve: req.body?.approve === true,
        reason: req.body?.reason ?? null,
        itemDecisions: req.body?.itemDecisions ?? null,
      }, req.session),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/restock-requests/:id/cancel', restock, (req, res, next) => {
  try {
    res.json({ request: restockService.cancel(req.params.id, req.body?.reason, req.session) });
  } catch (err) {
    next(err);
  }
});

// PO-108. One DRAFT purchase order per supplier, in one transaction.
router.post('/restock-requests/:id/orders', restock, (req, res, next) => {
  try {
    res.status(201).json(restockService.convert(req.params.id, req.session));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
