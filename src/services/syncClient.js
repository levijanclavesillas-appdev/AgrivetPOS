'use strict';

// TASK-063 — a device talking to its store's web copy.
//
// It syncs every fifteen seconds and shortly after anything is written, whatever the
// screen: push what is waiting, then pull what is new, until both are empty. Without a
// connection it keeps trying and the store keeps trading; the status says how many
// changes are waiting and when the hub last answered.
//
// Also the two ways a device joins a store: a fresh install connecting to a store that is
// already on the web (linkToHub), and a store that began on this device going online
// (goOnline).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const errors = require('./errors');
const clock = require('../config/clock');
const syncService = require('./syncService');
const backupRepository = require('../repositories/backupRepository');
const { LOCAL_SETTINGS } = require('../config/syncTables');

const INTERVAL_MS = 15000;
const NUDGE_MS = 1500;
const TIMEOUT_MS = 20000;
// The hub answered within this long: counted as connected (middleware/sync.js).
const REACHABLE_MS = 60000;

let timer = null;
let nudgeTimer = null;
let running = null;
let lastContactMs = 0;

// ── The address ─────────────────────────────────────────────────────────────

/**
 * `https://<store>.pos.chachisoftware.store`, however it was typed. Plain http only to
 * this machine, for tests and a store's own LAN trial: a device's secret and the store's
 * records do not cross the internet unencrypted.
 */
function normaliseHubUrl(input) {
  let text = String(input || '').trim();
  if (!text) throw errors.badRequest('Type the store\'s web address.', { ruleId: 'SYNC-003' });
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw errors.badRequest(`"${input}" is not a web address.`, { ruleId: 'SYNC-003' });
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) {
    throw errors.badRequest('The store\'s web address must start with https://.', { ruleId: 'SYNC-003' });
  }
  return `${url.protocol}//${url.host}`;
}

// ── HTTP ────────────────────────────────────────────────────────────────────

