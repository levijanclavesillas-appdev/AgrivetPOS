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

/** A Manila calendar day, or nothing. The service decides what "nothing" means. */
const dateParam = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : null);
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

/**
 * The list, and the two enumerations a screen would otherwise have to keep itself.
 *
 * `customer_types` and `price_levels` are served for the same reason `/settings` serves
 * its groups and `/sales/pricing-policy` serves its ceilings: a screen with its own
 * copy of a list the server validates against is a screen that is wrong the day the
 * list changes, and it fails by offering a choice the server then refuses.
 */
router.get('/customers', readCustomers, (req, res, next) => {
  try {
    res.json({
      customer_types: customerService.TYPES,
      price_levels: customerService.PRICE_LEVELS,
      ...customerService.search({
        q: req.query.q,
        includeInactive: req.query.includeInactive === 'true',
        creditOnly: req.query.creditOnly === 'true',
        limit: req.query.limit,
        offset: req.query.offset,
      }),
    });
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

/**
 * `CR-302` — the statement, `SCR-404`'s document.
 *
 * `TX-421`, not `TX-413`: a statement is the store's receivable ledger for one
 * customer, and a cashier who may look a customer up is not thereby somebody who reads
 * what the shop is owed. The service checks it again (SEC-6), where the refusal can
 * name the rule.
 */
router.get('/customers/:id/statement',
  [authenticate, requirePermission('TX-421')], (req, res, next) => {
    try {
      res.json(creditService.statement(req.params.id, {
        from: dateParam(req.query.from),
        to: dateParam(req.query.to),
        actor: req.session,
      }));
    } catch (err) {
      next(err);
    }
  });

/**
 * `CR-303` — the owner declares a debt uncollectable (`FT-409`).
 *
 * **The door is `TX-413` and the rule is `TX-417`**, which is the same shape the void
 * uses (`TX-401` at the edge, `POS-403` inside) and for the same reason: a route behind
 * `TX-417` would answer a manager with a bare 403 from the middleware, before anything
 * could audit the attempt or tell them what they *can* do. `creditService.writeOff`
 * enforces the owner-only rule where the refusal can do both.
 *
 * A cashier is stopped at the edge, and rightly — `TX-413` is the counter's grant for
 * customer work, and a cashier who reaches this URL has typed it by hand.
 */
router.post('/customers/:id/write-off', editCustomers, (req, res, next) => {
    try {
      const body = req.body || {};
      res.status(201).json(creditService.writeOff(req.params.id, {
        amountCentavos: body.amountCentavos,
        reason: body.reason,
        approver: body.approver || null,
        actor: req.session,
      }));
    } catch (err) {
      next(err);
    }
  });

/**
 * `CR-302` on paper. `TX-421` to read it, and the printer does not care who asked —
 * `CR-206`'s acknowledgement set the precedent for a document a customer takes away.
 */
router.post('/customers/:id/statement/print',
  [authenticate, requirePermission('TX-421')], (req, res, next) => {
    try {
      const body = req.body || {};
      res.json(creditService.printStatement(req.params.id, {
        from: dateParam(body.from),
        to: dateParam(body.to),
        actor: req.session,
        reprint: Boolean(body.reprint),
      }));
    } catch (err) {
      next(err);
    }
  });

/** The same figures as a file (TX-426 to export, TX-421 to read). */
router.get('/customers/:id/statement/export.csv',
  [authenticate, requirePermission('TX-426')], (req, res, next) => {
    try {
      const { csv, filename } = creditService.statementCsv(req.params.id, {
        from: dateParam(req.query.from),
        to: dateParam(req.query.to),
        actor: req.session,
      });
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="${filename}"`);
      res.send(csv);
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
/**
 * PR-103 — what this customer pays for these products.
 *
 * Behind `TX-411` — "change a selling price" — rather than `TX-413`'s "create or edit a
 * customer", which reaches a cashier. A negotiated price is a selling price that
 * happens to be attached to a customer, and it overrides every other level for that
 * pair, so it is not a customer detail.
 */
router.get('/customers/:id/prices', readCustomers, (req, res, next) => {
  try {
    res.json(customerService.priceList(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.put('/customers/:id/prices', [authenticate, requirePermission('TX-411')], (req, res, next) => {
  try {
    const { prices, reason = null } = req.body || {};
    res.json(customerService.setPrices(req.params.id, prices, req.session, req.session, { reason }));
  } catch (err) {
    next(err);
  }
});

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
