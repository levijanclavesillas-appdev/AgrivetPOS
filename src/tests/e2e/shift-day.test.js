'use strict';

// TC-E2E-11 — a cashier's whole day, through the endpoints the shift screens call.
//
// `TASK-010` and `TASK-013` proved the shift rules. What was missing until
// `TASK-038` was any way for a person to reach them: a shift could be opened from a
// two-field form buried in the POS screen and could not be closed at all. A till that
// cannot be counted is the sharpest thing that can be wrong with a point of sale.
//
// So this walks the day the way SCR-501, SCR-502 and SCR-503 walk it — open, sell,
// take cash out, count short, be refused, give a reason, close, read the summary — and
// asserts the two things the close screen is answerable for: that a drawer is **never
// silently forced to balance** (`POS-510`), and that the close says what happened to
// the backup (`OPS-001`, `OPS-002`).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const server = require('../../server');
const db = require('../../config/database');
const settingsService = require('../../services/settingsService');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const inventoryService = require('../../services/inventoryService');
const temp = require('../helpers/tempdb');

const PASSWORD = 'correct-horse-battery';

let instance;
let BASE;
let tokens = {};
let owner;
let product;
let shift;
let tolerance;

const call = (pathname, { method = 'GET', body = null, who = 'till' } = {}) => fetch(`${BASE}${pathname}`, {
  method,
  headers: {
    ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}),
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
  temp.openMigrated('shift-day');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;

  temp.seedStore({ withOwner: false, taxMode: 'NONE' });
  const ref = temp.seedCatalog();
  for (const [username, role] of [['boss', 'OWNER'], ['till', 'CASHIER'], ['mgr', 'MANAGER']]) {
    temp.seedUser({ username, role, password: PASSWORD });
    tokens[username] = authService.login({ username, password: PASSWORD }).token;
  }
  owner = authService.verifyToken(tokens.boss);

  const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-shiftday-'));
  db.transaction(() => settingsService.set('backup_folder', backups, owner));
  tolerance = settingsService.get('cash_variance_tolerance_centavos');

  product = productService.create({
    sku: 'FEED-001', name: 'Hog Grower Pellets',
    categoryId: ref.category.id, baseUnitId: ref.kg.id, retailPriceCentavos: 6000,
  }, owner);
  inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli: 500000, unitCostCentavos: 4000, actor: owner,
  });
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── SCR-501 ─────────────────────────────────────────────────────────────────

test('TC-E2E-11: the counter refuses to sell before the drawer is opened', async () => {
  const refused = await call('/sales', {
    method: 'POST',
    body: {
      lines: [{ productId: product.id, qtyMilli: 1000 }],
      tenders: [{ method: 'CASH', amountCentavos: 6000 }],
    },
  });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error.rule_id, 'POS-501');

  // Which is what the POS screen's empty state is for, and it routes to SCR-501.
  assert.equal((await json(await call('/shifts/current'))).open, false);
});

test('TC-E2E-11: POS-503 — the float must be counted and confirmed', async () => {
  const unconfirmed = await call('/shifts/open', {
    method: 'POST', body: { openingFloatCentavos: 200000, confirmed: false },
  });
  assert.equal(unconfirmed.status, 400);
  assert.equal((await unconfirmed.json()).error.rule_id, 'POS-503');

  const opened = await call('/shifts/open', {
    method: 'POST', body: { openingFloatCentavos: 200000, confirmed: true },
  });
  assert.equal(opened.status, 201);
  const body = await opened.json();
  shift = body.shift;
  assert.equal(body.expected.expected_cash_centavos, 200000, 'the drawer is the float, so far');
});

test('TC-E2E-11: POS-502 — opening again resumes, it does not open a second drawer', async () => {
  const again = await call('/shifts/open', {
    method: 'POST', body: { openingFloatCentavos: 999999, confirmed: true },
  });
  assert.equal(again.status, 200, 'a resume, not a create');
  const body = await again.json();
  assert.equal(body.resumed, true);
  assert.equal(body.shift.id, shift.id);
  assert.equal(body.shift.opening_float_centavos, 200000, 'and the float it was opened with stands');
});

