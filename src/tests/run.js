'use strict';

// The project runner (07_TEST_PLAN.md §1). It drives node:test one level at a time
// so the output says which level ran and how many cases it contained.
//
// A level with no cases reports "0 cases" and does not pass quietly. A green run
// over an empty directory is the kind of false comfort the release gate exists to
// prevent.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LEVELS = {
  unit: 'src/tests/unit',
  integration: 'src/tests/integration',
  e2e: 'src/tests/e2e',
  perf: 'src/tests/perf',
};

const root = path.join(__dirname, '..', '..');

function filesIn(dir) {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full).filter((f) => f.endsWith('.test.js')).map((f) => path.join(full, f));
}

const requested = process.argv.slice(2).filter((a) => a in LEVELS);
const levels = requested.length ? requested : Object.keys(LEVELS);

let failed = false;
const summary = [];

for (const level of levels) {
  const files = filesIn(LEVELS[level]);
  process.stdout.write(`\n── ${level} ${'─'.repeat(Math.max(0, 60 - level.length))}\n`);

  if (files.length === 0) {
    process.stdout.write(`no case files in ${LEVELS[level]}/\n`);
    summary.push(`${level}: 0 files — NOT COVERED`);
    continue;
  }

  const res = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], {
    stdio: 'inherit',
    cwd: root,
    // AGRIVET_BCRYPT_COST is honoured only when NODE_ENV is 'test' (authService
    // .workFactor). Cost 12 is ~300 ms a hash, which a suite that seeds users in every
    // case cannot afford; the production cost is asserted by TC-UT-01 regardless.
    env: { ...process.env, NODE_ENV: 'test', AGRIVET_BCRYPT_COST: process.env.AGRIVET_BCRYPT_COST || '4' },
  });
  if (res.status !== 0) failed = true;
  summary.push(`${level}: ${files.length} file(s) — ${res.status === 0 ? 'pass' : 'FAIL'}`);
}

process.stdout.write(`\n── summary ${'─'.repeat(53)}\n`);
for (const line of summary) process.stdout.write(`${line}\n`);
process.exitCode = failed ? 1 : 0;
