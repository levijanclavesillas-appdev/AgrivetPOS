'use strict';

// OPS-005: every operator-owned figure lives in the settings registry, not in code.
//
// This file **is** that list. `legacy/PRD_v1.1.md` said "the configured threshold"
// fourteen times without ever saying what was configurable, which is the failure
// OPS-005 exists to end — so a figure an operator may change is declared here, with
// its rule, its type, its bounds and its default, and is read from here everywhere.
//
// Adding a threshold anywhere else is a defect. TC-UT-06 greps services/ for a bare
// numeric literal used as a threshold and fails the build if one appears.

const db = require('../config/database');
const clock = require('../config/clock');
const errors = require('./errors');
const auditService = require('./auditService');
const settingsRepository = require('../repositories/settingsRepository');

// Groups are the sections of SCR-702 (04_UX_SPEC.md §3), one per subject.
const GROUPS = Object.freeze({
  SECURITY: 'Security and sessions',
  SALES: 'Sales and the till',
  PRICING: 'Discounts and rounding',
  INVENTORY: 'Inventory',
  CREDIT: 'Credit',
  PURCHASING: 'Purchasing',
  BACKUP: 'Backup',
});

/**
 * The registry.
 *
 * `ownerOnly` is what TX-424's MANAGER cell means. §10 grants the manager `LIMITED`
 * rather than a tick, and "limited" has to name a boundary or it is decoration: a
 * manager may tune the figures they work with daily — variance tolerance, due-soon
 * window, near-expiry days — and may not touch the ones that govern who gets in, what
 * may be given away, or where the backups go. Those need an owner.
 *
 * `min` and `max` are refusal bounds, not UI hints. A cash variance tolerance of ten
 * million pesos is not a preference, it is a disabled control.
 */
