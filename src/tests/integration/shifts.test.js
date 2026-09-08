'use strict';

// POS-501–POS-509 — the shift, the till and the expected figure.
//
// TC-INT-51 is the one the closing report rests on: the expected-cash arithmetic
// asserted against a scripted shift, hand-computed, to the centavo. It is written so
// that each of POS-509's six terms is exercised separately as well as together —
// a total that happens to be right for compensating reasons is not an assertion.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const db = require('../../config/database');
const authService = require('../../services/authService');
const shiftService = require('../../services/shiftService');
const creditService = require('../../services/creditService');
const customerService = require('../../services/customerService');
const settingsService = require('../../services/settingsService');
const drawerService = require('../../services/drawerService');
const auditService = require('../../services/auditService');
const shiftRepository = require('../../repositories/shiftRepository');
const temp = require('../helpers/tempdb');

// Port 0: the OS picks a free one and the real port is read back off the server.
// A fixed port collides whenever two runs overlap or a socket lingers, which is a
// flake that looks like a defect in whatever test happens to be running.
let BASE = null;
const PASSWORD = 'correct-horse-battery';

let instance;
const tokens = {};
const sessions = {};

const call = (path, { token = null, method = 'GET', body = null } = {}) => fetch(`${BASE}${path}`, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

/** A fresh cashier with an open shift — the state most cases start from. */
let seq = 0;
function openShiftFor(role = 'CASHIER', floatCentavos = 200000) {
  seq += 1;
  const username = `till${seq}`;
  temp.seedUser({ username, role, password: PASSWORD });
  const session = authService.verifyToken(authService.login({ username, password: PASSWORD }).token);
  const { shift } = shiftService.open({
    actor: session, openingFloatCentavos: floatCentavos, confirmed: true,
  });
  return { session, shift, username };
}

test.before(async () => {
  temp.openEmpty('shifts');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;
  temp.seedStore({ withOwner: false });

  for (const role of ['OWNER', 'MANAGER', 'CASHIER', 'INVENTORY']) {
    const username = role.toLowerCase();
    temp.seedUser({ username, role, password: PASSWORD });
    const signedIn = authService.login({ username, password: PASSWORD });
    tokens[role] = signedIn.token;
    sessions[role] = authService.verifyToken(signedIn.token);
  }
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── POS-502, POS-503 — opening ──────────────────────────────────────────────

test('POS-503: the opening float is required and confirmed', () => {
  temp.seedUser({ username: 'unconfirmed', role: 'CASHIER', password: PASSWORD });
  const session = authService.verifyToken(
    authService.login({ username: 'unconfirmed', password: PASSWORD }).token
  );

  let err;
  try {
    shiftService.open({ actor: session, openingFloatCentavos: 200000, confirmed: false });
  } catch (caught) {
    err = caught;
  }

  // The confirmation is enforced on the server, not by a checkbox: the variance at
  // close is measured against this figure, so an unconfirmed one makes the close
  // meaningless.
  assert.equal(err.status, 400);
  assert.equal(err.ruleId, 'POS-503');
  assert.match(err.message, /variance at close is measured against/);

  assert.throws(
    () => shiftService.open({ actor: session, openingFloatCentavos: -1, confirmed: true }),
    (e) => e.ruleId === 'MON-001'
  );
  assert.equal(shiftService.openShiftFor(session.id), null, 'nothing opened');
});

test('POS-502: a second open attempt resumes the existing shift', () => {
  const { session, shift } = openShiftFor();

  // Not an error. A cashier who reopens the app mid-morning is not making a mistake,
  // and refusing them teaches the counter that the shift screen is to be worked around.
  const again = shiftService.open({ actor: session, openingFloatCentavos: 999999, confirmed: true });

  assert.equal(again.resumed, true);
  assert.equal(again.shift.id, shift.id);
  assert.equal(again.shift.opening_float_centavos, 200000, 'the original float, not the resubmitted one');

  const count = db.get()
    .prepare('SELECT COUNT(*) AS n FROM cashier_shifts WHERE user_id = ?').get(session.id).n;
  assert.equal(count, 1, 'one shift, not two');
});

test('POS-502: a shift belongs to a user, not a terminal', () => {
  // legacy/PRD_v1.1.md §62 never said which. It is the user: the drawer is counted by
  // a person, and a terminal-owned shift cannot answer "whose till was short".
  const a = openShiftFor();
  const b = openShiftFor();

  assert.notEqual(a.shift.id, b.shift.id, 'two users, two shifts, one machine');
  assert.equal(shiftService.openShiftFor(a.session.id).id, a.shift.id);
  assert.equal(shiftService.openShiftFor(b.session.id).id, b.shift.id);
});

test('opening a shift is audited', () => {
  const { session, shift } = openShiftFor();
  const [row] = auditService.browse({ action: 'SHIFT_OPENED', entityId: shift.id }).rows;

  assert.equal(row.actor.id, session.id);
  assert.equal(row.after.opening_float_centavos, 200000);
  assert.equal(row.shift_id, shift.id, 'AUD-606: the row carries its own shift');
});

// ── TC-INT-50 / POS-501 — no shift, no money ────────────────────────────────

test('TC-INT-50: a sale and a collection are both refused with no open shift', () => {
  temp.seedUser({ username: 'noshift', role: 'CASHIER', password: PASSWORD });
  const session = authService.verifyToken(
    authService.login({ username: 'noshift', password: PASSWORD }).token
  );

  for (const action of ['complete a sale', 'take a collection', 'move till cash']) {
    let err;
    try {
      shiftService.requireOpenShift(session, { action });
    } catch (caught) {
      err = caught;
    }
    assert.equal(err.status, 409, action);
    assert.equal(err.ruleId, 'POS-501');
    // FR_5.1's AC: the POS refuses with an "open your shift" prompt, not a bare error.
    assert.match(err.message, new RegExp(`Open your shift before you ${action}`));
    assert.match(err.message, /Count the drawer/);
  }
});

test('TC-INT-50: an open shift belonging to someone else is not an open shift', () => {
  const owner = openShiftFor();
  temp.seedUser({ username: 'borrower', role: 'CASHIER', password: PASSWORD });
  const borrower = authService.verifyToken(
    authService.login({ username: 'borrower', password: PASSWORD }).token
  );

  // Borrowing a colleague's open shift is exactly how a drawer ends up short with
  // nobody's name on it.
  assert.throws(
    () => shiftService.requireOpenShift(borrower, { action: 'complete a sale' }),
    (err) => err.ruleId === 'POS-501'
  );
  assert.doesNotThrow(() => shiftService.requireOpenShift(owner.session));
});

// ── POS-504–POS-506 — till movements ────────────────────────────────────────

test('POS-504: a till movement needs an amount, a listed reason and an actor', () => {
  const { session, shift } = openShiftFor();

  for (const reason of [undefined, '', '   ', 'felt like it']) {
    assert.throws(
      () => shiftService.moveTillCash({
        shiftId: shift.id, direction: 'IN', amountCentavos: 5000, reason, actor: session,
      }),
      (err) => err.status === 400 && err.ruleId === 'POS-504',
      JSON.stringify(reason)
    );
  }

  assert.throws(
    () => shiftService.moveTillCash({
      shiftId: shift.id, direction: 'IN', amountCentavos: 0, reason: 'Petty cash', actor: session,
    }),
    (err) => err.ruleId === 'POS-504' || err.ruleId === 'MON-001'
  );
  assert.throws(
    () => shiftService.moveTillCash({
      shiftId: shift.id, direction: 'SIDEWAYS', amountCentavos: 100, reason: 'Petty cash', actor: session,
    }),
    (err) => err.ruleId === 'POS-504'
  );

  const ok = shiftService.moveTillCash({
    shiftId: shift.id, direction: 'IN', amountCentavos: 50000,
    reason: 'Change fund top-up', notes: 'From the safe', actor: session,
  });
  assert.equal(ok.movement.amount_centavos, 50000);
  assert.equal(ok.movement.reason, 'Change fund top-up');
});

test('POS-504: the reason list is configured, not hard-coded (OPS-005)', () => {
  const { session, shift } = openShiftFor();
  const listed = shiftService.tillReasons();
  assert.ok(listed.includes('Owner withdrawal'));

  db.transaction(() => settingsService.set('till_reasons', ['Paid the tricycle driver'], sessions.OWNER));
  try {
    assert.throws(
      () => shiftService.moveTillCash({
        shiftId: shift.id, direction: 'OUT', amountCentavos: 1000, reason: 'Petty cash', actor: session,
      }),
      (err) => err.ruleId === 'POS-504'
    );
    assert.doesNotThrow(() => shiftService.moveTillCash({
      shiftId: shift.id, direction: 'OUT', amountCentavos: 1000,
      reason: 'Paid the tricycle driver', actor: session,
    }));
  } finally {
    db.transaction(() => settingsService.set('till_reasons', listed, sessions.OWNER));
  }
});

test('TC-INT-54: cash out may not exceed the expected cash in the drawer', () => {
  const { session, shift } = openShiftFor('CASHIER', 200000);   // ₱2,000 float

  let err;
  try {
    shiftService.moveTillCash({
      shiftId: shift.id, direction: 'OUT', amountCentavos: 200001,
      reason: 'Owner withdrawal', actor: session,
    });
  } catch (caught) {
    err = caught;
  }

  assert.equal(err.status, 409);
  assert.equal(err.ruleId, 'POS-505');
  assert.match(err.message, /There is ₱2,000\.00 in the drawer/, 'the message states what is there');
  assert.match(err.message, /take out ₱2,000\.01/);

  // Exactly what is there is allowed — emptying the drawer is a real operation.
  assert.doesNotThrow(() => shiftService.moveTillCash({
    shiftId: shift.id, direction: 'OUT', amountCentavos: 200000,
    reason: 'Bank deposit', actor: session,
  }));
  assert.equal(shiftService.computeExpected(shift.id).expected_cash_centavos, 0);

  // And with nothing in it, nothing more comes out.
  assert.throws(
    () => shiftService.moveTillCash({
      shiftId: shift.id, direction: 'OUT', amountCentavos: 1, reason: 'Petty cash', actor: session,
    }),
    (e) => e.ruleId === 'POS-505'
  );
});

test('TC-INT-54: the ceiling uses the same arithmetic the close will use', () => {
  const { session, shift } = openShiftFor('CASHIER', 100000);
  shiftService.moveTillCash({
    shiftId: shift.id, direction: 'IN', amountCentavos: 50000, reason: 'Change fund top-up', actor: session,
  });

  // One arithmetic, used by the guard and by the close, cannot disagree with itself.
  assert.equal(shiftService.computeExpected(shift.id).expected_cash_centavos, 150000);
  assert.doesNotThrow(() => shiftService.moveTillCash({
    shiftId: shift.id, direction: 'OUT', amountCentavos: 150000, reason: 'Bank deposit', actor: session,
  }));
});

test('POS-506: a till movement touches nothing but the drawer', () => {
  const { session, shift } = openShiftFor();

  const before = {
    movements: db.get().prepare('SELECT COUNT(*) AS n FROM inventory_movements').get().n,
    credit: db.get().prepare('SELECT COUNT(*) AS n FROM customer_credit_transactions').get().n,
    inventory: db.get().prepare('SELECT COUNT(*) AS n FROM inventory').get().n,
  };

  shiftService.moveTillCash({
    shiftId: shift.id, direction: 'IN', amountCentavos: 25000, reason: 'Petty cash', actor: session,
  });

  // A till movement is never a sale: no inventory, no revenue, no customer ledger.
  // Asserted as an absence rather than trusted.
  assert.equal(db.get().prepare('SELECT COUNT(*) AS n FROM inventory_movements').get().n, before.movements);
  assert.equal(db.get().prepare('SELECT COUNT(*) AS n FROM customer_credit_transactions').get().n, before.credit);
  assert.equal(db.get().prepare('SELECT COUNT(*) AS n FROM inventory').get().n, before.inventory);
});

test('POS-511: nothing may be moved into a closed shift', () => {
  const { session, shift } = openShiftFor();
  shiftRepository.close(shift.id, { closedAt: new Date().toISOString() });

  assert.throws(
    () => shiftService.moveTillCash({
      shiftId: shift.id, direction: 'IN', amountCentavos: 100, reason: 'Petty cash', actor: session,
    }),
    (err) => err.status === 409 && err.ruleId === 'POS-511'
  );
});

test("a user may not move cash in another user's shift", () => {
  const a = openShiftFor();
  const b = openShiftFor();

  assert.throws(
    () => shiftService.moveTillCash({
      shiftId: a.shift.id, direction: 'IN', amountCentavos: 100, reason: 'Petty cash', actor: b.session,
    }),
    (err) => err.status === 403 && err.ruleId === 'POS-501'
  );
});

// ── POS-507 — the drawer ────────────────────────────────────────────────────

test('POS-507: the drawer interface is called on every till movement', () => {
  const { session, shift } = openShiftFor();
  const pulses = [];
  drawerService.setDriver((record) => pulses.push(record));

  try {
    shiftService.moveTillCash({
      shiftId: shift.id, direction: 'IN', amountCentavos: 30000, reason: 'Petty cash', actor: session,
    });
    shiftService.moveTillCash({
      shiftId: shift.id, direction: 'OUT', amountCentavos: 10000, reason: 'Owner withdrawal', actor: session,
    });

    assert.equal(pulses.length, 2, 'in and out both pulse');
    assert.equal(pulses[0].reason, 'TILL_MOVEMENT');
    assert.equal(pulses[0].shift_id, shift.id);
    assert.equal(pulses[0].amount_centavos, 30000);
    assert.equal(pulses[0].delivered, true);
  } finally {
    drawerService.setDriver(null);
  }
});

test('POS-507: a drawer that will not open does not undo the movement', () => {
  const { session, shift } = openShiftFor();
  drawerService.setDriver(() => { throw new Error('printer offline'); });

  try {
    const result = shiftService.moveTillCash({
      shiftId: shift.id, direction: 'IN', amountCentavos: 15000, reason: 'Petty cash', actor: session,
    });

    // A stuck drawer is a hardware problem at the counter. Failing the movement that
    // was already recorded would turn it into an inconsistent till.
    assert.equal(result.drawer.delivered, false);
    assert.equal(result.drawer.error, 'printer offline');
    assert.equal(result.movement.amount_centavos, 15000, 'and the movement stands');
    assert.equal(shiftService.computeExpected(shift.id).cash_in_centavos, 15000);
  } finally {
    drawerService.setDriver(null);
  }
});

test('with no driver installed the pulse is recorded and reported undelivered', () => {
  // TASK-014 installs the real one. Until then this is honest rather than silent, and
  // it is what lets a test assert the call without asserting a printer exists.
  const record = drawerService.pulse({ reason: 'TILL_MOVEMENT' });
  assert.equal(record.delivered, false);
  assert.match(record.error, /TASK-014/);
  assert.equal(record.reason_label, 'Till cash in or out');
  assert.deepEqual(Object.keys(drawerService.REASONS), ['CASH_TENDER', 'CASH_COLLECTION', 'TILL_MOVEMENT']);
});

// ── TC-INT-51 / POS-509 — the expected-cash arithmetic ──────────────────────

test('TC-INT-51: expected cash matches a hand-computed scripted shift, to the centavo', () => {
  const { session, shift } = openShiftFor('CASHIER', 200000);   // float ₱2,000.00

  // A cash collection on a credit account (CR-205: a cash collection is till cash).
  const customer = customerService.create({
    name: 'Till Test Farm', customerType: 'FARM',
    isCreditEligible: true, creditLimitCentavos: 5000000, termsDays: 15,
  }, sessions.OWNER);
  const account = creditService.accountFor(customer.id);

  creditService.postStandalone({
    accountId: account.id, type: 'CREDIT_SALE', amountCentavos: 500000,
    actor: session, documentNo: 'S-T1', shiftId: shift.id,
  });
  creditService.postStandalone({
    accountId: account.id, type: 'COLLECTION', amountCentavos: 125000,
    actor: session, documentNo: 'COLL-T1', method: 'CASH', shiftId: shift.id,
  });
  // A non-cash collection: it is expected at close, but not in the drawer.
  creditService.postStandalone({
    accountId: account.id, type: 'COLLECTION', amountCentavos: 75000,
    actor: session, documentNo: 'COLL-T2', method: 'GCASH', reference_no: 'GC-1', shiftId: shift.id,
  });

  shiftService.moveTillCash({
    shiftId: shift.id, direction: 'IN', amountCentavos: 50000, reason: 'Change fund top-up', actor: session,
  });
  shiftService.moveTillCash({
    shiftId: shift.id, direction: 'OUT', amountCentavos: 30000, reason: 'Owner withdrawal', actor: session,
  });
  shiftService.moveTillCash({
    shiftId: shift.id, direction: 'OUT', amountCentavos: 12550, reason: 'Petty cash', actor: session,
  });

  const expected = shiftService.computeExpected(shift.id);

  // POS-509, term by term. Each is asserted separately as well as in the total: a
  // figure that is right for compensating reasons is not an assertion.
  assert.equal(expected.opening_float_centavos, 200000, 'float');
  assert.equal(expected.cash_sales_centavos, 0, 'sales arrive with TASK-011');
  assert.equal(expected.cash_collections_centavos, 125000, 'the cash collection only');
  assert.equal(expected.cash_in_centavos, 50000);
  assert.equal(expected.cash_out_centavos, 30000 + 12550);
  assert.equal(expected.cash_refunds_centavos, 0, 'returns are v1.1');
  assert.equal(expected.change_given_centavos, 0);

  // 200000 + 0 + 125000 + 50000 − 42550 − 0 − 0
  assert.equal(expected.expected_cash_centavos, 332450);

  // The non-cash method is expected at close but never entered the drawer (POS-510).
  assert.equal(expected.by_method.GCASH.expected_centavos, 75000);
  assert.equal(expected.by_method.GCASH.in_drawer, false);
  assert.equal(expected.by_method.CASH.in_drawer, true);
  assert.equal(expected.by_method.CREDIT.expected_centavos, 0, 'credit takes no money');
});

test('TC-INT-51: computeExpected is a pure read', () => {
  const { shift } = openShiftFor();
  const before = db.get().prepare('SELECT COUNT(*) AS n FROM till_movements').get().n;

  // The task's own constraint: the screen calls it on every change, so looking must
  // never write.
  for (let i = 0; i < 5; i += 1) shiftService.computeExpected(shift.id);

  assert.equal(db.get().prepare('SELECT COUNT(*) AS n FROM till_movements').get().n, before);
  assert.equal(auditService.browse({ entityId: shift.id, action: 'TILL_CASH_MOVED' }).total, 0);
});

test('TC-INT-51: a term whose table does not exist yet reports zero, not an error', () => {
  // sale_returns arrives with TASK-020 (v1.1). At this schema version there are no
  // returns because there is no table for one — a true answer, not an assumption, and
  // one that starts counting the moment the table exists with no edit to the caller.
  const schemaRepository = require('../../repositories/schemaRepository');
  assert.equal(schemaRepository.listTables().includes('sale_returns'), false, 'returns are v1.1');

  const { shift } = openShiftFor();
  const expected = shiftService.computeExpected(shift.id);

  assert.equal(expected.cash_refunds_centavos, 0);
  // sales and sale_tenders exist now (006), so these are counted rather than skipped —
  // and a shift with no sales still reads zero, which is the same answer for a
  // different and better reason.
  assert.equal(schemaRepository.listTables().includes('sale_tenders'), true);
  assert.equal(expected.cash_sales_centavos, 0, 'this shift has sold nothing');
  assert.equal(expected.change_given_centavos, 0);
});

// ── POS-508 — the long-open shift ───────────────────────────────────────────

test('POS-508: a shift open past the maximum raises an alert, and is not auto-closed', () => {
  const { shift } = openShiftFor();
  const maxHours = settingsService.get('shift_max_open_hours');
  assert.equal(maxHours, 24);

  assert.equal(shiftService.staleShifts().length, 0, 'a fresh shift is not stale');

  // Back-date the opening. No application path does this, which is why the fixture does.
  const longAgo = new Date(Date.now() - 30 * 3600000).toISOString();
  db.get().prepare('UPDATE cashier_shifts SET opened_at = ? WHERE id = ?').run(longAgo, shift.id);

  const stale = shiftService.staleShifts();
  const mine = stale.find((s) => s.shift_id === shift.id);

  assert.ok(mine, 'past the maximum it is flagged');
  assert.equal(mine.rule_id, 'POS-508');
  assert.ok(mine.open_for_hours >= 30);
  assert.match(mine.message, /not closed automatically/);

  // Auto-closing would invent a count nobody made: the variance would be measured
  // against a drawer no person ever counted, and would look exactly like a real figure.
  assert.equal(shiftRepository.findById(shift.id).status, 'OPEN');

  const alert = shiftService.alerts().find((a) => a.shift_id === shift.id);
  assert.equal(alert.kind, 'SHIFT_OPEN_TOO_LONG');
  assert.equal(alert.severity, 'WARNING');
});

// ── Over HTTP ───────────────────────────────────────────────────────────────

test('POST /shifts/open needs TX-418, and resuming answers 200 rather than 201', async () => {
  const refused = await call('/shifts/open', {
    token: tokens.INVENTORY, method: 'POST', body: { openingFloatCentavos: 100000, confirmed: true },
  });
  assert.equal(refused.status, 403, 'an inventory clerk has no till');
  assert.equal((await refused.json()).error.rule_id, 'TX-418');

  const opened = await call('/shifts/open', {
    token: tokens.CASHIER, method: 'POST', body: { openingFloatCentavos: 100000, confirmed: true },
  });
  assert.equal(opened.status, 201);
  const first = (await opened.json()).shift;

  const resumed = await call('/shifts/open', {
    token: tokens.CASHIER, method: 'POST', body: { openingFloatCentavos: 100000, confirmed: true },
  });
  assert.equal(resumed.status, 200, 'POS-502: resuming is not a conflict');
  const body = await resumed.json();
  assert.equal(body.resumed, true);
  assert.equal(body.shift.id, first.id);
});

test('GET /shifts/current answers what SCR-301 asks before it shows a cart', async () => {
  const res = await call('/shifts/current', { token: tokens.CASHIER });
  const body = await res.json();

  assert.equal(body.open, true);
  assert.equal(body.expected.expected_cash_centavos, 100000);

  const none = await (await call('/shifts/current', { token: tokens.MANAGER })).json();
  assert.equal(none.open, false);
  assert.equal(none.shift, null);
});

test('POST /shifts/:id/till needs TX-420 and returns the new expected figure', async () => {
  const current = await (await call('/shifts/current', { token: tokens.CASHIER })).json();

  const refused = await call(`/shifts/${current.shift.id}/till`, {
    token: tokens.INVENTORY, method: 'POST',
    body: { direction: 'IN', amountCentavos: 5000, reason: 'Petty cash' },
  });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.rule_id, 'TX-420');

  const ok = await call(`/shifts/${current.shift.id}/till`, {
    token: tokens.CASHIER, method: 'POST',
    body: { direction: 'IN', amountCentavos: 5000, reason: 'Petty cash' },
  });
  assert.equal(ok.status, 201);
  const body = await ok.json();
  assert.equal(body.expected.expected_cash_centavos, 105000, 'the screen needs the new figure, not a refetch');
  assert.equal(body.drawer.reason, 'TILL_MOVEMENT');
});

test('GET /shifts/:id/expected is readable and writes nothing', async () => {
  const current = await (await call('/shifts/current', { token: tokens.CASHIER })).json();
  const before = db.get().prepare('SELECT COUNT(*) AS n FROM till_movements').get().n;

  const res = await call(`/shifts/${current.shift.id}/expected`, { token: tokens.CASHIER });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.expected_cash_centavos, 105000);
  assert.deepEqual(Object.keys(body.by_method).sort(), ['CASH', 'CREDIT', 'GCASH', 'QRPH']);
  assert.equal(db.get().prepare('SELECT COUNT(*) AS n FROM till_movements').get().n, before);
});

test('the till reason list is served rather than hard-coded in the screen', async () => {
  const res = await call('/shifts/meta/till-reasons', { token: tokens.CASHIER });
  const body = await res.json();

  assert.ok(body.reasons.includes('Owner withdrawal'));
  assert.deepEqual(body.methods, ['CASH', 'GCASH', 'QRPH', 'CREDIT']);
});

test('closing is reachable, and is covered by shift-close.test.js', async () => {
  // The placeholder that stood here while TASK-013 was outstanding is gone: closing
  // exists now, and its rules — POS-510's mandatory reason, POS-511's immutability,
  // AUD-602 and the OPS-001 backup — have their own file.
  const current = await (await call('/shifts/current', { token: tokens.CASHIER })).json();
  const res = await call(`/shifts/${current.shift.id}/close`, {
    token: tokens.CASHIER, method: 'POST',
    body: { actualCashCentavos: current.expected.expected_cash_centavos },
  });

  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.variance_centavos, 0, 'a counted drawer that matches');
  assert.equal(body.shift.status, 'CLOSED');
});
