'use strict';

// TC-E2E-13 — an installer configures a store from the settings screen.
//
// `DEPLOYMENT.md` §4 tells the installer to set the printer transport, the receipt
// width and the backup folder before they leave the shop. Until `TASK-039` there was
// no screen, so the only route was `PUT /settings` from a terminal on a store counter.
//
// This walks that configuration through the endpoints `SCR-702` calls, and asserts the
// two things the screen is answerable for: that **the registry is the only source of
// truth** — a value outside its declared bounds or enumeration is refused with its rule
// named — and that **every change is audited with both values** (`AUD-601`).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const server = require('../../server');
const authService = require('../../services/authService');
const auditService = require('../../services/auditService');
const settingsService = require('../../services/settingsService');
const temp = require('../helpers/tempdb');

const PASSWORD = 'sack-of-feed-2026';

let instance;
let BASE = null;
let ownerToken;
let managerToken;
let backupFolder;

const call = (pathname, { method = 'GET', body = null, token = null } = {}) => fetch(`${BASE}${pathname}`, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

const json = async (res) => {
  const body = await res.json();
  assert.ok(res.ok, `${res.status} ${JSON.stringify(body)}`);
  return body;
};

test.before(async () => {
  temp.openMigrated('settings-e2e');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;

  temp.seedStore({ withOwner: false, taxMode: 'NONE' });
  temp.seedUser({ username: 'chachi', role: 'OWNER', password: PASSWORD });
  temp.seedUser({ username: 'mgr', role: 'MANAGER', password: PASSWORD });
  ownerToken = authService.login({ username: 'chachi', password: PASSWORD }).token;
  managerToken = authService.login({ username: 'mgr', password: PASSWORD }).token;

  backupFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-settings-'));
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── What the screen renders from ────────────────────────────────────────────

test('TC-E2E-13: the screen is given the whole registry, and its groups', async () => {
  const body = await json(await call('/settings', { token: ownerToken }));

  assert.equal(body.settings.length, settingsService.KEYS.length,
    'every registered setting reaches the screen');
  assert.deepEqual(Object.keys(body.groups).sort(), Object.keys(settingsService.GROUPS).sort());

  // The declaration the screen builds each field from. If any of these stopped being
  // sent, SCR-702 would have to know them itself — which is the second registry
  // OPS-005 exists to prevent.
  for (const setting of body.settings) {
    assert.ok(setting.key && setting.value_type && setting.group, setting.key);
    assert.ok(setting.rule_id, `${setting.key} carries its rule`);
    assert.ok(setting.what, `${setting.key} says what it does`);
    assert.ok('default_value' in setting, `${setting.key} states its default`);
    assert.equal(typeof setting.is_default, 'boolean');
  }

  // Bounded and enumerated settings carry what bounds them.
  const width = body.settings.find((s) => s.key === 'receipt_width_columns');
  assert.ok(width.one_of || (width.min !== null && width.max !== null),
    'the receipt width tells the screen what it may be');
});

// ── The installer's own sequence ────────────────────────────────────────────

test('TC-E2E-13: the printer is configured from the screen (INT-1)', async () => {
  const saved = await json(await call('/settings', {
    method: 'PUT', token: ownerToken,
    body: {
      printer_transport: 'USB',
      printer_device: '\\\\SHOPPC\\POS-58',
      // 48 rather than 32: 32 is already the default, and a save reports what changed
      // rather than what was sent.
      receipt_width_columns: 48,
    },
  }));

  assert.deepEqual(saved.changed.sort(),
    ['printer_device', 'printer_transport', 'receipt_width_columns']);
  assert.equal(settingsService.get('printer_transport'), 'USB');
  assert.equal(settingsService.get('receipt_width_columns'), 48);
});

test('TC-E2E-13: the test page prints, or says it queued (INT-1)', async () => {
  const result = await json(await call('/print/test', { method: 'POST', token: ownerToken }));

  assert.ok(result.document.text.length > 0);
  // TAX-006 holds for every document, a test page included.
  assert.match(result.document.text, /not an official receipt/i);
  assert.match(result.document.text, /PRINTER TEST/);
  // No printer on a build machine, so it queues — which is what the screen reports.
  assert.equal(typeof result.printed.delivered, 'boolean');
});

test('TC-E2E-13: the receipt width is refused a value the registry does not allow', async () => {
  const refused = await call('/settings', {
    method: 'PUT', token: ownerToken, body: { receipt_width_columns: 40 },
  });

  assert.equal(refused.status, 400);
  const error = (await refused.json()).error;
  // A 40-column thermal head does not exist, and the refusal says which rule knows so.
  assert.ok(error.message.includes('receipt_width_columns') || /40/.test(error.message), error.message);
  assert.equal(settingsService.get('receipt_width_columns'), 48, 'and nothing changed');
});

test('TC-E2E-13: a figure outside its bounds is refused, naming the setting', async () => {
  const refused = await call('/settings', {
    method: 'PUT', token: ownerToken, body: { lockout_threshold: 0 },
  });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error.message, /lockout_threshold/);
});

test('TC-E2E-13: the backup folder is set, and OPS-001 refuses one inside app data', async () => {
  const paths = require('../../config/paths');

  const refused = await call('/settings', {
    method: 'PUT', token: ownerToken, body: { backup_folder: paths.dataDir() },
  });
  assert.equal(refused.status, 400);
  // OPS-001: a backup inside the folder being backed up survives exactly the failures
  // that do not matter. The screen surfaces this rather than pre-empting it.
  assert.match((await refused.json()).error.message, /outside the application data folder/i);

  await json(await call('/settings', {
    method: 'PUT', token: ownerToken, body: { backup_folder: backupFolder },
  }));
  assert.equal(settingsService.get('backup_folder'), backupFolder);
});

// ── Who may change what ─────────────────────────────────────────────────────

test('TC-E2E-13: a manager may change a shared setting but not an owner-only one', async () => {
  // TX-424 is LIMITED for a manager: they run the shop day to day.
  await json(await call('/settings', {
    method: 'PUT', token: managerToken, body: { cash_variance_tolerance_centavos: 15000 },
  }));
  assert.equal(settingsService.get('cash_variance_tolerance_centavos'), 15000);

  // The backup folder is the store's last line of defence, and it is the owner's.
  const refused = await call('/settings', {
    method: 'PUT', token: managerToken, body: { backup_folder: '/tmp/somewhere-else' },
  });
  assert.equal(refused.status, 403);
  const error = (await refused.json()).error;
  assert.equal(error.rule_id, 'TX-424');
  assert.equal(error.requires_role, 'OWNER');
  assert.equal(settingsService.get('backup_folder'), backupFolder, 'and it did not move');
});

test('TC-E2E-13: a cashier reaches the screen at all', async () => {
  temp.seedUser({ username: 'till', role: 'CASHIER', password: PASSWORD });
  const cashier = authService.login({ username: 'till', password: PASSWORD }).token;

  assert.equal((await call('/settings', { token: cashier })).status, 403);
});

// ── TAX-001 ─────────────────────────────────────────────────────────────────

test('TC-E2E-13: the tax mode is owner-only and audited with both values', async () => {
  const refused = await call('/store-profile/tax-mode', {
    method: 'PUT', token: managerToken, body: { taxMode: 'VAT' },
  });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.rule_id, 'TX-425');

  const changed = await json(await call('/store-profile/tax-mode', {
    method: 'PUT', token: ownerToken,
    body: { taxMode: 'NON_VAT', reason: 'Registered with the BIR this morning' },
  }));
  assert.equal(changed.profile.tax_mode, 'NON_VAT');

  const audited = auditService.list({ action: 'TAX_MODE_CHANGED' });
  assert.ok(audited.length >= 1);
  assert.match(audited[0].before_value, /NONE/);
  assert.match(audited[0].after_value, /NON_VAT/);
  assert.match(audited[0].reason, /Registered with the BIR/);

  // Put it back, so the rest of the suite sees the store it expects.
  await json(await call('/store-profile/tax-mode', {
    method: 'PUT', token: ownerToken, body: { taxMode: 'NONE', reason: 'Test cleanup' },
  }));
});

// ── AUD-601 ─────────────────────────────────────────────────────────────────

test('TC-E2E-13: every settings change is audited with before and after', async () => {
  const before = settingsService.get('shift_max_open_hours');

  await json(await call('/settings', {
    method: 'PUT', token: ownerToken,
    body: { shift_max_open_hours: 12, reason: 'The shop shuts at seven' },
  }));

  const audited = auditService.list({ action: 'SETTING_CHANGED' })
    .find((row) => row.entity_id === 'shift_max_open_hours');

  assert.ok(audited, 'the change is on the trail');
  assert.match(audited.before_value, new RegExp(String(before)));
  assert.match(audited.after_value, /12/);
  assert.match(audited.reason, /shuts at seven/);
});

test('TC-E2E-13: a saved section reports what actually changed, not what was sent', async () => {
  // Sending a value that is already set is not a change, and an audit row for it would
  // be noise in the one place noise costs the most.
  const result = await json(await call('/settings', {
    method: 'PUT', token: ownerToken,
    body: { shift_max_open_hours: 12, lockout_minutes: settingsService.get('lockout_minutes') },
  }));

  assert.deepEqual(result.changed, [], 'nothing moved, so nothing is reported');
});

test('TC-E2E-13: the screen sees its own changes reflected back', async () => {
  const body = await json(await call('/settings', { token: ownerToken }));
  const width = body.settings.find((s) => s.key === 'receipt_width_columns');

  assert.equal(width.value, 48);
  assert.equal(width.is_default, false, 'and it knows the figure is no longer the default');
  assert.ok(width.updated_at);
});
