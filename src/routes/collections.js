'use strict';

// 05_TECH_SPEC.md §4:
//
//   POST /customers/:id/collections   TX-416   CR-201..CR-206
//
// GET /customers/:id/collections is in TASK-012's API list but not §4's table — add
// the row. SCR-402 shows collection history under the sale history, and SCR-403 needs
// to show what a payment settled.

const express = require('express');
const collectionService = require('../services/collectionService');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const takeCollection = [authenticate, requirePermission('TX-416')];

router.get('/customers/:id/collections', takeCollection, (req, res, next) => {
  try {
    res.json(collectionService.listFor(req.params.id, {
      limit: req.query.limit, offset: req.query.offset,
    }));
  } catch (err) {
    next(err);
  }
});

router.post('/customers/:id/collections', takeCollection, (req, res, next) => {
  try {
    const { amountCentavos, method, referenceNo, notes, acceptOverpayment } = req.body || {};

    res.status(201).json(collectionService.record({
      customerId: req.params.id,
      amountCentavos,
      method,
      referenceNo,
      notes,
      // CR-204: the excess becomes store credit, and the rule requires the cashier to
      // say so explicitly rather than the system deciding for them.
      acceptOverpayment: acceptOverpayment === true,
    }, req.session));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
