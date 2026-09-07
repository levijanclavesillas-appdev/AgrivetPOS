'use strict';

// 03_BUSINESS_RULES.md §10 — the TX-* permission matrix, transcribed once.
//
// SEC-6: a permission is checked server-side on every request. Hiding a button is not
// a permission; the renderer's hidden controls are cosmetic and a hand-crafted request
// to a forbidden route is refused with 403 and audited.
//
// Three cells in §10 are not plain ticks — "view", "own shift" and "limited" — so a
// grant is a level, not a boolean. A route that writes demands FULL; a route that
// reads accepts VIEW. The qualified levels carry a constraint the *service* applies
// (a cashier's report is scoped to their own shift); the middleware's job is only to
// say whether the door opens at all.

const ROLES = Object.freeze(['OWNER', 'MANAGER', 'CASHIER', 'INVENTORY']);

const FULL = 'FULL';
const VIEW = 'VIEW';
const OWN_SHIFT = 'OWN_SHIFT';
const LIMITED = 'LIMITED';

const LEVELS = Object.freeze([FULL, VIEW, OWN_SHIFT, LIMITED]);

// [TX id, description, OWNER, MANAGER, CASHIER, INVENTORY]
const MATRIX = Object.freeze({
  'TX-401': { what: 'Complete a sale',                    OWNER: FULL, MANAGER: FULL, CASHIER: FULL, INVENTORY: null },
  'TX-402': { what: 'Apply a discount within ceiling',    OWNER: FULL, MANAGER: FULL, CASHIER: FULL, INVENTORY: null },
  'TX-403': { what: 'Authorise a discount above ceiling', OWNER: FULL, MANAGER: FULL, CASHIER: null, INVENTORY: null },
  'TX-404': { what: 'Sell below average cost',            OWNER: FULL, MANAGER: FULL, CASHIER: null, INVENTORY: null },
  'TX-405': { what: 'Void a sale',                        OWNER: FULL, MANAGER: FULL, CASHIER: null, INVENTORY: null },
  'TX-406': { what: 'Process a return',                   OWNER: FULL, MANAGER: FULL, CASHIER: FULL, INVENTORY: null },
  'TX-407': { what: 'Post an inventory adjustment',       OWNER: FULL, MANAGER: FULL, CASHIER: null, INVENTORY: FULL },
  'TX-408': { what: 'Approve a stock count',              OWNER: FULL, MANAGER: FULL, CASHIER: null, INVENTORY: null },
  'TX-409': { what: 'Receive goods',                      OWNER: FULL, MANAGER: FULL, CASHIER: null, INVENTORY: FULL },
  'TX-410': { what: 'Create or edit a product',           OWNER: FULL, MANAGER: FULL, CASHIER: null, INVENTORY: FULL },
  'TX-411': { what: 'Change a selling price',             OWNER: FULL, MANAGER: FULL, CASHIER: null, INVENTORY: null },
  'TX-412': { what: 'Change a product cost',              OWNER: FULL, MANAGER: null, CASHIER: null, INVENTORY: null },
  'TX-413': { what: 'Create or edit a customer',          OWNER: FULL, MANAGER: FULL, CASHIER: FULL, INVENTORY: VIEW },
  'TX-414': { what: 'Set or change a credit limit',       OWNER: FULL, MANAGER: FULL, CASHIER: null, INVENTORY: null },
  'TX-415': { what: 'Authorise an over-limit credit sale', OWNER: FULL, MANAGER: FULL, CASHIER: null, INVENTORY: null },
  'TX-416': { what: 'Record a collection',                OWNER: FULL, MANAGER: FULL, CASHIER: FULL, INVENTORY: null },
  'TX-417': { what: 'Write off a balance',                OWNER: FULL, MANAGER: null, CASHIER: null, INVENTORY: null },
  'TX-418': { what: 'Open / close own shift',             OWNER: FULL, MANAGER: FULL, CASHIER: FULL, INVENTORY: null },
  'TX-419': { what: "Close another user's shift",         OWNER: FULL, MANAGER: FULL, CASHIER: null, INVENTORY: null },
  'TX-420': { what: 'Till cash in / out',                 OWNER: FULL, MANAGER: FULL, CASHIER: FULL, INVENTORY: null },
  'TX-421': { what: 'View sales and profit reports',      OWNER: FULL, MANAGER: FULL, CASHIER: OWN_SHIFT, INVENTORY: null },
  'TX-422': { what: 'View inventory reports',             OWNER: FULL, MANAGER: FULL, CASHIER: VIEW, INVENTORY: FULL },
  'TX-423': { what: 'Manage users',                       OWNER: FULL, MANAGER: null, CASHIER: null, INVENTORY: null },
  'TX-424': { what: 'Change system settings',             OWNER: FULL, MANAGER: LIMITED, CASHIER: null, INVENTORY: null },
  'TX-425': { what: 'Change tax mode',                    OWNER: FULL, MANAGER: null, CASHIER: null, INVENTORY: null },
  'TX-426': { what: 'Export data',                        OWNER: FULL, MANAGER: FULL, CASHIER: null, INVENTORY: null },
  'TX-427': { what: 'Import / restore data',              OWNER: FULL, MANAGER: null, CASHIER: null, INVENTORY: null },
  'TX-428': { what: 'Run a manual backup',                OWNER: FULL, MANAGER: FULL, CASHIER: null, INVENTORY: null },
  'TX-429': { what: 'View the audit trail',               OWNER: FULL, MANAGER: FULL, CASHIER: null, INVENTORY: null },
  'TX-430': { what: 'Reprint a receipt',                  OWNER: FULL, MANAGER: FULL, CASHIER: FULL, INVENTORY: null },
});

