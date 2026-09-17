'use strict';

// 05_TECH_SPEC.md §4:
//
//   POST /sales             TX-401   **the transaction** — FR_3.5
//   GET  /sales             TX-401   the lookup SCR-305 opens with
//   GET  /sales/:id         TX-401   the receipt view
//   GET  /sales/:id/voidable TX-401  POS-402/POS-403, answered before the button shows
//   POST /sales/:id/void    TX-401   POS-401 – POS-404, and TX-405 inside the service
//
// POST /sales/price-check lives in routes/pricing.js with the engine it calls.
//
// There is no PUT and no DELETE. POS-107 makes a completed sale immutable, and the
// absence of the route is how that is enforced at the edge — the corrections are a
// void and a return, both of which write new rows and neither of which edits this one.
//
// **The void sits under TX-401, not TX-405, and that is deliberate.** §10 grants
// TX-405 to a manager and an owner only, so a route behind it would be a route a
// cashier cannot call — and POS-403 says "a cashier may never void *unaided*", which
// is a rule about authorisation, not about who may ask. The cashier is the person who
// notices the mis-scan. So the counter's own grant opens the door, and `voidService`
// enforces TX-405 inside, where the refusal can name POS-403 and open the inline
// authorisation panel rather than answering 403 at the edge with nothing to do next.

const express = require('express');
const saleService = require('../services/saleService');
const openOrderService = require('../services/openOrderService');
const printService = require('../services/printService');
const voidService = require('../services/voidService');
const sequenceService = require('../services/sequenceService');
const errors = require('../services/errors');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const atTheCounter = [authenticate, requirePermission('TX-401')];

/**
 * The one contract that matters.
 *
 * Everything in FR_3.5 happens inside one transaction in saleService; this route
 * parses, authorises, delegates and serialises, and holds no rule of its own
 * (05_TECH_SPEC.md §8.2).
 */
router.post('/sales', atTheCounter, async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = saleService.complete({
      lines: body.lines,
      customerId: body.customerId || null,
      tenders: body.tenders,
      transactionDiscountCentavos: body.transactionDiscountCentavos || 0,
      // Compared against the server's figure and discarded. §4.1's closing note: a
      // stale price list in a renderer is caught rather than banked.
      clientTotalCentavos: body.clientTotalCentavos ?? null,
      approver: body.approver || null,
      acceptDuplicateReference: body.acceptDuplicateReference === true,
      reason: body.reason || null,
      // TAX-004: the beneficiary's ID type, number and name. Passed straight through —
      // whether the store grants the discount at all, and which lines it reaches, are
      // decisions the pricing engine makes and this route holds no copy of.
      statutory: body.statutory || null,
      // TASK-066: a café's order — how it is served, the table, the open order it pays for.
      orderType: body.orderType || null,
      tableLabel: body.tableLabel ?? null,
      openOrderId: body.openOrderId || null,
      // PR-107 (TASK-070): a walk-in's cart switched to wholesale.
      priceLevel: body.priceLevel || null,
    }, req.session);

    // FR_3.7 / INT-1: the receipt prints now, after the sale has committed — until
    // TASK-054 nothing called this, and the first paper a store ever saw of a sale was a
    // reprint stamped REPRINT. It cannot fail the sale: the money is banked, and a
    // printer fault is an answer on the receipt screen, not an error.
    res.status(201).json({
      ...result,
      printed: await firstPrint(result.sale.id),
      // POS-110: and the kitchen hears what it has not yet — the whole order for a sale
      // rung up without one, what was added at the counter for one that was.
      kitchen: { printed: await kitchenPrint(result.sale.id, req.session) },
    });
  } catch (err) {
    next(err);
  }
});

/** What the receipt screen needs to say about the paper: printed, or why not. */
async function firstPrint(saleId) {
  let record;
  try {
    record = saleService.printReceipt(saleId).printed;
  } catch (err) {
    return { delivered: false, transport: null, error: err.message };
  }
  // A LAN printer answers within its own four-second timeout; waiting for it keeps the
  // screen truthful, and costs the cashier time only when the printer is not there.
  return printService.outcome(record);
}

/** POS-110 after the sale: null where the kitchen has nothing new to hear. */
async function kitchenPrint(saleId, actor) {
  try {
    const record = openOrderService.ticketForSale(saleId, actor);
    return record ? await printService.outcome(record) : null;
  } catch (err) {
    return { delivered: false, transport: null, error: err.message };
  }
}

