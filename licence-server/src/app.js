'use strict';

// The licence server's HTTP surface — TASK-048.
//
//   POST /api/v1/device/start      the POS asks for a link code
//   POST /api/v1/device/poll       …and polls until the owner approves it
//   POST /api/v1/licence/renew     the monthly check: installation id + secret → licence
//   POST /api/v1/play/purchase     a Google Play purchase, verified with Google
//   GET  /api/v1/public-key        the key the POS verifies licences with
//   GET  /link, /auth/google…      the owner links a device, signed in with Google
//   GET  /admin…                   Chachi's page: stores, devices, manual payments
//   GET  /, /privacy, /static/…     the public site that introduces Chachi POS (site/)
//   GET  /guide, /guide/:chapter    the user guide (site/guide/, wrapped by guide.js)

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const { pages } = require('./pages');
const guide = require('./guide');
const { pkce } = require('./google');
const { ServiceError } = require('./service');

const OWNER_COOKIE = 'cps_owner';
const SITE = path.join(__dirname, '..', 'site');
const ADMIN_COOKIE = 'cps_admin';

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map((part) => {
    const i = part.indexOf('=');
    return i < 0 ? [part.trim(), ''] : [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())];
  }).filter(([k]) => k));
}

/** A small fixed-window limit per address: enough to stop guessing, not a WAF. */
function limiter({ perMinute }) {
  const hits = new Map();
  return (req, res, next) => {
    const minute = Math.floor(Date.now() / 60e3);
    const key = `${req.ip}|${minute}`;
    const n = (hits.get(key) || 0) + 1;
    hits.set(key, n);
    if (hits.size > 10000) for (const k of hits.keys()) if (!k.endsWith(`|${minute}`)) hits.delete(k);
    if (n > perMinute) return res.status(429).json({ error: 'slow_down', message: 'Too many requests. Wait a minute.' });
    return next();
  };
}

