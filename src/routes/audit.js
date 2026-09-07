'use strict';

// SCR-703 — browse and export the trail, under TX-429.
//
// Read-only by construction: there is no POST, no PUT and no DELETE here, because
// AUD-605 gives the trail no application path that changes it. Rows arrive through
// the services that cause them, never through this route.

const express = require('express');
const auditService = require('../services/auditService');
const auditRepository = require('../repositories/auditRepository');
const clock = require('../config/clock');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const viewAudit = [authenticate, requirePermission('TX-429')];

const filtersFrom = (query) => ({
  actorId: query.actor || null,
  actorUsername: query.actorUsername || null,
  action: query.action || null,
  entityType: query.entity || null,
  entityId: query.entityId || null,
  from: query.from || null,
  to: query.to || null,
});

router.get('/audit', viewAudit, (req, res, next) => {
  try {
    const page = auditService.browse({
      ...filtersFrom(req.query),
      limit: req.query.limit,
      offset: req.query.offset,
    });

    res.json({
      ...page,
      // What SCR-703's two dropdowns are built from, so the screen does not have to
      // hard-code an action list that would drift from ACTIONS the first time one is
      // added.
      actions: auditService.ACTION_NAMES.map((name) => ({ value: name, label: auditService.describe(name) })),
      actors: auditRepository.actors(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * The same query as the browse above, as a CSV download.
 *
 * `GET /audit` is in 05_TECH_SPEC.md §4's table; `/audit/export` is not — add the row.
 * SCR-703 specifies an export beside the filters (04_UX_SPEC.md §3), and TX-426 is
 * not the permission for it: exporting the trail is reading the trail, so it sits
 * under TX-429 with the browse rather than under the general data-export grant.
 *
 * The export is itself audited (AUD-601 lists data export), which is not a formality:
 * the audit trail is the most sensitive read in the product — it carries who did what
 * and when for every user — and a copy of it leaving the machine is exactly the event
 * somebody would later want to find.
 */
router.get('/audit/export', viewAudit, (req, res, next) => {
  try {
    const filters = filtersFrom(req.query);
    const result = auditService.exportCsv(filters);

    auditService.write({
      actor: req.session,
      action: 'AUDIT_EXPORTED',
      entityType: 'audit_logs',
      after: { rows: result.rowCount, filters, capped: result.capped },
      reason: 'Audit trail exported from SCR-703',
      shiftId: req.session.shiftId,
    });

    const stamp = clock.manilaDate(clock.nowUtc());
    res.set('content-type', 'text/csv; charset=utf-8');
    res.set('content-disposition', `attachment; filename="audit-${stamp}.csv"`);
    res.send(result.csv);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