async function request(base, pathname, { method = 'GET', body = null, token = null, device = null, headers = {}, raw = false } = {}) {
  const auth = device ? `Device ${device.id}.${device.secret}` : (token ? `Bearer ${token}` : null);
  let response;
  try {
    response = await fetch(`${base}/api/v1${pathname}`, {
      method,
      headers: {
        ...(auth ? { authorization: auth } : {}),
        ...(body && !(body instanceof Readable) && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body ? { body: body instanceof Readable || Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {}),
      ...(body instanceof Readable ? { duplex: 'half' } : {}),
      signal: AbortSignal.timeout(raw ? TIMEOUT_MS * 15 : TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'it did not answer in time' : (err.cause && err.cause.code) || err.message;
    throw errors.conflict(`The store's web copy could not be reached (${reason}).`, { ruleId: 'SYNC-004' });
  }
  if (raw && response.ok) return response;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const err = payload && payload.error
      ? Object.assign(new Error(payload.error.message), { status: response.status, ruleId: payload.error.rule_id })
      : Object.assign(new Error(`The store's web copy answered ${response.status}.`), { status: response.status });
    throw err.status === 401 || err.status === 403
      ? errors.forbidden(err.message, { ruleId: err.ruleId || 'SYNC-001' })
      : errors.conflict(err.message, { ruleId: err.ruleId || 'SYNC-004' });
  }
  return payload;
}

const mine = () => {
  const me = syncService.identity();
  return { base: me.hub_url, device: { id: me.device_id, secret: me.device_secret } };
};

// ── The loop ────────────────────────────────────────────────────────────────

function reachable() {
  return syncService.isDevice() && Date.now() - lastContactMs < REACHABLE_MS;
}

/** Push until nothing waits, pull until nothing is new; again if the pull found work waiting. */
function syncNow() {
  if (!syncService.isDevice()) return Promise.resolve({ skipped: true, ...syncService.status() });
  if (running) return running;
  running = (async () => {
    try {
      for (let round = 0; round < 10; round += 1) {
        await pushAll();
        const settled = await pullAll();
        if (settled) break;
      }
      lastContactMs = Date.now();
      syncService.recordContact();
      return syncService.status();
    } catch (err) {
      syncService.recordError(err.message);
      // Unreachable is known now, not a minute from now; a refusal is still an answer.
      lastContactMs = err.ruleId === 'SYNC-004' ? 0 : Date.now();
      return { ...syncService.status(), error: err.message, rule_id: err.ruleId || null };
    } finally {
      running = null;
    }
  })();
  return running;
}

async function pushAll() {
  const { base, device } = mine();
  for (;;) {
    const batch = syncService.collectPush();
    if (batch.through <= syncService.identity().pushed_change) return;
    if (batch.changes.length === 0) {
      // Only what the hub works out for itself changed (stock on hand): nothing to send.
      syncService.markPushed(batch.through);
    } else {
      const answer = await request(base, '/sync/push', {
        method: 'POST', device, body: { through: batch.through, changes: batch.changes, schema: batch.schema },
      });
      syncService.markPushed(answer.through);
    }
    if (!batch.more) return;
  }
}

async function pullAll() {
  const { base, device } = mine();
  for (;;) {
    const since = syncService.identity().pulled_version;
    const page = await request(base, `/sync/pull?since=${since}`, { device });
    const result = syncService.applyPull(page);
    if (!result.applied) return false;            // something was written meanwhile: push it first
    if (!page.more) return true;
  }
}

function nudge() {
  if (!syncService.isDevice()) return;
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => { syncNow(); }, NUDGE_MS);
  if (nudgeTimer.unref) nudgeTimer.unref();
}

function start() {
  stop();
  if (!syncService.isDevice()) return false;
  timer = setInterval(() => { syncNow(); }, INTERVAL_MS);
  if (timer.unref) timer.unref();
  nudge();
  return true;
}

function stop() {
  clearInterval(timer);
  clearTimeout(nudgeTimer);
  timer = null;
  nudgeTimer = null;
}

// ── Joining a store ─────────────────────────────────────────────────────────

/** This machine's own settings for the ones that are not the store's (its printer, its backups). */
function localSettingsForThisMachine() {
  const settingsService = require('./settingsService');
  const setupService = require('./setupService');
  const out = {};
  for (const key of LOCAL_SETTINGS) out[key] = settingsService.defaultOf(key);
  out.backup_folder = setupService.validateBackupFolder(setupService.suggestBackupFolder());
  return out;
}

async function download(base, device, pathname) {
  const response = await request(base, pathname, { device, raw: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-join-'));
  const file = path.join(dir, 'store.zip');
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file, { mode: 0o600 }));
  return { file, dir, version: Number(response.headers.get('x-sync-version')) || 0 };
}

/**
 * A fresh install joining a store already on the web (it began there, or this is another
 * device). The owner signs in to the web copy from here; this device gets its letter and
 * secret, downloads the store and starts from it.
 */
async function linkToHub({ hubUrl, username, password, deviceName, platform = process.platform, appVersion = null }) {
  const setupService = require('./setupService');
  const restoreService = require('./restoreService');
  setupService.assertNotComplete();
  const base = normaliseHubUrl(hubUrl);

  const login = await request(base, '/auth/login', { method: 'POST', body: { username, password } });
  if (!login.user || login.user.role !== 'OWNER') {
    throw errors.forbidden('Only the store\'s owner can connect a device to it.', { ruleId: 'SYNC-003', requiresRole: 'OWNER' });
  }
  const joined = await request(base, '/sync/devices', {
    method: 'POST', token: login.token,
    body: { name: deviceName, platform, appVersion, schema: syncService.schemaVersion() },
  });
  const device = { id: joined.device.id, secret: joined.secret };
  const snap = await download(base, device, '/sync/snapshot');
  try {
    const localSettings = localSettingsForThisMachine();
    restoreService.installSnapshot(snap.file);
    syncService.adoptSnapshot({ device: joined.device, secret: joined.secret, hubUrl: base, version: snap.version, localSettings });
  } finally {
    fs.rmSync(snap.dir, { recursive: true, force: true });
  }
  lastContactMs = Date.now();
  start();
  return { ...syncService.status(), store_name: require('./storeProfileService').profile()?.store_name || null };
}

/**
 * A store that began on this device, going online: its web copy is new and waiting, with
 * the setup code Chachi's sent. This device uploads the store, becomes its first device
 * (letter A) and syncs from then on. What is sold while the upload runs is captured and
 * sent after it.
 */
async function goOnline({ hubUrl, setupCode, password, deviceName, platform = process.platform, appVersion = null }, actor) {
  if (!actor || actor.role !== 'OWNER') {
    throw errors.forbidden('Only the owner can put the store on the web.', { ruleId: 'SYNC-003', requiresRole: 'OWNER' });
  }
  const base = normaliseHubUrl(hubUrl);
  const waiting = await request(base, '/setup');
  if (!waiting.required || !waiting.hosted) {
    throw errors.conflict('That address is not a new web copy waiting for a store. Check the address Chachi\'s sent.', { ruleId: 'SYNC-003' });
  }

  const baseline = syncService.beginGoingOnline();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-online-'));
  try {
    const file = path.join(dir, 'store.zip');
    backupRepository.archive(file);
    await request(base, `/setup/restore?fileName=${encodeURIComponent('store-from-device.zip')}`, {
      method: 'POST', raw: false,
      headers: { 'content-type': 'application/zip', 'x-setup-code': String(setupCode || ''), 'x-sync-first-device': '1' },
      body: fs.readFileSync(file),
    });
    const login = await request(base, '/auth/login', { method: 'POST', body: { username: actor.username, password } });
    const joined = await request(base, '/sync/devices', {
      method: 'POST', token: login.token,
      body: { name: deviceName, platform, appVersion, schema: syncService.schemaVersion() },
    });
    syncService.finishGoingOnline({ device: joined.device, secret: joined.secret, hubUrl: base, baseline, hubVersion: joined.hub_version });
  } catch (err) {
    syncService.abandonGoingOnline();
    throw err;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  lastContactMs = Date.now();
  start();
  return syncService.status();
}

module.exports = { normaliseHubUrl, reachable, syncNow, nudge, start, stop, linkToHub, goOnline, REACHABLE_MS };
