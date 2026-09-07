'use strict';

// VR-101 — application-generated UUIDv7 identity.
//
// No TC-* case is assigned to VR-101: 07_TEST_PLAN.md §2 makes coverage mandatory
// for business-rule sections §1, §2, §5, §6 and §7, and VR-* is §9. These assertions
// are written anyway, because time-ordering is the property the whole index strategy
// rests on and a regression in it is silent.

const test = require('node:test');
const assert = require('node:assert/strict');
const { uuidv7, isUuidv7 } = require('../../config/ids');

test('VR-101: generated ids carry version 7 and the RFC variant', () => {
  for (let i = 0; i < 200; i += 1) {
    const id = uuidv7();
    assert.ok(isUuidv7(id), `${id} is not a well-formed UUIDv7`);
  }
});

test('VR-101: ids are unique', () => {
  const seen = new Set();
  for (let i = 0; i < 20000; i += 1) seen.add(uuidv7());
  assert.equal(seen.size, 20000);
});

test('VR-101: ids sort in generation order, including within one millisecond', () => {
  // The point of v7 over v4: lexical order is time order, so the primary key
  // indexes like a sequence without being one.
  const ids = Array.from({ length: 5000 }, () => uuidv7());
  assert.deepEqual(ids, [...ids].sort(), 'generation order is not lexical order');
});

test('VR-101: the timestamp prefix tracks wall-clock time', () => {
  const before = Date.now();
  const ms = parseInt(uuidv7().replace(/-/g, '').slice(0, 12), 16);
  const after = Date.now();
  assert.ok(ms >= before && ms <= after, `${ms} outside [${before}, ${after}]`);
});
