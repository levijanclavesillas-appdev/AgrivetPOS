'use strict';

// POS-507 / INT-2 — the cash drawer.
//
// The drawer is an RJ11 socket on the receipt printer, opened by an ESC/POS pulse
// (05_TECH_SPEC.md §6: 0x1B 0x70 0x00 0x19 0xFA). **TASK-014 owns the printer**; this
// file is the interface the rest of the application calls, so that "pulse the drawer"
// is a call at every one of POS-507's three moments — a cash tender, a cash collection,
// and any till movement — before there is anything to pulse.
//
// Written now rather than with the printer for one reason: an integration added after
// its callers is an integration whose call sites are found by grep and missed one at a
// time. The interface exists, every caller uses it, and TASK-014 replaces the body.

const clock = require('../config/clock');

/** POS-507's three moments, named so a caller cannot invent a fourth by typo. */
const REASONS = Object.freeze({
  CASH_TENDER: 'A sale carrying a cash tender',
  CASH_COLLECTION: 'A cash collection on a credit account',
  TILL_MOVEMENT: 'Till cash in or out',
});

// What has been asked for, in memory, for the health panel and for tests. Not a
// persisted log: the drawer opening is not a business event, and a table of them would
// be a table nobody reads.
const pulses = [];
const MAX_REMEMBERED = 200;

let driver = null;

/**
 * TASK-014 installs the real one. Until it does, a pulse is recorded and reported as
 * not delivered — which is honest, and is what lets a test assert the call happened
 * without asserting that a printer exists.
 */
function setDriver(fn) {
  driver = typeof fn === 'function' ? fn : null;
}

function reset() {
  pulses.length = 0;
  driver = null;
}

/**
 * Open the drawer.
 *
 * Never throws. A drawer that will not open is a hardware problem at the counter, and
 * failing the sale that had already completed because of it would turn a stuck drawer
 * into lost trade and an inconsistent till. The failure is reported in the return
 * value, and TASK-014 raises the alert (OPS-007).
 */
function pulse({ reason, shiftId = null, actor = null, amountCentavos = null } = {}) {
  const at = clock.nowUtc();
  const record = {
    at,
    reason: reason || null,
    reason_label: REASONS[reason] || null,
    shift_id: shiftId,
    actor: actor && actor.username ? actor.username : null,
    amount_centavos: amountCentavos,
    delivered: false,
    error: null,
  };

  if (driver) {
    try {
      driver(record);
      record.delivered = true;
    } catch (err) {
      record.error = err.message;
    }
  } else {
    record.error = 'No cash drawer is configured yet (TASK-014).';
  }

  pulses.push(record);
  if (pulses.length > MAX_REMEMBERED) pulses.shift();
  return record;
}

/** What the drawer has been asked to do this session, newest last. */
function history() {
  return pulses.slice();
}

module.exports = { REASONS, setDriver, reset, pulse, history };
