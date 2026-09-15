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

// AUD-603: a manager approves at the cashier's screen with their own password. The
// answer is an approval for this session's next action, not a session of their own —
// the cashier's screen never holds the manager's sign-in.
router.post('/auth/approve', authenticate, (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    res.json(authService.approve({ username, password }, req.session));
  } catch (err) {
    next(err);
  }
});

// TASK-058: a person's own sign-in. No TX-*: every role has a password of its own, and
// the service proves it again before changing anything — and refuses a PIN session.
router.post('/auth/password', authenticate, (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    res.json(authService.changePassword({ currentPassword, newPassword }, req.session));
  } catch (err) {
    next(err);
  }
});

router.post('/auth/pin', authenticate, (req, res, next) => {
  try {
    const { currentPassword, pin } = req.body || {};
    res.json(authService.changePin({ currentPassword, newPin: pin }, req.session));
  } catch (err) {
    next(err);
  }
});

// The new code is in this response and nowhere else, like the one at setup (SEC-5).
router.post('/auth/recovery-code', authenticate, (req, res, next) => {
  try {
    res.json(authService.renewRecoveryCode({ password: (req.body || {}).password }, req.session));
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
