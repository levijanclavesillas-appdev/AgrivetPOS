'use strict';

// The OPS-005 registry and TAX-001's modes, tested without a database.
//
// TC-UT-06 is the guard that makes OPS-005 mean something. `legacy/PRD_v1.1.md` said
// "the configured threshold" fourteen times and never said what was configurable; the
// way that happens again is one service quietly declaring a figure of its own, so this
// file fails the build when one does.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const settingsService = require('../../services/settingsService');
const storeProfileService = require('../../services/storeProfileService');

const root = path.join(__dirname, '..', '..', '..');
const servicesDir = path.join(root, 'src', 'services');

// ── The registry is the OPS-005 list ────────────────────────────────────────

/**
 * OPS-005 names thirteen figures in prose. This is the mapping from that prose to the
 * keys implementing it, and it is checked against the rule's own text below — so
 * adding a figure to 03_BUSINESS_RULES.md without adding a key here fails.
 */
const OPS_005_FIGURES = {
  'near-expiry days': ['near_expiry_days'],
  'backup hour and retention': ['backup_hour', 'backup_retention_count'],
  'discount ceilings': [
    'discount_ceiling_cashier_bp', 'discount_ceiling_manager_bp', 'discount_ceiling_owner_bp',
  ],
  'cash variance tolerance': ['cash_variance_tolerance_centavos'],
  'negative stock': ['allow_negative_stock'],
  'return window': ['return_window_days'],
  'void window': ['void_window_shift_only'],
  'idle timeout': ['idle_timeout_minutes'],
  'due-soon window': ['credit_due_soon_days'],
  'cost variance tolerance': ['cost_variance_tolerance_bp'],
  'adjustment authorisation threshold': ['adjustment_authorisation_centavos'],
  'cash rounding': ['cash_rounding_centavos'],
};

function ops005Text() {
  const rules = fs.readFileSync(path.join(root, 'docs', '03_BUSINESS_RULES.md'), 'utf8');
  const line = rules.split('\n').find((l) => l.includes('`OPS-005`'));
  assert.ok(line, 'OPS-005 is missing from 03_BUSINESS_RULES.md');
  return line;
}

test('TC-UT-06: every figure OPS-005 names has a key in the registry', () => {
  const text = ops005Text();

  for (const [figure, keys] of Object.entries(OPS_005_FIGURES)) {
    assert.ok(text.includes(figure), `OPS-005 no longer names "${figure}" — update the mapping`);
    for (const key of keys) {
      assert.ok(settingsService.REGISTRY[key], `OPS-005 names "${figure}" but ${key} is not registered`);
    }
  }

  // The rule's list is a comma-separated tail after the colon. Counting it catches a
  // figure added to the document that nobody added to the registry — the exact drift
  // OPS-005 exists to prevent.
  const listed = text.split('not in code:')[1].split('.')[0].split(',').map((s) => s.trim());
  assert.equal(listed.length, Object.keys(OPS_005_FIGURES).length,
    `OPS-005 lists ${listed.length} figures; the mapping covers ${Object.keys(OPS_005_FIGURES).length}: ${listed.join(' | ')}`);
});

test('TC-UT-06: every registered key is typed, grouped, ruled and described', () => {
  for (const [key, declared] of Object.entries(settingsService.REGISTRY)) {
    assert.ok(['INT', 'STRING', 'BOOL', 'JSON'].includes(declared.type),
      `${key}: value_type must match the CHECK constraint on system_settings`);
    assert.ok(settingsService.GROUPS[declared.group], `${key}: unknown group ${declared.group}`);
    assert.match(declared.ruleId, /^[A-Z]+[_-][0-9]+$/, `${key}: needs the rule it implements`);
    assert.ok(declared.what && declared.what.length > 10, `${key}: needs a plain-language label for SCR-702`);

    if (declared.type === 'INT') {
      assert.equal(typeof declared.value, 'number', `${key}: default must be a number`);
      if (declared.min !== undefined) assert.ok(declared.value >= declared.min, `${key}: default below its own minimum`);
      if (declared.max !== undefined) assert.ok(declared.value <= declared.max, `${key}: default above its own maximum`);
    }
  }
});

test('the documented defaults are the ones the rules state', () => {
  // Each of these is a figure a rule states in words. If a rule is amended, this fails
  // before the store's behaviour changes underneath the operator.
  const stated = {
    idle_timeout_minutes: 15,                    // FR_1.2 / SEC-7
    lockout_threshold: 5,                        // SEC-3
    lockout_minutes: 15,                         // SEC-3
    cash_variance_tolerance_centavos: 10000,     // POS-510 — ₱100
    shift_max_open_hours: 24,                    // POS-508
    return_window_days: 7,                       // POS-307
    discount_ceiling_cashier_bp: 200,            // PR-201 — 2%
    discount_ceiling_manager_bp: 500,            // PR-201 — 5%
    discount_ceiling_owner_bp: 10000,            // PR-201 — 100%
    cash_rounding_centavos: 1,                   // MON-008 — 1 is off
    allow_negative_stock: false,                 // INV-104
    stock_count_stale_days: 7,                   // INV-113
    near_expiry_days: 90,                        // INV-203
    credit_due_soon_days: 3,                     // CR-107
    cost_variance_tolerance_bp: 1000,            // PO-205 — 10%
    backup_retention_count: 30,                  // OPS-003
  };
  for (const [key, expected] of Object.entries(stated)) {
    assert.equal(settingsService.REGISTRY[key].value, expected, `${key} default`);
  }
});

