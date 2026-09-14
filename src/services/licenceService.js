'use strict';

// The store's subscription, on the POS — TASK-048, LIC-001 – LIC-004.
//
// A licence is a statement the licence server signed: which store this installation
// belongs to, what it has paid until, and when it was last checked. The POS checks the
// signature offline with the public key in config/licence.js, so a store works with no
// internet at all between checks (NFR_3.1, amended): the server is asked only when this
// installation is linked, when the owner presses "Check now", and once a day in the
// background when the internet happens to be there.
//
// ## What the licence allows (LIC-002)
//
//   ACTIVE    before the licence's warning window (7 days, set by the licence server)
//   WARNING   the last 7 days — said on the dashboard and the Subscription tab
//   GRACE     7 days past the end — said more loudly; everything still works
//   LAPSED    after that — no new shift opens (LIC-001)
//   UNLINKED  never linked to a store — no shift opens either
//
// The licence ends at the earlier of `paid_until` (the store stopped paying) and
// `valid_until` (30 days since the last check: the store has been offline a month).
//
// ## Why the shift, and only the shift (LIC-001, L-2)
//
// Every sale, return and collection already needs an open shift (POS-501). So refusing a
// new shift is exactly "read-only from the next shift": a shift that is open when the
// licence lapses finishes the day, a sale in progress is never interrupted, and reports,
// export, backup and restore work throughout.

const crypto = require('crypto');
const clock = require('../config/clock');
const licenceConfig = require('../config/licence');
const errors = require('./errors');
const auditService = require('./auditService');
const licenceRepository = require('../repositories/licenceRepository');

const REQUEST_TIMEOUT_MS = 15000;
const PREFIX = 'CPL1';

const DAY = 86400e3;
const later = (a, b) => (!b || a > b ? a : b);
const plusDays = (iso, days) => new Date(new Date(iso).getTime() + days * DAY).toISOString();
const daysUntil = (iso, at) => Math.ceil((new Date(iso) - new Date(at)) / DAY);

/** The licence payload, or null when this build's key did not sign it (LIC-003). */
function verify(token) {
  const key = licenceConfig.publicKey();
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (!key || parts.length !== 3 || parts[0] !== PREFIX) return null;
  let valid = false;
  try {
    valid = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey(key), Buffer.from(parts[2], 'base64url'));
  } catch {
    return null;
  }
  if (!valid) return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
}

const enforced = () => Boolean(licenceConfig.server());

