'use strict';

// SCR-702 and the store profile. TX-424 opens the door; the tax mode has its own
// permission (TX-425) and its own route, because folding it into a general settings
// write would let a TX-424 holder change it as a side effect of editing an address.

const express = require('express');
const settingsService = require('../services/settingsService');
const storeProfileService = require('../services/storeProfileService');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const changeSettings = [authenticate, requirePermission('TX-424')];
const changeTaxMode = [authenticate, requirePermission('TX-425')];

router.get('/settings', changeSettings, (req, res, next) => {
  try {
    res.json({
      groups: settingsService.GROUPS,
      settings: settingsService.describe(),
    });
  } catch (err) {
    next(err);
  }
});

// One save is one transaction; settingsService.setMany owns it (05_TECH_SPEC.md §8.3
// — a route never opens a transaction, asserted by TC-UT-99).
router.put('/settings', changeSettings, (req, res, next) => {
  try {
    const body = (req.body && req.body.settings) || req.body || {};
    const reason = typeof body.reason === 'string' ? body.reason : null;
    const results = settingsService.setMany(body, req.session, { reason });

    res.json({
      changed: results.filter((r) => r.changed).map((r) => r.key),
      settings: settingsService.describe(),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/store-profile', changeSettings, (req, res, next) => {
  try {
    res.json({ profile: storeProfileService.profile(), tax_modes: storeProfileService.TAX_MODES });
  } catch (err) {
    next(err);
  }
});

router.put('/store-profile', changeSettings, (req, res, next) => {
  try {
    res.json({ profile: storeProfileService.update(req.body || {}, req.session) });
  } catch (err) {
    next(err);
  }
});

// TAX-001: owner only, audited with both values.
router.put('/store-profile/tax-mode', changeTaxMode, (req, res, next) => {
  try {
    const { taxMode, reason } = req.body || {};
    const result = storeProfileService.setTaxMode(taxMode, req.session, { reason });
    res.json({ profile: result.profile, changed: result.changed });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