const REGISTRY = Object.freeze({
  // ── Security (SEC-*) ──────────────────────────────────────────────────────
  idle_timeout_minutes: {
    type: 'INT', value: 15, group: 'SECURITY', ruleId: 'SEC-7', ownerOnly: true,
    what: 'Minutes of inactivity before the screen locks', min: 1, max: 480,
  },
  lockout_threshold: {
    type: 'INT', value: 5, group: 'SECURITY', ruleId: 'SEC-3', ownerOnly: true,
    what: 'Failed sign-in attempts before an account locks', min: 3, max: 20,
  },
  lockout_minutes: {
    type: 'INT', value: 15, group: 'SECURITY', ruleId: 'SEC-3', ownerOnly: true,
    what: 'Minutes an account stays locked', min: 1, max: 1440,
  },

  // ── Sales and the till (POS-*) ────────────────────────────────────────────
  cash_variance_tolerance_centavos: {
    type: 'INT', value: 10000, group: 'SALES', ruleId: 'POS-510', ownerOnly: false,
    what: 'Cash variance at shift close that requires a reason', min: 0, max: 1000000,
  },
  // POS-504: till cash in/out requires "a reason from the configured list". Same
  // reasoning as INV-108's adjustment reasons — a list in code is what OPS-005 exists
  // to stop, and an owner withdrawal is the entry every store words differently.
  till_reasons: {
    type: 'JSON', group: 'SALES', ruleId: 'POS-504', ownerOnly: false,
    what: 'Reasons till cash may be moved in or out',
    value: Object.freeze([
      'Owner withdrawal',
      'Petty cash',
      'Change fund top-up',
      'Bank deposit',
      'Supplier paid in cash',
      'Correction of a miscount',
    ]),
  },
  shift_max_open_hours: {
    type: 'INT', value: 24, group: 'SALES', ruleId: 'POS-508', ownerOnly: false,
    what: 'Hours a shift may stay open before it raises an alert', min: 1, max: 168,
  },
  return_window_days: {
    type: 'INT', value: 7, group: 'SALES', ruleId: 'POS-307', ownerOnly: true,
    what: 'Days a return is accepted without manager authorisation', min: 0, max: 365,
  },
  // OPS-005 lists a "void window"; POS-402 defines that window as the shift the sale
  // occurred in, not a duration. The setting therefore records the rule rather than a
  // number, and turning it off is not implemented — POS-402 would have to be amended
  // first. It is registered so the OPS-005 list is complete and the discrepancy is
  // visible rather than silently dropped.
  void_window_shift_only: {
    type: 'BOOL', value: true, group: 'SALES', ruleId: 'POS-402', ownerOnly: true,
    what: 'A sale may be voided only within its own open shift', immutable: true,
  },

  // ── Discounts and rounding (PR-*, MON-*) ──────────────────────────────────
  // Basis points, not percent: 2% is 200. A percentage stored as a float is the
  // rounding bug MON-001 exists to prevent, one indirection later.
  discount_ceiling_cashier_bp: {
    type: 'INT', value: 200, group: 'PRICING', ruleId: 'PR-201', ownerOnly: true,
    what: 'Highest discount a cashier may apply, in basis points', min: 0, max: 10000,
  },
  discount_ceiling_manager_bp: {
    type: 'INT', value: 500, group: 'PRICING', ruleId: 'PR-201', ownerOnly: true,
    what: 'Highest discount a manager may apply, in basis points', min: 0, max: 10000,
  },
  discount_ceiling_owner_bp: {
    type: 'INT', value: 10000, group: 'PRICING', ruleId: 'PR-201', ownerOnly: true,
    what: 'Highest discount an owner may apply, in basis points', min: 0, max: 10000,
  },
  cash_rounding_centavos: {
    type: 'INT', value: 1, group: 'PRICING', ruleId: 'MON-008', ownerOnly: true,
    what: 'Cash payable rounding step in centavos; 1 is off', min: 1, max: 100,
  },

  // ── Inventory (INV-*) ─────────────────────────────────────────────────────
  allow_negative_stock: {
    type: 'BOOL', value: false, group: 'INVENTORY', ruleId: 'INV-104', ownerOnly: true,
    what: 'Allow a sale to take stock below zero, flagged and warned',
  },
  adjustment_authorisation_centavos: {
    type: 'INT', value: 500000, group: 'INVENTORY', ruleId: 'INV-108', ownerOnly: true,
    what: 'Adjustment value above which owner authorisation is required', min: 0, max: 100000000,
  },
  // INV-108: "a reason from the configured list". A free-text-only reason is rejected,
  // so the list has to exist somewhere an owner can edit — and a list that lives in
  // code is exactly what OPS-005 is about. JSON rather than a table: it is a short,
  // ordered list of labels with no identity of its own, and nothing references a
  // reason by id.
  adjustment_reasons: {
    type: 'JSON', group: 'INVENTORY', ruleId: 'INV-108', ownerOnly: false,
    what: 'Reasons an inventory adjustment may be filed under',
    value: Object.freeze([
      'Damaged in storage',
      'Spoilage',
      'Physical count correction',
      'Received but not recorded',
      'Internal use',
      'Supplier shortage on delivery',
      'Data entry correction',
    ]),
  },
  stock_count_stale_days: {
    type: 'INT', value: 7, group: 'INVENTORY', ruleId: 'INV-113', ownerOnly: false,
    what: 'Days before an unposted stock count is flagged stale', min: 1, max: 365,
  },
  near_expiry_days: {
    type: 'INT', value: 90, group: 'INVENTORY', ruleId: 'INV-203', ownerOnly: false,
    what: 'Days before expiry at which a batch reads NEAR_EXPIRY', min: 1, max: 730,
  },

  // ── Credit (CR-*) ─────────────────────────────────────────────────────────
  credit_due_soon_days: {
    type: 'INT', value: 3, group: 'CREDIT', ruleId: 'CR-107', ownerOnly: false,
    what: 'Days before a due date at which a balance reads DUE_SOON', min: 1, max: 90,
  },

  // ── Purchasing (PO-*) ─────────────────────────────────────────────────────
  cost_variance_tolerance_bp: {
    type: 'INT', value: 1000, group: 'PURCHASING', ruleId: 'PO-205', ownerOnly: true,
    what: 'Receipt cost variance needing authorisation, in basis points', min: 0, max: 10000,
  },

  // ── Printing (INT-1, INT-2) ───────────────────────────────────────────────
  //
  // The paper width is fixed by the hardware the store bought, and the transport by
  // how it is plugged in. Both are operator-owned in exactly OPS-005's sense: they
  // differ per installation and a build must not assume either.
  receipt_width_columns: {
    type: 'INT', value: 32, group: 'SALES', ruleId: 'INT-1', ownerOnly: false,
    what: 'Receipt width: 32 columns for 58 mm paper, 48 for 80 mm',
    // Not a range: a 40-column thermal head does not exist, and min/max would admit
    // one. The two values are the two paper sizes INT-1 names.
    oneOf: [32, 48],
  },
  printer_transport: {
    type: 'STRING', value: 'NONE', group: 'SALES', ruleId: 'INT-1', ownerOnly: false,
    what: 'How the receipt printer is connected: NONE, USB or LAN',
    oneOf: ['NONE', 'USB', 'LAN'],
  },
  printer_device: {
    type: 'STRING', value: '', group: 'SALES', ruleId: 'INT-1', ownerOnly: false,
    what: 'USB printer device or share the bridge writes to',
  },
  printer_host: {
    type: 'STRING', value: '', group: 'SALES', ruleId: 'INT-1', ownerOnly: false,
    what: 'LAN printer address',
  },
  printer_port: {
    type: 'INT', value: 9100, group: 'SALES', ruleId: 'INT-1', ownerOnly: false,
    what: 'LAN printer port; 9100 is the ESC/POS raw port', min: 1, max: 65535,
  },

  // ── Backup (OPS-*) ────────────────────────────────────────────────────────
  // Set by the wizard (OPS-001), which is why the default is empty: there is no
  // sensible folder to guess before the operator has chosen a drive, and a default
  // pointing inside the application data directory is exactly what OPS-001 forbids.
  backup_folder: {
    type: 'STRING', value: '', group: 'BACKUP', ruleId: 'OPS-001', ownerOnly: true,
    what: 'Folder automatic backups are written to',
  },
  backup_hour: {
    type: 'INT', value: 21, group: 'BACKUP', ruleId: 'OPS-001', ownerOnly: true,
    what: 'Hour of the day (Manila, 0–23) the daily backup runs', min: 0, max: 23,
  },
  backup_retention_count: {
    type: 'INT', value: 30, group: 'BACKUP', ruleId: 'OPS-003', ownerOnly: true,
    what: 'Number of backups kept before the oldest is pruned', min: 1, max: 3650,
  },
});

