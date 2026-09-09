'use strict';

// FR_1.5 / AUD-601–AUD-606 — the one audit-writing path in the product.
//
// It is one service so that no later task invents its own logging. Two decisions here
// are the reason this task exists before the ten tasks that call it:
//
//   AUD-603 — an override records the requesting user and the approving user as two
//   distinct actors. A single actor column would make every override in the product
//   unattributable, and adding the second one after ten tasks have written rows is a
//   migration plus a backfill nobody can do honestly.
//
//   AUD-606 — the username is denormalised onto the row, so deactivating a user does
//   not blank their history.
//
// The trail is append-only (AUD-605). auditRepository has no update and no delete, and
// SEC-11 makes that absence the control rather than a convention.

const ids = require('../config/ids');
const clock = require('../config/clock');
const errors = require('./errors');
const auditRepository = require('../repositories/auditRepository');

/**
 * Every action AUD-601, AUD-602, AUD-603 and AUD-604 name, as a constant.
 *
 * Requirement 2: a caller passing a bare string can typo one into a second, silent
 * action name that no filter and no report will ever find. `write` refuses an action
 * that is not in this table, so the typo fails at the call rather than in six months
 * when somebody searches the trail for it.
 *
 * The `what` text is what SCR-703 lists in its action filter — an operator browsing
 * the trail should not have to read SCREAMING_SNAKE_CASE.
 */
