'use strict';

// The audit trail against a real database and over HTTP: the two-actor override shape
// (AUD-603), the transaction contract, attribution surviving a deactivated user
// (AUD-606), and SCR-703's browse and export under TX-429.

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server');
const db = require('../../config/database');
const authService = require('../../services/authService');
const auditService = require('../../services/auditService');
const userService = require('../../services/userService');
const settingsService = require('../../services/settingsService');
const auditRepository = require('../../repositories/auditRepository');
const temp = require('../helpers/tempdb');

const PORT = 47894;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'correct-horse-battery';

let instance;
const tokens = {};
const users = {};

const call = (path, { token = null, method = 'GET' } = {}) => fetch(`${BASE}${path}`, {
  method,
  headers: token ? { authorization: `Bearer ${token}` } : {},
});

test.before(async () => {
  temp.openEmpty('audit');
  instance = await server.start({ listenPort: PORT });
  temp.seedStore({ withOwner: false });

  for (const role of ['OWNER', 'MANAGER', 'CASHIER']) {
    const username = role.toLowerCase();
    users[role] = temp.seedUser({ username, role, password: PASSWORD });
    tokens[role] = authService.login({ username, password: PASSWORD }).token;
  }
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── AUD-603: two distinct actors ────────────────────────────────────────────

test('TC-INT-41: an override records the requester and the approver as distinct actors', () => {
  // The shape the rule is about. TASK-008 supplies the over-limit credit sale that
  // raises this one for real (CR-104); what is settled here is that the trail can
  // carry two actors at all, which is the half that cannot be retrofitted later.
  auditService.recordOverride({
    action: 'OVERRIDE_CREDIT_OVER_LIMIT',
    actor: { id: users.CASHIER.id, username: 'cashier' },
    approver: { id: users.MANAGER.id, username: 'manager' },
    reason: 'Regular farm customer, harvest next week',
    entityType: 'customers',
    entityId: 'customer-1',
    after: { limit_centavos: 5000000, balance_centavos: 5200000 },
  });

  const [row] = auditRepository.list({ action: 'OVERRIDE_CREDIT_OVER_LIMIT' });

  assert.equal(row.actor_username, 'cashier', 'the requesting user');
  assert.equal(row.approver_username, 'manager', 'the approving user');
  assert.notEqual(row.actor_id, row.approver_id, 'two distinct actors, not one');
  assert.equal(row.reason, 'Regular farm customer, harvest next week');
});

test('an override without an approver, or without a reason, is refused', () => {
  const base = {
    action: 'OVERRIDE_BELOW_COST_SALE',
    actor: { id: users.CASHIER.id, username: 'cashier' },
    entityType: 'sales',
    reason: 'Clearance',
  };

  assert.throws(() => auditService.recordOverride({ ...base, approver: null }), /approver/);
  assert.throws(
    () => auditService.recordOverride({ ...base, approver: { id: users.OWNER.id, username: 'owner' }, reason: null }),
    /reason/
  );
});

test('a user may not approve their own override', () => {
  // "Distinct actors" is the rule's own wording, and self-approval is the failure the
  // two columns exist to make visible — so it is refused rather than recorded as if it
  // were an authorisation.
  assert.throws(
    () => auditService.recordOverride({
      action: 'OVERRIDE_DISCOUNT_ABOVE_CEILING',
      actor: { id: users.MANAGER.id, username: 'manager' },
      approver: { id: users.MANAGER.id, username: 'manager' },
      reason: 'Because I said so',
      entityType: 'sales',
    }),
    (err) => err.status === 403 && err.ruleId === 'AUD-603'
  );
});

test('a non-override action refuses to be written through the override path', () => {
  assert.throws(
    () => auditService.recordOverride({
      action: 'SETTING_CHANGED',
      actor: { id: users.OWNER.id, username: 'owner' },
      approver: { id: users.MANAGER.id, username: 'manager' },
      reason: 'x',
      entityType: 'system_settings',
    }),
    RangeError
  );
});

// ── The transaction contract ────────────────────────────────────────────────

test('an audit write inside a rolled-back business transaction rolls back with it', () => {
  const before = auditRepository.countAll();

  assert.throws(() => db.transaction(() => {
    auditService.write({
      actor: { id: users.OWNER.id, username: 'owner' },
      action: 'INVENTORY_ADJUSTED',
      entityType: 'inventory',
      entityId: 'product-1',
      after: { qty_milli: 5000 },
    });
    throw new Error('the business rule refused after the row was written');
  }), /refused after/);

  // A row claiming something that never happened is worse than no row at all: the
  // trail's value is that everything in it is true.
  assert.equal(auditRepository.countAll(), before, 'the audit row went back with the transaction');
});

test('an audit write commits with the change it records, not separately', () => {
  const before = auditRepository.countAll();

  db.transaction(() => {
    auditService.write({
      actor: { id: users.OWNER.id, username: 'owner' },
      action: 'STOCK_COUNT_POSTED',
      entityType: 'stock_counts',
      entityId: 'count-1',
      after: { posted: true },
    });
  });

  assert.equal(auditRepository.countAll(), before + 1);
});

// ── AUD-606: attribution survives a deactivated user ────────────────────────

test('deactivating a user leaves their historical rows fully attributed', () => {
  const doomed = temp.seedUser({ username: 'temporary', role: 'CASHIER', password: PASSWORD });

  auditService.write({
    actor: { id: doomed.id, username: doomed.username },
    action: 'RECEIPT_REPRINTED',
    entityType: 'sales',
    entityId: 'sale-1',
    reason: 'Customer asked for a second copy',
  });

  userService.update(doomed.id, { isActive: false }, { id: users.OWNER.id, username: 'owner' });

  const [row] = auditRepository.list({ action: 'RECEIPT_REPRINTED' });
  assert.equal(row.actor_username, 'temporary', 'AUD-606: the denormalised username stands');
  assert.equal(row.actor_id, doomed.id, 'and the id is still there to join on');

  // The deactivation itself is on the trail too.
  const [deactivation] = auditRepository.list({ action: 'USER_DEACTIVATED', entityId: doomed.id });
  assert.equal(deactivation.actor_username, 'owner');
});

test('a role change is findable as a role change, not buried in a generic modify', () => {
  const moved = temp.seedUser({ username: 'promoted', role: 'CASHIER', password: PASSWORD });
  const owner = { id: users.OWNER.id, username: 'owner' };

  userService.update(moved.id, { role: 'MANAGER' }, owner);
  const [row] = auditRepository.list({ action: 'ROLE_CHANGED', entityId: moved.id });

  assert.ok(row, 'AUD-601 lists role change separately from user modify');
  assert.deepEqual(JSON.parse(row.before_value), { role: 'CASHIER' });
  assert.deepEqual(JSON.parse(row.after_value), { role: 'MANAGER' });

  // A form that posts an unchanged role is not a demotion nobody performed.
  userService.update(moved.id, { role: 'MANAGER', fullName: 'Promoted Person' }, owner);
  assert.equal(auditRepository.list({ action: 'ROLE_CHANGED', entityId: moved.id }).length, 1);
  assert.equal(auditRepository.list({ action: 'USER_MODIFIED', entityId: moved.id }).length, 1);
});

test('a password reset through user administration is audited without the password', () => {
  const target = temp.seedUser({ username: 'forgetful', role: 'CASHIER', password: PASSWORD });

  userService.update(target.id, { password: 'a-completely-new-password' }, { id: users.OWNER.id, username: 'owner' });

  const [row] = auditRepository.list({ action: 'PASSWORD_RESET', entityId: target.id });
  assert.ok(row, 'AUD-601 lists password reset');
  assert.deepEqual(JSON.parse(row.after_value), { password_changed: true });
  assert.equal(JSON.stringify(row).includes('a-completely-new-password'), false, 'SEC-1');
});

// ── Redaction at the write, not just in the helper ──────────────────────────

test('a hash reaching write() is stripped before the row is stored', () => {
  const hash = '$2b$12$0123456789012345678901uvwxyzABCDEFGHIJKLMNOPQRSTUVW';

  auditService.write({
    actor: { id: users.OWNER.id, username: 'owner' },
    action: 'USER_MODIFIED',
    entityType: 'users',
    entityId: 'someone',
    before: { password_hash: hash },
    after: { password_hash: hash, note: hash },
  });

  const [row] = auditRepository.list({ entityId: 'someone' });
  assert.equal(row.before_value.includes(hash), false, 'stripped by the service, not the caller');
  assert.equal(row.after_value.includes(hash), false);
  assert.deepEqual(JSON.parse(row.after_value), {
    password_hash: auditService.REDACTED, note: auditService.REDACTED,
  });
});

// ── Browse (requirement 5, SCR-703) ─────────────────────────────────────────

test('browse filters by action, entity and actor, and pages', () => {
  const total = auditService.browse({ limit: 1 }).total;
  assert.ok(total > 5, 'the cases above have filled the trail');

  const byAction = auditService.browse({ action: 'ROLE_CHANGED' });
  assert.ok(byAction.total >= 1);
  assert.ok(byAction.rows.every((r) => r.action === 'ROLE_CHANGED'));

  const byActor = auditService.browse({ actorUsername: 'OWNER' });   // NOCASE
  assert.ok(byActor.total >= 1);
  assert.ok(byActor.rows.every((r) => r.actor.username === 'owner'));

  const byEntity = auditService.browse({ entityType: 'users' });
  assert.ok(byEntity.rows.every((r) => r.entity_type === 'users'));

  // Paging: two pages of one do not repeat a row, and the total does not move.
  const first = auditService.browse({ limit: 1, offset: 0 });
  const second = auditService.browse({ limit: 1, offset: 1 });
  assert.equal(first.total, second.total);
  assert.notEqual(first.rows[0].id, second.rows[0].id);
});

test('browse presents a row as SCR-703 shows it', () => {
  const { rows } = auditService.browse({ action: 'OVERRIDE_CREDIT_OVER_LIMIT' });
  const row = rows[0];

  assert.equal(row.action_label, 'Over-limit credit sale authorised', 'not SCREAMING_SNAKE_CASE');
  assert.deepEqual(row.approver, { id: users.MANAGER.id, username: 'manager' });
  assert.equal(typeof row.after, 'object', 'JSON is parsed, not handed over as text');
  assert.match(row.occurred_at, /Z$/, 'VR-102: stored UTC');
  assert.ok(row.occurred_at_manila.length > 0, 'and rendered Manila beside it');
});

test('a date filter covers the Manila day, and an unknown action is refused', () => {
  const today = require('../../config/clock').manilaDate(new Date().toISOString());
  assert.ok(auditService.browse({ from: today, to: today }).total > 0, "today's rows");
  assert.equal(auditService.browse({ from: '2020-01-01', to: '2020-01-02' }).total, 0);

  assert.throws(() => auditService.browse({ action: 'NOT_AN_ACTION' }), RangeError);
});

// ── Over HTTP: TX-429 (TC-API-01) ───────────────────────────────────────────

test('TC-API-01: browsing the trail needs TX-429', async () => {
  const owner = await call('/audit', { token: tokens.OWNER });
  assert.equal(owner.status, 200);

  const manager = await call('/audit', { token: tokens.MANAGER });
  assert.equal(manager.status, 200, '§10 grants TX-429 to a manager too');

  const cashier = await call('/audit', { token: tokens.CASHIER });
  assert.equal(cashier.status, 403);
  const body = await cashier.json();
  assert.equal(body.error.code, 'FORBIDDEN');
  assert.equal(body.error.rule_id, 'TX-429');

  assert.equal((await call('/audit')).status, 401, 'and a session is required at all');
});

test('the browse endpoint carries what SCR-703 builds its filters from', async () => {
  const res = await call('/audit?limit=5', { token: tokens.OWNER });
  const body = await res.json();

  assert.equal(body.rows.length, 5);
  assert.equal(body.limit, 5);
  assert.ok(body.total > 5);
  assert.ok(body.actions.some((a) => a.value === 'ROLE_CHANGED' && a.label === 'Role changed'));
  assert.ok(body.actors.some((a) => a.username === 'owner' && a.rows_written > 0));
});

test('the trail is read-only over HTTP: there is no write route', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await call('/audit', { token: tokens.OWNER, method });
    assert.equal(res.status, 404, `AUD-605: ${method} /audit does not exist`);
  }
});

