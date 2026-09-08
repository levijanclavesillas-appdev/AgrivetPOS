'use strict';

// 05_TECH_SPEC.md §4:
//
//   POST /shifts/open        TX-418   POS-502
//   POST /shifts/:id/till    TX-420   POS-504
//   GET  /shifts/:id/expected TX-418  POS-509
//
// GET /shifts/current, /shifts/:id and /shifts/meta/till-reasons are not in §4's table
// — add the rows. SCR-501 and SCR-502 need each of them, and the reason list is served
// rather than hard-coded because POS-504's list is a setting (OPS-005).
//
// TX-419 — closing another user's shift — belongs to TASK-013 along with the close
// itself; nothing here closes a shift.

const express = require('express');
const shiftService = require('../services/shiftService');
const errors = require('../services/errors');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ownShift = [authenticate, requirePermission('TX-418')];
const moveTillCash = [authenticate, requirePermission('TX-420')];

/** What SCR-301 asks before it will show a cart at all (POS-501). */
router.get('/shifts/current', ownShift, (req, res, next) => {
  try {
    const shift = shiftService.openShiftFor(req.session.id);
    res.json({
      open: Boolean(shift),
      shift: shift ? shiftService.present(shift) : null,
      expected: shift ? shiftService.computeExpected(shift.id) : null,
    });
  } catch (err) {
    next(err);
  }
});

/** POS-508's alert, so the dashboard can raise it without deriving the rule again. */
router.get('/shifts/alerts', ownShift, (req, res, next) => {
  try {
    res.json({ alerts: shiftService.alerts() });
  } catch (err) {
    next(err);
  }
});

router.get('/shifts/meta/till-reasons', moveTillCash, (req, res, next) => {
  try {
    res.json({ reasons: shiftService.tillReasons(), methods: shiftService.METHODS });
  } catch (err) {
    next(err);
  }
});

router.post('/shifts/open', ownShift, (req, res, next) => {
  try {
    const { openingFloatCentavos, confirmed } = req.body || {};
    const result = shiftService.open({
      actor: req.session, openingFloatCentavos, confirmed: confirmed === true,
    });

    // POS-502: a second attempt resumes rather than creating a second shift, so it is
    // a 200 on the existing one, not a 201 and not a conflict.
    //
    // The expected figure comes back with it, as it does from a till movement: SCR-501
    // shows the drawer immediately after opening, and a resumed shift has a figure
    // that is not the float it was opened with.
    res.status(result.resumed ? 200 : 201).json({
      ...result,
      expected: shiftService.computeExpected(result.shift.id),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/shifts/:id', ownShift, (req, res, next) => {
  try {
    res.json(shiftService.get(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.get('/shifts/:id/expected', ownShift, (req, res, next) => {
  try {
    // A pure read (the task's constraint), so the screen may call it after every
    // change without anything being written as a side effect of looking.
    res.json(shiftService.computeExpected(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post('/shifts/:id/till', moveTillCash, (req, res, next) => {
  try {
    const { direction, amountCentavos, reason, notes = null } = req.body || {};
    res.status(201).json(shiftService.moveTillCash({
      shiftId: req.params.id, direction, amountCentavos, reason, notes, actor: req.session,
    }));
  } catch (err) {
    next(err);
  }
});

// POS-511: a closed shift is immutable, and TASK-013 owns closing. The absence of a
// close route here is deliberate rather than pending — this one says so.
router.post('/shifts/:id/close', ownShift, (req, res, next) => {
  next(errors.conflict(
    'Closing a shift arrives with the close-and-variance screen (SCR-503).',
    { ruleId: 'POS-510' }
  ));
});

module.exports = router;
