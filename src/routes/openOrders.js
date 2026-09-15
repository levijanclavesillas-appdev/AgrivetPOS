'use strict';

// POS-109, POS-110 — a café's orders before they are paid (TASK-066).
//
// Under TX-401, the counter's own grant: taking an order and sending it to the kitchen is
// selling, and the cashier who takes the table's order is the one who is paid for it.
// Cancelling one needs a reason and is audited (openOrderService.cancel).

const express = require('express');
const openOrderService = require('../services/openOrderService');
const printService = require('../services/printService');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const atTheCounter = [authenticate, requirePermission('TX-401')];

/** A printed document for the screen: what the printer said, and the text if the page prints it. */
const withOutcome = async (result) => ({ ...result, printed: result.printed ? await printService.outcome(result.printed) : null });

router.get('/open-orders', atTheCounter, (req, res, next) => {
  try {
    res.json(openOrderService.list());
  } catch (err) {
    next(err);
  }
});

router.get('/open-orders/:id', atTheCounter, (req, res, next) => {
  try {
    res.json(openOrderService.get(req.params.id));
  } catch (err) {
    next(err);
  }
});

/** A new order, to the kitchen. */
router.post('/open-orders', atTheCounter, async (req, res, next) => {
  try {
    const body = req.body || {};
    res.status(201).json(await withOutcome(openOrderService.send({
      lines: body.lines,
      orderType: body.orderType,
      tableLabel: body.tableLabel,
      customerId: body.customerId || null,
      transactionDiscountCentavos: body.transactionDiscountCentavos || 0,
    }, req.session)));
  } catch (err) {
    next(err);
  }
});

/** The order as it stands now; the kitchen is sent only what changed. */
router.put('/open-orders/:id', atTheCounter, async (req, res, next) => {
  try {
    const body = req.body || {};
    res.json(await withOutcome(openOrderService.send({
      id: req.params.id,
      lines: body.lines,
      orderType: body.orderType,
      tableLabel: body.tableLabel,
      customerId: body.customerId || null,
      transactionDiscountCentavos: body.transactionDiscountCentavos || 0,
    }, req.session)));
  } catch (err) {
    next(err);
  }
});

router.post('/open-orders/:id/cancel', atTheCounter, async (req, res, next) => {
  try {
    res.json(await withOutcome(openOrderService.cancel(req.params.id, { reason: (req.body || {}).reason }, req.session)));
  } catch (err) {
    next(err);
  }
});

router.post('/open-orders/:id/ticket', atTheCounter, async (req, res, next) => {
  try {
    res.json(await withOutcome(openOrderService.reprintTicket(req.params.id, req.session)));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
