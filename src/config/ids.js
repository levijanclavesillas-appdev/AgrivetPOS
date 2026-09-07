'use strict';

// VR-101: identity is an application-generated UUIDv7 — time-ordered, so it indexes
// like a sequence without being one, and it is stable across a PostgreSQL migration
// in a way an INTEGER AUTOINCREMENT is not.
//
// Node 20 ships randomUUID() (v4) only, so v7 is built here from the RFC 9562 layout:
//   48 bits  unix_ts_ms
//    4 bits  version (7)
//   12 bits  rand_a   — used here as a monotonic counter inside the same millisecond
//    2 bits  variant (0b10)
//   62 bits  rand_b

const crypto = require('crypto');

let lastMs = -1;
let counter = 0;

function uuidv7() {
  const ms = Date.now();
  if (ms === lastMs) {
    // Same millisecond: keep ordering by stepping the counter. 4,096 ids per ms is
    // far beyond anything this product does; roll into the next ms if ever exhausted.
    counter += 1;
    if (counter > 0xfff) {
      while (Date.now() === lastMs) { /* spin to the next millisecond */ }
      return uuidv7();
    }
  } else {
    lastMs = ms;
    counter = crypto.randomBytes(2).readUInt16BE(0) & 0x0fff;
  }

  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(ms, 0, 6);                       // 48-bit timestamp
  bytes.writeUInt16BE(0x7000 | counter, 6);          // version 7 + counter
  crypto.randomBytes(8).copy(bytes, 8);              // random tail
  bytes[8] = (bytes[8] & 0x3f) | 0x80;               // variant 0b10

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Shape check only — it does not prove the id came from this generator. */
function isUuidv7(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

module.exports = { uuidv7, isUuidv7 };