// ── Typing and bounds ───────────────────────────────────────────────────────

test('a value is coerced to its declared type, and refused outside its bounds', () => {
  // The renderer sends form fields, so an INT arrives as a string and a BOOL as a word.
  assert.equal(settingsService.coerce('near_expiry_days', '45'), 45);
  assert.equal(settingsService.coerce('near_expiry_days', 45), 45);
  assert.equal(settingsService.coerce('allow_negative_stock', 'true'), true);
  assert.equal(settingsService.coerce('allow_negative_stock', false), false);

  assert.throws(() => settingsService.coerce('near_expiry_days', 'soon'), (e) => e.status === 400);
  assert.throws(() => settingsService.coerce('near_expiry_days', 0), (e) => e.status === 400);
  assert.throws(() => settingsService.coerce('near_expiry_days', 5000), (e) => e.status === 400);
  assert.throws(() => settingsService.coerce('lockout_threshold', 1), (e) => e.status === 400);
  assert.throws(() => settingsService.coerce('nonsense_key', 1), (e) => e.status === 400);
});

test('a figure a rule fixes is not configurable, and says which rule fixes it', () => {
  // POS-402 makes the void window the shift itself. OPS-005 lists it as operator-owned;
  // the two cannot both be true, so the key exists, carries POS-402, and refuses a write.
  assert.throws(
    () => settingsService.coerce('void_window_shift_only', false),
    (err) => err.status === 400 && err.ruleId === 'POS-402'
  );
});

test('encode and decode round-trip every declared type', () => {
  for (const [key, declared] of Object.entries(settingsService.REGISTRY)) {
    const encoded = settingsService.encode(declared.value, declared.type);
    assert.equal(typeof encoded, 'string', `${key}: storage is TEXT`);
    assert.deepEqual(settingsService.decode(encoded, declared.type), declared.value, `${key}: round trip`);
  }
});

// ── TAX-001 / TAX-002 ───────────────────────────────────────────────────────

test('TC-UT-17: NONE and NON_VAT compute no tax; VAT does', () => {
  // TAX-002: in NONE and NON_VAT the selling price is the final price — no tax is
  // computed, split or printed, and every sale line records tax_amount_centavos = 0.
  assert.equal(storeProfileService.computesTax('NONE'), false);
  assert.equal(storeProfileService.computesTax('NON_VAT'), false);
  assert.equal(storeProfileService.computesTax('VAT'), true);

  // TASK-009 owns the decomposition itself; what is settled here is the branch every
  // caller takes, so no call site re-reads the mode string and gets it wrong.
  assert.deepEqual(storeProfileService.MODES, ['NONE', 'NON_VAT', 'VAT']);
  assert.throws(() => storeProfileService.computesTax('EXEMPT'), (e) => e.ruleId === 'TAX-001');
});

test('every tax mode carries the plain-language sentence SCR-001 shows', () => {
  for (const [mode, declared] of Object.entries(storeProfileService.TAX_MODES)) {
    assert.ok(declared.label, `${mode}: needs a label`);
    assert.ok(declared.sentence.length > 40, `${mode}: needs a sentence an operator can act on`);
    assert.equal(typeof declared.computesTax, 'boolean');
  }
});

// ── The "no threshold in code" guard (acceptance criterion) ─────────────────

const serviceFiles = () => fs.readdirSync(servicesDir)
  .filter((f) => f.endsWith('.js') && f !== 'settingsService.js')
  .map((f) => path.join('src', 'services', f));

test('TC-UT-06: no service declares an operator-owned figure of its own', () => {
  // The acceptance criterion asks for "a grep for a numeric threshold literal in
  // services/ returning nothing". A literal grep for digits cannot be that check —
  // 100 in a percentage, 60000 in a millisecond conversion and 0o600 in a file mode
  // are all numeric literals and none of them is a threshold. What is checkable, and
  // what actually goes wrong, is a service naming a figure OPS-005 owns.
  const naming = /\b(?:const|let|var)\s+([A-Z][A-Z0-9_]*(?:THRESHOLD|TOLERANCE|WINDOW|CEILING|RETENTION|_DAYS|_HOURS|_TIMEOUT))\s*=\s*-?\d/;
  const offenders = [];

  for (const rel of serviceFiles()) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    source.split('\n').forEach((line, i) => {
      const match = naming.exec(line);
      if (match) offenders.push(`${rel}:${i + 1} declares ${match[1]} — register it in settingsService (OPS-005)`);
    });
  }

  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('TC-UT-06: every setting read anywhere in the application is a declared one', () => {
  // The other half of the guard: a service may read a figure from the registry, and a
  // typo'd key would otherwise fall through to a thrown RangeError on a store PC
  // rather than here.
  const reads = /settingsService\.get\(\s*'([^']+)'/g;
  const offenders = [];

  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'tests' ? [] : walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });

  for (const full of walk(path.join(root, 'src'))) {
    const source = fs.readFileSync(full, 'utf8');
    for (const match of source.matchAll(reads)) {
      if (!settingsService.REGISTRY[match[1]]) {
        offenders.push(`${path.relative(root, full)} reads undeclared setting ${match[1]}`);
      }
    }
  }

  assert.deepEqual(offenders, [], offenders.join('\n'));
});
