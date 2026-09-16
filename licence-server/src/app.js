'use strict';

// The licence server's HTTP surface — TASK-048.
//
//   POST /api/v1/device/start      the POS asks for a link code
//   POST /api/v1/device/poll       …and polls until the owner approves it
//   POST /api/v1/licence/renew     the monthly check: installation id + secret → licence
//   POST /api/v1/play/purchase     a Google Play purchase, verified with Google
//   GET  /api/v1/public-key        the key the POS verifies licences with
//   GET  /link, /auth/google…      the owner links a device, signed in with Google
//   GET  /admin…                   Chachi's page: stores, devices, manual payments; plans set by hand (TASK-067)
//   GET  /, /privacy, /static/…     the public site that introduces Chachi POS (site/)
//   GET  /guide, /guide/:chapter    the user guide (site/guide/, wrapped by guide.js)

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const { pages } = require('./pages');
const guide = require('./guide');
const { pkce } = require('./google');
const { ServiceError, endOfManilaDay } = require('./service');

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
  /**
   * TASK-065: the web stores live on this host too, at /s/<store>/. A sign-in cookie is
   * therefore set only for the pages that read it, not for the whole site — so a store's
   * pages never carry the owner's or Chachi's admin session — and a copy once set for the
   * whole site is cleared as it is replaced.
   */
  const COOKIE_PATHS = { [OWNER_COOKIE]: ['/link', '/stores', '/logout'], [ADMIN_COOKIE]: ['/admin'] };
  const setCookie = (res, name, value, maxAgeSeconds) => {
    for (const where of COOKIE_PATHS[name] || ['/']) {
      res.append('Set-Cookie',
        `${name}=${encodeURIComponent(value)}; Path=${where}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`);
    }
    res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
  };

  /**
   * TASK-065: the pages a sign-in cookie opens answer only as pages — a navigation or a
   * form — never to a script's fetch. A store's page on this host is the same origin as
   * these, and this is what keeps even a misbehaving one from reading them.
   */
  const pagesOnly = (req, res, next) => {
    // A browser marks every request with where it came from (Sec-Fetch-Site) and how
    // (Sec-Fetch-Mode); a page load or a form post is "navigate", a script's fetch is not.
    const site = req.get('sec-fetch-site');
    const mode = req.get('sec-fetch-mode');
    if (site && mode && mode !== 'navigate') return res.status(403).type('text/plain').send('This page opens only as a page.');
    return next();
  };
  app.use(['/link', '/stores', '/logout', '/admin', '/auth'], pagesOnly);

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
    webUrl: b.web_url,
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
      code: link.user_code, link, stores: service.storesForApproval({ sub: session.subject, email: session.email }),
      owner: { email: session.email }, csrf: session.csrf,
    }));
  });

  app.get('/auth/google', limiter({ perMinute: 20 }), (req, res) => {
    if (!google.configured) return page(res, pages.message('Not set up yet', 'Google sign-in is not configured on this server.'), 503);
    const { verifier, challenge } = pkce();
    const nonce = crypto.randomBytes(16).toString('base64url');
    const state = service.saveOAuthState({
      verifier, nonce, userCode: String(req.query.code || ''), returnTo: req.query.next === 'stores' ? 'stores' : null,
    });
    return res.redirect(google.authorizationUrl({ state, nonce, challenge }));
  });

  app.get('/auth/google/callback', async (req, res) => {
    const saved = service.takeOAuthState(req.query.state);
    if (!saved || !req.query.code) return page(res, pages.message('Sign-in failed', 'The sign-in could not be completed. Start again from the code.', 'err'), 400);
    try {
      const who = await google.exchange({ code: String(req.query.code), verifier: saved.verifier, nonce: saved.nonce });
      const session = service.createSession({ kind: 'owner', subject: who.sub, email: who.email, name: who.name, hours: 1 });
      setCookie(res, OWNER_COOKIE, session.id, 3600);
      if (saved.return_to === 'stores') return res.redirect('/stores');
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
    if (req.query.next === 'stores') return res.redirect('/stores');
    return res.redirect(req.query.code ? `/link?code=${encodeURIComponent(String(req.query.code))}` : '/link');
  });

  // TASK-065: an owner's front door to their stores on the web, by Google sign-in. Staff
  // go straight to their store's own address and sign in there with their POS login.
  app.get('/stores', (req, res) => {
    const session = owner(req);
    if (!session) return page(res, pages.storesSignIn({ googleReady: google.configured }));
    return page(res, pages.stores({ owner: { email: session.email }, stores: service.ownerStores(session.subject), now: now() }));
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
  app.get('/admin', requireAdmin, (req, res) => page(res, pages.adminStores({
    stores: service.listStores(), now: now(), csrf: req.admin.csrf, notice: req.query.notice || null,
  })));
  app.get('/admin/stores/:id', requireAdmin, (req, res) => {
    const detail = service.storeDetail(req.params.id);
    if (!detail) return page(res, pages.message('Not found', 'No such store.'), 404);
    return page(res, pages.adminStore({ detail, now: now(), csrf: req.admin.csrf, notice: req.query.notice || null }));
  });
  /** An amount typed on a form, in centavos: null when blank, undefined when it is not one. */
  const pesos = (typed) => {
    const amount = String(typed || '').replace(/[₱,\s]/g, '');
    if (!amount) return null;
    return /^\d+(\.\d{1,2})?$/.test(amount) ? Math.round(Number(amount) * 100) : undefined;
  };
  const text = (value, max) => String(value || '').trim().slice(0, max) || null;
  const confirmed = (req) => req.body.confirm === 'yes';

  /**
   * One admin form: `act` does the work and answers the store it changed; the page goes back
   * to that store with `notice`, or says why nothing was done.
   */
  const adminForm = (act) => (req, res) => {
    try {
      const { store, notice, to } = act(req);
      return res.redirect(to || `/admin/stores/${store.id}?notice=${encodeURIComponent(notice)}`);
    } catch (err) {
      if (err instanceof ServiceError) return page(res, pages.message('Not done', err.message, 'err', '/admin'), err.status);
      throw err;
    }
  };
  const refuse = (status, code, message) => { throw new ServiceError(status, code, message); };
  const paidDate = (store) => (store.plan === 'ONE_TIME' ? 'one-time, for good' : `paid until ${store.paid_until.slice(0, 10)}`);

  app.post('/admin/stores/:id/payments', requireAdmin, adminForm((req) => {
    const amountCentavos = pesos(req.body.amount);
    if (amountCentavos === undefined) refuse(400, 'amount', 'The amount is not a peso amount.');
    const store = service.recordPayment({
      storeId: req.params.id, months: Number(req.body.months), amountCentavos,
      reference: text(req.body.reference, 80), note: text(req.body.note, 200), recordedBy: 'admin',
    });
    return { store, notice: `Recorded. Paid until ${store.paid_until.slice(0, 10)}.` };
  }));

  // TASK-067, LIC-005 – LIC-007: the plan, set by hand.
  app.post('/admin/stores/:id/one-time', requireAdmin, adminForm((req) => {
    const amountCentavos = pesos(req.body.amount);
    if (amountCentavos === undefined) refuse(400, 'amount', 'The amount is not a peso amount.');
    if (!confirmed(req)) refuse(400, 'confirm', 'Tick the box to confirm the store has paid once, for good.');
    const store = service.setOneTime({
      storeId: req.params.id, amountCentavos,
      reference: text(req.body.reference, 80), note: text(req.body.note, 200), recordedBy: 'admin',
    });
    return { store, notice: 'Set as one-time paid. Its devices have it at their next check.' };
  }));

  app.post('/admin/stores/:id/paid-until', requireAdmin, adminForm((req) => {
    const current = service.storeDetail(req.params.id);
    if (!current) refuse(404, 'no_store', 'No such store.');
    // Access taken away, or shortened, is confirmed first.
    const shortens = current.store.plan === 'ONE_TIME' || endOfManilaDay(req.body.date) < current.store.paid_until;
    if (shortens && !confirmed(req)) {
      refuse(400, 'confirm', `That is earlier than what the store has now (${paidDate(current.store)}). Tick the box to confirm.`);
    }
    const store = service.setPaidUntil({ storeId: req.params.id, date: req.body.date, note: req.body.note, recordedBy: 'admin' });
    return { store, notice: `Set. Paid until ${store.paid_until.slice(0, 10)}; its devices have it at their next check.` };
  }));

  app.post('/admin/stores/:id/revoke-one-time', requireAdmin, adminForm((req) => {
    if (!confirmed(req)) refuse(400, 'confirm', 'Tick the box to confirm. Every device of this store stops opening shifts after its grace.');
    const store = service.revokeOneTime({ storeId: req.params.id, note: req.body.note, recordedBy: 'admin' });
    return { store, notice: 'One-time licence revoked. Its devices lapse after their next check and grace.' };
  }));

  app.post('/admin/stores', requireAdmin, adminForm((req) => {
    const amountCentavos = pesos(req.body.amount);
    if (amountCentavos === undefined) refuse(400, 'amount', 'The amount is not a peso amount.');
    const store = service.registerStore({
      name: req.body.store_name, ownerEmail: req.body.owner_email, plan: String(req.body.plan || ''),
      date: req.body.date, amountCentavos, reference: text(req.body.reference, 80), note: text(req.body.note, 200),
      recordedBy: 'admin',
    });
    return { store, notice: `Registered, ${paidDate(store)}. It is linked when ${store.owner_email} approves a POS on /link.` };
  }));

  app.post('/admin/stores/:id/delete', requireAdmin, adminForm((req) => {
    if (!confirmed(req)) refuse(400, 'confirm', 'Tick the box to confirm.');
    const store = service.deleteUnlinkedStore(req.params.id);
    return { store, to: `/admin?notice=${encodeURIComponent(`${store.name} deleted.`)}` };
  }));

  app.post('/admin/installations/:id/revoke', requireAdmin, (req, res) => {
    const storeId = service.revokeInstallation(req.params.id);
    return res.redirect(storeId ? `/admin/stores/${storeId}?notice=Device%20removed.` : '/admin');
  });

  return app;
}

module.exports = { createApp };
