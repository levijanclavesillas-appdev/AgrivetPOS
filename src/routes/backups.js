'use strict';

// 05_TECH_SPEC.md §4:
//
//   GET  /backups                  TX-428   SCR-704 — the log and the folder
//   POST /backups                  TX-428   OPS-001, OPS-002 — a manual backup
//   GET  /backups/restore/preflight TX-427  what must be true before a restore
//   POST /backups/:id/restore      TX-427   OPS-004 — owner only
//   GET  /alerts                   —        OPS-007, any signed-in user
//   POST /alerts/dismiss           —        OPS-007, never the undismissible three
//
// Routes parse, authorise, delegate and serialise (§8.2). Every rule below lives in a
// service: the owner-only check, the open-shift refusal and the typed filename are all
// in restoreService, because a control that lives in a route is a control the next
// caller can go round.

const express = require('express');
const backupService = require('../services/backupService');
const restoreService = require('../services/restoreService');
const alertService = require('../services/alertService');
const systemService = require('../services/systemService');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const manageBackups = [authenticate, requirePermission('TX-428')];
const restorePermission = [authenticate, requirePermission('TX-427')];

router.get('/backups', manageBackups, (req, res, next) => {
  try {
    res.json({
      ...backupService.list({ limit: Number(req.query.limit) || 30 }),
      overdue: backupService.overdue(),
    });
  } catch (err) {
    next(err);
  }
});

/** OPS-001, OPS-002. Returns the file, its size and its verification status. */
router.post('/backups', manageBackups, (req, res, next) => {
  try {
    const result = backupService.run({ trigger: 'MANUAL', actor: req.session });
    // A failed backup is not a 500: nothing crashed, the store is simply not backed
    // up, and the reason is the payload. 409 says "the state of the world is wrong",
    // which is exactly what happened.
    res.status(result.ok ? 201 : 409).json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/backups/restore/preflight', restorePermission, (req, res, next) => {
  try {
    res.json(restoreService.preflight({ backupId: req.query.backupId || null }));
  } catch (err) {
    next(err);
  }
});

router.post('/backups/:id/restore', restorePermission, (req, res, next) => {
  try {
    res.json(restoreService.restore({
      backupId: req.params.id,
      confirmFilename: (req.body || {}).confirmFilename,
      actor: req.session,
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * OPS-007's list, for the shell's top bar and SCR-601 alike.
 *
 * No TX-* beyond being signed in: an alert about the store's data being at risk is not
 * privileged information, and a cashier who can see "no backup for three days" is a
 * cashier who can tell the owner.
 */
router.get('/alerts', [authenticate], (req, res, next) => {
  try {
    res.json(alertService.list({ includeDismissed: req.query.includeDismissed === 'true' }));
  } catch (err) {
    next(err);
  }
});

router.post('/alerts/dismiss', [authenticate], (req, res, next) => {
  try {
    res.json(alertService.dismiss((req.body || {}).alertKey, req.session));
  } catch (err) {
    next(err);
  }
});

/** OPS-006's "last integrity check" — run on demand from SCR-705. */
router.post('/health/integrity-check', [authenticate, requirePermission('TX-428')], (req, res, next) => {
  try {
    res.json(systemService.integrityCheck({ actor: req.session }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
