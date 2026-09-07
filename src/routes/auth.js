'use strict';

// Routes parse, authorise, delegate and serialise (05_TECH_SPEC.md §8.2).
//
// Login, PIN unlock and recovery carry no TX-* permission: nobody is authenticated yet
// when they are called. Each rate-limits itself on the account (SEC-3, SEC-5).

const express = require('express');
const authService = require('../services/authService');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.post('/auth/login', (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    res.json(authService.login({ username, password }));
  } catch (err) {
    next(err);
  }
});

router.post('/auth/pin-unlock', (req, res, next) => {
  try {
    const { username, pin } = req.body || {};
    res.json(authService.pinUnlock({ username, pin }));
  } catch (err) {
    next(err);
  }
});

router.post('/auth/recover', (req, res, next) => {
  try {
    const { username, recoveryCode, newPassword } = req.body || {};
    // The replacement code is in this response and nowhere else — it is shown once and
    // is not recoverable afterwards (SEC-5).
    res.json(authService.recover({ username, recoveryCode, newPassword }));
  } catch (err) {
    next(err);
  }
});

// Who am I. Not in 05_TECH_SPEC.md §4's table — add the row: the renderer must not
// decode a token to learn its own role, and TASK-015 needs this to choose a landing
// screen (04_UX_SPEC.md §2).
router.get('/auth/session', authenticate, (req, res) => {
  res.json({ session: req.session });
});

module.exports = router;