const ACTIONS = Object.freeze({
  // ── AUD-601: catalog and pricing ──────────────────────────────────────────
  PRICE_CHANGED: { what: 'Selling price changed', rule: 'AUD-601' },
  COST_CHANGED: { what: 'Product cost changed', rule: 'AUD-601' },
  DISCOUNT_RULE_CHANGED: { what: 'Discount rule changed', rule: 'AUD-601' },
  PRODUCT_CREATED: { what: 'Product created', rule: 'AUD-601' },
  PRODUCT_MODIFIED: { what: 'Product modified', rule: 'AUD-601' },
  PRODUCT_DEACTIVATED: { what: 'Product deactivated', rule: 'VR-206' },
  BARCODE_ATTACHED: { what: 'Barcode attached to a product', rule: 'VR-205' },
  BARCODE_DETACHED: { what: 'Barcode detached from a product', rule: 'VR-205' },
  // Categories, brands and units. Not on AUD-601's list — they are reference data,
  // not a mutation of money or stock — but a renamed category silently re-labels every
  // report that groups by it, so the change is recorded rather than invisible.
  REFERENCE_DATA_CHANGED: { what: 'Category, brand or unit changed', rule: 'VR-209' },

  // ── AUD-601: inventory ────────────────────────────────────────────────────
  INVENTORY_ADJUSTED: { what: 'Inventory adjusted', rule: 'AUD-601' },
  STOCK_COUNT_POSTED: { what: 'Stock count posted', rule: 'AUD-601' },

  // ── AUD-601: sales ────────────────────────────────────────────────────────
  SALE_VOIDED: { what: 'Sale voided', rule: 'AUD-601' },
  SALE_RETURNED: { what: 'Return processed', rule: 'AUD-601' },
  RECEIPT_REPRINTED: { what: 'Receipt reprinted', rule: 'AUD-601' },

  // ── AUD-601: credit ───────────────────────────────────────────────────────
  CREDIT_LIMIT_CHANGED: { what: 'Credit limit changed', rule: 'AUD-601' },
  BALANCE_WRITTEN_OFF: { what: 'Balance written off', rule: 'AUD-601' },
  // Not on AUD-601's list — a customer record is not a mutation of money or stock.
  // Recorded anyway: a renamed or merged farm re-labels every statement that has
  // ever been issued to it, and deactivating one hides a debt from the screens that
  // filter to active customers (VR-305).
  CUSTOMER_CREATED: { what: 'Customer created', rule: 'VR-301' },
  CUSTOMER_MODIFIED: { what: 'Customer modified', rule: 'VR-301' },
  CUSTOMER_DEACTIVATED: { what: 'Customer deactivated', rule: 'VR-304' },
  // Not on AUD-601's list — a collection is not a mutation of a rule-governed figure,
  // it is the ordinary business of getting paid. Recorded because CR-205 makes a cash
  // collection till cash: it moves the drawer, and every peso that moves the drawer
  // needs a name against it when the close comes up short.
  COLLECTION_RECORDED: { what: 'Collection recorded', rule: 'CR-201' },
  CREDIT_ADJUSTED: { what: 'Credit balance adjusted', rule: 'CR-103' },

  // ── AUD-601: purchasing (FT-501–FT-504) ───────────────────────────────────
  //
  // A goods receipt is a cost change: PO-203 moves the average cost at the actual
  // received price, and AUD-601 names "cost change" explicitly. The others are not on
  // the rule's list and are recorded anyway — PO-104 says a PENDING order is amended
  // by a revision rather than overwritten, and the trail is where the superseded lines
  // live, so a supplier holding a printed rev 1 can be reconciled against rev 2.
  SUPPLIER_CREATED: { what: 'Supplier created', rule: 'VR-401' },
  SUPPLIER_MODIFIED: { what: 'Supplier modified', rule: 'VR-401' },
  SUPPLIER_DEACTIVATED: { what: 'Supplier deactivated', rule: 'VR-401' },
  PURCHASE_ORDER_CREATED: { what: 'Purchase order raised', rule: 'PO-101' },
  PURCHASE_ORDER_MODIFIED: { what: 'Purchase order edited in draft', rule: 'PO-104' },
  PURCHASE_ORDER_AMENDED: { what: 'Purchase order amended to a new revision', rule: 'PO-104' },
  PURCHASE_ORDER_SUBMITTED: { what: 'Purchase order sent to the supplier', rule: 'PO-102' },
  PURCHASE_ORDER_CANCELLED: { what: 'Purchase order cancelled', rule: 'PO-102' },
  GOODS_RECEIVED: { what: 'Goods received', rule: 'AUD-601' },

  // ── AUD-601: users and access ─────────────────────────────────────────────
  USER_CREATED: { what: 'User created', rule: 'AUD-601' },
  USER_MODIFIED: { what: 'User modified', rule: 'AUD-601' },
  USER_DEACTIVATED: { what: 'User deactivated', rule: 'AUD-601' },
  ROLE_CHANGED: { what: 'Role changed', rule: 'AUD-601' },
  PERMISSION_CHANGED: { what: 'Permission changed', rule: 'AUD-601' },
  PASSWORD_RESET: { what: 'Password reset', rule: 'AUD-601' },
  OWNER_PASSWORD_RECOVERED: { what: 'Owner password recovered offline', rule: 'AUD-604' },
  LOGIN_LOCKED: { what: 'Account locked after failed sign-ins', rule: 'AUD-601' },

  // SEC-6 rather than AUD-601: a refusal is not a mutation, but an attempt to reach a
  // forbidden route is exactly what an audit trail is read for afterwards.
  PERMISSION_REFUSED: { what: 'Permission refused', rule: 'SEC-6' },

  // ── AUD-601: configuration ────────────────────────────────────────────────
  TAX_MODE_CHANGED: { what: 'Tax mode changed', rule: 'AUD-601' },
  SETTING_CHANGED: { what: 'Setting changed', rule: 'AUD-601' },
  STORE_PROFILE_CHANGED: { what: 'Store profile changed', rule: 'AUD-601' },
  INSTALLATION_SET_UP: { what: 'Installation set up', rule: 'FR_1.1' },

  // ── AUD-601: data and operations ──────────────────────────────────────────
  DATA_IMPORTED: { what: 'Data imported', rule: 'AUD-605' },
  DATA_EXPORTED: { what: 'Data exported', rule: 'AUD-601' },
  BACKUP_RESTORED: { what: 'Backup restored', rule: 'AUD-601' },
  // OPS-002: a backup that did not happen is a fact worth keeping, and the one an
  // owner asks about after the fact. Failure is recorded; success is the log table's
  // job, because a row per successful backup would drown the trail people read.
  BACKUP_FAILED: { what: 'Backup failed or failed verification', rule: 'OPS-002' },
  // OPS-009: the clock moved backwards past the last recorded transaction.
  CLOCK_ANOMALY: { what: 'System clock earlier than the last recorded transaction', rule: 'OPS-009' },
  AUDIT_EXPORTED: { what: 'Audit trail exported', rule: 'AUD-601' },

  // ── AUD-602: the till ─────────────────────────────────────────────────────
  SHIFT_CLOSED_WITH_VARIANCE: { what: 'Shift closed with a variance beyond tolerance', rule: 'AUD-602' },
  // Not on AUD-601's list, and recorded anyway: POS-509 measures the close against the
  // opening float, and every peso moved in or out of the drawer between the two is part
  // of that arithmetic. A variance nobody can explain is a variance nobody can explain
  // *because* the movements behind it were not recorded with a name on them.
  SHIFT_OPENED: { what: 'Shift opened', rule: 'POS-503' },
  SHIFT_CLOSED: { what: 'Shift closed', rule: 'POS-510' },
  TILL_CASH_MOVED: { what: 'Till cash moved in or out', rule: 'POS-504' },

  // ── AUD-603: the six overrides, each two-actor ────────────────────────────
  OVERRIDE_DISCOUNT_ABOVE_CEILING: { what: 'Discount above ceiling authorised', rule: 'AUD-603', override: true },
  OVERRIDE_CREDIT_OVER_LIMIT: { what: 'Over-limit credit sale authorised', rule: 'AUD-603', override: true },
  OVERRIDE_BELOW_COST_SALE: { what: 'Below-cost sale authorised', rule: 'AUD-603', override: true },
  OVERRIDE_EXPIRED_STOCK_SALE: { what: 'Expired-stock sale authorised', rule: 'AUD-603', override: true },
  OVERRIDE_OVER_RECEIPT: { what: 'Over-receipt authorised', rule: 'AUD-603', override: true },
  OVERRIDE_COST_VARIANCE: { what: 'Cost variance authorised', rule: 'AUD-603', override: true },
  // POS-304 and POS-307. The first is the one worth reading a trail for: it is the
  // row that says a medicine went back on the shelf, and who said it could.
  OVERRIDE_RESTOCK_AGAINST_DEFAULT: { what: 'Restock against the write-off default authorised', rule: 'AUD-603', override: true },
  OVERRIDE_LATE_RETURN: { what: 'Return beyond the window authorised', rule: 'AUD-603', override: true },
  // POS-403. The only override in this list that is required on *every* occurrence
  // rather than on an exception — a cashier may never void unaided.
  OVERRIDE_SALE_VOID: { what: 'Sale void authorised', rule: 'AUD-603', override: true },
});

