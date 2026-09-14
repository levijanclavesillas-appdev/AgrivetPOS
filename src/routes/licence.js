'use strict';

// The store's subscription — TASK-048.
//
//   GET  /licence              any signed-in user: the state, so every screen can warn
//   POST /licence/link         the owner: ask the licence server for a code (LIC-004)
//   POST /licence/link/poll    the owner: has it been approved yet?
//   POST /licence/renew        the owner: "Check now"

const express = require('express');
const licenceService = require('../services/licenceService');
const storeProfileService = require('../services/storeProfileService');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const owner = [authenticate, requirePermission('TX-424')];

router.get('/licence', authenticate, (req, res, next) => {
  try {
    res.json(licenceService.state());
  } catch (err) {
    next(err);
  }
});

router.post('/licence/link', owner, async (req, res, next) => {
  try {
    const profile = storeProfileService.profile();
    res.json(await licenceService.startLink(req.session, {
      storeName: profile ? profile.store_name : null,
      appVersion: require('../../package.json').version,
    }));
  } catch (err) {
    next(err);
  }
});

router.post('/licence/link/poll', owner, async (req, res, next) => {
  try {
    res.json(await licenceService.pollLink(req.session));
  } catch (err) {
    next(err);
  }
});

router.post('/licence/renew', owner, async (req, res, next) => {
  try {
    res.json(await licenceService.renew(req.session));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
