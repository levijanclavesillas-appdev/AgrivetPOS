'use strict';

// SCR-001. Two routes, neither authenticated: they run before any user exists, which
// is the only reason a route in this product carries no TX-* (05_TECH_SPEC.md §4).
//
// POST /setup is self-limiting rather than unprotected — it refuses once the
// installation has a store profile and an active owner, so it is reachable exactly
// once in the life of a database.

const express = require('express');
const setupService = require('../services/setupService');

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
    const { store, taxMode, owner, backupFolder, acknowledgedRecoveryCode } = req.body || {};
    const result = setupService.complete({ store, taxMode, owner, backupFolder, acknowledgedRecoveryCode });

    // SEC-5: the recovery code is in this response and in no other. It is not stored
    // in plaintext, not logged, and cannot be requested again.
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