const ACTION_NAMES = Object.freeze(Object.keys(ACTIONS));
const OVERRIDE_ACTIONS = Object.freeze(ACTION_NAMES.filter((name) => ACTIONS[name].override));

function isKnownAction(action) {
  return Object.prototype.hasOwnProperty.call(ACTIONS, action);
}

function assertKnownAction(action) {
  if (!isKnownAction(action)) {
    // A programming error, not a refusal an operator can act on: the caller named an
    // action that does not exist, and a row written under it would be invisible to
    // every filter SCR-703 offers.
    throw new RangeError(`unknown audit action: ${action} (add it to auditService.ACTIONS)`);
  }
  return action;
}

/** The human label SCR-703 shows for an action. */
function describe(action) {
  assertKnownAction(action);
  return ACTIONS[action].what;
}

// ── Redaction (SEC-1, requirement 3) ────────────────────────────────────────

const REDACTED = '[redacted]';

/**
 * Key names whose value is a credential by definition.
 *
 * Matched on the whole key or its last underscore-separated part, deliberately, so
 * that `password_changed: true` and `pin_set: true` survive — those record *that* a
 * credential moved, which AUD-601 wants, without recording the credential.
 */
const SECRET_KEY = /(^|_)(hash|password|passwd|pin|pincode|token|secret|salt|apikey|key)$/i;
const SECRET_KEY_WHOLE = /^(recovery_code|session_token|access_token|refresh_token|jwt)$/i;

/** Value shapes that are a credential whatever they are called. */
// Deliberately looser than bcrypt's exact 53-character tail: a value that is *nearly*
// a hash is still a credential, and the point of this net is to catch the one that
// arrived somewhere nobody expected.
const BCRYPT = /^\$2[aby]?\$\d{2}\$[./A-Za-z0-9]{20,}$/;
const JWT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
const RECOVERY_CODE = /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/;

const MAX_DEPTH = 8;

function looksSecret(value) {
  if (typeof value !== 'string') return false;
  return BCRYPT.test(value) || JWT.test(value) || RECOVERY_CODE.test(value);
}

/**
 * Strip credentials from a before/after payload — in the service, not in each caller.
 *
 * Requirement 3 puts this here for one reason: a caller that has to remember to strip
 * is a caller that will one day forget, and the row it forgets on is written, kept
 * forever and never deleted (AUD-605). The two nets are complementary — the key net
 * catches a hash stored under its own name, the value net catches one that arrived
 * inside a field nobody thought about.
 */