// ── Trading ─────────────────────────────────────────────────────────────────

test('TC-E2E-11: the day is traded', async () => {
  // Cash, with change.
  await json(await call('/sales', {
    method: 'POST',
    body: {
      lines: [{ productId: product.id, qtyMilli: 2000 }],
      tenders: [{ method: 'CASH', amountCentavos: 20000 }],
    },
  }));

  // A split, so the close has a non-cash row to reconcile.
  await json(await call('/sales', {
    method: 'POST',
    body: {
      lines: [{ productId: product.id, qtyMilli: 3000 }],
      tenders: [
        { method: 'CASH', amountCentavos: 10000 },
        { method: 'GCASH', amountCentavos: 8000, referenceNo: '0009988776' },
      ],
    },
  }));

  const { expected } = await json(await call('/shifts/current'));
  assert.equal(expected.cash_sales_centavos, 12000 + 18000);
  assert.equal(expected.change_given_centavos, 8000 + 0);
  assert.equal(expected.by_method.GCASH.expected_centavos, 8000);
});

// ── SCR-502 ─────────────────────────────────────────────────────────────────

test('TC-E2E-11: POS-504 — cash out needs a reason from the list', async () => {
  const bad = await call(`/shifts/${shift.id}/till`, {
    method: 'POST',
    body: { direction: 'OUT', amountCentavos: 50000, reason: 'boss took it' },
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.rule_id, 'POS-504');

  const reasons = (await json(await call('/shifts/meta/till-reasons'))).reasons;
  assert.ok(reasons.includes('Owner withdrawal'));
});

test('TC-E2E-11: POS-505 — a withdrawal moves the expected figure', async () => {
  const before = (await json(await call('/shifts/current'))).expected.expected_cash_centavos;

  await json(await call(`/shifts/${shift.id}/till`, {
    method: 'POST',
    body: {
      direction: 'OUT', amountCentavos: 50000,
      reason: 'Owner withdrawal', notes: 'Banked at lunchtime',
    },
  }));

  const after = (await json(await call('/shifts/current'))).expected;
  assert.equal(after.cash_out_centavos, 50000);
  assert.equal(after.expected_cash_centavos, before - 50000, 'the drawer expects ₱500 less');
});

// ── SCR-503 ─────────────────────────────────────────────────────────────────

test('TC-E2E-11: POS-510 — a drawer short beyond tolerance cannot be closed silently', async () => {
  const { expected } = await json(await call('/shifts/current'));
  const short = expected.expected_cash_centavos - tolerance - 20000;

  const refused = await call(`/shifts/${shift.id}/close`, {
    method: 'POST',
    body: { actualCashCentavos: short, actualByMethod: { GCASH: 8000 } },
  });

  assert.equal(refused.status, 400);
  const error = (await refused.json()).error;
  assert.equal(error.rule_id, 'POS-510');
  // The screen shows this before the cashier starts typing: which row, and by how much.
  assert.match(error.message, /CASH is ₱[\d,.]+ short/);
  assert.match(error.message, /never silently forced to balance/);

  // And nothing was written: the shift is still open, and closable.
  assert.equal((await json(await call('/shifts/current'))).open, true);
});

test('TC-E2E-11: a non-cash row out of true is caught too, not just cash', async () => {
  const { expected } = await json(await call('/shifts/current'));

  // Over rather than short: the day's GCash is ₱80 and the tolerance is ₱100, so it
  // cannot be short beyond tolerance without going negative — which the amount
  // validator refuses first, for a different and correct reason.
  const refused = await call(`/shifts/${shift.id}/close`, {
    method: 'POST',
    body: {
      actualCashCentavos: expected.expected_cash_centavos,   // cash is exact
      actualByMethod: { GCASH: 8000 + tolerance + 5000 },    // GCash is not
    },
  });
  assert.equal(refused.status, 400);
  const message = (await refused.json()).error.message;
  assert.match(message, /GCASH is ₱[\d,.]+ over/);
  // POS-510 closes per method: a cash drawer that balances exactly does not excuse a
  // GCash total that does not.
  assert.match(message, /never silently forced to balance/);
});

test('TC-E2E-11: CREDIT is never asked for a count', async () => {
  const { expected } = await json(await call('/shifts/current'));

  // A credit sale takes no money, so there is nothing to count against it. The screen
  // renders the row with its figure and no input; the server carries it at zero
  // variance by construction, so omitting it entirely cannot fail a close.
  const closed = await call(`/shifts/${shift.id}/close`, {
    method: 'POST',
    body: {
      actualCashCentavos: expected.expected_cash_centavos - tolerance - 20000,
      actualByMethod: { GCASH: 8000 },
      varianceReason: 'Two ₱100 notes missing after the afternoon rush; counted three times',
    },
  });
  assert.equal(closed.status, 201);

  const result = await closed.json();
  const credit = result.lines.find((line) => line.method === 'CREDIT');
  assert.equal(credit.reconcilable, false);
  assert.equal(credit.variance_centavos, 0);

  // What the summary screen renders.
  assert.equal(result.beyond_tolerance, true);
  assert.equal(result.variance_centavos, -(tolerance + 20000));
  assert.equal(result.tolerance_centavos, tolerance);
  assert.match(result.variance_reason, /counted three times/);

  // OPS-001, OPS-002: the close backed the day up and checked the copy — and the
  // summary screen says which of those happened.
  assert.equal(result.backup.ok, true, result.backup.error);
  assert.equal(result.backup.verified, true);
  assert.ok(fs.existsSync(result.backup.file_path));

  // FR_5.4: the summary is printed by the close itself.
  assert.ok(result.printed, 'a document was produced');
  assert.match(result.summary.text, /SHIFT/i);
});

test('TC-E2E-11: POS-511 — a closed shift cannot be closed again', async () => {
  const again = await call(`/shifts/${shift.id}/close`, {
    method: 'POST', body: { actualCashCentavos: 1 },
  });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error.rule_id, 'POS-511');

  // Which is why the summary screen offers no edit.
  assert.equal((await json(await call('/shifts/current'))).open, false);
});

