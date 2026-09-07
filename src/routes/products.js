'use strict';

// Products. 05_TECH_SPEC.md §4 sets the permissions:
//
//   GET  /products                TX-422   the list and search (NFR_1.3)
//   GET  /products/barcode/:code  TX-401   a scan at the counter (NFR_1.2)
//   POST PUT /products            TX-410   create and edit, cost only under TX-412
//
// The split matters: a cashier scans (TX-401) and may not edit (TX-410); an inventory
// clerk edits the product but not its selling price (TX-411); only the owner touches
// cost (TX-412). Each is checked here, and again in the service for the cost, because
// the cost is the one field where a wrong answer is invisible until the margin report.
//
// The child-collection routes below — barcodes, packs, prices, cost and deactivate —
// are not in §4's table; add the rows. Each exists because SCR-202 edits that tab on
// its own, and because prices and cost carry permissions the product itself does not.

const express = require('express');
const productService = require('../services/productService');
const errors = require('../services/errors');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const readCatalog = [authenticate, requirePermission('TX-422')];
const scanAtCounter = [authenticate, requirePermission('TX-401')];
const editProduct = [authenticate, requirePermission('TX-410')];
const changePrice = [authenticate, requirePermission('TX-411')];
const changeCost = [authenticate, requirePermission('TX-412')];

// Before /:id, or "barcode" is read as a product id.
router.get('/products/barcode/:code', scanAtCounter, (req, res, next) => {
  try {
    const result = productService.findByBarcode(req.params.code, req.session);

    // TC-INT-30: an unknown barcode is 200 with an offer, not a 404. The counter has
    // the item in hand; "not found" is a dead end, "attach this code" is the next step.
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/products', readCatalog, (req, res, next) => {
  try {
    res.json(productService.search({
      q: req.query.q,
      categoryId: req.query.category,
      includeInactive: req.query.includeInactive === 'true',
      limit: req.query.limit,
      offset: req.query.offset,
    }, req.session));
  } catch (err) {
    next(err);
  }
});

router.get('/products/:id', readCatalog, (req, res, next) => {
  try {
    res.json({ product: productService.get(req.params.id, req.session) });
  } catch (err) {
    next(err);
  }
});

router.post('/products', editProduct, (req, res, next) => {
  try {
    res.status(201).json({ product: productService.create(req.body || {}, req.session) });
  } catch (err) {
    next(err);
  }
});

router.put('/products/:id', editProduct, (req, res, next) => {
  try {
    res.json({ product: productService.update(req.params.id, req.body || {}, req.session) });
  } catch (err) {
    next(err);
  }
});

// VR-206: referenced by history, so it is switched off rather than removed.
router.post('/products/:id/deactivate', editProduct, (req, res, next) => {
  try {
    res.json({ product: productService.deactivate(req.params.id, req.session) });
  } catch (err) {
    next(err);
  }
});

router.delete('/products/:id', editProduct, (req, res, next) => {
  next(errors.conflict(
    'A product is never deleted — movements and sales reference it. Deactivate it instead.',
    { ruleId: 'VR-206' }
  ));
});

// ── Barcodes (VR-205) ───────────────────────────────────────────────────────

router.post('/products/:id/barcodes', editProduct, (req, res, next) => {
  try {
    res.status(201).json({ barcodes: productService.attachBarcode(req.params.id, (req.body || {}).barcode, req.session) });
  } catch (err) {
    next(err);
  }
});

router.delete('/products/:id/barcodes/:barcodeId', editProduct, (req, res, next) => {
  try {
    // Unlike the product itself, a barcode is a label on a box rather than history:
    // nothing references product_barcodes, and a mis-scanned code has to be removable
    // or it is burnt forever.
    res.json({ barcodes: productService.detachBarcode(req.params.id, req.params.barcodeId, req.session) });
  } catch (err) {
    next(err);
  }
});

// ── Packs (UOM-002) ─────────────────────────────────────────────────────────

router.post('/products/:id/packs', editProduct, (req, res, next) => {
  try {
    res.status(201).json({ packs: productService.addPack(req.params.id, req.body || {}, req.session) });
  } catch (err) {
    next(err);
  }
});

router.delete('/products/:id/packs/:packId', editProduct, (req, res, next) => {
  try {
    res.json({ packs: productService.removePack(req.params.id, req.params.packId, req.session) });
  } catch (err) {
    next(err);
  }
});

// ── Prices (TX-411) and cost (TX-412) ───────────────────────────────────────

router.put('/products/:id/prices', changePrice, (req, res, next) => {
  try {
    const { effectiveFrom = null, reason = null, ...levels } = req.body || {};
    res.json({ product: productService.setPrices(req.params.id, levels, req.session, req.session, { effectiveFrom, reason }) });
  } catch (err) {
    next(err);
  }
});

router.put('/products/:id/cost', changeCost, (req, res, next) => {
  try {
    const { avgCostCentavos, reason = null } = req.body || {};
    res.json({ product: productService.setCost(req.params.id, avgCostCentavos, req.session, req.session, { reason }) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