const KEYS = Object.freeze(Object.keys(REGISTRY));

// ── Typing ──────────────────────────────────────────────────────────────────

/** Storage is TEXT (05_TECH_SPEC.md §3.4); the registry says how to read it back. */
function decode(value, type) {
  switch (type) {
    case 'INT': {
      const n = Number.parseInt(value, 10);
      if (!Number.isInteger(n)) throw new RangeError(`setting is not an integer: ${value}`);
      return n;
    }
    case 'BOOL': return value === '1' || value === 'true';
    case 'JSON': return JSON.parse(value);
    case 'STRING':
    default: return String(value);
  }
}

function encode(value, type) {
  if (type === 'BOOL') return value ? '1' : '0';
  if (type === 'JSON') return JSON.stringify(value);
  return String(value);
}

/**
 * A setting whose values are an enumeration rather than a range.
 *
 * Bounds are the wrong shape for a figure with a fixed set of legal values: 32 to 48
 * columns admits 40, and no thermal printer has a 40-column head. `oneOf` says what
 * the values actually are, and the refusal lists them.
 */
function assertOneOf(key, value, declared) {
  if (!declared.oneOf || declared.oneOf.includes(value)) return value;
  throw errors.badRequest(
    `${key} must be one of ${declared.oneOf.join(', ')}`,
    { ruleId: declared.ruleId }
  );
}

