'use strict';

// TC-UT-98 — every covered rule is cited by at least one test (NFR_5.2).
//
// 07_TEST_PLAN.md §2 states the obligation and its reason: **a rule with no test is
// treated as unimplemented, whatever the code says.** The sections it covers are the
// ones where a silent defect costs money — §1 money, §2 units, §5 inventory, §6 sales
// and the till, §7 credit — and this case is the mechanical assertion of it.
//
// ## What counts as a citation
//
// A rule id appearing anywhere in the test suite: in a case name, an assertion message
// or a comment explaining why the assertion is what it is. Comments count deliberately.
// The rule this file enforces is that somebody writing a test thought about the rule
// and said so, and a comment saying "MON-003: rounded once, at the line total" beside
// the assertion that proves it is exactly that. Requiring the id inside the assertion
// string would push people to write worse messages to satisfy a grep.
//
// What does **not** count is a citation in the source under test. The point is a test
// that would fail if the rule stopped holding, and `src/services/*.js` naming a rule
// proves only that the author of the code had read it.
//
// ## Rules that are not v1.0
//
// 03_BUSINESS_RULES.md carries a version column. A rule marked 1.1 or later has no
// implementation to test, so requiring a citation would force a fake one — which is
// worse than an honest gap, because it makes the coverage figure stop meaning
// anything. Those are listed separately and reported, not asserted.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..', '..');
const RULES_DOC = path.join(root, 'docs', '03_BUSINESS_RULES.md');

/** §2's covered sections, by rule prefix. */
const COVERED = Object.freeze(['MON', 'UOM', 'INV', 'POS', 'CR']);

/**
 * The rules the document declares, with the release each is scheduled for.
 *
 * A row is `| \`ID\` | text | version |`. Anchoring on the leading cell matters: rule
 * ids are cited across the document in each other's prose, and a looser match picks up
 * a cross-reference as though it were a declaration — the trap TC-UT-06 and TC-UT-07
 * both fell into first.
 */
function declaredRules() {
  const lines = fs.readFileSync(RULES_DOC, 'utf8').split('\n');
  const rules = [];
  let section = null;

  for (const line of lines) {
    const heading = /^## \d+\.\s+(.*)$/.exec(line);
    if (heading) section = heading[1];

    const row = /^\|\s*`([A-Z]{2,4}-\d+)`\s*\|(.*)\|\s*([\d.]+)\s*\|\s*$/.exec(line);
    if (row) rules.push({ id: row[1], prefix: row[1].split('-')[0], version: row[3], section });
  }
  return rules;
}

/** Every rule id cited anywhere under src/tests/. */
function citedRules() {
  const cited = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;

      const source = fs.readFileSync(full, 'utf8');
      for (const match of source.matchAll(/\b([A-Z]{2,4}-\d+)\b/g)) {
        if (!cited.has(match[1])) cited.set(match[1], new Set());
        cited.get(match[1]).add(path.relative(root, full));
      }
    }
  };
  walk(path.join(root, 'src', 'tests'));
  return cited;
}

test('TC-UT-98: the rule document parses, and says what it is expected to say', () => {
  const rules = declaredRules();

  // If the parse breaks, the coverage figure below silently becomes "0 of 0 missing",
  // which is the most dangerous shape a coverage check can take.
  assert.ok(rules.length > 100, `only ${rules.length} rules parsed out of the document`);
  for (const prefix of COVERED) {
    assert.ok(
      rules.some((r) => r.prefix === prefix),
      `no ${prefix}-* rules parsed — §2 names that section as covered`
    );
  }

  // Spot-checks against rules whose ids and versions are fixed by the specification.
  const byId = new Map(rules.map((r) => [r.id, r]));
  assert.equal(byId.get('MON-001').version, '1.0');
  assert.equal(byId.get('POS-509').version, '1.0');
  assert.equal(byId.get('CR-103').version, '1.0');
  assert.equal(byId.get('RPT-104').version, '1.0', 'moved to 1.0 in TASK-016');
});

test('TC-UT-98: every v1.0 rule in a covered section is cited by a test (NFR_5.2)', () => {
  const rules = declaredRules().filter((r) => COVERED.includes(r.prefix) && r.version === '1.0');
  const cited = citedRules();

  const missing = rules.filter((rule) => !cited.has(rule.id));

  assert.deepEqual(
    missing.map((r) => `${r.id} — ${r.section}`), [],
    `${missing.length} of ${rules.length} covered v1.0 rules have no test citing them.\n`
    + '07_TEST_PLAN.md §2: a rule with no test is treated as unimplemented, whatever the code says.'
  );

  process.stdout.write(`    ${rules.length} covered v1.0 rules, all cited\n`);
});

test('TC-UT-98: a citation is in a test, not only in the code it tests', () => {
  // A rule id in src/services/ proves the author of the code read the rule. It says
  // nothing about whether anything would fail if the rule stopped holding.
  const cited = citedRules();

  for (const id of ['MON-001', 'MON-003', 'INV-101', 'POS-509', 'CR-103']) {
    const files = cited.get(id);
    assert.ok(files, `${id} is cited nowhere in the tests`);
    assert.ok(
      [...files].some((f) => f.includes('src/tests/')),
      `${id} is cited only outside the test suite`
    );
  }
});

test('TC-UT-98: rules scheduled after v1.0 are reported, never faked', () => {
  const rules = declaredRules().filter((r) => COVERED.includes(r.prefix) && r.version !== '1.0');
  const cited = citedRules();

  const later = rules.map((r) => `${r.id} (v${r.version})`);
  const alreadyCited = rules.filter((r) => cited.has(r.id)).map((r) => r.id);

  // Not an assertion either way. A later rule cited by a test is usually a test saying
  // "this is deliberately absent in v1.0", which is worth having; one with no citation
  // is simply not built yet. What must not happen is either being counted as coverage.
  process.stdout.write(
    `    ${later.length} covered rules are scheduled after v1.0 and are outside NFR_5.2:\n`
    + `      ${later.join(', ') || 'none'}\n`
    + `    of those, ${alreadyCited.length} are already mentioned by a test\n`
  );
  assert.ok(Array.isArray(later));
});

test('TC-UT-98: the sections outside §2 are reported, so the gap is visible', () => {
  // §2 covers five sections. The others — tax, pricing, validation, permissions,
  // audit, operations, reporting — carry no coverage obligation, and stating how well
  // they happen to be covered is more useful than pretending the question is settled.
  const rules = declaredRules().filter((r) => !COVERED.includes(r.prefix) && r.version === '1.0');
  const cited = citedRules();
  const missing = rules.filter((r) => !cited.has(r.id));

  process.stdout.write(
    `    outside §2's obligation: ${rules.length - missing.length} of ${rules.length} v1.0 rules `
    + `are cited by a test\n`
  );
  if (missing.length > 0) {
    process.stdout.write(`      not cited: ${missing.map((r) => r.id).join(', ')}\n`);
  }
  assert.ok(rules.length > 0);
});