function createApp({ service, config, google, play, now = () => new Date() }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.behindProxy) app.set('trust proxy', 1);

  const secure = config.baseUrl.startsWith('https://');
  const setCookie = (res, name, value, maxAgeSeconds) => res.append('Set-Cookie',
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`);

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    });
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));

  app.get('/assets/site.css', (req, res) => res.type('text/css').set('Cache-Control', 'public, max-age=3600').send(pages.css));

  // ── The public site ───────────────────────────────────────────────────────
  //
  // Static files, and no script: the same CSP as every other page here. The pages are
  // revalidated on each visit so a change shows at once; what they link to is under
  // /static and cached for a day.

  const sitePage = (file) => (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(SITE, file));
  app.get('/', sitePage('index.html'));
  app.get('/privacy', sitePage('privacy.html'));
  app.get('/robots.txt', sitePage('robots.txt'));
  app.get('/sitemap.xml', (req, res) => res.type('application/xml').set('Cache-Control', 'no-cache').send(guide.sitemap()));
  app.get(['/guide', '/guide/:slug'], (req, res, next) => {
    const html = guide.render(req.params.slug || '');
    if (!html) return next();
    return res.type('html').set('Cache-Control', 'no-cache').send(html);
  });
  app.get('/favicon.ico', (req, res) => res.redirect(301, '/static/img/favicon-32.png'));
  app.use('/static', express.static(path.join(SITE, 'static'), { index: false, maxAge: '1d' }));

  // ── The API the POS calls ─────────────────────────────────────────────────

  const api = express.Router();
  api.use(limiter({ perMinute: 60 }));
  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req.body || {}, req));
    } catch (err) {
      if (err instanceof ServiceError) return res.status(err.status).json({ error: err.code, message: err.message });
      console.error(err);
      return res.status(500).json({ error: 'server', message: 'The licence server could not answer. Try again later.' });
    }
  };

  api.get('/health', (req, res) => res.json({ ok: true, at: now().toISOString() }));
  api.get('/public-key', (req, res) => res.type('text/plain').send(service.publicKeyPem()));
  api.post('/device/start', wrap((b) => service.startLink({
    installationId: b.installation_id, storeName: b.store_name, platform: b.platform, appVersion: b.app_version,
  })));
  api.post('/device/poll', wrap((b) => service.pollLink({ deviceCode: b.device_code })));
  api.post('/licence/renew', wrap((b) => service.renew({ installationId: b.installation_id, secret: b.installation_secret })));
  api.post('/play/purchase', wrap(async (b) => {
    if (!play.configured) throw new ServiceError(503, 'play_not_configured', 'Google Play purchases cannot be checked yet on this server.');
    let verified;
    try {
      verified = await play.verify({ productId: b.product_id, purchaseToken: b.purchase_token });
    } catch (err) {
      throw new ServiceError(402, 'purchase_not_verified', err.message);
    }
    return service.applyPlayPurchase({
      installationId: b.installation_id, secret: b.installation_secret,
      productId: b.product_id, purchaseToken: b.purchase_token, verified,
    });
  }));
  app.use('/api/v1', api);

  // ── The owner's pages ─────────────────────────────────────────────────────

  const owner = (req) => service.getSession(cookies(req)[OWNER_COOKIE], 'owner');
  const page = (res, html, status = 200) => res.status(status).type('html').set('Cache-Control', 'no-store').send(html);

  app.get('/link', (req, res) => {
    const code = String(req.query.code || '');
    if (!code) return page(res, pages.enterCode({ googleReady: google.configured }));
    const link = service.findLink(code);
    if (!link) return page(res, pages.enterCode({ code, error: 'That code has expired or was already used. Ask the POS for a new one.', googleReady: google.configured }), 404);
    const session = owner(req);
    if (!session) return page(res, pages.signIn({ code: link.user_code, link }));
    return page(res, pages.approve({
      code: link.user_code, link, stores: service.storesForOwner(session.subject),
      owner: { email: session.email }, csrf: session.csrf,
    }));
  });

  app.get('/auth/google', limiter({ perMinute: 20 }), (req, res) => {
    if (!google.configured) return page(res, pages.message('Not set up yet', 'Google sign-in is not configured on this server.'), 503);
    const { verifier, challenge } = pkce();
    const nonce = crypto.randomBytes(16).toString('base64url');
    const state = service.saveOAuthState({ verifier, nonce, userCode: String(req.query.code || '') });
    return res.redirect(google.authorizationUrl({ state, nonce, challenge }));
  });

  app.get('/auth/google/callback', async (req, res) => {
    const saved = service.takeOAuthState(req.query.state);
    if (!saved || !req.query.code) return page(res, pages.message('Sign-in failed', 'The sign-in could not be completed. Start again from the code.', 'err'), 400);
    try {
      const who = await google.exchange({ code: String(req.query.code), verifier: saved.verifier, nonce: saved.nonce });
      const session = service.createSession({ kind: 'owner', subject: who.sub, email: who.email, name: who.name, hours: 1 });
      setCookie(res, OWNER_COOKIE, session.id, 3600);
      return res.redirect(saved.user_code ? `/link?code=${encodeURIComponent(saved.user_code)}` : '/link');
    } catch (err) {
      return page(res, pages.message('Sign-in failed', err.message, 'err'), 400);
    }
  });

  const checkCsrf = (session, req) => session && typeof req.body.csrf === 'string'
    && req.body.csrf.length === session.csrf.length
    && crypto.timingSafeEqual(Buffer.from(req.body.csrf), Buffer.from(session.csrf));

  app.post('/link/approve', (req, res) => {
    const session = owner(req);
    if (!checkCsrf(session, req)) return page(res, pages.message('Sign in again', 'Your sign-in has expired. Start again from the code.', 'err'), 403);
    try {
      const { store } = service.approveLink({
        code: req.body.code, owner: { sub: session.subject, email: session.email },
        storeId: req.body.store_id || null, newStoreName: req.body.store_name,
      });
      return page(res, pages.linked({ store }));
    } catch (err) {
      if (err instanceof ServiceError) return page(res, pages.message('Not linked', err.message, 'err'), err.status);
      throw err;
    }
  });

  app.post('/link/deny', (req, res) => {
    const session = owner(req);
    if (!checkCsrf(session, req)) return page(res, pages.message('Sign in again', 'Your sign-in has expired.', 'err'), 403);
    service.denyLink({ code: req.body.code, owner: { email: session.email } });
    return page(res, pages.denied());
  });

  app.get('/logout', (req, res) => {
    service.endSession(cookies(req)[OWNER_COOKIE]);
    setCookie(res, OWNER_COOKIE, '', 0);
    return res.redirect(req.query.code ? `/link?code=${encodeURIComponent(String(req.query.code))}` : '/link');
  });

  // ── Admin ─────────────────────────────────────────────────────────────────

  const admin = (req) => service.getSession(cookies(req)[ADMIN_COOKIE], 'admin');
  const requireAdmin = (req, res, next) => {
    const session = admin(req);
    if (!session) return res.redirect('/admin/login');
    if (req.method === 'POST' && !checkCsrf(session, req)) return page(res, pages.message('Expired', 'Sign in again.', 'err'), 403);
    req.admin = session;
    return next();
  };

  app.get('/admin/login', (req, res) => page(res, pages.adminLogin({ configured: Boolean(config.admin.passwordHash) })));
  app.post('/admin/login', limiter({ perMinute: 10 }), async (req, res) => {
    const ok = config.admin.passwordHash && typeof req.body.password === 'string'
      && await bcrypt.compare(req.body.password, config.admin.passwordHash);
    if (!ok) return page(res, pages.adminLogin({ error: 'Wrong password.', configured: Boolean(config.admin.passwordHash) }), 401);
    const session = service.createSession({ kind: 'admin', subject: 'admin', email: 'admin', hours: 8 });
    setCookie(res, ADMIN_COOKIE, session.id, 8 * 3600);
    return res.redirect('/admin');
  });
  app.post('/admin/logout', requireAdmin, (req, res) => {
    service.endSession(cookies(req)[ADMIN_COOKIE]);
    setCookie(res, ADMIN_COOKIE, '', 0);
    return res.redirect('/admin/login');
  });
  app.get('/admin', requireAdmin, (req, res) => page(res, pages.adminStores({ stores: service.listStores(), now: now(), csrf: req.admin.csrf })));
  app.get('/admin/stores/:id', requireAdmin, (req, res) => {
    const detail = service.storeDetail(req.params.id);
    if (!detail) return page(res, pages.message('Not found', 'No such store.'), 404);
    return page(res, pages.adminStore({ detail, now: now(), csrf: req.admin.csrf, notice: req.query.notice || null }));
  });
  app.post('/admin/stores/:id/payments', requireAdmin, (req, res) => {
    const amount = String(req.body.amount || '').replace(/[₱,\s]/g, '');
    if (amount && !/^\d+(\.\d{1,2})?$/.test(amount)) return page(res, pages.message('Not recorded', 'The amount is not a peso amount.', 'err'), 400);
    try {
      const store = service.recordPayment({
        storeId: req.params.id, months: Number(req.body.months),
        amountCentavos: amount ? Math.round(Number(amount) * 100) : null,
        reference: String(req.body.reference || '').slice(0, 80) || null,
        note: String(req.body.note || '').slice(0, 200) || null,
        recordedBy: 'admin',
      });
      return res.redirect(`/admin/stores/${store.id}?notice=${encodeURIComponent(`Recorded. Paid until ${store.paid_until.slice(0, 10)}.`)}`);
    } catch (err) {
      if (err instanceof ServiceError) return page(res, pages.message('Not recorded', err.message, 'err'), err.status);
      throw err;
    }
  });
  app.post('/admin/installations/:id/revoke', requireAdmin, (req, res) => {
    const storeId = service.revokeInstallation(req.params.id);
    return res.redirect(storeId ? `/admin/stores/${storeId}?notice=Device%20removed.` : '/admin');
  });

  return app;
}

module.exports = { createApp };