test('TC-E2E-11: AUD-602 — the variance and its reason are on the trail', async () => {
  const auditService = require('../../services/auditService');
  const rows = auditService.list({ action: 'SHIFT_CLOSED_WITH_VARIANCE' });

  assert.ok(rows.length >= 1);
  assert.match(rows[0].reason, /counted three times/);
});

test('TC-E2E-11: the summary reads back, and says the same thing', async () => {
  const summary = await json(await call(`/shifts/${shift.id}/summary`));

  assert.equal(summary.closing.variance_centavos, -(tolerance + 20000));
  assert.equal(summary.closing.lines.length, 4, 'every method, counted or not');
  assert.ok(summary.closing.lines.find((l) => l.method === 'GCASH').variance_centavos === 0);
});

// ── TX-419 ──────────────────────────────────────────────────────────────────

test('TC-E2E-11: TX-419 — a cashier cannot close somebody else’s drawer', async () => {
  const other = await json(await call('/shifts/open', {
    method: 'POST', who: 'mgr', body: { openingFloatCentavos: 100000, confirmed: true },
  }));

  const refused = await call(`/shifts/${other.shift.id}/close`, {
    method: 'POST', who: 'till', body: { actualCashCentavos: 100000 },
  });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.rule_id, 'TX-419');

  // An owner may, and the screen tells them whose count they are signing off.
  const closed = await call(`/shifts/${other.shift.id}/close`, {
    method: 'POST', who: 'boss', body: { actualCashCentavos: 100000 },
  });
  assert.equal(closed.status, 201);
  assert.equal((await closed.json()).variance_centavos, 0);
});
