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
 * AUD-603: the second actor on a request is who an approval proves, never who the body
 * says. A body naming an `approver` must carry that approver's `token` from
 * POST /auth/approve; it is checked here, against this session, and the body's
 * approver is replaced by the verified one — id, username and the role stored now — so
 * no route or service downstream can read a claimed name or role. A bare `approverRole`
 * is a claim of the same kind and is dropped; the pricing preview reads the role from
 * the approver instead.
 *
 * One approval, one action: it is spent as the request starts, and given back only if
 * the request is refused, so a mistyped reason does not send the manager back to the
 * counter.
 */
function provenApprover(req, res) {
  const body = req.body;
  if (!body || typeof body !== 'object') return;
  delete body.approverRole;
  if (body.approver === null || body.approver === undefined) return;

  const approval = authService.verifyApproval(body.approver && body.approver.token, req.session);
  const reason = body.approver && typeof body.approver.reason === 'string' ? body.approver.reason : undefined;
  // `rules`: what the approver was shown and agreed to (TASK-060), for the rules that ask.
  body.approver = {
    id: approval.id, username: approval.username, role: approval.role, rules: approval.rules,
    ...(reason ? { reason } : {}),
  };

  const giveBack = authService.spendApproval(approval);
  res.on('finish', () => { if (res.statusCode >= 400) giveBack(); });
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
    provenApprover(req, res);
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
 * A list is any one of them (TASK-056). The counter's own reads — look an item up, see
 * its stock and picture, know which shift is open — are the inventory clerk's by TX-422
 * and the cashier's by TX-401: a cashier who unlocked with a PIN is scoped to the
 * counter (SEC-2) and must still be able to sell, without the PIN reaching the
 * inventory reports TX-422 also opens. A refusal names the first, the route's own.
 *
 * A refusal is audited (SEC-6). The row names the transaction that was refused, which
 * is what makes an attempt to reach a forbidden route visible afterwards rather than
 * merely blocked at the time.
 */
function requirePermission(txIds, { level = null } = {}) {
  const list = Array.isArray(txIds) ? txIds : [txIds];
  list.forEach((id) => permissions.assertKnown(id));
  const txId = list[0];

  return function check(req, res, next) {
    try {
      if (!req.session) throw errors.unauthorized('Sign in to continue.', { ruleId: 'SEC-7' });

      if (list.some((id) => permissions.can(req.session, id, level))) return next();

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
