'use strict';

// FT-707 — the cutover load. OPS-105, OPS-106, OPS-107.
//
// Three named cases, and what each is actually for:
//
//   `TC-INT-98` — `OPS-106`. A stock row with no unit cost is **rejected, not
//   defaulted to zero**, and a loaded one sets `avg_cost_centavos` to exactly the
//   cost in the cell. The rejection is the half that matters: a load that defaulted
//   would also pass an "average cost is set" assertion, at zero, and every
//   gross-profit figure the store ever reported would be wrong by the cost of goods
//   while looking entirely plausible.
//
//   `TC-INT-99` — `OPS-107`. An opening balance is a credit *transaction* dated at
//   cutover, so it is the first line of the statement and `CR-103` reconciles. A
//   balance written straight onto the account would satisfy "the customer owes
//   12,500" and fail the only check that matters.
//
//   `TC-INT-100` — requirement 7. Validate-only writes nothing and reports what the
//   load would. Asserted as row counts taken before and after plus a field-for-field
//   comparison of the two reports, because "it validated" is not the claim — the
//   claim is that a rehearsal tells you what the real thing will do.
//
// The files are built as CSV text rather than fixtures on disk, so a column change in
// `KINDS` breaks the test that asserts the column rather than silently drifting from
// a fixture nobody re-reads.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const server = require('../../server');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const customerService = require('../../services/customerService');
const creditService = require('../../services/creditService');
const inventoryService = require('../../services/inventoryService');
const settingsService = require('../../services/settingsService');
const openingDataService = require('../../services/openingDataService');
const productRepository = require('../../repositories/productRepository');
const customerRepository = require('../../repositories/customerRepository');
const dataRepository = require('../../repositories/dataRepository');
const csv = require('../../config/csv');
const temp = require('../helpers/tempdb');

let BASE = null;
const PASSWORD = 'correct-horse-battery';

let instance;
let ref;
const tokens = {};
const sessions = {};

const call = (p, { token = null, method = 'GET', body = null } = {}) => fetch(`${BASE}${p}`, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

/** Row counts across every table, for the "nothing was written" assertions. */
const snapshot = () => Object.fromEntries(
  dataRepository.EXPORTABLE.map((table) => [table, dataRepository.countOf(table)])
);

/** A file, from a header row and data rows — written by the same writer the exports use. */
const file = (headers, rows) => csv.stringify([headers, ...rows]);

const problemsOn = (report, line) => report.problems.filter((p) => p.line === line);
const ruleIdsOn = (report, line) => problemsOn(report, line).map((p) => p.rule_id);

function backupFolder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-opening-backups-'));
  settingsService.set('backup_folder', dir, sessions.OWNER);
  return dir;
}

