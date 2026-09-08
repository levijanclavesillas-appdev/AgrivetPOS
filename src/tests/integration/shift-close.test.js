'use strict';

// POS-510, POS-511, AUD-602, OPS-001 — the close.
//
// This is the screen where the temptation to "make it balance" is strongest, so the
// cases are written around the refusals rather than the happy path: a variance beyond
// tolerance that cannot be closed silently, a closed shift that nothing can be
// back-dated into, and a backup whose failure is reported rather than swallowed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const server = require('../../server');
const db = require('../../config/database');
const authService = require('../../services/authService');
const shiftService = require('../../services/shiftService');
const productService = require('../../services/productService');
const inventoryService = require('../../services/inventoryService');
const saleService = require('../../services/saleService');
const customerService = require('../../services/customerService');
const creditService = require('../../services/creditService');
const collectionService = require('../../services/collectionService');
const settingsService = require('../../services/settingsService');
const documentService = require('../../services/documentService');
const backupService = require('../../services/backupService');
const auditService = require('../../services/auditService');
const shiftRepository = require('../../repositories/shiftRepository');
const temp = require('../helpers/tempdb');

const PORT = 47884;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'correct-horse-battery';

let instance;
let ref;
let backupFolder;
const tokens = {};
const sessions = {};

const call = (path_, { token = null, method = 'GET', body = null } = {}) => fetch(`${BASE}${path_}`, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

let seq = 0;

/** A cashier with an open shift of their own. */
function openShiftFor(role = 'CASHIER', floatCentavos = 200000) {
  seq += 1;
  const username = `close${seq}`;
  temp.seedUser({ username, role, password: PASSWORD });
  const session = authService.verifyToken(authService.login({ username, password: PASSWORD }).token);
  const { shift } = shiftService.open({ actor: session, openingFloatCentavos: floatCentavos, confirmed: true });
  return { session, shift, username };
}

function stocked({ retail = 10000, cost = 6000 } = {}) {
  seq += 1;
  const product = productService.create({
    sku: `CLOSE-${String(seq).padStart(3, '0')}`,
    name: `Close Test Feed ${seq}`,
    categoryId: ref.category.id,
    baseUnitId: ref.kg.id,
    retailPriceCentavos: retail,
  }, sessions.OWNER);
  inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli: 1000000, unitCostCentavos: cost, actor: sessions.OWNER,
  });
  return product;
}

test.before(async () => {
  temp.openEmpty('shift-close');
  instance = await server.start({ listenPort: PORT });
  temp.seedStore({ withOwner: false });
  ref = temp.seedCatalog();

  for (const role of ['OWNER', 'MANAGER', 'CASHIER', 'INVENTORY']) {
    const username = role.toLowerCase();
    temp.seedUser({ username, role, password: PASSWORD });
    const signedIn = authService.login({ username, password: PASSWORD });
    tokens[role] = signedIn.token;
    sessions[role] = authService.verifyToken(signedIn.token);
  }

  // OPS-001: the folder the wizard would have set. seedStore does not run the wizard,
  // so the setting is written directly here.
  backupFolder = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-close-')), 'backups');
  db.transaction(() => settingsService.set('backup_folder', backupFolder, sessions.OWNER));
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── Requirement 1, 2 — expected per method, and the closing lines ────────────

test('the close captures expected, actual and variance per method (POS-510)', () => {
  const { session, shift } = openShiftFor('CASHIER', 200000);
  const product = stocked({ retail: 10000 });

  // A scripted shift: ₱200 cash, ₱300 GCash, ₱150 cash collection, ₱50 cash out.
  saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 2000 }],
    tenders: [{ method: 'CASH', amountCentavos: 20000 }],
  }, session);
  saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 3000 }],
    tenders: [{ method: 'GCASH', amountCentavos: 30000, referenceNo: `GC-${seq}` }],
  }, session);

  const customer = customerService.create({
    name: `Close Farm ${seq}`, customerType: 'FARM',
    isCreditEligible: true, creditLimitCentavos: 1000000, termsDays: 15,
  }, sessions.OWNER);
  creditService.postStandalone({
    accountId: creditService.accountFor(customer.id).id, type: 'CREDIT_SALE',
    amountCentavos: 150000, actor: session, documentNo: `S-C${seq}`,
  });
  collectionService.record({
    customerId: customer.id, amountCentavos: 15000, method: 'CASH',
  }, session);

  shiftService.moveTillCash({
    shiftId: shift.id, direction: 'OUT', amountCentavos: 5000, reason: 'Petty cash', actor: session,
  });

  const expectedCash = 200000 + 20000 + 15000 - 5000;
  assert.equal(shiftService.computeExpected(shift.id).expected_cash_centavos, expectedCash);

  const result = shiftService.close({
    shiftId: shift.id,
    actualCashCentavos: expectedCash,
    actualByMethod: { GCASH: 30000, QRPH: 0, CREDIT: 0 },
    actor: session,
  }, session);

  assert.equal(result.variance_centavos, 0);
  assert.equal(result.beyond_tolerance, false);

  // One line per method, with all three figures.
  assert.deepEqual(result.lines.map((l) => l.method), ['CASH', 'GCASH', 'QRPH', 'CREDIT']);
  const byMethod = Object.fromEntries(result.lines.map((l) => [l.method, l]));
  assert.equal(byMethod.CASH.expected_centavos, expectedCash);
  assert.equal(byMethod.GCASH.expected_centavos, 30000);
  assert.equal(byMethod.GCASH.variance_centavos, 0);

  // Stored, not only returned.
  const closing = shiftService.closingFor(shift.id);
  assert.equal(closing.expected_cash_centavos, expectedCash);
  assert.equal(closing.lines.length, 4);
  assert.equal(shiftRepository.findById(shift.id).status, 'CLOSED');
});

