'use strict';

// Routes parse, authorise, delegate and serialise. No SQL, no business rule
// (05_TECH_SPEC.md §8.1, §8.2).
//
// /health carries no TX-* permission (05_TECH_SPEC.md §4): main.js polls it before
// the window opens, so it must answer before anyone has authenticated.

const express = require('express');
const healthService = require('../services/healthService');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();

/**
 * Liveness, unauthenticated, deliberately thin.
 *
 * A status, a version and nothing about the store. OPS-006's six figures are on
 * /health/panel behind TX-428 — an unauthenticated caller on the loopback has no
 * business learning how many sales the store has taken.
 */
router.get('/health', (req, res, next) => {
  try {
    res.json(healthService.liveness());
  } catch (err) {
    next(err);
  }
});

/** SCR-705 — OPS-006's six figures. */
router.get('/health/panel', [authenticate, requirePermission('TX-428')], (req, res, next) => {
  try {
    res.json(healthService.panel());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
