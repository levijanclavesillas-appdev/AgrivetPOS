'use strict';

// 05_TECH_SPEC.md §4:
//
//   GET  /customers?q=            TX-413
//   GET  /customers/:id/credit    TX-413   limit, balance, available, ageing
//
// POST/PUT /customers and PUT /customers/:id/credit-limit are in TASK-008's API list
// but not in §4's table — add the rows.
//
// The split is TX-413 against TX-414: a cashier may look a farm up and register a new
// one at the counter, and may not decide how much credit it gets. §10's INVENTORY cell
// for TX-413 is VIEW, so a clerk reads but does not edit — expressed here as a level
// on the write routes rather than a second permission.

const express = require('express');
const customerService = require('../services/customerService');
const creditService = require('../services/creditService');
const errors = require('../services/errors');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const readCustomers = [authenticate, requirePermission('TX-413')];
const editCustomers = [authenticate, requirePermission('TX-413', { level: 'FULL' })];
const setCreditLimit = [authenticate, requirePermission('TX-414')];

// Before /:id, or "outstanding" is read as a customer id.
router.get('/customers/outstanding', readCustomers, (req, res, next) => {
  try {
    res.json(creditService.outstanding());
  } catch (err) {
    next(err);
  }
});

/** The CR-103 invariant, asked rather than assumed. Owner-only, as INV-101's is. */
router.get('/customers/credit-reconciliation', [authenticate, requirePermission('TX-427')], (req, res, next) => {
  try {
    res.json(creditService.reconcile());
  } catch (err) {
    next(err);
  }
});

router.get('/customers', readCustomers, (req, res, next) => {
  try {
    res.json(customerService.search({
      q: req.query.q,
      includeInactive: req.query.includeInactive === 'true',
      creditOnly: req.query.creditOnly === 'true',
      limit: req.query.limit,
      offset: req.query.offset,
    }));
  } catch (err) {
    next(err);
  }
});

router.get('/customers/:id', readCustomers, (req, res, next) => {
  try {
    res.json({ customer: customerService.get(req.params.id) });
  } catch (err) {
    next(err);
  }
});

// SCR-402's first block: limit, balance, available credit and ageing (CR-107).
router.get('/customers/:id/credit', readCustomers, (req, res, next) => {
  try {
    res.json(creditService.creditFor(req.params.id, {
      limit: req.query.limit,
      offset: req.query.offset,
    }));
  } catch (err) {
    next(err);
  }
});

router.post('/customers', editCustomers, (req, res, next) => {
  try {
    res.status(201).json({ customer: customerService.create(req.body || {}, req.session) });
  } catch (err) {
    next(err);
  }
});

router.put('/customers/:id', editCustomers, (req, res, next) => {
  try {
    res.json({ customer: customerService.update(req.params.id, req.body || {}, req.session) });
  } catch (err) {
    next(err);
  }
});

// VR-304: transacted customers are history. VR-305 refuses even this while a balance
// stands, which the service enforces.
router.post('/customers/:id/deactivate', editCustomers, (req, res, next) => {
  try {
    res.json({ customer: customerService.deactivate(req.params.id, req.session) });
  } catch (err) {
    next(err);
  }
});

router.delete('/customers/:id', editCustomers, (req, res, next) => {
  next(errors.conflict(
    'A customer is never deleted — sales and credit history reference them. Deactivate them instead.',
    { ruleId: 'VR-304' }
  ));
});

/**
 * CR-106 — a limit change needs TX-414 and is audited with both values.
 *
 * Its own route rather than a field on PUT /customers, for the reason the tax mode got
 * its own: folding it in would let a TX-413 holder raise a credit limit as a side
 * effect of correcting a phone number.
 */
router.put('/customers/:id/credit-limit', setCreditLimit, (req, res, next) => {
  try {
    const { creditLimitCentavos, termsDays, reason = null } = req.body || {};
    res.json({
      credit: creditService.setLimit(req.params.id, creditLimitCentavos, req.session, { reason, termsDays }),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