test.before(async () => {
  temp.openEmpty('opening-data');
  instance = await server.start({ listenPort: 0 });
  BASE = `http://127.0.0.1:${instance.address().port}/api/v1`;
  temp.seedStore({ taxMode: 'NONE', withOwner: false });
  ref = temp.seedCatalog();

  for (const role of ['OWNER', 'CASHIER']) {
    const username = role.toLowerCase();
    temp.seedUser({ username, role, password: PASSWORD });
    const signedIn = authService.login({ username, password: PASSWORD });
    tokens[role] = signedIn.token;
    sessions[role] = authService.verifyToken(signedIn.token);
  }
  backupFolder();
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

// ── TC-INT-98 — OPS-106, the cost that cannot be defaulted ──────────────────

test('TC-INT-98: a stock row with no unit cost is rejected, and never defaulted to zero', () => {
  const products = file(
    ['sku', 'name', 'category', 'base_unit', 'retail_price'],
    [
      ['COST-A', 'Costed Feed', 'Feeds', 'KG', '52.00'],
      ['COST-B', 'Costless Feed', 'Feeds', 'KG', '48.00'],
    ]
  );
  const stock = file(
    ['sku', 'quantity', 'unit_cost'],
    [
      ['COST-A', '250', '39.00'],
      ['COST-B', '100', ''],        // the row OPS-106 exists for
    ]
  );

  const report = openingDataService.validate({ products, stock });

  assert.equal(report.ok, false);
  // Line 3 of the stock file: header is 1, COST-A is 2, COST-B is 3.
  assert.deepEqual(ruleIdsOn(report, 3), ['OPS-106']);
  assert.match(problemsOn(report, 3)[0].message, /COST-B: no unit cost/);

  // The rejection is of that row only. A file is not condemned by one bad row —
  // an owner fixing a spreadsheet needs the whole list, and the accepted count is
  // what tells them how much of it is already right.
  assert.equal(report.summary.stock.rows, 2);
  assert.equal(report.summary.stock.accepted, 1);
  assert.equal(report.summary.stock.rejected, 1);

  // And it is not silently loaded at zero: the row is simply not there.
  assert.deepEqual(report.parsed.stock.accepted.map((r) => r.sku), ['COST-A']);
});

test('TC-INT-98: a loaded row sets the average cost to the cost in the cell', () => {
  const products = file(
    ['sku', 'name', 'category', 'base_unit', 'retail_price'],
    [['AVG-001', 'Average Cost Feed', 'Feeds', 'KG', '52.00']]
  );
  const stock = file(['sku', 'quantity', 'unit_cost'], [['AVG-001', '250', '39.00']]);

  const result = openingDataService.run({ products, stock }, sessions.OWNER);

  assert.equal(result.ok, true);
  assert.equal(result.loaded.products, 1);
  assert.equal(result.loaded.stock, 1);

  // MON-004: the average cost after the load *is* the opening cost, to the centavo.
  const loaded = productRepository.findBySku('AVG-001');
  assert.equal(loaded.avg_cost_centavos, 3900);
  assert.ok(loaded.avg_cost_as_of, 'the cost is dated, so a report can say when it was set');

  // And the movement carries it, which is where the average came from (INV-106).
  const { movements } = inventoryService.ledger(loaded.id);
  assert.equal(movements.length, 1);
  assert.equal(movements[0].type, 'OPENING');
  assert.equal(movements[0].unit_cost_centavos, 3900);
  assert.equal(movements[0].qty_milli, 250000);
  assert.equal(movements[0].reference.type, 'opening_load');

  // Requirement 8: the load says the ledgers agree, rather than leaving it to be asked.
  assert.equal(result.reconciliation.inventory_balances, true);
  assert.equal(result.reconciliation.credit_balances, true);
  assert.deepEqual(result.reconciliation.breaks, []);

  // OPS-103: the backup is named, so there is a way back from a wrong cutover.
  assert.ok(result.pre_load_backup.file_name);
  assert.equal(result.pre_load_backup.verified, true);
});

test('TC-INT-98: a cost of zero loads, but is said out loud', () => {
  const products = file(
    ['sku', 'name', 'category', 'base_unit', 'retail_price'],
    [['FREE-001', 'Sample Sachet', 'Veterinary', 'PC', '15.00']]
  );
  const stock = file(['sku', 'quantity', 'unit_cost'], [['FREE-001', '20', '0']]);

  const report = openingDataService.validate({ products, stock });

  // Zero is a claim, not a gap: a store does receive free samples. It passes —
  // and it warns, because it is also exactly what a mis-keyed cell looks like.
  assert.equal(report.ok, true);
  const warning = report.warnings.find((w) => w.rule_id === 'OPS-106');
  assert.ok(warning, 'a zero cost warns');
  assert.match(warning.message, /whole price as profit/);
});

// ── TC-INT-99 — OPS-107, the balance that has to reconcile ──────────────────

test('TC-INT-99: an opening balance is the first line of the statement, and reconciles', () => {
  const balances = file(
    ['customer', 'balance', 'code', 'credit_limit', 'terms_days'],
    [['Sitio Maligaya Farm', '12500.00', 'MALIGAYA', '50000.00', '30']]
  );

  const result = openingDataService.run(
    { balances, cutoverAt: '2026-08-31' },
    sessions.OWNER
  );

  assert.equal(result.ok, true);
  assert.equal(result.loaded.customers, 1);
  assert.equal(result.loaded.balances, 1);
  assert.equal(result.cutover_at, '2026-08-31T00:00:00.000Z');

  const customer = customerRepository.findByName('Sitio Maligaya Farm');
  assert.ok(customer, 'the customer was created by the load');
  const view = creditService.creditFor(customer.id);

  // CR-103: the balance is *derived*, not written. It equals the transaction.
  assert.equal(view.credit.balance_centavos, 1250000);
  assert.equal(view.transactions.total, 1);

  // OPS-107: the earliest transaction is the opening one. The statement runs newest
  // first for the screen, so chronologically first is last in the list.
  const chronological = [...view.transactions.rows].reverse();
  const first = chronological[0];
  assert.equal(first.type, 'OPENING');
  assert.equal(first.amount_centavos, 1250000);
  assert.equal(first.occurred_at, '2026-08-31T00:00:00.000Z');
  // Referencing "opening balance" in its own words, so the first line of a statement
  // says where the figure came from instead of showing a bare amount.
  assert.equal(first.document_no, 'OPENING-BALANCE');
  assert.match(first.reason, /Opening balance at cutover/);

  assert.equal(result.reconciliation.credit_balances, true);
  assert.equal(creditService.reconcile().ok, true);
});

test('TC-INT-99: a customer already keyed in by hand gets their balance, not a refusal', () => {
  const existing = customerService.create({
    name: 'Aling Nena', customerType: 'FARM', priceLevel: 'RETAIL',
    isCreditEligible: true, creditLimitCentavos: 500000, termsDays: 15,
  }, sessions.OWNER);

  const balances = file(['customer', 'balance'], [['Aling Nena', '850.00']]);
  const result = openingDataService.run({ balances, cutoverAt: '2026-08-31' }, sessions.OWNER);

  // Matched, not duplicated: no second customer, but the balance is posted.
  assert.equal(result.loaded.customers, 0);
  assert.equal(result.loaded.balances, 1);
  assert.equal(creditService.creditFor(existing.id).credit.balance_centavos, 85000);
});

test('TC-INT-99: a negative opening balance is refused with the reason', () => {
  const balances = file(['customer', 'balance'], [['Owed Money Farm', '-500.00']]);
  const report = openingDataService.validate({ balances });

  assert.equal(report.ok, false);
  assert.deepEqual(ruleIdsOn(report, 2), ['OPS-107']);
  assert.match(problemsOn(report, 2)[0].message, /store credit/);
});

// ── TC-INT-100 — requirement 7, the rehearsal ───────────────────────────────

test('TC-INT-100: validate-only writes nothing, and reports what the load would', async () => {
  const products = file(
    ['sku', 'name', 'category', 'base_unit', 'retail_price', 'brand'],
    [
      ['REH-001', 'Rehearsal Feed', 'Feeds', 'KG', '52.00', 'B-MEG'],
      ['REH-002', 'Rehearsal Vet', 'Veterinary', 'PC', '320.00', ''],
      ['REH-003', 'Bad Unit', 'Feeds', 'DRUM', '10.00', ''],      // UOM-001
    ]
  );
  const stock = file(
    ['sku', 'quantity', 'unit_cost'],
    [
      ['REH-001', '250', '39.00'],
      ['REH-999', '10', '5.00'],                                  // in neither file
    ]
  );
  const balances = file(
    ['customer', 'balance'],
    [['Rehearsal Farm', '12500.00']]
  );

  const before = snapshot();
  const rehearsal = await call('/data/opening/validate', {
    token: tokens.OWNER, method: 'POST', body: { products, stock, balances },
  });

  // A rehearsal that found problems is a rehearsal that worked. `200`, not `400`:
  // an owner fixing a spreadsheet does this several times and none of it is a failure.
  assert.equal(rehearsal.status, 200);
  const report = await rehearsal.json();
  assert.equal(report.ok, false);

  // Nothing was written. The row counts are the assertion, not the absence of an error.
  assert.deepEqual(snapshot(), before);
  assert.equal(productRepository.findBySku('REH-001'), null);

  // Every bad row is named, with its line and the rule it broke — not the first one.
  assert.equal(report.problems.length, 2);
  const unit = report.problems.find((p) => p.rule_id === 'UOM-001');
  assert.ok(unit, 'the unknown unit is reported under UOM-001');
  assert.equal(unit.line, 4);
  assert.match(unit.message, /no unit "DRUM"/);       // requirement 5: named, not "unknown unit"
  const orphan = report.problems.find((p) => /REH-999/.test(p.message));
  assert.equal(orphan.line, 3);

  // The summary counts every file, so an owner can see how much is already right.
  assert.deepEqual(report.summary.products, { label: 'Products', rows: 3, accepted: 2, rejected: 1 });
  assert.deepEqual(report.summary.stock, { label: 'Opening stock', rows: 2, accepted: 1, rejected: 1 });
  assert.deepEqual(report.summary.balances, { label: 'Opening credit balances', rows: 1, accepted: 1, rejected: 0 });

  // `parsed` is the service's working copy and not the caller's business — for a
  // 500-row catalogue it would be most of the response.
  assert.equal(report.parsed, undefined);

  // ── The other half of requirement 7: the same files, fixed, report the same thing ──
  const fixed = {
    products: file(
      ['sku', 'name', 'category', 'base_unit', 'retail_price', 'brand'],
      [
        ['REH-001', 'Rehearsal Feed', 'Feeds', 'KG', '52.00', 'B-MEG'],
        ['REH-002', 'Rehearsal Vet', 'Veterinary', 'PC', '320.00', ''],
      ]
    ),
    stock: file(['sku', 'quantity', 'unit_cost'], [['REH-001', '250', '39.00']]),
    balances,
  };

  const second = await (await call('/data/opening/validate', {
    token: tokens.OWNER, method: 'POST', body: fixed,
  })).json();
  assert.equal(second.ok, true);
  assert.deepEqual(snapshot(), before, 'still nothing written');

  // And the load agrees with the rehearsal, field for field on what it said would happen.
  const loaded = await (await call('/data/opening', {
    token: tokens.OWNER, method: 'POST', body: { ...fixed, cutoverAt: '2026-08-31' },
  })).json();

  assert.equal(loaded.ok, true);
  assert.equal(loaded.loaded.products, second.summary.products.accepted);
  assert.equal(loaded.loaded.stock, second.summary.stock.accepted);
  assert.equal(loaded.loaded.balances, second.summary.balances.accepted);
  assert.equal(loaded.reconciliation.inventory_balances, true);
  assert.equal(loaded.reconciliation.credit_balances, true);
});

test('TC-INT-100: a load whose files are bad writes nothing and says so', () => {
  const before = snapshot();
  const stock = file(['sku', 'quantity', 'unit_cost'], [['NOPE-001', '10', '5.00']]);

  assert.throws(
    () => openingDataService.run({ stock }, sessions.OWNER),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /Nothing has been written/);
      return true;
    }
  );
  assert.deepEqual(snapshot(), before);
});