// ── Export (requirement 5) ──────────────────────────────────────────────────

test('the export is CSV, complete, and carries the approver column', async () => {
  // Read before the export runs: exporting writes its own AUDIT_EXPORTED row, and that
  // row is written after the CSV is built, so it is correctly not in its own output.
  const total = auditService.browse({ limit: 1 }).total;
  const res = await call('/audit/export', { token: tokens.OWNER });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="audit-\d{4}-\d{2}-\d{2}\.csv"/);

  const csv = await res.text();
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], auditService.CSV_COLUMNS.join(','));
  assert.ok(lines[0].includes('approver_username'), 'AUD-603 survives the export');

  // Every row of the trail is in it — an export that silently stops at page one is
  // worse than none, because the reader cannot tell.
  assert.equal(lines.length, total + 1, 'header plus every row');
  assert.ok(csv.includes('Over-limit credit sale authorised'));
});

test('exporting the trail is itself audited (AUD-601)', async () => {
  const before = auditService.browse({ action: 'AUDIT_EXPORTED' }).total;
  await call('/audit/export?action=ROLE_CHANGED', { token: tokens.OWNER });

  const after = auditService.browse({ action: 'AUDIT_EXPORTED' });
  assert.equal(after.total, before + 1);
  assert.equal(after.rows[0].actor.username, 'owner');
  assert.equal(after.rows[0].after.filters.action, 'ROLE_CHANGED', 'what was taken, not just that something was');
});