function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return REDACTED;

  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  if (typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) || SECRET_KEY_WHOLE.test(key)
        ? REDACTED
        : redact(inner, depth + 1);
    }
    return out;
  }

  return looksSecret(value) ? REDACTED : value;
}

// ── Writing ─────────────────────────────────────────────────────────────────

function actorFields(actor, label) {
  if (!actor || !actor.username) {
    // AUD-606 makes the username the thing that survives a deactivated user, so a row
    // without one is not a row worth having.
    throw new TypeError(`an audit row needs an ${label} username (AUD-606)`);
  }
  return { id: actor.id || null, username: actor.username };
}

/**
 * Append one audit row.
 *
 * It joins the caller's transaction: better-sqlite3 is synchronous on one connection,
 * so an INSERT issued inside `db.transaction` commits and rolls back with everything
 * else in it. That is required in both directions — AUD-604 needs the recovery row to
 * commit with the reset, and a business transaction that rolls back must take its
 * audit row with it rather than leaving a row claiming something that never happened.
 *
 * `approver` is how AUD-603 is expressed: the requesting user is `actor`, the
 * authorising user is `approver`, and they are two columns because the whole point of
 * an override record is that they are two different people.
 */
function write({
  actor, action, entityType, entityId = null,
  before = null, after = null, reason = null, approver = null, shiftId = null,
}) {
  assertKnownAction(action);
  if (!entityType) throw new TypeError('an audit row needs an entity type');

  const who = actorFields(actor, 'actor');
  const approvedBy = approver ? actorFields(approver, 'approver') : null;

  if (ACTIONS[action].override) {
    if (!approvedBy) {
      throw new TypeError(`${action} is an override and needs an approver (AUD-603)`);
    }
    if (!reason) throw new TypeError(`${action} is an override and needs a reason (AUD-603)`);
    if (approvedBy.id && who.id && approvedBy.id === who.id) {
      // "Distinct actors" is the rule's own wording. Approving one's own override is
      // the failure the two columns exist to make visible, so it is refused here
      // rather than recorded as if it were an authorisation.
      throw errors.forbidden(
        'An override must be authorised by a different user.',
        { ruleId: 'AUD-603' }
      );
    }
  }

  const redactedBefore = redact(before);
  const redactedAfter = redact(after);

  return auditRepository.insert({
    id: ids.uuidv7(),
    occurred_at: clock.nowUtc(),
    actor_id: who.id,
    actor_username: who.username,
    approver_id: approvedBy ? approvedBy.id : null,
    approver_username: approvedBy ? approvedBy.username : null,
    action,
    entity_type: entityType,
    entity_id: entityId,
    before_value: redactedBefore === null || redactedBefore === undefined ? null : JSON.stringify(redactedBefore),
    after_value: redactedAfter === null || redactedAfter === undefined ? null : JSON.stringify(redactedAfter),
    reason,
    shift_id: shiftId,
  });
}

/**
 * AUD-603 in one call: the requester, the approver, and the reason, for the six
 * overrides the rule names.
 *
 * A convenience rather than a second path — it calls `write`, so the checks above
 * apply. It exists because the tasks that raise overrides (TASK-009's ceilings,
 * TASK-008's limits, TASK-011's below-cost sale) should not each re-derive the shape.
 */
function recordOverride({ action, actor, approver, reason, entityType, entityId = null, before = null, after = null, shiftId = null }) {
  if (!ACTIONS[action] || !ACTIONS[action].override) {
    throw new RangeError(`${action} is not an AUD-603 override`);
  }
  return write({ action, actor, approver, reason, entityType, entityId, before, after, shiftId });
}

// ── Browsing (requirement 5, SCR-703) ───────────────────────────────────────

const MAX_PAGE = 500;
const DEFAULT_PAGE = 50;

/**
 * Filter, page and read the trail.
 *
 * Dates are Manila calendar days on the way in and UTC instants on the way out
 * (VR-102): an owner filtering "7 September" means their own day, not a UTC window
 * that starts at eight in the morning.
 */