// ── The grant, and the template ─────────────────────────────────────────────

test('the opening load is TX-427, and a cashier cannot run it', async () => {
  const refused = await call('/data/opening/validate', {
    token: tokens.CASHIER, method: 'POST', body: { balances: file(['customer', 'balance'], []) },
  });
  assert.equal(refused.status, 403);
});

test('requirement 2: each template downloads, and passes its own validation', async () => {
  for (const kind of openingDataService.KIND_NAMES) {
    const response = await call(`/data/opening/template/${kind}`, { token: tokens.OWNER });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/csv/);
    assert.match(response.headers.get('content-disposition'), new RegExp(`agrivet_opening_${kind}\\.csv`));

    // Asserted on the bytes, not on `text()`: the fetch standard strips a leading BOM
    // when it decodes, so the string would pass this whether the bytes were there or
    // not — and it is the bytes Excel reads.
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'Excel needs the BOM to read it as UTF-8');

    const body = bytes.toString('utf8');

    // The template's header row carries every required column, so a store that fills
    // it in cannot fail `checkHeaders` on a file the product handed them.
    const headers = csv.parse(body)[0].map(csv.normaliseHeader);
    for (const column of openingDataService.KINDS[kind].required) {
      assert.ok(headers.includes(column), `${kind} template has a ${column} column`);
    }
  }
});