test('a method the closer did not count is recorded as zero, not as matching', () => {
  const { session, shift } = openShiftFor();
  const product = stocked();
  saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 2000 }],
    tenders: [{ method: 'GCASH', amountCentavos: 20000, referenceNo: `GC-N${seq}` }],
  }, session);

  // Assuming an uncounted method matched would hide exactly the discrepancy the close
  // exists to find. It is a ₱200 shortfall on GCash, and it is reported as one.
  const result = shiftService.close({
    shiftId: shift.id, actualCashCentavos: 200000, varianceReason: 'GCash not reconciled yet', actor: session,
  }, session);

  const gcash = result.lines.find((l) => l.method === 'GCASH');
  assert.equal(gcash.expected_centavos, 20000);
  assert.equal(gcash.actual_centavos, 0);
  assert.equal(gcash.variance_centavos, -20000);
  assert.equal(result.beyond_tolerance, true, 'and it trips the tolerance');
});

test('POS-510: CREDIT is reported but never counted against', () => {
  // Found by the end-to-end day: demanding a count for CREDIT made every close with a
  // credit sale on it refuse. A credit sale takes no money — there is nothing in the
  // drawer to count, and reconciling it here would count the same peso twice, once as
  // credit given today and once as cash collected next week.
  const { session, shift } = openShiftFor();
  const product = stocked({ retail: 10000 });
  const customer = customerService.create({
    name: `Credit Close Farm ${seq}`, customerType: 'FARM',
    isCreditEligible: true, creditLimitCentavos: 1000000, termsDays: 15,
  }, sessions.OWNER);

  saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 10000 }],
    customerId: customer.id,
    tenders: [{ method: 'CREDIT', amountCentavos: 100000 }],
  }, session);

  // Closed with no CREDIT figure supplied at all, and it does not trip anything.
  const result = shiftService.close({
    shiftId: shift.id, actualCashCentavos: 200000, actor: session,
  }, session);

  const credit = result.lines.find((l) => l.method === 'CREDIT');
  assert.equal(credit.expected_centavos, 100000, 'the credit given today is still reported');
  assert.equal(credit.actual_centavos, 100000);
  assert.equal(credit.variance_centavos, 0);
  assert.equal(credit.reconcilable, false);
  assert.equal(result.beyond_tolerance, false);

  // GCash and QR Ph *are* counted — they are money the store expects to have received.
  assert.deepEqual([...shiftService.RECONCILABLE_METHODS], ['CASH', 'GCASH', 'QRPH']);
});

// ── TC-INT-52 / POS-510 — the mandatory reason ──────────────────────────────

