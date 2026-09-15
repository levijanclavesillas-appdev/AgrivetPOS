'use strict';

// TASK-063 — what a store's device may do without its web copy.
//
// The owner chose (2026-09-15): the counter, the stockroom and customers work offline —
// selling, payments on account, returns, cash in and out, shifts, receiving deliveries,
// adjustments, counts, purchase orders, adding and editing customers. What defines the
// store for every device — its products and prices, its users and their sign-in, its
// settings and profile, and loading another source's data — waits for a connection, so
// two devices offline cannot give one product two prices.
//
// Connected, a device writes to its own database like any other and syncs straight after.

const errors = require('../services/errors');
const syncService = require('../services/syncService');
const syncClient = require('../services/syncClient');

const NEEDS_THE_WEB = Object.freeze([
  /^\/products(\/|$)/,
  /^\/(categories|brands|units)(\/|$)/,
  /^\/users(\/|$)/,
  /^\/settings(\/|$)/,
  /^\/store-profile(\/|$)/,
  /^\/customers\/[^/]+\/prices$/,
  /^\/data\/(import|opening)(\/|$)/,
  /^\/auth\/(password|pin|recovery-code)$/,
]);

const writes = (req) => !['GET', 'HEAD', 'OPTIONS'].includes(req.method);

function offlinePolicy(req, res, next) {
  if (!writes(req) || !syncService.isDevice()) return next();
  if (NEEDS_THE_WEB.some((rule) => rule.test(req.path)) && !syncClient.reachable()) {
    return next(errors.conflict(
      'This needs a connection to the store\'s web copy: products, prices, users and settings are '
      + 'changed with every device connected, so no two can disagree. Selling, stock and customers '
      + 'work offline.',
      { ruleId: 'SYNC-005' }
    ));
  }
  return next();
}

/** After a write on a device, sync soon rather than at the next tick. */
function nudgeAfterWrite(req, res, next) {
  if (writes(req) && syncService.isDevice()) {
    res.on('finish', () => { if (res.statusCode < 400) syncClient.nudge(); });
  }
  next();
}

module.exports = { NEEDS_THE_WEB, offlinePolicy, nudgeAfterWrite };