test('an unknown template kind is refused with the list of the real ones', () => {
  assert.throws(() => openingDataService.template('suppliers'), /products, stock, balances/);
});

// ── At the size the task was written for ────────────────────────────────────

test('a 500-row product CSV loads, and its stock carries 500 costs', () => {
  // The acceptance criterion's own figure. Eight hundred products is the case this
  // task exists for and hand entry cannot reach; 500 is enough to show the load is
  // not a demonstration that works on three rows.
  const products = file(
    ['sku', 'name', 'category', 'base_unit', 'retail_price'],
    Array.from({ length: 500 }, (_, i) => [
      `BULK-${String(i).padStart(3, '0')}`, `Bulk Product ${i}`, 'Feeds', 'KG', '52.00',
    ])
  );
  const stock = file(
    ['sku', 'quantity', 'unit_cost'],
    Array.from({ length: 500 }, (_, i) => [
      `BULK-${String(i).padStart(3, '0')}`, '100', '39.00',
    ])
  );

  const result = openingDataService.run({ products, stock, cutoverAt: '2026-08-31' }, sessions.OWNER);

  assert.equal(result.loaded.products, 500);
  assert.equal(result.loaded.stock, 500);

  // Every one of them costed, not merely counted — the whole of OPS-106 at scale.
  for (const sku of ['BULK-000', 'BULK-250', 'BULK-499']) {
    assert.equal(productRepository.findBySku(sku).avg_cost_centavos, 3900, sku);
  }

  // And 500 rows of movements and prices still reconcile in the one transaction.
  assert.equal(result.reconciliation.inventory_balances, true);
  assert.deepEqual(result.reconciliation.breaks, []);
});

test('a bad row deep in a 500-row file is reported with its own line number', () => {
  // The criterion's other half: "or reports every bad row with its line number". A
  // number that is right on row 3 and wrong on row 480 is worse than no number —
  // it sends somebody to correct a row that was already right.
  // Against the catalogue the case above loaded, so the only rejections are the two
  // this case plants — nothing is written, so a second opening row is fine to check.
  const rows = Array.from({ length: 500 }, (_, i) => [
    `BULK-${String(i).padStart(3, '0')}`, '100', '39.00',
  ]);
  rows[479][2] = '';                                   // file line 481: header + 480
  rows[12][1] = 'not a number';                        // file line 14

  const report = openingDataService.validate({ stock: file(['sku', 'quantity', 'unit_cost'], rows) });

  assert.equal(report.ok, false);
  assert.equal(report.summary.stock.rejected, 2);
  assert.deepEqual(
    report.problems.map((p) => [p.line, p.rule_id]).sort((a, b) => a[0] - b[0]),
    [[14, 'MON-002'], [481, 'OPS-106']]
  );
});
