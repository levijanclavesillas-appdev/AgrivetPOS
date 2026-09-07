'use strict';

// TASK-004 requirement 1: on an empty database the application serves only the
// wizard, and no other route or screen is reachable.
//
// This is a gate, not a redirect. A renderer that shows the wizard is a courtesy; the
// server refusing every other route is the guarantee — the same reasoning as SEC-6,
// applied to configuration rather than to permission. Without it, a half-configured
// installation is reachable through a hand-crafted request, and every route below
// would need its own "is there a store profile yet" check.

const errors = require('../services/errors');
const setupService = require('../services/setupService');

/**
 * Routes reachable before setup finishes.
 *
 *  /setup   — the wizard itself, or there is no way out of this state.
 *  /health  — main.js polls it before the window opens (05_TECH_SPEC.md §4), so it
 *             must answer on an unconfigured database too. It reports schema and row
 *             counts, which on a fresh install are zeros.
 */
const OPEN_PATHS = Object.freeze(['/setup', '/health']);

const isOpen = (urlPath) => OPEN_PATHS.some((open) => urlPath === open || urlPath.startsWith(`${open}/`));

/**
 * Refuse everything but the wizard while setup is outstanding.
 *
 * Mounted at the API base, so `req.path` is already relative to `/api/v1`.
 */
function requireSetup(req, res, next) {
  if (isOpen(req.path)) return next();
  if (setupService.isComplete()) return next();

  return next(errors.setupRequired(
    'This installation is not set up yet. Finish the setup wizard before using the application.'
  ));
}

module.exports = { OPEN_PATHS, isOpen, requireSetup };