/**
 * TASK-054: print the original again, for a sale whose first print failed. Refused once
 * it has printed — a copy then is a reprint, marked, behind TX-430 (POS-208).
 */
router.post('/sales/:id/print', atTheCounter, async (req, res, next) => {
  try {
    const { printed } = saleService.printQueuedReceipt(req.params.id);
    res.json({ printed: await printService.outcome(printed) });
  } catch (err) {
    next(err);
  }
});

/** POS-108's run for today, so "are there gaps in today's sale numbers" is answerable. */
router.get('/sales/sequence-audit', [authenticate, requirePermission('TX-421')], (req, res, next) => {
  try {
    res.json(sequenceService.auditDay('SALE'));
  } catch (err) {
    next(err);
  }
});

/**
 * POS-207 — has this reference been used today?
 *
 * Asked when the cashier leaves the field rather than at Complete, because
 * 04_UX_SPEC.md §6 puts rule validation at the point of action: finding out that a
 * GCash reference is a duplicate *after* keying the whole payment is finding out too
 * late to do anything but retype it. The server re-checks at the sale regardless.
 */
router.get('/sales/tender-references', atTheCounter, (req, res, next) => {
  try {
    const method = String(req.query.method || '').toUpperCase();
    const reference = String(req.query.reference || '').trim();
    if (!reference) return res.json({ duplicates: [] });

    return res.json({ duplicates: saleService.duplicateReferences(method, reference) });
  } catch (err) {
    return next(err);
  }
});

/**
 * Find a sale. SCR-305's opening question, and SCR-304's "which receipt was that".
 *
 * `returnable=true` is the filter a counter actually wants — a voided or fully
 * returned sale has nothing left to give back — expressed as a flag so the screen does
 * not keep its own copy of which two statuses those are (POS-301). Everything it can
 * filter on is a column of the sale; nothing here decides a rule.
 */
router.get('/sales', atTheCounter, (req, res, next) => {
  try {
    const filters = {
      from: req.query.from || null,
      to: req.query.to || null,
      customerId: req.query.customerId || null,
      shiftId: req.query.shiftId || null,
      status: req.query.status || null,
      q: req.query.q || null,
      returnable: req.query.returnable === 'true',
    };
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 25, 1), 200);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);

    res.json({
      total: saleService.countSearch(filters),
      limit,
      offset,
      sales: saleService.search({ ...filters, limit, offset }),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/sales/:id', atTheCounter, (req, res, next) => {
  try {
    res.json(saleService.get(req.params.id));
  } catch (err) {
    next(err);
  }
});

/**
 * POS-402 and POS-403, answered before SCR-304 shows the button.
 *
 * Whether the originating shift is still open is the server's fact, and a screen that
 * decided it for itself would offer a void after a close and explain the refusal
 * afterwards — by which time the cashier has already told the customer it can be
 * undone. Read-only; it writes nothing.
 */
router.get('/sales/:id/voidable', atTheCounter, (req, res, next) => {
  try {
    res.json(voidService.eligibility(req.params.id, req.session));
  } catch (err) {
    next(err);
  }
});

/**
 * POS-401 — the reversal.
 *
 * One transaction in voidService: the compensating movements, the credit reversal, the
 * sale's four stamped columns and both audit rows. This route parses, authorises,
 * delegates and serialises, and holds no rule of its own (05_TECH_SPEC.md §8.2).
 */
router.post('/sales/:id/void', atTheCounter, (req, res, next) => {
  try {
    const body = req.body || {};
    res.status(201).json(voidService.post({
      saleId: req.params.id,
      reason: body.reason,
      // POS-403's authoriser, as a username. Resolved against the users table
      // server-side, because a body carrying `{ role: 'MANAGER' }` is a claim (SEC-6).
      approver: body.approver || null,
    }, req.session));
  } catch (err) {
    next(err);
  }
});

for (const method of ['put', 'patch', 'delete']) {
  router[method]('/sales/:id', atTheCounter, (req, res, next) => {
    next(errors.conflict(
      'A completed sale is never edited or deleted. Correct it with a void or a return.',
      { ruleId: 'POS-107' }
    ));
  });
}

module.exports = router;
