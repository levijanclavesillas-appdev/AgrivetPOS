'use strict';

// Routes parse, authorise, delegate and serialise. No SQL, no business rule
// (05_TECH_SPEC.md §8.1, §8.2).
//
// /health carries no TX-* permission (05_TECH_SPEC.md §4): main.js polls it before
// the window opens, so it must answer before anyone has authenticated.

const express = require('express');
const healthService = require('../services/healthService');

const router = express.Router();

router.get('/health', (req, res, next) => {
  try {
    res.json(healthService.health());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
