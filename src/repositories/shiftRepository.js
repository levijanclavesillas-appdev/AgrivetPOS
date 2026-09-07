'use strict';

// TASK-010 owns cashier shifts — the table, the till movements and the expected-cash
// arithmetic. This is the one read TASK-003 needs: SEC-2 permits a PIN unlock only
// while the user has an open shift.
//
// Before migration 005 the table does not exist, and the honest answer to "does this
// user have an open shift" is no, not an error. That is what this returns.

const db = require('../config/database');

function tableExists() {
  const row = db.get()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cashier_shifts'")
    .get();
  return Boolean(row);
}

/** The user's open shift, or null. Null before the shifts table exists (POS-502). */
function findOpenForUser(userId) {
  if (!tableExists()) return null;
  return db.get()
    .prepare("SELECT id, user_id, status FROM cashier_shifts WHERE user_id = ? AND status = 'OPEN'")
    .get(userId) || null;
}

module.exports = { tableExists, findOpenForUser };
