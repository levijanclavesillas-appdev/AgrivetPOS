'use strict';

// 05_TECH_SPEC.md §4, the rows this task adds:
//
//   GET  POST PUT /suppliers                    TX-409   VR-401
//   GET  POST     /purchase-orders              TX-409   PO-101, PO-104
//   POST          /purchase-orders/:id/submit   TX-409   PO-102
//   POST          /purchase-orders/:id/cancel   TX-409   PO-105
//   POST          /goods-receipts               TX-409   PO-201 – PO-207
//
// All of purchasing sits behind `TX-409` — "receive goods" — because §10 has no
// separate grant for raising an order, and TX-409's roles are exactly the right set:
// owner, manager and the inventory clerk, and never a cashier. A new permission would
// be a change to 03_BUSINESS_RULES.md §10, which is not this task's to make.
//
// A goods receipt moves average cost, which is otherwise TX-412 and owner-only. It is
// not gated on that: PO-203 makes the cost move a *consequence* of a delivery rather
// than an edit of a product, and a clerk who may receive stock is being asked what the
// van charged, not being allowed to retype a margin. PO-205's authorisation is what
// covers the case where that answer is wrong.

const express = require('express');
const supplierService = require('../services/supplierService');
const purchaseOrderService = require('../services/purchaseOrderService');
const goodsReceiptService = require('../services/goodsReceiptService');
const errors = require('../services/errors');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const purchasing = [authenticate, requirePermission('TX-409')];

// ── Suppliers (FT-501, VR-401) ──────────────────────────────────────────────

router.get('/suppliers', purchasing, (req, res, next) => {
  try {
    res.json(supplierService.search({
      q: req.query.q,
      includeInactive: req.query.includeInactive === 'true',
      limit: req.query.limit,
      offset: req.query.offset,
    }));
  } catch (err) {
    next(err);
  }
});

router.get('/suppliers/:id', purchasing, (req, res, next) => {
  try {
    res.json({ supplier: supplierService.get(req.params.id) });
  } catch (err) {
    next(err);
  }
});

router.post('/suppliers', purchasing, (req, res, next) => {
  try {
    res.status(201).json({ supplier: supplierService.create(req.body || {}, req.session) });
  } catch (err) {
    next(err);
  }
});

router.put('/suppliers/:id', purchasing, (req, res, next) => {
  try {
    res.json({ supplier: supplierService.update(req.params.id, req.body || {}, req.session) });
  } catch (err) {
    next(err);
  }
});

router.post('/suppliers/:id/deactivate', purchasing, (req, res, next) => {
  try {
    res.json({ supplier: supplierService.deactivate(req.params.id, req.session) });
  } catch (err) {
    next(err);
  }
});

router.post('/suppliers/:id/reactivate', purchasing, (req, res, next) => {
  try {
    res.json({ supplier: supplierService.reactivate(req.params.id, req.session) });
  } catch (err) {
    next(err);
  }
});

// VR-401's sibling of VR-304, refused in the same shape: orders and deliveries
// reference a supplier, so there is nothing to delete them into.
router.delete('/suppliers/:id', purchasing, (req, res, next) => {
  next(errors.conflict(
    'A supplier is never deleted — orders and deliveries reference them. Deactivate them instead.',
    { ruleId: 'VR-401' }
  ));
});

// ── Purchase orders (FT-502, PO-101 – PO-105) ───────────────────────────────

router.get('/purchase-orders', purchasing, (req, res, next) => {
  try {
    res.json(purchaseOrderService.search({
      supplierId: req.query.supplierId,
      status: req.query.status,
      open: req.query.open,
      q: req.query.q,
      from: req.query.from,
      to: req.query.to,
      limit: req.query.limit,
      offset: req.query.offset,
    }));
  } catch (err) {
    next(err);
  }
});

router.get('/purchase-orders/:id', purchasing, (req, res, next) => {
  try {
    res.json({ purchase_order: purchaseOrderService.get(req.params.id) });
  } catch (err) {
    next(err);
  }
});

router.post('/purchase-orders', purchasing, (req, res, next) => {
  try {
    res.status(201).json({ purchase_order: purchaseOrderService.create(req.body || {}, req.session) });
  } catch (err) {
    next(err);
  }
});

/**
 * PO-104 — the same route for both halves of the rule.
 *
 * A DRAFT is edited in place; a PENDING order comes back with a new revision. The
 * service decides which, because a client that chose would be a client that could
 * choose wrongly and silently overwrite an order the supplier is holding.
 */
router.put('/purchase-orders/:id', purchasing, (req, res, next) => {
  try {
    res.json({ purchase_order: purchaseOrderService.update(req.params.id, req.body || {}, req.session) });
  } catch (err) {
    next(err);
  }
});

router.post('/purchase-orders/:id/submit', purchasing, (req, res, next) => {
  try {
    res.json({ purchase_order: purchaseOrderService.submit(req.params.id, req.session) });
  } catch (err) {
    next(err);
  }
});

router.post('/purchase-orders/:id/cancel', purchasing, (req, res, next) => {
  try {
    const { reason = null } = req.body || {};
    res.json({ purchase_order: purchaseOrderService.cancel(req.params.id, { reason }, req.session) });
  } catch (err) {
    next(err);
  }
});

// PO-103, as a route that does not exist: there is no endpoint here that posts stock
// from a purchase order, and TC-INT-76 asserts that none of the ones above do.

// ── Goods receipts (FT-503, FT-504, PO-201 – PO-207) ────────────────────────

router.get('/goods-receipts', purchasing, (req, res, next) => {
  try {
    res.json(goodsReceiptService.search({
      supplierId: req.query.supplierId,
      poId: req.query.poId,
      q: req.query.q,
      from: req.query.from,
      to: req.query.to,
      flaggedOnly: req.query.flaggedOnly,
      limit: req.query.limit,
      offset: req.query.offset,
    }));
  } catch (err) {
    next(err);
  }
});

router.get('/goods-receipts/:id', purchasing, (req, res, next) => {
  try {
    res.json({ goods_receipt: goodsReceiptService.get(req.params.id) });
  } catch (err) {
    next(err);
  }
});

/**
 * The delivery. `poId` present is FT-503; absent is FT-504's counter purchase, which
 * still needs a `supplierId` (PO-207).
 *
 * The approver is a username the renderer collected in the authorisation panel; the
 * service resolves it against the users table rather than believing the role in the
 * body (SEC-6).
 */
router.post('/goods-receipts', purchasing, (req, res, next) => {
  try {
    res.status(201).json({ goods_receipt: goodsReceiptService.post(req.body || {}, req.session) });
  } catch (err) {
    next(err);
  }
});

// PO-206 — a posted receipt is immutable, and the refusal says what to do instead
// rather than returning a bare 404 for a route nobody wrote.
const immutable = (req, res, next) => next(errors.conflict(
  'A posted delivery cannot be changed. File an inventory adjustment, or return the goods '
  + 'to the supplier.',
  { ruleId: 'PO-206' }
));
router.put('/goods-receipts/:id', purchasing, immutable);
router.delete('/goods-receipts/:id', purchasing, immutable);

/** The purchase history of one product: what it has cost, from whom, and when. */
router.get('/products/:id/purchase-history', purchasing, (req, res, next) => {
  try {
    res.json(goodsReceiptService.historyForProduct(req.params.id, {
      limit: Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200),
      offset: Math.max(Number.parseInt(req.query.offset, 10) || 0, 0),
    }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
