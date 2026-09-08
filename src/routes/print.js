'use strict';

// 05_TECH_SPEC.md §4:
//
//   POST /sales/:id/reprint   TX-430   POS-208
//
// POST /print/test and GET /print/queue are in TASK-014's API list but not §4's table
// — add the rows. SCR-702 needs a way to prove a printer is plugged in before a
// customer is standing at the counter, and SCR-304 needs the list of what did not
// print (INT-1's queue).
//
// Everything here is outside every business transaction. A printer is hardware and a
// failure is a toast.

const express = require('express');
const saleService = require('../services/saleService');
const printService = require('../services/printService');
const documentService = require('../services/documentService');
const storeProfileService = require('../services/storeProfileService');
const escpos = require('../services/escpos');
const settingsService = require('../services/settingsService');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const reprintReceipt = [authenticate, requirePermission('TX-430')];
const configurePrinter = [authenticate, requirePermission('TX-424')];

/**
 * POS-208 — reprint, stamped and audited.
 *
 * TX-430 rather than TX-401: reprinting is a separate grant from selling because the
 * rule treats an unmarked reprint as a shrinkage risk, and the grant is what makes
 * "who may produce a second copy" answerable.
 */
router.post('/sales/:id/reprint', reprintReceipt, (req, res, next) => {
  try {
    res.json(saleService.reprint(req.params.id, req.session));
  } catch (err) {
    next(err);
  }
});

/** The document as it would print, without printing it — SCR-304's preview. */
router.get('/sales/:id/receipt', reprintReceipt, (req, res, next) => {
  try {
    const view = saleService.get(req.params.id);
    const columns = req.query.columns
      ? escpos.assertWidth(Number.parseInt(req.query.columns, 10))
      : printService.width();

    res.json({
      document: printService.renderSaleReceipt({
        sale: { ...view.sale, id: req.params.id },
        items: view.items,
        tenders: view.tenders,
        profile: storeProfileService.profile(),
        columns,
      }),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Prove the printer is plugged in.
 *
 * Subject to TAX-006 like every other document — a test page is still a piece of paper
 * with the store's name on it, and the rule holds for all of them.
 */
router.post('/print/test', configurePrinter, (req, res, next) => {
  try {
    const profile = storeProfileService.profile();
    const columns = printService.width();

    const document = {
      kind: 'SALE_RECEIPT',
      document_no: null,
      columns,
      text: [
        ...printService.header(profile, 'PRINTER TEST', columns),
        escpos.divider(columns),
        escpos.leftRight('Width', `${columns} columns`, columns),
        escpos.leftRight('Transport', settingsService.get('printer_transport'), columns),
        escpos.leftRight('Requested by', req.session.username, columns),
        ...printService.footer(columns),
      ].join('\n'),
    };

    res.json({ document, printed: documentService.print(document) });
  } catch (err) {
    next(err);
  }
});

/** INT-1's queue: what did not print, waiting to be reprinted. */
router.get('/print/queue', reprintReceipt, (req, res, next) => {
  try {
    res.json({ queued: printService.queued() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
