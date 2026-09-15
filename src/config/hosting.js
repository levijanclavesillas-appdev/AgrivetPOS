'use strict';

// TASK-062 — the web version: one copy of the POS per store, in a container on Chachi's
// server, at `https://pos.chachisoftware.store/s/<store>/` (TASK-065), behind the host's nginx
// and TLS.
//
// Everything that differs between a store's own PC and a hosted copy is decided here,
// from the environment the container is started with, so no service has to guess:
//
//   AGRIVET_HOSTED=1        this copy is on the internet, behind nginx
//   AGRIVET_HOST            the address to listen on inside the container (0.0.0.0);
//                           compose publishes it on the host's 127.0.0.1 only
//   AGRIVET_SETUP_CODE      the one-time code the store's owner types in the setup wizard.
//                           Without it the first visitor to a new copy would become its
//                           owner — on a PC that is the person who installed it, on the
//                           internet it is whoever found the address first
//   AGRIVET_BACKUP_DIR      where backups go: a volume of its own, not the data volume
//                           (OPS-001), and not a folder anybody picks from a browser
//   AGRIVET_PUBLIC_URL      where the store is on the web (TASK-065):
//                           https://pos.chachisoftware.store/s/<store>. Sent when its
//                           subscription is linked, so the owner's Google sign-in lists it
//
// On a store's PC none of these is set and nothing here changes anything: SEC-8's
// 127.0.0.1, the wizard as it was, the backup folder the owner chooses.

const crypto = require('crypto');

const isHosted = () => process.env.AGRIVET_HOSTED === '1';

/**
 * SEC-8: 127.0.0.1 on a store's PC, and not configurable there. A hosted copy listens
 * inside its container's own network, which compose publishes on the host's loopback
 * only, and every request reaches it through nginx over TLS.
 */
function listenHost() {
  if (!isHosted()) return '127.0.0.1';
  return process.env.AGRIVET_HOST || '0.0.0.0';
}

/** The fixed backup folder of a hosted copy, or null on a PC (the owner chooses). */
function backupDir() {
  return isHosted() ? (process.env.AGRIVET_BACKUP_DIR || '/backups') : null;
}

/** The store's own address on the web, without a trailing slash, or null. */
function publicUrl() {
  if (!isHosted()) return null;
  const url = String(process.env.AGRIVET_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(url) ? url : null;
}

function setupCode() {
  const code = process.env.AGRIVET_SETUP_CODE;
  return typeof code === 'string' && code.trim().length >= 8 ? code.trim() : null;
}

/** Case and spaces forgiven — it is read off a message and typed on a phone. */
const normalise = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Constant-time, so the comparison says nothing about how close a guess was. */
function setupCodeMatches(given) {
  const expected = setupCode();
  if (!expected) return false;
  const a = Buffer.from(normalise(expected));
  const b = Buffer.from(normalise(given));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** A code for store.sh to hand to a new store: four groups, no I/O/0/1. */
function newSetupCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const groups = [];
  for (let g = 0; g < 4; g += 1) {
    let group = '';
    for (let i = 0; i < 4; i += 1) group += alphabet[crypto.randomInt(alphabet.length)];
    groups.push(group);
  }
  return groups.join('-');
}

module.exports = { isHosted, listenHost, backupDir, publicUrl, setupCode, setupCodeMatches, newSetupCode };

if (require.main === module && process.argv[2] === 'new-setup-code') {
  process.stdout.write(`${newSetupCode()}\n`);
}