function state({ at = clock.nowUtc() } = {}) {
  if (!enforced()) return { enforced: false, state: 'OFF' };

  const row = licenceRepository.ensure(crypto.randomUUID(), at);
  // LIC-003: judged against the latest time this installation has seen, never less.
  const seen = later(at, row.max_seen_at);
  if (seen !== row.max_seen_at) licenceRepository.update({ max_seen_at: seen }, at);

  const pendingLive = row.pending_user_code && row.pending_expires_at > at;
  const base = {
    enforced: true,
    server: licenceConfig.server(),
    installation_id: row.installation_id,
    last_attempt_at: row.last_attempt_at,
    last_error: row.last_error,
    pending: pendingLive
      ? { user_code: row.pending_user_code, uri: row.pending_uri, expires_at: row.pending_expires_at }
      : null,
  };

  if (!licenceConfig.publicKey()) {
    return { ...base, state: 'MISCONFIGURED', message: 'This build names a licence server but carries no key to check its licences with.' };
  }
  const payload = row.licence ? verify(row.licence) : null;
  if (!payload || payload.installation_id !== row.installation_id) {
    return {
      ...base,
      state: 'UNLINKED',
      message: row.licence
        ? 'The licence on this POS is not valid for it. Link it to the store again.'
        : 'This POS is not linked to a store yet. The owner links it under Admin → Subscription.',
    };
  }

  const endsBecause = payload.paid_until <= payload.valid_until ? 'UNPAID' : 'OFFLINE';
  const ends = endsBecause === 'UNPAID' ? payload.paid_until : payload.valid_until;
  const graceEnds = plusDays(ends, payload.grace_days);
  // The warning window and the grace are the licence's own terms, set by the licence
  // server and signed with the rest — not figures of this POS's to change (OPS-005).
  const value = seen < plusDays(ends, -payload.warning_days) ? 'ACTIVE'
    : seen < ends ? 'WARNING'
      : seen < graceEnds ? 'GRACE'
        : 'LAPSED';

  const why = endsBecause === 'UNPAID'
    ? 'the subscription is paid until then'
    : 'this POS has not reached the licence server since '
      + `${payload.checked_at.slice(0, 10)}; connect it to the internet to renew`;
  const messages = {
    ACTIVE: `Subscribed until ${ends.slice(0, 10)}.`,
    WARNING: `The subscription ends on ${ends.slice(0, 10)}: ${why}.`,
    GRACE: `The subscription ended on ${ends.slice(0, 10)} (${endsBecause === 'UNPAID' ? 'not paid' : 'not renewed online'}). `
      + `Everything works until ${graceEnds.slice(0, 10)}; after that no new shift can be opened.`,
    LAPSED: `The subscription ended on ${ends.slice(0, 10)} and its grace period on ${graceEnds.slice(0, 10)}. `
      + 'Reports, export and backups still work; no new shift can be opened until it is renewed.',
  };

  return {
    ...base,
    state: value,
    message: messages[value],
    store_id: payload.store_id,
    store_name: payload.store_name,
    owner_email: payload.owner_email,
    plan: payload.plan,
    paid_until: payload.paid_until,
    valid_until: payload.valid_until,
    checked_at: payload.checked_at,
    ends_at: ends,
    ends_because: endsBecause,
    grace_ends_at: graceEnds,
    days_left: value === 'GRACE' ? daysUntil(graceEnds, seen) : Math.max(0, daysUntil(ends, seen)),
  };
}

/** LIC-001: a new shift opens only under a licence that has not lapsed. */
function assertMayOpenShift({ at = clock.nowUtc() } = {}) {
  const current = state({ at });
  if (!current.enforced || ['ACTIVE', 'WARNING', 'GRACE'].includes(current.state)) return current;
  // LAPSED's own message already says what is refused; the others say why, and this adds what.
  const message = current.state === 'LAPSED' ? current.message : `${current.message} No shift can be opened until then.`;
  throw errors.forbidden(message, { ruleId: 'LIC-001' });
}

// ── Talking to the licence server ──────────────────────────────────────────

