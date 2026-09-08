'use strict';

// The settings registry and the store profile over HTTP: TC-UT-05 (a change writes one
// audit row carrying both values), the TX-424 / TX-425 boundary, and the FR_1.1 gate.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const authService = require('../../services/authService');
const auditService = require('../../services/auditService');
const settingsService = require('../../services/settingsService');
const temp = require('../helpers/tempdb');

// Port 0: the OS picks a free one and the real port is read back off the server.
// A fixed port collides whenever two runs overlap or a socket lingers, which is a
// flake that looks like a defect in whatever test happens to be running.
let BASE = null;
const PASSWORD = 'correct-horse-battery';

let instance;
const tokens = {};

const call = (path, { token = null, method = 'GET', body = null } = {}) => fetch(`${BASE}${path}`, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

test.before(async () => {
  temp.openEmpty('settings');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;
  temp.seedStore({ storeName: 'Chachi Agrivet Supply', taxMode: 'NON_VAT', withOwner: false });

  for (const role of ['OWNER', 'MANAGER', 'CASHIER']) {
    const username = role.toLowerCase();
    temp.seedUser({ username, role, password: PASSWORD });
    tokens[role] = authService.login({ username, password: PASSWORD }).token;
  }
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── Reading (SCR-702) ───────────────────────────────────────────────────────

test('GET /settings returns the whole OPS-005 list with the metadata SCR-702 renders', async () => {
  const res = await call('/settings', { token: tokens.OWNER });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.settings.length, settingsService.KEYS.length);
  for (const setting of body.settings) {
    assert.ok(body.groups[setting.group], `${setting.key}: its group is a section of the screen`);
    assert.ok(setting.rule_id, `${setting.key}: 04_UX_SPEC.md §3 puts the rule id in a tooltip`);
    assert.ok(setting.what, `${setting.key}: a label an operator can read`);
    assert.notEqual(setting.value, undefined);
  }

  const nearExpiry = body.settings.find((s) => s.key === 'near_expiry_days');
  assert.deepEqual(
    { value: nearExpiry.value, rule: nearExpiry.rule_id, min: nearExpiry.min, max: nearExpiry.max },
    { value: 90, rule: 'INV-203', min: 1, max: 730 }
  );
});

// ── TC-UT-05 — the audit row (AUD-601, AUD-606) ─────────────────────────────

test('TC-UT-05: a settings change writes exactly one audit row carrying both values', async () => {
  const before = settingsService.get('near_expiry_days');
  assert.equal(before, 90);

  const res = await call('/settings', {
    token: tokens.OWNER,
    method: 'PUT',
    body: { near_expiry_days: 45 },
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).changed, ['near_expiry_days']);

  const rows = auditService.list({ entityType: 'system_settings', entityId: 'near_expiry_days' });
  assert.equal(rows.length, 1, 'exactly one row, not one per read and one per write');

  // Both values. A trail that records only the new figure cannot answer "what was it
  // before", which is the only question anyone ever asks of it.
  assert.deepEqual(JSON.parse(rows[0].before_value), { near_expiry_days: 90 });
  assert.deepEqual(JSON.parse(rows[0].after_value), { near_expiry_days: 45 });
  assert.equal(rows[0].action, 'SETTING_CHANGED');
  assert.equal(rows[0].actor_username, 'owner');
  assert.ok(rows[0].reason.includes('INV-203'), 'the rule travels with the row');

  assert.equal(settingsService.get('near_expiry_days'), 45);
});

test('a write that changes nothing writes nothing', async () => {
  const current = settingsService.get('credit_due_soon_days');
  const res = await call('/settings', {
    token: tokens.OWNER, method: 'PUT', body: { credit_due_soon_days: current },
  });

  assert.deepEqual((await res.json()).changed, []);
  assert.equal(auditService.list({ entityId: 'credit_due_soon_days' }).length, 0);
});

test('a refused key leaves the whole save unapplied', async () => {
  const before = settingsService.get('stock_count_stale_days');

  // One good key, one out of bounds. SCR-702 is a form with a save button: applying
  // half of it leaves the operator with a screen they cannot reconstruct.
  const res = await call('/settings', {
    token: tokens.OWNER,
    method: 'PUT',
    body: { stock_count_stale_days: 14, near_expiry_days: 99999 },
  });

  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.rule_id, 'INV-203');
  assert.equal(settingsService.get('stock_count_stale_days'), before, 'rolled back');
});

// ── TX-424: what "LIMITED" means for a manager ──────────────────────────────

test('a manager may change the figures they work with daily', async () => {
  const res = await call('/settings', {
    token: tokens.MANAGER,
    method: 'PUT',
    body: { cash_variance_tolerance_centavos: 20000 },
  });

  assert.equal(res.status, 200, 'TX-424 admits a manager at LIMITED');
  assert.equal(settingsService.get('cash_variance_tolerance_centavos'), 20000);
});

test('a manager may not change the figures that govern access, money given away, or backups', async () => {
  for (const key of ['idle_timeout_minutes', 'discount_ceiling_manager_bp', 'backup_folder', 'lockout_threshold']) {
    const before = settingsService.get(key);
    const res = await call('/settings', { token: tokens.MANAGER, method: 'PUT', body: { [key]: 99 } });

    assert.equal(res.status, 403, `${key} is owner-only`);
    const body = await res.json();
    assert.equal(body.error.rule_id, 'TX-424');
    assert.equal(body.error.requires_role, 'OWNER');
    assert.deepEqual(settingsService.get(key), before, `${key} unchanged`);
  }
});

test('a cashier does not reach the settings screen at all', async () => {
  const res = await call('/settings', { token: tokens.CASHIER });
  assert.equal(res.status, 403, 'TX-424 holds no grant for a cashier');
  assert.equal((await res.json()).error.code, 'FORBIDDEN');
});

test('a figure a rule fixes is refused even to the owner', async () => {
  const res = await call('/settings', {
    token: tokens.OWNER, method: 'PUT', body: { void_window_shift_only: false },
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.rule_id, 'POS-402');
});

// ── TX-425: the tax mode (TAX-001) ──────────────────────────────────────────

test('changing the tax mode requires TX-425 and is audited with both values', async () => {
  const refused = await call('/store-profile/tax-mode', {
    token: tokens.MANAGER, method: 'PUT', body: { taxMode: 'VAT' },
  });
  assert.equal(refused.status, 403, 'TX-425 is owner-only, unlike TX-424');
  assert.equal((await refused.json()).error.rule_id, 'TX-425');

  const res = await call('/store-profile/tax-mode', {
    token: tokens.OWNER, method: 'PUT', body: { taxMode: 'VAT' },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).profile.tax_mode, 'VAT');

  const rows = auditService.list({ action: 'TAX_MODE_CHANGED' });
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].before_value), { tax_mode: 'NON_VAT' });
  assert.deepEqual(JSON.parse(rows[0].after_value), { tax_mode: 'VAT' });
  assert.equal(rows[0].actor_username, 'owner');
});

test('an unknown tax mode is refused, naming TAX-001', async () => {
  const res = await call('/store-profile/tax-mode', {
    token: tokens.OWNER, method: 'PUT', body: { taxMode: 'PERCENTAGE' },
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.rule_id, 'TAX-001');
});

test('the tax mode cannot be moved through the general settings route', async () => {
  // TX-424 must not become a way to reach TX-425. The key is not in the registry, so
  // the write is refused as an unknown setting rather than silently ignored.
  const res = await call('/settings', {
    token: tokens.OWNER, method: 'PUT', body: { tax_mode: 'NONE' },
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.rule_id, 'OPS-005');
});

// ── The store profile ───────────────────────────────────────────────────────

test('the store profile is editable under TX-424 and audited, tax mode untouched', async () => {
  const res = await call('/store-profile', {
    token: tokens.OWNER, method: 'PUT', body: { storeName: 'Chachi Agrivet Supply II', address: 'Poblacion' },
  });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.profile.store_name, 'Chachi Agrivet Supply II');
  assert.equal(body.profile.tax_mode, 'VAT', 'unchanged by an identity edit');

  const rows = auditService.list({ action: 'STORE_PROFILE_CHANGED' });
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].before_value).store_name, 'Chachi Agrivet Supply');
});