test('a filtered export contains only the filtered rows', async () => {
  const res = await call('/audit/export?action=ROLE_CHANGED', { token: tokens.OWNER });
  const lines = (await res.text()).trim().split('\r\n');

  assert.ok(lines.length >= 2);
  for (const line of lines.slice(1)) assert.ok(line.includes('"ROLE_CHANGED"'), line);
});

test('the export needs TX-429 like the browse does', async () => {
  assert.equal((await call('/audit/export', { token: tokens.CASHIER })).status, 403);
});

// ── The write path used by the rest of the product ─────────────────────────

test('TC-UT-05: an audited mutation writes exactly one row carrying both values', () => {
  // The canonical instance is a price change (TASK-006 supplies products). The rule
  // being asserted — one row, before and after — is the same for every mutation on
  // AUD-601's list, and this is the one on the list that exists today.
  const owner = { id: users.OWNER.id, username: 'owner' };
  const before = auditService.browse({ entityId: 'backup_retention_count' }).total;

  db.transaction(() => settingsService.set('backup_retention_count', 60, owner));

  const rows = auditService.browse({ entityId: 'backup_retention_count' });
  assert.equal(rows.total, before + 1, 'exactly one row');
  assert.deepEqual(rows.rows[0].before, { backup_retention_count: 30 });
  assert.deepEqual(rows.rows[0].after, { backup_retention_count: 60 });
});