async function call(path, body) {
  let response;
  try {
    response = await fetch(`${licenceConfig.server()}/api/v1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw errors.conflict('The licence server could not be reached. Check the internet connection and try again.', { ruleId: 'LIC-002' });
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = errors.conflict(payload.message || `The licence server refused (${response.status}).`, { ruleId: 'LIC-002' });
    err.remoteStatus = response.status;
    throw err;
  }
  return payload;
}

/** LIC-004: only the owner links or renews. The routes check TX-424; this checks the role. */
function assertOwner(actor) {
  if (!actor || actor.role !== 'OWNER') {
    throw errors.forbidden('Only the owner manages the subscription.', { ruleId: 'LIC-004', requiresRole: 'OWNER' });
  }
}

function assertEnforced() {
  if (!enforced()) throw errors.conflict('This build has no licence server; there is nothing to link.', { ruleId: 'LIC-002' });
}

/** Ask the licence server for a code the owner approves on /link. */
async function startLink(actor, { storeName = null, appVersion = null } = {}) {
  assertOwner(actor);
  assertEnforced();
  const at = clock.nowUtc();
  const row = licenceRepository.ensure(crypto.randomUUID(), at);
  const started = await call('/device/start', {
    installation_id: row.installation_id,
    store_name: storeName,
    platform: process.platform === 'android' ? 'Android' : process.platform === 'win32' ? 'Windows' : process.platform,
    app_version: appVersion,
  });
  licenceRepository.update({
    pending_device_code: started.device_code,
    pending_user_code: started.user_code,
    pending_uri: started.verification_uri_complete,
    pending_expires_at: new Date(Date.parse(at) + started.expires_in * 1000).toISOString(),
    last_error: null,
  }, at);
  return state({ at });
}

function saveLicence(token, secret, at) {
  const payload = verify(token);
  const row = licenceRepository.get();
  if (!payload || payload.installation_id !== row.installation_id) {
    throw errors.conflict('The licence server sent a licence this POS cannot verify. Check that this build is the current one.', { ruleId: 'LIC-003' });
  }
  const previous = row.licence ? verify(row.licence) : null;
  licenceRepository.update({
    licence: token,
    ...(secret ? { installation_secret: secret } : {}),
    last_attempt_at: at,
    last_error: null,
  }, at);
  return { payload, previous };
}

/** The poll behind the code: pending, linked, or the reason it will not be. */
async function pollLink(actor) {
  assertOwner(actor);
  assertEnforced();
  const at = clock.nowUtc();
  const row = licenceRepository.ensure(crypto.randomUUID(), at);
  if (!row.pending_device_code) return { poll: 'none', ...state({ at }) };

  const result = await call('/device/poll', { device_code: row.pending_device_code });
  if (result.status === 'pending') return { poll: 'pending', ...state({ at }) };

  const clearPending = { pending_device_code: null, pending_user_code: null, pending_uri: null, pending_expires_at: null };
  if (result.status !== 'approved') {
    const why = { expired: 'The code expired before it was approved. Start again.', denied: 'The owner denied the link.', used: 'That code was already used.' };
    licenceRepository.update({ ...clearPending, last_error: why[result.status] || 'The link did not complete.' }, at);
    return { poll: result.status, ...state({ at }) };
  }

  const { payload } = saveLicence(result.licence, result.installation_secret, at);
  licenceRepository.update(clearPending, at);
  auditService.write({
    actor,
    action: 'LICENCE_LINKED',
    entityType: 'licence_state',
    entityId: row.installation_id,
    after: { store_id: payload.store_id, store_name: payload.store_name, paid_until: payload.paid_until },
  });
  return { poll: 'approved', ...state({ at }) };
}

/**
 * The monthly check (LIC-002). Silent: the renewal secret authenticates, not Google.
 * Recorded in the audit trail only when it changes something — a payment extended the
 * subscription — because a row per day would drown the trail people read.
 */
async function renew(actor = auditService.SYSTEM_ACTOR) {
  assertEnforced();
  const at = clock.nowUtc();
  const row = licenceRepository.ensure(crypto.randomUUID(), at);
  if (!row.installation_secret) {
    throw errors.conflict('This POS is not linked to a store yet.', { ruleId: 'LIC-001' });
  }
  licenceRepository.update({ last_attempt_at: at }, at);
  let result;
  try {
    result = await call('/licence/renew', { installation_id: row.installation_id, installation_secret: row.installation_secret });
  } catch (err) {
    licenceRepository.update({ last_error: err.message }, at);
    throw err;
  }
  const { payload, previous } = saveLicence(result.licence, null, at);
  if (!previous || previous.paid_until !== payload.paid_until) {
    auditService.write({
      actor,
      action: 'LICENCE_RENEWED',
      entityType: 'licence_state',
      entityId: row.installation_id,
      before: previous ? { paid_until: previous.paid_until } : null,
      after: { paid_until: payload.paid_until },
    });
  }
  return state({ at });
}

/** Once a day from the scheduler, when licensing is on. Never throws. */
function renewIfDue({ at = clock.nowUtc() } = {}) {
  try {
    if (!enforced()) return null;
    const row = licenceRepository.get();
    if (!row || !row.installation_secret) return null;
    const lastTry = row.last_attempt_at ? Date.parse(row.last_attempt_at) : 0;
    if (Date.parse(at) - lastTry < DAY / 2) return null;
    return renew().catch(() => null);
  } catch {
    return null;
  }
}

module.exports = { verify, state, assertMayOpenShift, startLink, pollLink, renew, renewIfDue };
