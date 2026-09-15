'use strict';

// TASK-065 — a store's web address, as a device is given it: every web store shares one
// host, so the path is part of the address and must survive however it was typed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { normaliseHubUrl } = require('../../services/syncClient');

test('TASK-065: a store address keeps its path, however it was typed', () => {
  for (const typed of [
    'https://pos.chachisoftware.store/s/botika-chachi',
    'https://pos.chachisoftware.store/s/botika-chachi/',
    'pos.chachisoftware.store/s/botika-chachi',
    '  pos.chachisoftware.store/s/botika-chachi//  ',
  ]) {
    assert.equal(normaliseHubUrl(typed), 'https://pos.chachisoftware.store/s/botika-chachi', typed);
  }
});

test('TASK-065: plain http only to this machine; anything else is refused', () => {
  assert.equal(normaliseHubUrl('http://127.0.0.1:47941'), 'http://127.0.0.1:47941');
  assert.throws(() => normaliseHubUrl('http://pos.chachisoftware.store/s/x'), (err) => err.ruleId === 'SYNC-003');
  assert.throws(() => normaliseHubUrl(''), (err) => err.ruleId === 'SYNC-003');
});