/**
 * SEC-2: a PIN unlocks an already-authenticated user's open shift. It is not an
 * alternative login, and it never widens what the user could already do — it narrows
 * it to the counter.
 *
 * FR_1.3: "the PIN shall never grant access outside POS and collections", and it
 * cannot reach Settings, Users, Products edit, or Reports. Anything not in this set is
 * refused for a PIN session whatever the user's role says.
 */
const PIN_SCOPE = Object.freeze([
  'TX-401',  // complete a sale
  'TX-402',  // discount within own ceiling
  'TX-413',  // look a customer up at the counter
  'TX-416',  // record a collection
  'TX-420',  // till cash in / out
  'TX-430',  // reprint a receipt
]);

function isKnown(txId) {
  return Object.prototype.hasOwnProperty.call(MATRIX, txId);
}

function assertKnown(txId) {
  if (!isKnown(txId)) throw new RangeError(`unknown permission: ${txId} (03_BUSINESS_RULES.md §10)`);
}

/** The level a role holds for a transaction, or null where it holds none. */
function grant(role, txId) {
  assertKnown(txId);
  if (!ROLES.includes(role)) throw new RangeError(`unknown role: ${role}`);
  return MATRIX[txId][role];
}

/**
 * Whether a session may pass. `required` defaults to any grant at all; a route that
 * writes passes FULL so that a VIEW-level role is refused.
 */
function can(session, txId, required = null) {
  assertKnown(txId);
  const level = grant(session.role, txId);
  if (level === null) return false;
  if (session.scope === 'PIN' && !PIN_SCOPE.includes(txId)) return false;
  if (required !== null && level !== required) return false;
  return true;
}

/** Who may approve an action the actor cannot take — for the UI's refusal message. */
function rolesHolding(txId, required = null) {
  assertKnown(txId);
  return ROLES.filter((role) => {
    const level = MATRIX[txId][role];
    return level !== null && (required === null || level === required);
  });
}

function describe(txId) {
  assertKnown(txId);
  return MATRIX[txId].what;
}

module.exports = {
  ROLES, LEVELS, FULL, VIEW, OWN_SHIFT, LIMITED, MATRIX, PIN_SCOPE,
  isKnown, assertKnown, grant, can, rolesHolding, describe,
};
