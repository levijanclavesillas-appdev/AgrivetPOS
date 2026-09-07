'use strict';

// Categories, brands and units. Reading them is part of reading the catalog (TX-422);
// changing them is part of editing a product (TX-410).
//
// There is no DELETE on any of these routes. VR-206 is enforced by the absence of the
// path, not by a check inside one — the same reasoning as AUD-605.

const express = require('express');
const referenceService = require('../services/referenceService');
const errors = require('../services/errors');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const readCatalog = [authenticate, requirePermission('TX-422')];
const editCatalog = [authenticate, requirePermission('TX-410')];

const KINDS = ['categories', 'brands', 'units'];

/** One set of handlers for three tables with the same shape. */
for (const kind of KINDS) {
  router.get(`/${kind}`, readCatalog, (req, res, next) => {
    try {
      res.json({ [kind]: referenceService.list(kind, { includeInactive: req.query.includeInactive === 'true' }) });
    } catch (err) {
      next(err);
    }
  });

  router.post(`/${kind}`, editCatalog, (req, res, next) => {
    try {
      res.status(201).json({ [kind.replace(/ies$/, 'y').replace(/s$/, '')]: referenceService.create(kind, req.body || {}, req.session) });
    } catch (err) {
      next(err);
    }
  });

  router.put(`/${kind}/:id`, editCatalog, (req, res, next) => {
    try {
      res.json({ [kind.replace(/ies$/, 'y').replace(/s$/, '')]: referenceService.update(kind, req.params.id, req.body || {}, req.session) });
    } catch (err) {
      next(err);
    }
  });

  // VR-206: the only removal is deactivation, and it is spelled that way in the URL so
  // nobody reaches for DELETE expecting it to work.
  router.post(`/${kind}/:id/deactivate`, editCatalog, (req, res, next) => {
    try {
      res.json({ [kind.replace(/ies$/, 'y').replace(/s$/, '')]: referenceService.deactivate(kind, req.params.id, req.session) });
    } catch (err) {
      next(err);
    }
  });

  router.delete(`/${kind}/:id`, editCatalog, (req, res, next) => {
    next(errors.conflict(
      'Categories, brands and units are not deleted — history references them. Deactivate it instead.',
      { ruleId: 'VR-206' }
    ));
  });
}

module.exports = router;
