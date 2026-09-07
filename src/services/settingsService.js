'use strict';

// OPS-005: every operator-owned figure lives in the settings registry, not in code.
//
// TASK-004 owns the registry — the full list, its validation and SCR-702. What is here
// is the typed read with a default, which is what makes "not in code" true for the one
// setting TASK-003 needs while the rest is still to come.

const settingsRepository = require('../repositories/settingsRepository');

// Defaults are declared, not scattered as literals at call sites. TASK-004 extends
// this to the whole OPS-005 list.
const DEFAULTS = Object.freeze({
  idle_timeout_minutes: { value: 15, type: 'INT' },      // SEC-7, FR_1.2
  lockout_threshold: { value: 5, type: 'INT' },          // SEC-3
  lockout_minutes: { value: 15, type: 'INT' },           // SEC-3
});

function parse(value, type) {
  switch (type) {
    case 'INT': {
      const n = Number.parseInt(value, 10);
      if (!Number.isInteger(n)) throw new RangeError(`setting is not an integer: ${value}`);
      return n;
    }
    case 'BOOL': return value === '1' || value === 'true';
    case 'JSON': return JSON.parse(value);
    case 'STRING':
    default: return value;
  }
}

/** The stored value, or the declared default where the store has not set one. */
function get(key) {
  const fallback = DEFAULTS[key];
  const row = settingsRepository.get(key);
  if (!row) {
    if (!fallback) throw new RangeError(`no such setting and no default: ${key}`);
    return fallback.value;
  }
  return parse(row.value, row.value_type);
}

function set(key, value, { updatedAt = null, updatedBy = null } = {}) {
  const declared = DEFAULTS[key];
  const valueType = declared ? declared.type : 'STRING';
  settingsRepository.put({ key, value: String(value), valueType, updatedAt, updatedBy });
  return get(key);
}

module.exports = { DEFAULTS, get, set };
