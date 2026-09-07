'use strict';

// User administration. TX-423 is owner-only, and the check is here on every route
// rather than inferred from the renderer hiding the menu (SEC-6).

const express = require('express');
const userService = require('../services/userService');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const manageUsers = [authenticate, requirePermission('TX-423')];

router.get('/users', manageUsers, (req, res, next) => {
  try {
    res.json({ users: userService.list({ includeInactive: req.query.includeInactive === 'true' }) });
  } catch (err) {
    next(err);
  }
});

router.get('/users/:id', manageUsers, (req, res, next) => {
  try {
    res.json({ user: userService.get(req.params.id) });
  } catch (err) {
    next(err);
  }
});

router.post('/users', manageUsers, (req, res, next) => {
  try {
    const { username, fullName, password, role, pin } = req.body || {};
    const user = userService.create({ username, fullName, password, role, pin }, req.session);
    res.status(201).json({ user });
  } catch (err) {
    next(err);
  }
});

router.put('/users/:id', manageUsers, (req, res, next) => {
  try {
    res.json({ user: userService.update(req.params.id, req.body || {}, req.session) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
