'use strict';

// TC-UT-99 — no SQL and no better-sqlite3 import outside repositories/ and config/
// (05_TECH_SPEC.md §8.1).
//
// This is the whole of the SQLite -> PostgreSQL portability requirement, reduced to
// something a grep can enforce. It is a permanent regression guard
// (07_TEST_PLAN.md §7) and is never deleted.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..', '..');

// Permitted to hold SQL and to import the driver.
const PERMITTED = ['src/repositories', 'src/config', 'src/migrations'];

// src/tests is excluded deliberately, and this is the only exclusion worth arguing
// about. A fixture has to build database states no production path can produce — a
// database from the future, a corrupted page — and it cannot do that through a
// repository without adding production code that exists only for a test.
const EXCLUDED = ['node_modules', 'dist', '.git', 'src/tests'];

const SCANNED_ROOTS = ['src', 'public', 'main.js'];

// SQL is looked for inside string literals only. Scanning raw source matches English
// prose — "the on-hand update", "select a customer" — and a guard that cries wolf gets
// weakened until it catches nothing. Real SQL is always in a string.
//
// Keywords are assembled from fragments so that this file does not match its own
// patterns — the scanner reads every file it is told to, including this one.
const SQL_PATTERNS = [
  ['SEL', 'ECT'], ['INS', 'ERT INTO'], ['UPD', 'ATE '], ['DEL', 'ETE FROM'],
  ['CRE', 'ATE TABLE'], ['DR', 'OP TABLE'], ['ALT', 'ER TABLE'], ['PRA', 'GMA'],
].map(([a, b]) => new RegExp(`\\b${a}${b}\\b`, 'i'));

const DRIVER_PATTERNS = [
  new RegExp(`require\\(['"\`]better-${'sqlite'}3['"\`]\\)`),
  new RegExp(`from\\s+['"\`]better-${'sqlite'}3['"\`]`),
];

/**
 * Literals that are an HTML tag name, not SQL.
 *
 * `h('select', …)` builds a dropdown, and a case-insensitive `\bSELECT\b` cannot tell
 * it from a query. Excluding the exact tag name is narrower than loosening the SQL
 * pattern — a real single-line `SELECT … FROM` is still caught, and so is
 * `'select * from users'`, because neither is exactly the word.
 */
const HTML_TAGS = new Set(['select', 'option', 'table', 'form', 'label', 'input']);

const isHtmlTag = (literal) => HTML_TAGS.has(literal.slice(1, -1).trim().toLowerCase());

/** Every string literal on a line: single, double and backtick quoted. */
function stringLiterals(line) {
  return (line.match(/'[^']*'|"[^"]*"|`[^`]*`/g) || []).filter((l) => !isHtmlTag(l));
}

function walk(target, out = []) {
  const full = path.join(root, target);
  if (!fs.existsSync(full)) return out;
  if (fs.statSync(full).isFile()) {
    out.push(target);
    return out;
  }
  for (const entry of fs.readdirSync(full)) {
    const rel = path.posix.join(target, entry);
    if (EXCLUDED.some((ex) => rel === ex || rel.startsWith(`${ex}/`))) continue;
    walk(rel, out);
  }
  return out;
}

function filesUnderReview() {
  return SCANNED_ROOTS
    .flatMap((r) => walk(r))
    .filter((rel) => /\.(js|mjs|cjs|html)$/.test(rel))
    .filter((rel) => !PERMITTED.some((p) => rel === p || rel.startsWith(`${p}/`)));
}

test('TC-UT-99: the scanner actually has files to scan', () => {
  // Without this, an empty file list would make every assertion below pass while
  // proving nothing — the classic way a layering guard rots.
  const files = filesUnderReview();
  assert.ok(files.length >= 5, `only ${files.length} file(s) under review: ${files.join(', ')}`);
  assert.ok(files.includes('src/app.js'));
  assert.ok(files.includes('src/routes/health.js'));
  assert.ok(files.includes('src/services/healthService.js'));
});

test('TC-UT-99: no SQL outside repositories/ and config/', () => {
  const offenders = [];
  for (const rel of filesUnderReview()) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    source.split('\n').forEach((line, i) => {
      for (const literal of stringLiterals(line)) {
        for (const pattern of SQL_PATTERNS) {
          if (pattern.test(literal)) offenders.push(`${rel}:${i + 1} matches ${pattern}`);
        }
      }
    });
  }
  assert.deepEqual(offenders, [], `SQL outside the permitted layers:\n${offenders.join('\n')}`);
});

test('TC-UT-99: the tag-name exclusion does not blunt the SQL patterns', () => {
  // The exclusion is exact, and this is the assertion that keeps it exact. A guard
  // loosened to stop a false positive, with nothing checking how far it was loosened,
  // is a guard that stops catching the thing it was written for.
  const caught = (line) => stringLiterals(line)
    .some((literal) => SQL_PATTERNS.some((p) => p.test(literal)));

  assert.equal(caught(`h('select', {}, [])`), false, 'an HTML dropdown is not a query');
  assert.equal(caught(`h('option', { value: '' })`), false);

  assert.equal(caught(`db.prepare('SELECT id FROM users').get()`), true);
  assert.equal(caught(`const sql = "select * from products";`), true);
  assert.equal(caught('run(`DELETE FROM carts WHERE id = ?`)'), true);
  assert.equal(caught(`exec('CREATE TABLE t (a)')`), true);
  assert.equal(caught(`pragma('PRAGMA journal_mode')`), true);
});

test('TC-UT-99: no better-sqlite3 import outside repositories/ and config/', () => {
  const offenders = [];
  for (const rel of filesUnderReview()) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    if (DRIVER_PATTERNS.some((p) => p.test(source))) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `driver imported outside the permitted layers: ${offenders.join(', ')}`);
});

test('TC-UT-99: a service is the only layer that opens a transaction', () => {
  // 05_TECH_SPEC.md §8.3. A route that opens one has put a business rule in the
  // wrong layer; a repository that opens one has taken the service's job.
  const offenders = [];
  for (const rel of filesUnderReview()) {
    if (!rel.startsWith('src/routes/')) continue;
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    if (/\btransaction\s*\(/.test(source)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `route opening a transaction: ${offenders.join(', ')}`);
});
