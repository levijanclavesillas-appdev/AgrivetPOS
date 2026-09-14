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

  function startLink({ installationId, storeName = null, platform = null, appVersion = null }) {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(String(installationId || ''))) {
      throw new ServiceError(400, 'bad_installation', 'An installation id is required.');
    }
    const deviceCode = token();
    let code = userCode();
    while (db.prepare('SELECT 1 FROM device_links WHERE user_code = ?').get(code)) code = userCode();
    const created = at();
    const expires = new Date(now().getTime() + LINK_MINUTES * 60e3).toISOString();
    db.prepare(`INSERT INTO device_links (device_code_hash, user_code, installation_id, store_name, platform, app_version, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sha256(deviceCode), code, installationId, String(storeName || '').slice(0, 120) || null,
        String(platform || '').slice(0, 40) || null, String(appVersion || '').slice(0, 40) || null, created, expires);
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
        if (!store || store.owner_sub !== owner.sub) throw new ServiceError(403, 'not_your_store', 'That store belongs to another account.');
      } else {
        const name = String(newStoreName || link.store_name || '').trim().slice(0, 120);
        if (name.length < 2) throw new ServiceError(400, 'store_name', 'Give the store a name.');
        const created = at();
        store = {
          id: newId(), name, owner_sub: owner.sub, owner_email: owner.email,
          plan: 'monthly', paid_until: addDays(created, config.trialDays), created_at: created,
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
      db.prepare(`INSERT INTO installations (id, store_id, secret_hash, platform, app_version, created_at, last_check_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET store_id = excluded.store_id, secret_hash = excluded.secret_hash,
                    platform = excluded.platform, app_version = excluded.app_version,
                    last_check_at = excluded.last_check_at, revoked_at = NULL`)
        .run(link.installation_id, store.id, sha256(secret), link.platform, link.app_version, created, created);
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

  /** A manual payment (GCash, bank transfer), recorded on the admin page. */
  function recordPayment({ storeId, months, amountCentavos = null, reference = null, note = null, recordedBy }) {
    const store = storeById(storeId);
    if (!store) throw new ServiceError(404, 'no_store', 'No such store.');
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
      if (verified.expiry && verified.expiry > store.paid_until) {
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

  function saveOAuthState({ verifier, nonce, userCode: code }) {
    const state = token();
    db.prepare('INSERT INTO oauth_states (state, verifier, nonce, user_code, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(state, verifier, nonce, code || null, at());
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
    storesForOwner, listStores, storeDetail, revokeInstallation,
    createSession, getSession, endSession, saveOAuthState, takeOAuthState,
    publicKeyPem: () => licence.publicPem(privateKey),
  };
}

module.exports = { createService, ServiceError, normaliseCode, addMonths, addDays };