function browse({
  actorId = null, actorUsername = null, action = null,
  entityType = null, entityId = null, from = null, to = null,
  limit = DEFAULT_PAGE, offset = 0,
} = {}) {
  if (action !== null) assertKnownAction(action);

  const filters = {
    actorId,
    actorUsername,
    action,
    entityType,
    entityId,
    fromAt: from ? dayStartUtc(from) : null,
    toAt: to ? dayEndUtc(to) : null,
  };

  const size = Math.min(Math.max(Number.parseInt(limit, 10) || DEFAULT_PAGE, 1), MAX_PAGE);
  const skip = Math.max(Number.parseInt(offset, 10) || 0, 0);
  const total = auditRepository.count(filters);

  return {
    total,
    limit: size,
    offset: skip,
    rows: auditRepository.list({ ...filters, limit: size, offset: skip }).map(present),
  };
}

/**
 * A stored row as SCR-703 shows it: parsed JSON, the action's label, and the Manila
 * rendering of the UTC timestamp beside it rather than instead of it.
 */
function present(row) {
  return {
    id: row.id,
    occurred_at: row.occurred_at,
    occurred_at_manila: clock.toManila(row.occurred_at),
    actor: { id: row.actor_id, username: row.actor_username },
    approver: row.approver_username ? { id: row.approver_id, username: row.approver_username } : null,
    action: row.action,
    action_label: isKnownAction(row.action) ? describe(row.action) : row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    before: row.before_value === null ? null : JSON.parse(row.before_value),
    after: row.after_value === null ? null : JSON.parse(row.after_value),
    reason: row.reason,
    shift_id: row.shift_id,
  };
}

/**
 * A Manila calendar date to the UTC instant it begins at.
 *
 * The Philippines has been UTC+8 with no daylight saving since 1978, so the offset is
 * a constant rather than a lookup — but it is written as one place, not sprinkled at
 * call sites, because v1.3's LAN terminals are the point at which someone will ask
 * what happens in another zone.
 */
const MANILA_OFFSET = '+08:00';
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function dayStartUtc(date) {
  if (!DATE_ONLY.test(date)) throw errors.badRequest('A date filter is YYYY-MM-DD', { ruleId: 'VR-102' });
  return new Date(`${date}T00:00:00.000${MANILA_OFFSET}`).toISOString();
}

function dayEndUtc(date) {
  if (!DATE_ONLY.test(date)) throw errors.badRequest('A date filter is YYYY-MM-DD', { ruleId: 'VR-102' });
  return new Date(`${date}T23:59:59.999${MANILA_OFFSET}`).toISOString();
}

// ── Export (requirement 5, SEC-11) ──────────────────────────────────────────

const CSV_COLUMNS = Object.freeze([
  'occurred_at_utc', 'occurred_at_manila', 'actor_username', 'approver_username',
  'action', 'action_label', 'entity_type', 'entity_id', 'before', 'after', 'reason', 'shift_id',
]);

/** RFC 4180: quote everything, double an embedded quote. */
function csvCell(value) {
  if (value === null || value === undefined) return '""';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * The trail as CSV, for SCR-703's export button.
 *
 * Not paginated: an export that silently stops at page one is worse than no export,
 * because the person reading it has no way to tell. The row cap is explicit and is
 * reported back to the caller.
 */
const EXPORT_CAP = 100000;

function exportCsv(filters = {}) {
  const page = browse({ ...filters, limit: MAX_PAGE, offset: 0 });
  const rows = [];

  for (let offset = 0; offset < Math.min(page.total, EXPORT_CAP); offset += MAX_PAGE) {
    rows.push(...browse({ ...filters, limit: MAX_PAGE, offset }).rows);
  }

  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push([
      row.occurred_at, row.occurred_at_manila, row.actor.username,
      row.approver ? row.approver.username : null,
      row.action, row.action_label, row.entity_type, row.entity_id,
      row.before, row.after, row.reason, row.shift_id,
    ].map(csvCell).join(','));
  }

  return { csv: `${lines.join('\r\n')}\r\n`, rowCount: rows.length, total: page.total, capped: page.total > EXPORT_CAP };
}

/** The actor for something the application did on its own — a scheduled backup. */
const SYSTEM_ACTOR = Object.freeze({ id: null, username: 'system' });

module.exports = {
  SYSTEM_ACTOR,
  ACTIONS, ACTION_NAMES, OVERRIDE_ACTIONS, CSV_COLUMNS, MAX_PAGE, DEFAULT_PAGE, EXPORT_CAP, REDACTED,
  isKnownAction, assertKnownAction, describe, redact,
  write, recordOverride, browse, present, exportCsv,
  dayStartUtc, dayEndUtc,
  // The repository's own list stays available for the tasks that assert on raw rows.
  list: auditRepository.list,
};
