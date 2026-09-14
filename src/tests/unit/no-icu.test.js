'use strict';

// The server needs no ICU data — TASK-049.
//
// The Node inside the Android app (nodejs-mobile 18.20.4) is built without ICU data:
// no time-zone database, no collation. `Intl.DateTimeFormat` with `timeZone:
// 'Asia/Manila'` fails there, and that was the red error the phone showed straight after
// sign-in. So Manila time is arithmetic (config/clock.js), names sort without
// `localeCompare`, and this file keeps it that way: the arithmetic must agree with Intl
// wherever Intl works, and no server file may reach for ICU again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const clock = require('../../config/clock');

const SRC = path.join(__dirname, '..', '..');

test('TASK-049: Manila time by arithmetic agrees with Intl, on every kind of instant', () => {
  const reference = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const intlOf = (iso) => Object.fromEntries(reference.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));

  const instants = [
    '2026-09-14T15:59:59.999Z', '2026-09-14T16:00:00.000Z', // Manila midnight
    '2026-12-31T16:00:00.000Z', '2028-02-28T16:00:00.000Z', // a new year, a leap day
    '1990-07-29T16:00:00.000Z', '2099-12-31T23:59:59.999Z',
  ];
  let seed = 7;
  for (let i = 0; i < 20000; i += 1) {
    seed = (seed * 48271) % 2147483647;
    // From 1991: the Philippines last kept daylight saving in 1990, and nothing this
    // product stores is older than its own installation.
    instants.push(new Date(Date.UTC(1991, 0, 1) + (seed / 2147483647) * 3.4e12).toISOString());
  }

  for (const iso of instants) {
    const p = intlOf(iso);
    assert.equal(clock.manilaDate(iso), `${p.year}-${p.month}-${p.day}`, iso);
    assert.equal(clock.toManila(iso), `${p.month}/${p.day}/${p.year}, ${p.hour}:${p.minute}:${p.second}`, iso);
  }
});

test('TASK-049: a minute past midnight reads 00:01, not the 24:01 the Intl version printed', () => {
  assert.equal(clock.toManila('2026-09-14T16:01:00.000Z'), '09/15/2026, 00:01:00');
});

test('TASK-049: Manila time works in a Node whose Intl knows no time zones', () => {
  // As on the phone: any Intl time-zone request throws.
  const probe = `
    const Real = Intl.DateTimeFormat;
    Intl.DateTimeFormat = function (locale, options = {}) {
      if (options.timeZone) throw new RangeError('Invalid time zone specified: ' + options.timeZone);
      return new Real(locale, options);
    };
    String.prototype.localeCompare = () => { throw new Error('no collation data'); };
    const clock = require(${JSON.stringify(path.join(SRC, 'config', 'clock'))});
    process.stdout.write(clock.toManila('2026-09-14T05:22:07.000Z') + '|' + clock.manilaDate('2026-09-14T17:00:00.000Z'));
  `;
  const run = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '09/14/2026, 13:22:07|2026-09-15');
});

test('TASK-049: no server file reaches for ICU', () => {
  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'tests') walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/^\s*\*/.test(line)) return;
        if (/\bIntl\.|\.localeCompare\(|\.toLocale(Date|Time)?String\(/.test(code)) {
          offenders.push(`${path.relative(SRC, full)}:${i + 1}`);
        }
      });
    }
  }(SRC));
  assert.deepEqual(offenders, [], 'ICU is not available to the server on Android');
});
