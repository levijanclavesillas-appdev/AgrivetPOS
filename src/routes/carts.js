'use strict';

// POS-105, POS-106 — the cart the renderer restores on load, and the parked ones.
//
// Not in 05_TECH_SPEC.md §4's table — add the rows. TX-401 throughout: a cart is the
// act of selling, and anyone who may complete a sale may build one.

const express = require('express');
const cartService = require('../services/cartService');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const atTheCounter = [authenticate, requirePermission('TX-401')];

/** What SCR-301 asks on load: is there a cart to come back to (POS-105)? */
router.get('/carts/active', atTheCounter, (req, res, next) => {
  try {
    res.json({ cart: cartService.active(req.session) });
  } catch (err) {
    next(err);
  }
});

router.put('/carts/active', atTheCounter, (req, res, next) => {
  try {
    const { lines = [], customerId = null, transactionDiscountCentavos = 0 } = req.body || {};
    res.json(cartService.save({ lines, customerId, transactionDiscountCentavos }, req.session));
  } catch (err) {
    next(err);
  }
});

router.delete('/carts/active', atTheCounter, (req, res, next) => {
  try {
    res.json(cartService.clear(req.session));
  } catch (err) {
    next(err);
  }
});

router.get('/carts/parked', atTheCounter, (req, res, next) => {
  try {
    res.json(cartService.parked(req.session));
  } catch (err) {
    next(err);
  }
});

/** F6, and F12 which is this plus an empty counter. */
router.post('/carts/park', atTheCounter, (req, res, next) => {
  try {
    res.status(201).json(cartService.park({ label: (req.body || {}).label }, req.session));
  } catch (err) {
    next(err);
  }
});

/** F7. Whatever is in progress is parked rather than lost. */
router.post('/carts/:id/resume', atTheCounter, (req, res, next) => {
  try {
    res.json(cartService.resume(req.params.id, req.session));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