test('TC-INT-52: a ₱200 short close demands a reason and is refused without one', () => {
  const { session, shift } = openShiftFor('CASHIER', 200000);
  const tolerance = settingsService.get('cash_variance_tolerance_centavos');
  assert.equal(tolerance, 10000, '₱100');

  let err;
  try {
    shiftService.close({ shiftId: shift.id, actualCashCentavos: 180000, actor: session }, session);
  } catch (caught) {
    err = caught;
  }

  assert.equal(err.status, 400);
  assert.equal(err.ruleId, 'POS-510');
  assert.match(err.message, /CASH is ₱200\.00 short/);
  assert.match(err.message, /beyond the ₱100\.00 tolerance/);
  // The rule's own point: closing is never silently forced to balance.
  assert.match(err.message, /never silently forced to balance/);

  assert.equal(shiftRepository.findById(shift.id).status, 'OPEN', 'and nothing closed');
  assert.equal(shiftService.closingFor(shift.id), null);
});

test('TC-INT-52: within tolerance, no reason is needed', () => {
  const { session, shift } = openShiftFor('CASHIER', 200000);

  // ₱99 short is inside the ₱100 tolerance. A drawer is counted by a person; demanding
  // a reason for every centavo would teach the counter to type "ok" forever.
  const result = shiftService.close({ shiftId: shift.id, actualCashCentavos: 190100, actor: session }, session);

  assert.equal(result.variance_centavos, -9900);
  assert.equal(result.beyond_tolerance, false);
  assert.equal(result.variance_reason, null);
});

test('TC-INT-52: the close writes AUD-602 with the variance, the reason and the closer', () => {
  const { session, shift, username } = openShiftFor('CASHIER', 200000);

  const result = shiftService.close({
    shiftId: shift.id,
    actualCashCentavos: 180000,
    varianceReason: 'Two ₱100 notes missing; counted three times',
    actor: session,
  }, session);

  assert.equal(result.variance_centavos, -20000);
  assert.equal(result.beyond_tolerance, true);

  const [row] = auditService.browse({ action: 'SHIFT_CLOSED_WITH_VARIANCE', entityId: shift.id }).rows;
  assert.ok(row, 'AUD-602');
  assert.equal(row.actor.username, username, 'the closing user');
  assert.equal(row.reason, 'Two ₱100 notes missing; counted three times');
  assert.equal(row.after.variance_centavos, -20000);
  assert.equal(row.after.beyond_tolerance, true);
  assert.equal(row.after.tolerance_centavos, 10000);
  assert.equal(row.shift_id, shift.id);

  // A clean close is audited too, under its own action, so a filter on "closed with a
  // variance" means what it says.
  const clean = openShiftFor();
  shiftService.close({ shiftId: clean.shift.id, actualCashCentavos: 200000, actor: clean.session }, clean.session);
  assert.equal(auditService.browse({ action: 'SHIFT_CLOSED', entityId: clean.shift.id }).total, 1);
});

test('an over count is as much a variance as a short one', () => {
  const { session, shift } = openShiftFor('CASHIER', 200000);

  assert.throws(
    () => shiftService.close({ shiftId: shift.id, actualCashCentavos: 220000, actor: session }, session),
    (err) => err.ruleId === 'POS-510' && /₱200\.00 over/.test(err.message)
  );

  const result = shiftService.close({
    shiftId: shift.id, actualCashCentavos: 220000, varianceReason: 'Found a note under the tray', actor: session,
  }, session);
  assert.equal(result.variance_centavos, 20000);
});

// ── TX-419 — closing another user's shift ───────────────────────────────────

test("closing another user's shift requires TX-419", () => {
  const owner = openShiftFor();
  const other = openShiftFor();

  // A cashier may close their own drawer and nobody else's — that is a count they did
  // not make.
  let err;
  try {
    shiftService.close({
      shiftId: owner.shift.id, actualCashCentavos: 200000, actor: other.session,
    }, other.session);
  } catch (caught) {
    err = caught;
  }
  assert.equal(err.status, 403);
  assert.equal(err.ruleId, 'TX-419');
  assert.equal(err.requiresRole, 'OWNER or MANAGER');

  // §10 grants TX-419 to owner and manager.
  const result = shiftService.close({
    shiftId: owner.shift.id, actualCashCentavos: 200000, actor: sessions.MANAGER,
  }, sessions.MANAGER);
  assert.equal(result.shift.status, 'CLOSED');
  assert.equal(shiftRepository.findClosingByShift(owner.shift.id).closed_by, sessions.MANAGER.id);

  shiftService.close({ shiftId: other.shift.id, actualCashCentavos: 200000, actor: other.session }, other.session);
});

