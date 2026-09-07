'use strict';

// SEC-6: authorisation is server-side, on every route, without exception. The
// renderer's hidden buttons are cosmetic; a hand-crafted request to a forbidden route
// is refused with 403 and audited.

const errors = require('../services/errors');
const authService = require('../services/authService');
const auditService = require('../services/auditService');
const permissions = require('../services/permissions');

const SESSION_HEADER = 'X-Session-Token';

function bearerToken(req) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  return scheme && scheme.toLowerCase() === 'bearer' && token ? token.trim() : null;
}

/**
 * Verify the session and re-issue it.
 *
 * The re-issue is what makes FR_1.2's "idle timeout" an idle one: every authenticated
 * request extends the window, so a cashier working steadily is never signed out
 * mid-sale, while one who walks away is locked out on schedule. The renderer replaces
 * its in-memory token from this header (SEC-7) and never stores it.
 */
function authenticate(req, res, next) {
  try {
    const token = bearerToken(req);
    if (!token) throw errors.unauthorized('Sign in to continue.', { ruleId: 'SEC-7' });

    const session = authService.verifyToken(token);
    req.session = session;
    res.set(SESSION_HEADER, authService.issueToken({
      user: { id: session.id, username: session.username, role: session.role },
      scope: session.scope,
      shiftId: session.shiftId,
    }));
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Require a TX-* permission. `level` demands a specific grant, so a route that writes
 * refuses a role holding only VIEW.
 *
 * A refusal is audited (SEC-6). The row names the transaction that was refused, which
 * is what makes an attempt to reach a forbidden route visible afterwards rather than
 * merely blocked at the time.
 */
function requirePermission(txId, { level = null } = {}) {
  permissions.assertKnown(txId);

  return function check(req, res, next) {
    try {
      if (!req.session) throw errors.unauthorized('Sign in to continue.', { ruleId: 'SEC-7' });

      if (permissions.can(req.session, txId, level)) return next();

      const pinBlocked = req.session.scope === 'PIN' && !permissions.PIN_SCOPE.includes(txId);
      const holders = permissions.rolesHolding(txId, level);

      auditService.write({
        actor: { id: req.session.id, username: req.session.username },
        action: 'PERMISSION_REFUSED',
        entityType: 'permission',
        entityId: txId,
        after: { route: `${req.method} ${req.originalUrl}`, role: req.session.role, scope: req.session.scope },
        reason: pinBlocked ? 'PIN session is scoped to the counter (SEC-2)' : `Role lacks ${txId}`,
        shiftId: req.session.shiftId,
      });

      return next(errors.forbidden(
        pinBlocked
          ? `A PIN session cannot ${permissions.describe(txId).toLowerCase()}. Sign in with your password.`
          : `You do not have permission to ${permissions.describe(txId).toLowerCase()}.`,
        { ruleId: pinBlocked ? 'SEC-2' : txId, requiresRole: holders.join(' or ') || null }
      ));
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { SESSION_HEADER, authenticate, requirePermission, bearerToken };
