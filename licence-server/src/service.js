'use strict';

// What the licence server does, without HTTP — TASK-048.
//
//   A store is per owner (L-6): created the first time its owner approves a device,
//   with a trial, and extended by payments — manual ones recorded on the admin page, and
//   Google Play subscriptions verified with Google (L-4).
//
//   A device joins a store by the device-link flow: it asks for a code, the owner signs
//   in with Google on /link and approves it, and the device's next poll collects its
//   licence and a renewal secret. After that it renews with the secret, silently, when
//   it has the internet — no Google sign-in each month (L-1).
//
//   TASK-067: a store is on one plan (LIC-005): MONTHLY, paid to a date, or ONE_TIME, paid
//   for good (its paid_until is FOR_GOOD). Chachi's admin sets either by hand, and can
//   register a store before its owner links it (LIC-006). Every change is a payments row.
//
//   A licence is signed (licence.js), valid for `validityDays` from its check, and
//   carries `grace_days`; the POS decides warning, grace and lapse from it offline (L-2,
//   L-3).

const crypto = require('crypto');
const licence = require('./licence');

const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789'; // no vowels, no 0/O/1/I: nothing to misread, nothing spelled
const LINK_MINUTES = 15;

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const newId = () => crypto.randomUUID();

class ServiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function userCode() {
  let out = '';
  for (const byte of crypto.randomBytes(8)) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** What somebody typed, as a code: case, spaces and the dash do not matter. */
const normaliseCode = (typed) => {
  const clean = String(typed || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : null;
};

const addDays = (iso, days) => new Date(new Date(iso).getTime() + days * 86400e3).toISOString();
function addMonths(iso, months) {
  const d = new Date(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString();
}
const later = (a, b) => (a > b ? a : b);

/** A one-time store's paid-until (LIC-005). A POS built before TASK-067 reads it as a date far off. */
const FOR_GOOD = '9999-12-31T00:00:00.000Z';

/**
 * "Paid until 2026-10-16" means through that day in the Philippines: the last millisecond
 * of it, which is still the 16th in UTC.
 */
function endOfManilaDay(typed) {
  const text = String(typed || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const d = match && new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (!d || d.toISOString().slice(0, 10) !== text || Number(match[1]) < 2020 || Number(match[1]) > 2100) {
    throw new ServiceError(400, 'date', 'Give the date as YYYY-MM-DD, between 2020 and 2100.');
  }
  return `${text}T15:59:59.999Z`;
}

const cleanEmail = (value) => {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    throw new ServiceError(400, 'email', "Give the owner's Google e-mail address.");
  }
  return email;
};

const requiredNote = (note) => {
  const text = String(note || '').trim().slice(0, 200);
  if (text.length < 3) throw new ServiceError(400, 'note', 'Say why, in the note.');
  return text;
};

function createService({ db, config, privateKey, now = () => new Date() }) {
  const at = () => now().toISOString();

  // ── Licences ─────────────────────────────────────────────────────────────

  function issue(installation, store) {
    const checked = at();
    return licence.sign({
      v: 1,
      store_id: store.id,
      store_name: store.name,
      installation_id: installation.id,
      owner_email: store.owner_email,
      plan: store.plan,
      paid_until: store.paid_until,
      checked_at: checked,
      valid_until: addDays(checked, config.validityDays),
      grace_days: config.graceDays,
      warning_days: config.warningDays,
    }, privateKey);
  }

  const storeById = (id) => db.prepare('SELECT * FROM stores WHERE id = ?').get(id);

  // ── The device link ──────────────────────────────────────────────────────

  /**
   * TASK-065: a web copy's address, accepted only if it is one of this site's own store
   * paths. The owner's "Your stores" page links to it, and a link to anywhere else would
   * be a link an installation chose to put in front of the owner.
   */
  const storePath = new RegExp(`^${String(config.baseUrl).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/s/[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$`);
  const cleanWebUrl = (url) => {
    const text = String(url || '').trim().replace(/\/+$/, '');
    return storePath.test(text) ? text : null;
  };

  function startLink({ installationId, storeName = null, platform = null, appVersion = null, webUrl = null }) {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(String(installationId || ''))) {
      throw new ServiceError(400, 'bad_installation', 'An installation id is required.');
    }
    const deviceCode = token();
    let code = userCode();
    while (db.prepare('SELECT 1 FROM device_links WHERE user_code = ?').get(code)) code = userCode();
    const created = at();
    const expires = new Date(now().getTime() + LINK_MINUTES * 60e3).toISOString();
    db.prepare(`INSERT INTO device_links (device_code_hash, user_code, installation_id, store_name, platform, app_version, created_at, expires_at, web_url)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sha256(deviceCode), code, installationId, String(storeName || '').slice(0, 120) || null,
        String(platform || '').slice(0, 40) || null, String(appVersion || '').slice(0, 40) || null, created, expires,
        cleanWebUrl(webUrl));
    return {
      device_code: deviceCode,
      user_code: code,
      verification_uri: `${config.baseUrl}/link`,
      verification_uri_complete: `${config.baseUrl}/link?code=${code}`,
      interval: 5,
      expires_in: LINK_MINUTES * 60,
    };
  }

  /** A pending link by the code the owner typed, or null. */
  function findLink(typed) {
    const code = normaliseCode(typed);
    if (!code) return null;
    const link = db.prepare('SELECT * FROM device_links WHERE user_code = ?').get(code);
    if (!link || link.status !== 'PENDING' || link.expires_at <= at()) return null;
    return link;
  }

  /**
   * The owner approves a device, for one of their stores or a new one. A new store
   * starts with the trial, recorded as a payment row so the store's history begins
   * with it rather than with an unexplained date.
   */
  function approveLink({ code, owner, storeId = null, newStoreName = null }) {
    const link = findLink(code);
    if (!link) throw new ServiceError(410, 'link_gone', 'That code has expired or was already used. Ask the POS for a new one.');
    return db.transaction(() => {
      let store;
      if (storeId) {
        store = storeById(storeId);
        const registered = store && !store.owner_sub && store.owner_email === String(owner.email || '').toLowerCase();
        if (!store || (store.owner_sub !== owner.sub && !registered)) {
          throw new ServiceError(403, 'not_your_store', 'That store belongs to another account.');
        }
        // TASK-067: a store Chachi's registered for this e-mail becomes this account's, as
        // it was set up: its plan and paid-until stand, and there is no trial.
        if (registered) {
          db.prepare('UPDATE stores SET owner_sub = ? WHERE id = ?').run(owner.sub, store.id);
          store = storeById(store.id);
        }
      } else {
        const name = String(newStoreName || link.store_name || '').trim().slice(0, 120);
        if (name.length < 2) throw new ServiceError(400, 'store_name', 'Give the store a name.');
        const created = at();
        store = {
          id: newId(), name, owner_sub: owner.sub, owner_email: owner.email,
          plan: 'MONTHLY', paid_until: addDays(created, config.trialDays), created_at: created,
        };
        db.prepare(`INSERT INTO stores (id, name, owner_sub, owner_email, plan, paid_until, created_at)
                    VALUES (@id, @name, @owner_sub, @owner_email, @plan, @paid_until, @created_at)`).run(store);
        db.prepare(`INSERT INTO payments (id, store_id, method, note, paid_until_before, paid_until_after, recorded_by, created_at)
                    VALUES (?, ?, 'TRIAL', ?, NULL, ?, ?, ?)`)
          .run(newId(), store.id, `${config.trialDays}-day trial`, store.paid_until, owner.email, created);
      }
      db.prepare("UPDATE device_links SET status = 'APPROVED', store_id = ?, approved_by = ? WHERE device_code_hash = ?")
        .run(store.id, owner.email, link.device_code_hash);
      return { store, link };
    })();
  }

  function denyLink({ code, owner }) {
    const link = findLink(code);
    if (!link) return false;
    db.prepare("UPDATE device_links SET status = 'DENIED', approved_by = ? WHERE device_code_hash = ?")
      .run(owner.email, link.device_code_hash);
    return true;
  }

  /**
   * The device's poll. Once approved, the first poll collects the licence and the
   * renewal secret — once: a second poll with the same code gets nothing, so a code
   * seen over a shoulder is worth nothing after the device has used it.
   */
  function pollLink({ deviceCode }) {
    const link = db.prepare('SELECT * FROM device_links WHERE device_code_hash = ?').get(sha256(deviceCode));
    if (!link) throw new ServiceError(404, 'unknown_code', 'Unknown code.');
    if (link.status === 'DENIED') return { status: 'denied' };
    if (link.status === 'PICKED_UP') return { status: 'used' };
    if (link.expires_at <= at() && link.status === 'PENDING') return { status: 'expired' };
    if (link.status === 'PENDING') return { status: 'pending' };

    return db.transaction(() => {
      const store = storeById(link.store_id);
      const secret = token();
      const created = at();
      db.prepare(`INSERT INTO installations (id, store_id, secret_hash, platform, app_version, created_at, last_check_at, web_url)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET store_id = excluded.store_id, secret_hash = excluded.secret_hash,
                    platform = excluded.platform, app_version = excluded.app_version,
                    last_check_at = excluded.last_check_at, revoked_at = NULL, web_url = excluded.web_url`)
        .run(link.installation_id, store.id, sha256(secret), link.platform, link.app_version, created, created, link.web_url || null);
      db.prepare("UPDATE device_links SET status = 'PICKED_UP' WHERE device_code_hash = ?").run(link.device_code_hash);
      const installation = { id: link.installation_id };
      return { status: 'approved', licence: issue(installation, store), installation_secret: secret };
    })();
  }

  // ── Renewal ──────────────────────────────────────────────────────────────

  function installationFor({ installationId, secret }) {
    const installation = db.prepare('SELECT * FROM installations WHERE id = ?').get(String(installationId || ''));
    const matches = installation && crypto.timingSafeEqual(
      Buffer.from(installation.secret_hash), Buffer.from(sha256(secret))
    );
    if (!matches) throw new ServiceError(401, 'unknown_installation', 'This device is not linked to a store. Link it again.');
    if (installation.revoked_at) throw new ServiceError(403, 'revoked', 'This device was removed from its store. Link it again.');
    return installation;
  }

  function renew({ installationId, secret }) {
    const installation = installationFor({ installationId, secret });
    db.prepare('UPDATE installations SET last_check_at = ? WHERE id = ?').run(at(), installation.id);
    return { licence: issue(installation, storeById(installation.store_id)) };
  }

  // ── Payments ─────────────────────────────────────────────────────────────

  const storeFor = (id) => {
    const store = storeById(id);
    if (!store) throw new ServiceError(404, 'no_store', 'No such store.');
    return store;
  };

  /** LIC-006: a store's plan and paid-until changed, with the row that says so. */
  function change(store, { plan, paidUntil, method, amountCentavos = null, reference = null, note = null, recordedBy }) {
    db.prepare('UPDATE stores SET plan = ?, paid_until = ? WHERE id = ?').run(plan, paidUntil, store.id);
    db.prepare(`INSERT INTO payments (id, store_id, method, amount_centavos, reference, note, paid_until_before, paid_until_after, recorded_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(newId(), store.id, method, amountCentavos, reference, note, store.paid_until, paidUntil, recordedBy, at());
    return storeById(store.id);
  }

  /** TASK-067: paid once, for good (LIC-005). */
  function setOneTime({ storeId, amountCentavos = null, reference = null, note = null, recordedBy }) {
    const store = storeFor(storeId);
    if (store.plan === 'ONE_TIME') throw new ServiceError(409, 'already_one_time', 'This store already has a one-time licence.');
    return db.transaction(() => change(store, {
      plan: 'ONE_TIME', paidUntil: FOR_GOOD, method: 'ONE_TIME', amountCentavos, reference, note, recordedBy,
    }))();
  }

  /**
   * TASK-067: the admin's override. The store is on the monthly plan, paid through the day
   * given, earlier or later than today: a free month, a correction, or access ended.
   */
  function setPaidUntil({ storeId, date: day, note, recordedBy }) {
    const store = storeFor(storeId);
    const paidUntil = endOfManilaDay(day);
    const why = requiredNote(note);
    return db.transaction(() => change(store, { plan: 'MONTHLY', paidUntil, method: 'OVERRIDE', note: why, recordedBy }))();
  }

  /** TASK-067: a one-time licence taken back. Its devices lapse after their grace (LIC-007). */
  function revokeOneTime({ storeId, note, recordedBy }) {
    const store = storeFor(storeId);
    if (store.plan !== 'ONE_TIME') throw new ServiceError(409, 'not_one_time', 'This store does not have a one-time licence.');
    const why = requiredNote(note);
    return db.transaction(() => change(store, {
      plan: 'MONTHLY', paidUntil: at(), method: 'OVERRIDE', note: `One-time licence revoked: ${why}`, recordedBy,
    }))();
  }

  /**
   * TASK-067: a store Chachi's sets up before its owner links anything, under the owner's
   * Google e-mail. Paid how the admin says: `ONE_TIME`, `PAID_UNTIL` a date, or the usual
   * `TRIAL`. The first link approved by that e-mail takes it (approveLink).
   */
  function registerStore({ name, ownerEmail, plan, date: day = null, amountCentavos = null, reference = null, note = null, recordedBy }) {
    const storeName = String(name || '').trim().slice(0, 120);
    if (storeName.length < 2) throw new ServiceError(400, 'store_name', 'Give the store a name.');
    const email = cleanEmail(ownerEmail);
    if (!['ONE_TIME', 'PAID_UNTIL', 'TRIAL'].includes(plan)) throw new ServiceError(400, 'plan', 'Choose how the store is paid.');
    const paidUntil = plan === 'PAID_UNTIL' ? endOfManilaDay(day) : null;
    const created = at();
    return db.transaction(() => {
      const id = newId();
      db.prepare(`INSERT INTO stores (id, name, owner_sub, owner_email, plan, paid_until, created_at)
                  VALUES (?, ?, NULL, ?, 'MONTHLY', ?, ?)`).run(id, storeName, email, created, created);
      const store = storeById(id);
      if (plan === 'ONE_TIME') {
        return change(store, { plan: 'ONE_TIME', paidUntil: FOR_GOOD, method: 'ONE_TIME', amountCentavos, reference, note, recordedBy });
      }
      if (plan === 'PAID_UNTIL') {
        return change(store, { plan: 'MONTHLY', paidUntil, method: 'OVERRIDE', amountCentavos, reference, note: note || 'Registered by Chachi\'s', recordedBy });
      }
      return change(store, {
        plan: 'MONTHLY', paidUntil: addDays(created, config.trialDays), method: 'TRIAL', note: `${config.trialDays}-day trial`, recordedBy,
      });
    })();
  }

  /** TASK-067: a registered store nobody has linked, removed. A linked one never is. */
  function deleteUnlinkedStore(storeId) {
    const store = storeFor(storeId);
    const devices = db.prepare('SELECT COUNT(*) AS n FROM installations WHERE store_id = ?').get(store.id).n;
    const links = db.prepare('SELECT COUNT(*) AS n FROM device_links WHERE store_id = ?').get(store.id).n;
    if (store.owner_sub || devices || links) {
      throw new ServiceError(409, 'linked', 'This store has been linked, so it is kept. Remove its devices or revoke its licence instead.');
    }
    db.transaction(() => {
      db.prepare('DELETE FROM payments WHERE store_id = ?').run(store.id);
      db.prepare('DELETE FROM stores WHERE id = ?').run(store.id);
    })();
    return store;
  }

  /** A manual payment (GCash, bank transfer), recorded on the admin page. */
  function recordPayment({ storeId, months, amountCentavos = null, reference = null, note = null, recordedBy }) {
    const store = storeFor(storeId);
    if (store.plan === 'ONE_TIME') {
      throw new ServiceError(409, 'one_time', 'This store has a one-time licence; there is no subscription to extend.');
    }
    const n = Number(months);
    if (!Number.isInteger(n) || n < 1 || n > 36) throw new ServiceError(400, 'months', 'Months is a whole number from 1 to 36.');
    // Extended from whichever is later — today or the date already paid to — so a store
    // that pays early loses nothing and one that pays late is not charged for the gap.
    const before = store.paid_until;
    const after = addMonths(later(at(), before), n);
    return db.transaction(() => {
      db.prepare('UPDATE stores SET paid_until = ? WHERE id = ?').run(after, store.id);
      db.prepare(`INSERT INTO payments (id, store_id, method, amount_centavos, reference, note, paid_until_before, paid_until_after, recorded_by, created_at)
                  VALUES (?, ?, 'MANUAL', ?, ?, ?, ?, ?, ?, ?)`)
        .run(newId(), store.id, amountCentavos, reference, note, before, after, recordedBy, at());
      return storeById(store.id);
    })();
  }

  /**
   * A Google Play purchase, already verified with Google by the caller (play.js). The
   * store is paid to Google's expiry, never shortened: a store that also paid manually
   * keeps the later of the two.
   */
  function applyPlayPurchase({ installationId, secret, productId, purchaseToken, verified }) {
    const installation = installationFor({ installationId, secret });
    const store = storeById(installation.store_id);
    return db.transaction(() => {
      db.prepare(`INSERT INTO play_purchases (purchase_token, store_id, product_id, expiry, state, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(purchase_token) DO UPDATE SET expiry = excluded.expiry, state = excluded.state, updated_at = excluded.updated_at`)
        .run(purchaseToken, store.id, productId, verified.expiry, verified.state, at());
      // LIC-005: a one-time store keeps its licence whatever Play reports.
      if (store.plan !== 'ONE_TIME' && verified.expiry && verified.expiry > store.paid_until) {
        db.prepare('UPDATE stores SET paid_until = ? WHERE id = ?').run(verified.expiry, store.id);
        db.prepare(`INSERT INTO payments (id, store_id, method, reference, note, paid_until_before, paid_until_after, recorded_by, created_at)
                    VALUES (?, ?, 'PLAY', ?, ?, ?, ?, 'Google Play', ?)`)
          .run(newId(), store.id, purchaseToken.slice(0, 24), `${productId} · ${verified.state}`, store.paid_until, verified.expiry, at());
      }
      db.prepare('UPDATE installations SET last_check_at = ? WHERE id = ?').run(at(), installation.id);
      return { licence: issue(installation, storeById(store.id)) };
    })();
  }

  // ── What the pages show ──────────────────────────────────────────────────

  const storesForOwner = (sub) => db.prepare('SELECT * FROM stores WHERE owner_sub = ? ORDER BY created_at').all(sub);

  /**
   * The stores a device may join on the approve page: the ones Chachi's registered for this
   * e-mail and nobody has linked yet (first, flagged `registered`), then the owner's own.
   */
  const storesForApproval = ({ sub, email }) => [
    ...db.prepare('SELECT * FROM stores WHERE owner_sub IS NULL AND owner_email = ? ORDER BY created_at')
      .all(String(email || '').toLowerCase()).map((store) => ({ ...store, registered: true })),
    ...storesForOwner(sub),
  ];

  /** TASK-065: an owner's stores, each with its web copies and how many devices it has. */
  const ownerStores = (sub) => storesForOwner(sub).map((store) => ({
    ...store,
    web: db.prepare(`SELECT id, web_url, last_check_at FROM installations
                      WHERE store_id = ? AND web_url IS NOT NULL AND revoked_at IS NULL ORDER BY created_at`).all(store.id),
    devices: db.prepare('SELECT COUNT(*) AS n FROM installations WHERE store_id = ? AND revoked_at IS NULL').get(store.id).n,
  }));
  const listStores = () => db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM installations i WHERE i.store_id = s.id AND i.revoked_at IS NULL) AS devices,
           (SELECT MAX(last_check_at) FROM installations i WHERE i.store_id = s.id) AS last_check_at
      FROM stores s ORDER BY s.paid_until`).all();
  const storeDetail = (id) => {
    const store = storeById(id);
    if (!store) return null;
    return {
      store,
      installations: db.prepare('SELECT * FROM installations WHERE store_id = ? ORDER BY created_at').all(id),
      payments: db.prepare('SELECT * FROM payments WHERE store_id = ? ORDER BY created_at DESC, rowid DESC').all(id),
    };
  };
  function revokeInstallation(id) {
    const changed = db.prepare('UPDATE installations SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(at(), id).changes;
    const row = db.prepare('SELECT store_id FROM installations WHERE id = ?').get(id);
    return changed ? row.store_id : null;
  }

  // ── Sessions and sign-in state ───────────────────────────────────────────

  function createSession({ kind, subject, email = null, name = null, hours = 12 }) {
    const id = token();
    const csrf = token(16);
    db.prepare('INSERT INTO sessions (id, kind, subject, email, name, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sha256(id), kind, subject, email, name, csrf, at(), new Date(now().getTime() + hours * 3600e3).toISOString());
    return { id, csrf };
  }
  const getSession = (id, kind) => {
    if (!id) return null;
    const row = db.prepare('SELECT * FROM sessions WHERE id = ? AND kind = ?').get(sha256(id), kind);
    return row && row.expires_at > at() ? row : null;
  };
  const endSession = (id) => db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(id || ''));

  function saveOAuthState({ verifier, nonce, userCode: code, returnTo = null }) {
    const state = token();
    db.prepare('INSERT INTO oauth_states (state, verifier, nonce, user_code, created_at, return_to) VALUES (?, ?, ?, ?, ?, ?)')
      .run(state, verifier, nonce, code || null, at(), returnTo === 'stores' ? 'stores' : null);
    return state;
  }
  function takeOAuthState(state) {
    const row = db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(String(state || ''));
    if (!row) return null;
    db.prepare('DELETE FROM oauth_states WHERE state = ?').run(row.state);
    return new Date(row.created_at).getTime() > now().getTime() - 15 * 60e3 ? row : null;
  }

  return {
    startLink, findLink, approveLink, denyLink, pollLink, renew, recordPayment, applyPlayPurchase,
    setOneTime, setPaidUntil, revokeOneTime, registerStore, deleteUnlinkedStore,
    storesForOwner, storesForApproval, ownerStores, listStores, storeDetail, revokeInstallation,
    createSession, getSession, endSession, saveOAuthState, takeOAuthState,
    publicKeyPem: () => licence.publicPem(privateKey),
  };
}

module.exports = { createService, ServiceError, normaliseCode, addMonths, addDays, FOR_GOOD, endOfManilaDay };