// ── TC-INT-53 / POS-511 — immutability ──────────────────────────────────────

test('TC-INT-53: nothing may be moved into, or re-closed on, a closed shift', () => {
  const { session, shift } = openShiftFor();
  shiftService.close({ shiftId: shift.id, actualCashCentavos: 200000, actor: session }, session);

  // legacy/PRD_v1.1.md never said this, which would have left the door open to
  // back-dating a correction into a closed day — the most common way a POS's history
  // stops being evidence.
  assert.throws(
    () => shiftService.moveTillCash({
      shiftId: shift.id, direction: 'IN', amountCentavos: 100, reason: 'Petty cash', actor: session,
    }),
    (err) => err.status === 409 && err.ruleId === 'POS-511'
  );
  assert.throws(
    () => shiftService.close({ shiftId: shift.id, actualCashCentavos: 999999, actor: session }, session),
    (err) => err.status === 409 && err.ruleId === 'POS-511'
  );
});

test('TC-INT-53: a sale cannot be rung into a closed shift', () => {
  const { session, shift } = openShiftFor();
  const product = stocked();
  shiftService.close({ shiftId: shift.id, actualCashCentavos: 200000, actor: session }, session);

  // POS-501's guard finds no *open* shift for the user, which is the same refusal as
  // never having opened one — and the right one: the day is closed.
  assert.throws(
    () => saleService.complete({
      lines: [{ productId: product.id, qtyMilli: 1000 }],
      tenders: [{ method: 'CASH', amountCentavos: 99999 }],
    }, session),
    (err) => err.ruleId === 'POS-501'
  );
});

test('TC-INT-53: no repository method updates a closing or its lines', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'repositories', 'shiftRepository.js'), 'utf8'
  );
  const literals = source.split('\n').flatMap((line) => [...line.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? ''));
  const templates = source.match(/`[\s\S]*?`/g) || [];

  for (const verb of ['UP' + 'DATE', 'DEL' + 'ETE']) {
    for (const table of ['cashier_closings', 'closing_method_lines', 'till_movements']) {
      const pattern = new RegExp(`${verb}[\\s\\S]{0,40}\\b${table}\\b`, 'i');
      const offender = [...literals, ...templates].find((text) => pattern.test(text));
      assert.equal(offender, undefined, `${verb} path on ${table}`);
    }
  }

  // The one UPDATE on cashier_shifts is the close itself, and it is guarded so it can
  // only ever move OPEN to CLOSED.
  const closeStatement = [...literals, ...templates].find((t) => /UPDATE cashier_shifts/i.test(t));
  assert.match(closeStatement, /status = 'CLOSED'/);
  assert.match(closeStatement, /AND status = 'OPEN'/, 'never reopens, never re-closes');
});

// ── TC-INT-70 / OPS-001, OPS-002 — the backup ───────────────────────────────

test('TC-INT-70: a successful close writes a backup and verifies it', () => {
  const { session, shift } = openShiftFor();

  const result = shiftService.close({ shiftId: shift.id, actualCashCentavos: 200000, actor: session }, session);

  assert.equal(result.backup.ok, true);
  assert.equal(result.backup.verified, true, 'OPS-002: opened and integrity-checked');
  assert.equal(result.backup.trigger, 'SHIFT_CLOSE');
  assert.ok(fs.existsSync(result.backup.file_path), 'the file is on disk');
  assert.ok(result.backup.size_bytes > 0);
  assert.ok(result.backup.schema_version >= 6, 'and it carries this schema');

  // The copy is a real database with this store's rows in it, not an empty file that
  // happens to pass an integrity check.
  assert.ok(result.backup.row_counts.sales >= 0);
  assert.deepEqual(result.alerts, [], 'nothing to raise');
});