function declaration(key) {
  const declared = REGISTRY[key];
  if (!declared) {
    throw errors.badRequest(`No such setting: ${key}`, { ruleId: 'OPS-005' });
  }
  return declared;
}

/**
 * Coerce and bounds-check an incoming value.
 *
 * The renderer sends JSON, so an INT may arrive as a string from a form field and a
 * BOOL as the word "true". Coercing here rather than at each call site is what keeps
 * "1" and 1 from being two different settings.
 */
function coerce(key, raw) {
  const declared = declaration(key);

  if (declared.immutable) {
    throw errors.badRequest(
      `"${declared.what}" is fixed by ${declared.ruleId} and is not configurable.`,
      { ruleId: declared.ruleId }
    );
  }

  if (declared.type === 'INT') {
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw).trim(), 10);
    if (!Number.isInteger(n)) {
      throw errors.badRequest(`${key} must be a whole number`, { ruleId: declared.ruleId });
    }
    assertOneOf(key, n, declared);
    if (declared.min !== undefined && n < declared.min) {
      throw errors.badRequest(`${key} may not be below ${declared.min}`, { ruleId: declared.ruleId });
    }
    if (declared.max !== undefined && n > declared.max) {
      throw errors.badRequest(`${key} may not be above ${declared.max}`, { ruleId: declared.ruleId });
    }
    return n;
  }

  if (declared.type === 'BOOL') {
    if (typeof raw === 'boolean') return raw;
    const text = String(raw).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(text)) return true;
    if (['false', '0', 'no', 'off'].includes(text)) return false;
    throw errors.badRequest(`${key} must be true or false`, { ruleId: declared.ruleId });
  }

  if (declared.type === 'JSON') {
    const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(list) || list.length === 0) {
      throw errors.badRequest(`${key} must be a non-empty list`, { ruleId: declared.ruleId });
    }
    const cleaned = list.map((item) => String(item).trim()).filter(Boolean);
    if (cleaned.length !== list.length) {
      throw errors.badRequest(`${key} may not contain a blank entry`, { ruleId: declared.ruleId });
    }
    return cleaned;
  }

  const text = String(raw === null || raw === undefined ? '' : raw).trim();
  if (declared.required && text === '') {
    throw errors.badRequest(`${key} is required`, { ruleId: declared.ruleId });
  }
  if (declared.oneOf) {
    const upper = text.toUpperCase();
    assertOneOf(key, upper, declared);
    return upper;
  }
  return text;
}

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * The stored value, or the declared default where the store has not set one.
 *
 * The fallback matters on an upgrade: a new key added to this registry by a later
 * version reads its default on a database seeded by an earlier one, so a build never
 * has to migrate settings rows to be usable.
 */
function get(key) {
  const declared = declaration(key);
  const row = settingsRepository.get(key);
  if (!row) return declared.value;
  try {
    return decode(row.value, row.value_type);
  } catch {
    // A corrupted row is not worth taking the application down for; the declared
    // default is always a safe figure, and the health panel reports the row (OPS-006).
    return declared.value;
  }
}

/** Every setting with the metadata SCR-702 renders: group, rule, bounds, default. */
function describe({ includeOwnerOnly = true } = {}) {
  return KEYS
    .filter((key) => includeOwnerOnly || !REGISTRY[key].ownerOnly)
    .map((key) => {
      const declared = REGISTRY[key];
      const row = settingsRepository.get(key);
      return {
        key,
        value: get(key),
        value_type: declared.type,
        group: declared.group,
        group_label: GROUPS[declared.group],
        rule_id: declared.ruleId,
        what: declared.what,
        default_value: declared.value,
        min: declared.min ?? null,
        max: declared.max ?? null,
        one_of: declared.oneOf ?? null,
        owner_only: Boolean(declared.ownerOnly),
        immutable: Boolean(declared.immutable),
        is_default: !row,
        updated_at: row ? row.updated_at : null,
        updated_by: row ? row.updated_by : null,
      };
    });
}

