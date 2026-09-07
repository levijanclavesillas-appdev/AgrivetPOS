'use strict';

// TC-UT-90 — timestamps stored UTC, rendered Asia/Manila (VR-102, NFR_4.2).

const test = require('node:test');
const assert = require('node:assert/strict');
const clock = require('../../config/clock');

test('TC-UT-90: nowUtc() produces ISO-8601 UTC, never local time', () => {
  const t = clock.nowUtc();
  assert.ok(clock.isUtcTimestamp(t), `${t} is not the stored UTC form`);
  assert.ok(t.endsWith('Z'), 'a stored timestamp must carry the Z designator');
  assert.equal(new Date(t).toISOString(), t, 'round-trips through Date unchanged');
});

test('TC-UT-90: a stored UTC timestamp renders in Manila time, +8 with no DST', () => {
  // The Philippines has observed no daylight saving since 1978; the offset is a
  // constant +08:00, which is why a fixed expectation is safe here.
  assert.equal(clock.toManila('2026-09-07T00:00:00.000Z'), '09/07/2026, 08:00:00');
  assert.equal(clock.toManila('2026-01-01T15:30:00.000Z'), '01/01/2026, 23:30:00');
});

test('TC-UT-90: the Manila calendar date can differ from the UTC date', () => {
  // 16:00 UTC is already the next day in Manila. A report keyed on the UTC date
  // would put an evening sale in the wrong day — this is the bug this asserts against.
  assert.equal(clock.manilaDate('2026-09-07T16:00:00.000Z'), '2026-09-08');
  assert.equal(clock.manilaDate('2026-09-07T15:59:59.000Z'), '2026-09-07');
});

test('TC-UT-90: a value that is not a timestamp is refused, not coerced', () => {
  assert.throws(() => clock.toManila('yesterday'), TypeError);
  assert.equal(clock.isUtcTimestamp('2026-09-07 10:00:00'), false, 'space-separated local form');
  assert.equal(clock.isUtcTimestamp('2026-09-07T10:00:00+08:00'), false, 'offset form is not UTC storage');
});