test('TC-INT-70: the backup is a consistent snapshot, not a byte copy', () => {
  const { session, shift } = openShiftFor();
  const product = stocked();
  saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 10000 }],
  }, session);

  const result = shiftService.close({
    shiftId: shift.id, actualCashCentavos: 210000, actor: session,
  }, session);

  // Opened independently and checked: a filesystem copy of a WAL database mid-write is
  // the backup that restores into a half-written page (TC-INT-75's concern).
  const Database = require('better-sqlite3');
  const copy = new Database(result.backup.file_path, { readonly: true, fileMustExist: true });
  try {
    assert.equal(copy.pragma('integrity_check')[0].integrity_check, 'ok');
    assert.deepEqual(copy.pragma('foreign_key_check'), []);
    // The sale that was rung before the close is in the copy.
    assert.ok(copy.prepare('SELECT COUNT(*) AS n FROM sales').get().n > 0);
    assert.ok(copy.prepare('SELECT COUNT(*) AS n FROM cashier_closings').get().n > 0);
  } finally {
    copy.close();
  }
});

test('TC-INT-70: a backup failure raises an alert and does not reopen the shift', () => {
  const { session, shift } = openShiftFor();
  const good = settingsService.get('backup_folder');

  // A folder that cannot be written: the shape of a full disk or an unplugged drive.
  db.transaction(() => settingsService.set('backup_folder', '', sessions.OWNER));

  try {
    const result = shiftService.close({ shiftId: shift.id, actualCashCentavos: 200000, actor: session }, session);

    // The drawer has been counted and signed off. It is not un-counted because a USB
    // stick was full — the close stands and the failure is an alert.
    assert.equal(result.backup.ok, false);
    assert.equal(result.backup.verified, false);
    assert.match(result.backup.error, /No backup folder is configured/);
    assert.equal(result.shift.status, 'CLOSED', 'the shift stayed closed');
    assert.equal(shiftRepository.findById(shift.id).status, 'CLOSED');

    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0].kind, 'BACKUP_FAILED');
    assert.equal(result.alerts[0].severity, 'CRITICAL');
    assert.match(result.alerts[0].message, /not backed up/);
  } finally {
    db.transaction(() => settingsService.set('backup_folder', good, sessions.OWNER));
  }
});

test('OPS-002: a backup that fails verification is deleted and does not count', (t) => {
  const backupRepository = require('../../repositories/backupRepository');
  t.mock.method(backupRepository, 'verify', () => ({ ok: false, error: 'database disk image is malformed' }));

  const result = backupService.run({ trigger: 'MANUAL', actor: sessions.OWNER });

  assert.equal(result.ok, false);
  assert.equal(result.rule_id, 'OPS-002');
  assert.match(result.error, /failed verification/);
  assert.match(result.error, /does not count as a backup/);

  // Leaving a corrupt file is worse than leaving none: the next person to look sees a
  // recent backup and believes it.
  assert.equal(fs.existsSync(result.file_path), false, 'the file was removed');
  t.mock.restoreAll();
});

// ── Requirement 7 — the closing summary ─────────────────────────────────────

test('the closing summary prints, and is subject to TAX-006', () => {
  const { session, shift } = openShiftFor('CASHIER', 200000);
  const product = stocked({ retail: 10000 });
  saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 2000 }],
    tenders: [{ method: 'CASH', amountCentavos: 20000 }],
  }, session);

  const result = shiftService.close({
    shiftId: shift.id, actualCashCentavos: 200000,
    varianceReason: 'Counted twice; ₱200 not found', actor: session,
  }, session);

  const text = result.summary.text;
  assert.match(text, /SHIFT CLOSING SUMMARY/);
  assert.match(text, /Test Agrivet Supply/);
  assert.match(text, /Opening float\s+2,000\.00/);
  assert.match(text, /Cash sales\s+200\.00/);
  assert.match(text, /CASH\n {2}expected/);
  assert.match(text, /CASH VARIANCE\s+200\.00 short/);
  assert.match(text, /Reason:/);
  assert.match(text, /Counted twice/);

  // TAX-006 — it is an internal record, and documentService refused to print it
  // otherwise.
  assert.match(text, /This is not an official receipt/);
  const withoutNotice = text.replace(/This is not an official receipt/ig, '');
  for (const pattern of [/official\s+receipt/i, /sales\s+invoice/i, /\bor\s*no\.?\b/i]) {
    assert.equal(pattern.test(withoutNotice), false, String(pattern));
  }
  assert.equal(result.printed.kind, 'SHIFT_CLOSING');
});