// ── Writing ─────────────────────────────────────────────────────────────────

/**
 * Write without auditing. Used only by the setup wizard's seed, where the audit row
 * would name a user who does not exist yet and the whole installation is one event.
 */
function put(key, value, { updatedAt = null, updatedBy = null } = {}) {
  const declared = declaration(key);
  settingsRepository.put({
    key,
    value: encode(value, declared.type),
    valueType: declared.type,
    updatedAt,
    updatedBy,
  });
  return get(key);
}

/**
 * Seed every declared key at its default (TASK-004 requirement 7).
 *
 * Called inside the wizard's transaction. Existing rows are left alone so that
 * re-seeding after an upgrade adds the new keys without resetting the operator's
 * figures.
 */
function seedDefaults({ at = clock.nowUtc(), by = null, overrides = {} } = {}) {
  const written = [];
  for (const key of KEYS) {
    if (settingsRepository.get(key)) continue;
    const value = Object.prototype.hasOwnProperty.call(overrides, key)
      ? coerceForSeed(key, overrides[key])
      : REGISTRY[key].value;
    put(key, value, { updatedAt: at, updatedBy: by });
    written.push(key);
  }
  return written;
}

/** Seeding may set an immutable key to its declared value; changing one later may not. */
function coerceForSeed(key, raw) {
  const declared = declaration(key);
  if (declared.immutable) return declared.value;
  return coerce(key, raw);
}

/**
 * Change a setting. AUD-601 lists "settings change" among the writes that audit
 * without exception, and TC-UT-05 asserts the row carries **both** values — a trail
 * that records only the new figure cannot answer "what was it before", which is the
 * only question anyone asks of it.
 *
 * The caller supplies the transaction where several settings move together, so the
 * audit row and the change commit as one.
 */
function set(key, raw, actor, { reason = null } = {}) {
  const declared = declaration(key);
  const value = coerce(key, raw);
  const before = get(key);

  if (before === value) return { key, value, changed: false };

  const at = clock.nowUtc();
  put(key, value, { updatedAt: at, updatedBy: actor && actor.id ? actor.id : null });

  auditService.write({
    actor,
    action: 'SETTING_CHANGED',
    entityType: 'system_settings',
    entityId: key,
    before: { [key]: before },
    after: { [key]: value },
    reason: reason || `${declared.what} (${declared.ruleId})`,
  });

  return { key, value, before, changed: true };
}

/**
 * Apply a whole SCR-702 form in one transaction.
 *
 * A save that applies four of six figures and refuses the fifth leaves the operator
 * with a screen whose state they cannot reconstruct, so every key is authorised before
 * any key is written and the lot commits together. Each accepted key still writes its
 * own audit row (AUD-601) inside that transaction.
 */
function setMany(changes, session, { reason = null } = {}) {
  const keys = Object.keys(changes).filter((key) => key !== 'reason');
  return db.transaction(() => {
    for (const key of keys) assertMayChange(session, key);
    return keys.map((key) => set(key, changes[key], session, { reason }));
  });
}

/**
 * SEC-6 applied to a single field rather than a route.
 *
 * TX-424 opens the settings door for a manager at level LIMITED. This is where
 * "limited" is given a meaning: the manager passes the middleware and is still refused
 * the keys marked ownerOnly, with the rule id the UI needs to say why.
 */
function assertMayChange(session, key) {
  const declared = declaration(key);
  if (!declared.ownerOnly) return;
  if (session && session.role === 'OWNER') return;
  throw errors.forbidden(
    `Only the owner may change "${declared.what.toLowerCase()}".`,
    { ruleId: 'TX-424', requiresRole: 'OWNER' }
  );
}

module.exports = {
  GROUPS, REGISTRY, KEYS,
  decode, encode, coerce, declaration,
  get, describe, put, seedDefaults, set, setMany, assertMayChange,
};
