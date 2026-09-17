'use strict';

// POS-113 — the counter's quick keys (TASK-070).
//
//   GET  /quick-keys            the counter: the buttons, and whether they are on
//   PUT  /quick-keys            arranging them is editing the catalogue (TX-410)
//   POST /quick-keys/suggest    a first set, from the products with no barcode

const express = require('express');
const quickKeyService = require('../services/quickKeyService');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const atTheCounter = [authenticate, requirePermission(['TX-401', 'TX-422'])];
const arrange = [authenticate, requirePermission('TX-410')];

router.get('/quick-keys', atTheCounter, (req, res, next) => {
  try {
    res.json(quickKeyService.list());
  } catch (err) {
    next(err);
  }
});

router.put('/quick-keys', arrange, (req, res, next) => {
  try {
    res.json(quickKeyService.replace((req.body || {}).keys, req.session));
  } catch (err) {
    next(err);
  }
});

router.post('/quick-keys/suggest', arrange, (req, res, next) => {
  try {
    res.json(quickKeyService.suggest(req.session));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