test('INT-1: a printer failure never reopens a closed shift', () => {
  const { session, shift } = openShiftFor();
  documentService.setDriver(() => { throw new Error('printer offline'); });

  try {
    const result = shiftService.close({ shiftId: shift.id, actualCashCentavos: 200000, actor: session }, session);
    assert.equal(result.printed.delivered, false);
    assert.equal(result.shift.status, 'CLOSED');
  } finally {
    documentService.setDriver(null);
  }
});

// ── POS-508 — a long-open shift closing with a variance ─────────────────────

test('POS-508: a long-open shift closing with a variance needs owner authorisation', () => {
  const { session, shift } = openShiftFor('CASHIER', 200000);

  // Back-dated past the 24-hour maximum. No application path does this.
  const longAgo = new Date(Date.now() - 30 * 3600000).toISOString();
  db.get().prepare('UPDATE cashier_shifts SET opened_at = ? WHERE id = ?').run(longAgo, shift.id);
  assert.ok(shiftService.staleShifts().some((s) => s.shift_id === shift.id));

  let err;
  try {
    shiftService.close({
      shiftId: shift.id, actualCashCentavos: 180000, varianceReason: 'Short', actor: session,
    }, session);
  } catch (caught) {
    err = caught;
  }

  assert.equal(err.status, 403);
  assert.equal(err.ruleId, 'POS-508');
  assert.equal(err.requiresRole, 'OWNER');

  // An owner authorising it — or closing it themselves — releases it.
  const result = shiftService.close({
    shiftId: shift.id, actualCashCentavos: 180000, varianceReason: 'Short',
    approver: sessions.OWNER, actor: session,
  }, session);
  assert.equal(result.beyond_tolerance, true);
});

test('POS-508: a long-open shift closing clean needs no authorisation', () => {
  const { session, shift } = openShiftFor('CASHIER', 200000);
  const longAgo = new Date(Date.now() - 30 * 3600000).toISOString();
  db.get().prepare('UPDATE cashier_shifts SET opened_at = ? WHERE id = ?').run(longAgo, shift.id);

  // A clean close of a long shift is still just a close. It is the *combination* of a
  // long shift and a discrepancy that is the shape of a problem.
  assert.doesNotThrow(() => shiftService.close({
    shiftId: shift.id, actualCashCentavos: 200000, actor: session,
  }, session));
});

// ── Over HTTP ───────────────────────────────────────────────────────────────

test('POST /shifts/:id/close returns the variance, the backup and the summary', async () => {
  const { session, shift } = openShiftFor('CASHIER', 200000);
  const token = authService.issueToken({ user: { id: session.id, username: session.username, role: session.role } });

  const short = await call(`/shifts/${shift.id}/close`, {
    token, method: 'POST', body: { actualCashCentavos: 180000 },
  });
  assert.equal(short.status, 400);
  assert.equal((await short.json()).error.rule_id, 'POS-510');

  const res = await call(`/shifts/${shift.id}/close`, {
    token, method: 'POST',
    body: { actualCashCentavos: 180000, varianceReason: 'Counted three times' },
  });
  assert.equal(res.status, 201);
  const body = await res.json();

  assert.equal(body.variance_centavos, -20000);
  assert.equal(body.beyond_tolerance, true);
  assert.equal(body.backup.verified, true, 'SCR-503 states this');
  assert.ok(body.summary.text.includes('SHIFT CLOSING SUMMARY'));
  assert.equal(body.lines.length, 4);
});

test('GET /shifts/:id/summary reads a closed shift back', async () => {
  const { session, shift } = openShiftFor();
  shiftService.close({ shiftId: shift.id, actualCashCentavos: 200000, actor: session }, session);

  const body = await (await call(`/shifts/${shift.id}/summary`, { token: tokens.OWNER })).json();

  assert.equal(body.shift.status, 'CLOSED');
  assert.equal(body.closing.variance_centavos, 0);
  assert.equal(body.closing.lines.length, 4);
  assert.ok(body.closing.closed_at_manila);
});

test('an open shift has no closing yet', async () => {
  const { shift } = openShiftFor();
  const body = await (await call(`/shifts/${shift.id}/summary`, { token: tokens.OWNER })).json();

  assert.equal(body.shift.status, 'OPEN');
  assert.equal(body.closing, null);
});
