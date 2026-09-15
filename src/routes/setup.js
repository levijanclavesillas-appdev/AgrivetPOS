'use strict';

// SCR-001. Two routes, neither authenticated: they run before any user exists, which
// is the only reason a route in this product carries no TX-* (05_TECH_SPEC.md §4).
//
// POST /setup is self-limiting rather than unprotected — it refuses once the
// installation has a store profile and an active owner, so it is reachable exactly
// once in the life of a database.

const express = require('express');
const setupService = require('../services/setupService');
const restoreService = require('../services/restoreService');
const { receiveFile } = require('../middleware/upload');

const router = express.Router();

// Not in 05_TECH_SPEC.md §4's table — add the rows. The renderer needs the wizard's
// state before it can choose a screen, and SCR-101 needs the store name to render the
// login page of a configured installation.
router.get('/setup', (req, res, next) => {
  try {
    res.json(setupService.status());
  } catch (err) {
    next(err);
  }
});

router.post('/setup', (req, res, next) => {
  try {
    const { store, taxMode, owner, backupFolder, acknowledgedRecoveryCode, industry, setupCode } = req.body || {};
    const result = setupService.complete({ store, taxMode, owner, backupFolder, acknowledgedRecoveryCode, industry, setupCode });

    // SEC-5: the recovery code is in this response and in no other. It is not stored
    // in plaintext, not logged, and cannot be requested again.
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * TASK-062: a hosted copy's setup code, checked when the owner leaves step 1 rather than
 * at "Finish setup" four steps later. The same count of wrong codes as the real thing.
 */
router.post('/setup/code', (req, res, next) => {
  try {
    setupService.assertNotComplete();
    setupService.assertSetupCode((req.body || {}).setupCode);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * TASK-057: the store already exists, on a computer that died. The body is the backup
 * file's bytes; its name and this computer's backup folder ride in the query, since
 * the body is not JSON. Refused before a byte is read once the installation has a
 * store, so it is reachable exactly as long as `POST /setup` is.
 */
const beforeSetup = (req, res, next) => {
  try {
    setupService.assertNotComplete();
    // TASK-062: a hosted copy's code, checked before a byte of the upload is read. In a
    // header rather than the query string, so it is not written into an access log.
    setupService.assertSetupCode(req.get('x-setup-code'));
    next();
  } catch (err) {
    next(err);
  }
};

router.post('/setup/restore', beforeSetup, receiveFile(), (req, res, next) => {
  try {
    res.status(201).json(restoreService.restoreAtSetup({
      archivePath: req.file.path,
      fileName: req.query.fileName || null,
      backupFolder: req.query.backupFolder,
    }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
