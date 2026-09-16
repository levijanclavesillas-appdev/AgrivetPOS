'use strict';

// The licence server, over real HTTP — TASK-048. Google and Play are stubbed; the
// signing, the database, the pages and the rules are the real ones.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../src/db');
const licence = require('../src/licence');
const { createService, normaliseCode, addMonths } = require('../src/service');
const { createGoogle } = require('../src/google');
const { createApp } = require('../src/app');
const guide = require('../src/guide');

const PASSWORD = 'correct-horse-battery-staple';

const rawFetch = global.fetch;

/** A server on a random port with its own clock, database and key. */
async function boot({ playVerify = null, googleClaims = { sub: 'g-owner-1', email: 'rosa@example.com', name: 'Rosa' } } = {}) {
  let clock = new Date('2026-09-15T00:00:00.000Z');
  const now = () => clock;
  const config = {
    baseUrl: 'http://licence.test', validityDays: 30, graceDays: 7, warningDays: 7, trialDays: 14,
    admin: { passwordHash: bcrypt.hashSync(PASSWORD, 4) }, behindProxy: false,
  };
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const service = createService({ db: db.open(':memory:'), config, privateKey, now });
  const google = {
    configured: true,
    authorizationUrl: ({ state }) => `https://accounts.google.test/auth?state=${state}`,
    exchange: async ({ code }) => { if (code !== 'good') throw new Error('Google refused'); return googleClaims; },
  };
  const play = playVerify ? { configured: true, verify: playVerify } : { configured: false };
  const server = createApp({ service, config, google, play, now }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const publicKey = crypto.createPublicKey(privateKey);
  return {
    base, service, publicKey, server,
    advance: (days) => { clock = new Date(clock.getTime() + days * 86400e3); },
    close: () => new Promise((r) => server.close(r)),
  };
}

const post = (base, path, body, headers = {}) => fetch(base + path, {
  method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const form = (base, path, fields, cookie) => fetch(base + path, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams(fields),
});
const cookieOf = (response) => (response.headers.get('set-cookie') || '').split(';')[0];
const csrfIn = (html) => /name="csrf" value="([^"]+)"/.exec(html)[1];

/** Start a link and walk the owner through Google to the approve page. */
async function linkAndSignIn(s, { installationId = 'inst-0000-0001', storeName = 'Botika ni Aling Rosa' } = {}) {
  const started = await (await post(s.base, '/api/v1/device/start', { installation_id: installationId, store_name: storeName, platform: 'Android' })).json();
  const toGoogle = await fetch(`${s.base}/auth/google?code=${started.user_code}`, { redirect: 'manual' });
  const state = new URL(toGoogle.headers.get('location')).searchParams.get('state');
  const back = await fetch(`${s.base}/auth/google/callback?code=good&state=${state}`, { redirect: 'manual' });
  const cookie = cookieOf(back);
  const approvePage = await (await fetch(`${s.base}/link?code=${started.user_code}`, { headers: { cookie } })).text();
  return { started, cookie, approvePage };
}

test('the device link: a code, the owner signs in with Google, approves, and the device collects its licence once', async () => {
  const s = await boot();
  try {
    const { started, cookie, approvePage } = await linkAndSignIn(s);
    assert.match(started.user_code, /^[B-DF-HJ-NP-TV-XZ2-9]{4}-[B-DF-HJ-NP-TV-XZ2-9]{4}$/);
    assert.equal(started.verification_uri_complete, `http://licence.test/link?code=${started.user_code}`);

    // Before approval the device waits.
    assert.equal((await (await post(s.base, '/api/v1/device/poll', { device_code: started.device_code })).json()).status, 'pending');

    assert.match(approvePage, /Approve this device\?/);
    assert.match(approvePage, /rosa@example\.com/);
    const approved = await form(s.base, '/link/approve', { csrf: csrfIn(approvePage), code: started.user_code, store_name: 'Botika ni Aling Rosa' }, cookie);
    assert.equal(approved.status, 200);
    assert.match(await approved.text(), /now part of <strong>Botika ni Aling Rosa<\/strong>/);

    const picked = await (await post(s.base, '/api/v1/device/poll', { device_code: started.device_code })).json();
    assert.equal(picked.status, 'approved');
    assert.ok(picked.installation_secret.length >= 40);
    const payload = licence.verify(picked.licence, s.publicKey);
    assert.equal(payload.store_name, 'Botika ni Aling Rosa');
    assert.equal(payload.installation_id, 'inst-0000-0001');
    assert.equal(payload.paid_until, '2026-09-29T00:00:00.000Z', 'a new store starts on the 14-day trial');
    assert.equal(payload.valid_until, '2026-10-15T00:00:00.000Z', '30 days from the check');
    assert.equal(payload.grace_days, 7);

    // Once only: a code seen over a shoulder is worth nothing afterwards.
    assert.equal((await (await post(s.base, '/api/v1/device/poll', { device_code: started.device_code })).json()).status, 'used');
    assert.equal((await fetch(`${s.base}/link?code=${started.user_code}`)).status, 404);
  } finally { await s.close(); }
});

test('without the sign-in, or without the form\'s token, nothing is approved', async () => {
  const s = await boot();
  try {
    const started = await (await post(s.base, '/api/v1/device/start', { installation_id: 'inst-0000-0002' })).json();
    const signInPage = await (await fetch(`${s.base}/link?code=${started.user_code.toLowerCase().replace('-', '')}`)).text();
    assert.match(signInPage, /Continue with Google/, 'the code is read however it was typed');
    assert.equal((await form(s.base, '/link/approve', { code: started.user_code }, '')).status, 403);

    const { cookie } = await linkAndSignIn(s, { installationId: 'inst-0000-0003' });
    assert.equal((await form(s.base, '/link/approve', { csrf: 'forged', code: started.user_code }, cookie)).status, 403);
    assert.equal((await (await post(s.base, '/api/v1/device/poll', { device_code: started.device_code })).json()).status, 'pending');
  } finally { await s.close(); }
});

test('a link code lasts fifteen minutes', async () => {
  const s = await boot();
  try {
    const started = await (await post(s.base, '/api/v1/device/start', { installation_id: 'inst-0000-0004' })).json();
    s.advance(16 / 1440);
    assert.equal((await (await post(s.base, '/api/v1/device/poll', { device_code: started.device_code })).json()).status, 'expired');
  } finally { await s.close(); }
});

async function linkedDevice(s, installationId = 'inst-0000-0010') {
  const { started, cookie, approvePage } = await linkAndSignIn(s, { installationId });
  await form(s.base, '/link/approve', { csrf: csrfIn(approvePage), code: started.user_code, store_name: 'Botika' }, cookie);
  return (await post(s.base, '/api/v1/device/poll', { device_code: started.device_code })).json();
}

test('renewal: the secret renews silently; a wrong one, or a removed device, is refused', async () => {
  const s = await boot();
  try {
    const device = await linkedDevice(s);
    s.advance(20);
    const renewed = await (await post(s.base, '/api/v1/licence/renew', { installation_id: 'inst-0000-0010', installation_secret: device.installation_secret })).json();
    const payload = licence.verify(renewed.licence, s.publicKey);
    assert.equal(payload.checked_at, '2026-10-05T00:00:00.000Z');
    assert.equal(payload.valid_until, '2026-11-04T00:00:00.000Z');

    assert.equal((await post(s.base, '/api/v1/licence/renew', { installation_id: 'inst-0000-0010', installation_secret: 'x'.repeat(43) })).status, 401);

    const storeId = payload.store_id;
    const devices = s.service.storeDetail(storeId).installations;
    s.service.revokeInstallation(devices[0].id);
    assert.equal((await post(s.base, '/api/v1/licence/renew', { installation_id: 'inst-0000-0010', installation_secret: device.installation_secret })).status, 403);
  } finally { await s.close(); }
});

test('a manual payment extends from the later of today and the date already paid to', async () => {
  const s = await boot();
  try {
    const device = await linkedDevice(s);
    const storeId = licence.verify(device.licence, s.publicKey).store_id;

    // Paid early, during the trial: the month is added to the trial's end.
    let store = s.service.recordPayment({ storeId, months: 1, amountCentavos: 49900, reference: 'GC-1', recordedBy: 'admin' });
    assert.equal(store.paid_until, '2026-10-29T00:00:00.000Z');

    // Paid late, after it lapsed: from today, not from the old date.
    s.advance(60);
    store = s.service.recordPayment({ storeId, months: 1, recordedBy: 'admin' });
    assert.equal(store.paid_until, '2026-12-14T00:00:00.000Z');

    assert.throws(() => s.service.recordPayment({ storeId, months: 0, recordedBy: 'admin' }), /Months is a whole number/);
    assert.equal(addMonths('2027-01-31T00:00:00.000Z', 1), '2027-02-28T00:00:00.000Z', 'the 31st into February is its last day');
  } finally { await s.close(); }
});

test('Google Play: unverified until the server can ask Google, and then paid to Google\'s date and never shortened', async () => {
  const off = await boot();
  try {
    const device = await linkedDevice(off);
    const r = await post(off.base, '/api/v1/play/purchase', { installation_id: 'inst-0000-0010', installation_secret: device.installation_secret, product_id: 'pos_monthly', purchase_token: 't1' });
    assert.equal(r.status, 503);
  } finally { await off.close(); }

  const asked = [];
  const s = await boot({ playVerify: async (q) => { asked.push(q); return { productId: q.productId, expiry: '2026-11-15T00:00:00.000Z', state: 'SUBSCRIPTION_STATE_ACTIVE' }; } });
  try {
    const device = await linkedDevice(s);
    const body = { installation_id: 'inst-0000-0010', installation_secret: device.installation_secret, product_id: 'pos_monthly', purchase_token: 'play-token-1' };
    const paid = licence.verify((await (await post(s.base, '/api/v1/play/purchase', body)).json()).licence, s.publicKey);
    assert.equal(paid.paid_until, '2026-11-15T00:00:00.000Z');
    assert.deepEqual(asked[0], { productId: 'pos_monthly', purchaseToken: 'play-token-1' });

    // A manual payment on top, then a Play report of an earlier date: the later stands.
    s.service.recordPayment({ storeId: paid.store_id, months: 2, recordedBy: 'admin' });
    const again = licence.verify((await (await post(s.base, '/api/v1/play/purchase', body)).json()).licence, s.publicKey);
    assert.equal(again.paid_until, '2027-01-15T00:00:00.000Z');
  } finally { await s.close(); }
});

test('admin: the password signs in, a payment is recorded through the form, and a form without its token is refused', async () => {
  const s = await boot();
  try {
    const device = await linkedDevice(s);
    const storeId = licence.verify(device.licence, s.publicKey).store_id;

    assert.equal((await form(s.base, '/admin/login', { password: 'wrong' }, '')).status, 401);
    const login = await form(s.base, '/admin/login', { password: PASSWORD }, '');
    assert.equal(login.status, 302);
    const cookie = cookieOf(login);

    const list = await (await fetch(`${s.base}/admin`, { headers: { cookie } })).text();
    assert.match(list, /Botika/);
    const detail = await (await fetch(`${s.base}/admin/stores/${storeId}`, { headers: { cookie } })).text();
    assert.equal((await form(s.base, `/admin/stores/${storeId}/payments`, { months: '1' }, cookie)).status, 403);
    const recorded = await form(s.base, `/admin/stores/${storeId}/payments`, { csrf: csrfIn(detail), months: '3', amount: '1,497.00', reference: 'GC-778' }, cookie);
    assert.equal(recorded.status, 302);
    const after = s.service.storeDetail(storeId);
    assert.equal(after.store.paid_until, '2026-12-29T00:00:00.000Z');
    assert.equal(after.payments[0].amount_centavos, 149700);
    assert.equal(after.payments[0].reference, 'GC-778');

    assert.equal((await fetch(`${s.base}/admin`, { redirect: 'manual' })).status, 302, 'no cookie, no admin');
  } finally { await s.close(); }
});

test('pages carry a strict policy and no script', async () => {
  const s = await boot();
  try {
    const r = await fetch(`${s.base}/link`);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'.*frame-ancestors 'none'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(/<script/i.test(await r.text()), false);
  } finally { await s.close(); }
});

test('the public site: its pages, every file they name, and the same policy with no script', async () => {
  const s = await boot();
  try {
    const guidePages = ['/guide', ...guide.chapters().map((c) => `/guide/${c.slug}`)];
    for (const page of ['/', '/privacy', ...guidePages]) {
      const r = await fetch(`${s.base}${page}`);
      assert.equal(r.status, 200, page);
      assert.match(r.headers.get('content-type'), /text\/html/);
      assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
      const html = await r.text();
      assert.match(html, /Chachi POS/);
      // The one <script> allowed is the search engines' data block, which a browser never runs.
      for (const tag of html.match(/<script[^>]*>/gi) || []) assert.match(tag, /type="application\/ld\+json"/, `${page}: ${tag}`);
      const files = new Set([...html.matchAll(/(?:src|href)="(\/static\/[^"#]+)/g)].map((m) => m[1]));
      for (const file of files) {
        const asset = await fetch(`${s.base}${file}`);
        assert.equal(asset.status, 200, `${page} names ${file}`);
        assert.match(asset.headers.get('cache-control'), /max-age=86400/);
      }
    }
    assert.equal((await fetch(`${s.base}/static/nothing-here.png`)).status, 404);
    assert.match(await (await fetch(`${s.base}/robots.txt`)).text(), /Disallow: \/admin/);
    const sitemap = await (await fetch(`${s.base}/sitemap.xml`)).text();
    for (const page of guidePages) assert.ok(sitemap.includes(`store${page}<`), `sitemap lists ${page}`);
    assert.equal((await fetch(`${s.base}/guide/no-such-chapter`)).status, 404);
    assert.equal((await fetch(`${s.base}/guide/..%2Fsrc%2Fapp`)).status, 404);
    assert.equal((await fetch(`${s.base}/link`)).status, 200);
  } finally { await s.close(); }
});

test('the guide: every link between chapters, and within one, reaches a section that exists', async () => {
  const s = await boot();
  try {
    const html = {};
    for (const page of ['/guide', ...guide.chapters().map((c) => `/guide/${c.slug}`)]) {
      html[page] = await (await fetch(`${s.base}${page}`)).text();
    }
    const ids = (text) => new Set([...text.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const [page, text] of Object.entries(html)) {
      for (const [, target, hash] of text.matchAll(/href="(\/guide(?:\/[a-z-]+)?)?(?:#([^"]+))?"/g)) {
        const where = target || page;
        assert.ok(html[where], `${page} links to ${where}, which is not a guide page`);
        if (hash) assert.ok(ids(html[where]).has(hash), `${page} links to ${where}#${hash}, which has no such section`);
      }
    }
  } finally { await s.close(); }
});

test('a code is read however it is typed', () => {
  assert.equal(normaliseCode(' bcdf 2345 '), 'BCDF-2345');
  assert.equal(normaliseCode('BCDF-2345'), 'BCDF-2345');
  assert.equal(normaliseCode('BCD'), null);
});

test('Google ID tokens are verified by signature, issuer, audience, expiry and nonce', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const now = Date.parse('2026-09-15T00:00:00Z');
  const google = createGoogle({
    clientId: 'client-1', clientSecret: 's', redirectUri: 'x', now: () => now,
    fetch: async () => ({ ok: true, json: async () => ({ keys: [jwk] }) }),
  });
  const mint = (claims, { kid = 'k1', key = privateKey } = {}) => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${enc({ alg: 'RS256', kid })}.${enc(claims)}`;
    return `${unsigned}.${crypto.sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`;
  };
  const good = { iss: 'https://accounts.google.com', aud: 'client-1', sub: '42', email: 'o@x.ph', email_verified: true, exp: now / 1000 + 600, nonce: 'n1' };

  assert.deepEqual(await google.verifyIdToken(mint(good), { nonce: 'n1' }), { sub: '42', email: 'o@x.ph', name: 'o@x.ph' });
  await assert.rejects(google.verifyIdToken(mint({ ...good, aud: 'someone-else' }), { nonce: 'n1' }), /another application/);
  await assert.rejects(google.verifyIdToken(mint({ ...good, exp: now / 1000 - 1 }), { nonce: 'n1' }), /expired/);
  await assert.rejects(google.verifyIdToken(mint(good), { nonce: 'n2' }), /does not answer this sign-in/);
  await assert.rejects(google.verifyIdToken(mint({ ...good, iss: 'evil' }), { nonce: 'n1' }), /not issued by Google/);
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await assert.rejects(google.verifyIdToken(mint(good, { key: other }), { nonce: 'n1' }), /signature is not valid/);
  await assert.rejects(google.verifyIdToken(mint(good, { kid: 'k9' }), { nonce: 'n1' }), /does not publish/);
});

// ── TASK-065: web stores on this host ──────────────────────────────────────

test('TASK-065: a web copy that links is listed on its owner\'s "Your stores", and only a store path is accepted', async () => {
  const s = await boot();
  try {
    // Not signed in: the page offers Google.
    const signIn = await (await fetch(`${s.base}/stores`)).text();
    assert.match(signIn, /Continue with Google/);
    assert.match(signIn, /href="\/auth\/google\?next=stores"/);

    // A web copy starts its link with its address; a phone does not have one.
    const web = await (await post(s.base, '/api/v1/device/start', {
      installation_id: 'inst-web-0001', store_name: 'Botika sa Web', platform: 'Web',
      web_url: 'http://licence.test/s/botika-web/',
    })).json();
    // An address anywhere else is not kept: "Your stores" would link the owner to it.
    const elsewhere = await (await post(s.base, '/api/v1/device/start', {
      installation_id: 'inst-web-0002', store_name: 'Elsewhere', platform: 'Web', web_url: 'https://evil.test/s/x',
    })).json();

    const toGoogle = await fetch(`${s.base}/auth/google?next=stores`, { redirect: 'manual' });
    const state = new URL(toGoogle.headers.get('location')).searchParams.get('state');
    const back = await fetch(`${s.base}/auth/google/callback?code=good&state=${state}`, { redirect: 'manual' });
    assert.equal(back.headers.get('location'), '/stores', 'Google sign-in returns to Your stores');

    // The owner cookie is set for the pages that read it, never for the whole site.
    const setCookies = back.headers.getSetCookie();
    const paths = setCookies.filter((c) => c.startsWith('cps_owner=') && !/Max-Age=0/.test(c)).map((c) => /Path=([^;]+)/.exec(c)[1]);
    assert.deepEqual(paths.sort(), ['/link', '/logout', '/stores']);
    assert.ok(setCookies.some((c) => /Path=\/;/.test(c) && /Max-Age=0/.test(c)), 'and a whole-site copy is cleared');
    const cookie = cookieOf(back);

    for (const [started, name] of [[web, 'Botika sa Web'], [elsewhere, 'Elsewhere']]) {
      const code = started.user_code;
      const approvePage = await (await fetch(`${s.base}/link?code=${code}`, { headers: { cookie } })).text();
      const approved = await form(s.base, '/link/approve', { csrf: csrfIn(approvePage), code, store_id: '', store_name: name }, cookie);
      assert.equal(approved.status, 200);
      // The POS collects its licence, which is when it becomes one of the store's installations.
      assert.equal((await (await post(s.base, '/api/v1/device/poll', { device_code: started.device_code })).json()).status, 'approved');
    }

    const stores = await (await fetch(`${s.base}/stores`, { headers: { cookie } })).text();
    assert.match(stores, /Botika sa Web/);
    assert.match(stores, /href="http:\/\/licence\.test\/s\/botika-web\/">Open on the web/);
    assert.doesNotMatch(stores, /evil\.test/, 'an address outside this site is not shown');
    assert.match(stores, /Not on the web/);
  } finally {
    await s.close();
  }
});

test('TASK-065: pages behind a sign-in answer a page load, never a script', async () => {
  const s = await boot();
  try {
    for (const path of ['/stores', '/link', '/admin', '/admin/login', '/logout']) {
      // What a browser sends for a script's fetch from a page on this host (a store's, at /s/…).
      const script = await rawFetch(`${s.base}${path}`, { headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }, redirect: 'manual' });
      assert.equal(script.status, 403, `${path} refuses a fetch`);
    }
    // A page load, as a browser sends it (Node's fetch cannot say "navigate", so plain http).
    const navigated = await new Promise((resolve, reject) => require('http')
      .get(`${s.base}/stores`, { headers: { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' } }, (r) => { r.resume(); resolve(r.statusCode); })
      .on('error', reject));
    assert.equal(navigated, 200, 'and opens as a page');
    // The public site and the API are not behind a cookie, and answer scripts as before.
    assert.equal((await rawFetch(`${s.base}/api/v1/health`)).status, 200);
    assert.equal((await rawFetch(`${s.base}/`)).status, 200);
  } finally {
    await s.close();
  }
});


// ── TASK-067: one-time licences, and plans set by hand ───────────────────────

async function adminCookie(s) {
  return cookieOf(await form(s.base, '/admin/login', { password: PASSWORD }, ''));
}
const adminCsrf = async (s, cookie, where = '/admin') => csrfIn(await (await fetch(s.base + where, { headers: { cookie } })).text());

test('TASK-067: a trial store set as one-time paid is paid for good; a payment or a Play purchase leaves it so', async () => {
  const s = await boot({ playVerify: async (q) => ({ productId: q.productId, expiry: '2026-11-15T00:00:00.000Z', state: 'SUBSCRIPTION_STATE_ACTIVE' }) });
  try {
    const device = await linkedDevice(s);
    const storeId = licence.verify(device.licence, s.publicKey).store_id;
    const cookie = await adminCookie(s);
    const csrf = await adminCsrf(s, cookie, `/admin/stores/${storeId}`);

    // Unconfirmed, nothing happens; without the token, nothing either.
    assert.equal((await form(s.base, `/admin/stores/${storeId}/one-time`, { csrf, amount: '15,000' }, cookie)).status, 400);
    assert.equal((await form(s.base, `/admin/stores/${storeId}/one-time`, { amount: '15,000', confirm: 'yes' }, cookie)).status, 403);
    assert.equal(s.service.storeDetail(storeId).store.plan, 'MONTHLY');

    const set = await form(s.base, `/admin/stores/${storeId}/one-time`, { csrf, amount: '15,000', reference: 'BDO-9', confirm: 'yes' }, cookie);
    assert.equal(set.status, 302);
    const detail = s.service.storeDetail(storeId);
    assert.equal(detail.store.plan, 'ONE_TIME');
    assert.equal(detail.store.paid_until, '9999-12-31T00:00:00.000Z');
    assert.deepEqual(
      { method: detail.payments[0].method, amount: detail.payments[0].amount_centavos, before: detail.payments[0].paid_until_before },
      { method: 'ONE_TIME', amount: 1500000, before: '2026-09-29T00:00:00.000Z' },
    );

    const renewed = licence.verify((await (await post(s.base, '/api/v1/licence/renew', { installation_id: 'inst-0000-0010', installation_secret: device.installation_secret })).json()).licence, s.publicKey);
    assert.equal(renewed.plan, 'ONE_TIME');
    assert.equal(renewed.paid_until, '9999-12-31T00:00:00.000Z');
    assert.equal(renewed.valid_until, '2026-10-15T00:00:00.000Z', 'LIC-007: still checked in every 30 days');

    const page = await (await fetch(`${s.base}/admin/stores/${storeId}`, { headers: { cookie } })).text();
    assert.match(page, /One-time licence<\/strong>, paid for good/);
    assert.match(page, /no subscription to extend/);
    assert.doesNotMatch(page, /Record payment<\/button>/);
    assert.match(await (await fetch(`${s.base}/admin`, { headers: { cookie } })).text(), /<td>One-time<\/td>/);

    assert.throws(() => s.service.recordPayment({ storeId, months: 1, recordedBy: 'admin' }), /one-time licence/);
    assert.throws(() => s.service.setOneTime({ storeId, recordedBy: 'admin' }), /already has a one-time/);
    const play = licence.verify((await (await post(s.base, '/api/v1/play/purchase', {
      installation_id: 'inst-0000-0010', installation_secret: device.installation_secret, product_id: 'pos_monthly', purchase_token: 'p-1',
    })).json()).licence, s.publicKey);
    assert.equal(play.plan, 'ONE_TIME');
    assert.equal(play.paid_until, '9999-12-31T00:00:00.000Z');
  } finally { await s.close(); }
});

test('TASK-067: paid until a date, later or earlier, with a reason; earlier is confirmed first', async () => {
  const s = await boot();
  try {
    const device = await linkedDevice(s);
    const storeId = licence.verify(device.licence, s.publicKey).store_id;
    const cookie = await adminCookie(s);
    const csrf = await adminCsrf(s, cookie, `/admin/stores/${storeId}`);
    const to = (fields) => form(s.base, `/admin/stores/${storeId}/paid-until`, { csrf, ...fields }, cookie);

    assert.equal((await to({ date: '2026-12-31' })).status, 400, 'a reason is required');
    assert.equal((await to({ date: '2026-02-30', note: 'free month' })).status, 400, 'a date that does not exist');
    assert.equal((await to({ date: '2026-12-31', note: 'Free months for the pilot' })).status, 302);
    let store = s.service.storeDetail(storeId).store;
    assert.equal(store.paid_until, '2026-12-31T15:59:59.999Z', 'through the 31st in Manila');
    assert.equal(s.service.storeDetail(storeId).payments[0].method, 'OVERRIDE');

    const shorter = await to({ date: '2026-09-14', note: 'Did not pay' });
    assert.equal(shorter.status, 400);
    assert.match(await shorter.text(), /earlier than what the store has now \(paid until 2026-12-31\)/);
    assert.equal((await to({ date: '2026-09-14', note: 'Did not pay', confirm: 'yes' })).status, 302);
    store = s.service.storeDetail(storeId).store;
    assert.equal(store.paid_until, '2026-09-14T15:59:59.999Z');

    // From one-time, any date takes the licence away, so it is confirmed too.
    s.service.setOneTime({ storeId, recordedBy: 'admin' });
    assert.equal((await to({ date: '2030-01-01', note: 'Moved to monthly' })).status, 400);
    assert.equal((await to({ date: '2030-01-01', note: 'Moved to monthly', confirm: 'yes' })).status, 302);
    assert.equal(s.service.storeDetail(storeId).store.plan, 'MONTHLY');
  } finally { await s.close(); }
});

test('TASK-067: revoking a one-time licence leaves the store unpaid from today, with the reason kept', async () => {
  const s = await boot();
  try {
    const device = await linkedDevice(s);
    const storeId = licence.verify(device.licence, s.publicKey).store_id;
    s.service.setOneTime({ storeId, recordedBy: 'admin' });
    s.advance(40);
    const cookie = await adminCookie(s);
    const csrf = await adminCsrf(s, cookie, `/admin/stores/${storeId}`);

    assert.equal((await form(s.base, `/admin/stores/${storeId}/revoke-one-time`, { csrf, note: 'Refunded' }, cookie)).status, 400);
    assert.equal((await form(s.base, `/admin/stores/${storeId}/revoke-one-time`, { csrf, confirm: 'yes' }, cookie)).status, 400, 'a reason is required');
    assert.equal((await form(s.base, `/admin/stores/${storeId}/revoke-one-time`, { csrf, note: 'Refunded', confirm: 'yes' }, cookie)).status, 302);

    const { store, payments } = s.service.storeDetail(storeId);
    assert.deepEqual({ plan: store.plan, paid_until: store.paid_until }, { plan: 'MONTHLY', paid_until: '2026-10-25T00:00:00.000Z' });
    assert.equal(payments[0].note, 'One-time licence revoked: Refunded');
    assert.equal(payments[0].paid_until_before, '9999-12-31T00:00:00.000Z');
    assert.equal(payments.length, 3, 'trial, one-time, revoked: nothing edited in place');

    const renewed = licence.verify((await (await post(s.base, '/api/v1/licence/renew', { installation_id: 'inst-0000-0010', installation_secret: device.installation_secret })).json()).licence, s.publicKey);
    assert.deepEqual({ plan: renewed.plan, paid_until: renewed.paid_until }, { plan: 'MONTHLY', paid_until: '2026-10-25T00:00:00.000Z' });
    assert.throws(() => s.service.revokeOneTime({ storeId, note: 'again', recordedBy: 'admin' }), /does not have a one-time/);
  } finally { await s.close(); }
});

test('TASK-067: a store registered for an e-mail is linked by that Google account as it was set up, with no trial', async () => {
  const s = await boot({ googleClaims: { sub: 'g-rosa', email: 'rosa@example.com', name: 'Rosa' } });
  try {
    const cookie = await adminCookie(s);
    const csrf = await adminCsrf(s, cookie);
    const added = await form(s.base, '/admin/stores', {
      csrf, store_name: 'Botika ni Aling Rosa', owner_email: ' Rosa@Example.com ', plan: 'ONE_TIME', amount: '15000', reference: 'CASH',
    }, cookie);
    assert.equal(added.status, 302);
    const [registered] = s.service.listStores();
    assert.deepEqual(
      { owner_sub: registered.owner_sub, owner_email: registered.owner_email, plan: registered.plan },
      { owner_sub: null, owner_email: 'rosa@example.com', plan: 'ONE_TIME' },
    );
    assert.match(await (await fetch(`${s.base}/admin`, { headers: { cookie } })).text(), /not linked yet/);

    // Another Google account is not offered it, and cannot take it.
    assert.equal(s.service.storesForApproval({ sub: 'g-other', email: 'other@example.com' }).length, 0);

    const { started, cookie: owner, approvePage } = await linkAndSignIn(s, { installationId: 'inst-0000-0067' });
    assert.match(approvePage, /Botika ni Aling Rosa<\/strong><br><span class="muted">One-time licence · set up for you by Chachi's/);
    const elsewhere = s.service.registerStore({ name: 'Not Rosa\'s', ownerEmail: 'other@example.com', plan: 'ONE_TIME', recordedBy: 'admin' });
    const taken = await form(s.base, '/link/approve', { csrf: csrfIn(approvePage), code: started.user_code, store_id: elsewhere.id }, owner);
    assert.equal(taken.status, 403, 'a store registered for another e-mail');
    const approved = await form(s.base, '/link/approve', { csrf: csrfIn(approvePage), code: started.user_code, store_id: registered.id }, owner);
    assert.equal(approved.status, 200);
    assert.match(await approved.text(), /One-time licence\. You can close this page/);

    const picked = await (await post(s.base, '/api/v1/device/poll', { device_code: started.device_code })).json();
    const payload = licence.verify(picked.licence, s.publicKey);
    assert.deepEqual({ store: payload.store_id, plan: payload.plan }, { store: registered.id, plan: 'ONE_TIME' });
    const detail = s.service.storeDetail(registered.id);
    assert.equal(detail.store.owner_sub, 'g-rosa');
    assert.deepEqual(detail.payments.map((p) => p.method), ['ONE_TIME'], 'no trial row');

    // Linked now: it cannot be deleted, and it is the owner's own on the next approval.
    assert.throws(() => s.service.deleteUnlinkedStore(registered.id), /has been linked/);
    assert.equal(s.service.storesForApproval({ sub: 'g-rosa', email: 'rosa@example.com' })[0].registered, undefined);
  } finally { await s.close(); }
});

test('TASK-067: registering checks its fields; a store nobody linked can be deleted, after a confirmation', async () => {
  const s = await boot();
  try {
    assert.throws(() => s.service.registerStore({ name: 'X', ownerEmail: 'a@b.co', plan: 'TRIAL', recordedBy: 'admin' }), /name/);
    assert.throws(() => s.service.registerStore({ name: 'Store', ownerEmail: 'not an email', plan: 'TRIAL', recordedBy: 'admin' }), /e-mail/);
    assert.throws(() => s.service.registerStore({ name: 'Store', ownerEmail: 'a@b.co', plan: 'FREE', recordedBy: 'admin' }), /how the store is paid/);
    assert.throws(() => s.service.registerStore({ name: 'Store', ownerEmail: 'a@b.co', plan: 'PAID_UNTIL', recordedBy: 'admin' }), /YYYY-MM-DD/);

    const trial = s.service.registerStore({ name: 'Trial store', ownerEmail: 'a@b.co', plan: 'TRIAL', recordedBy: 'admin' });
    assert.equal(trial.paid_until, '2026-09-29T00:00:00.000Z');
    const paid = s.service.registerStore({ name: 'Paid store', ownerEmail: 'a@b.co', plan: 'PAID_UNTIL', date: '2027-03-31', amountCentavos: 299400, recordedBy: 'admin' });
    assert.deepEqual({ plan: paid.plan, paid_until: paid.paid_until }, { plan: 'MONTHLY', paid_until: '2027-03-31T15:59:59.999Z' });

    const cookie = await adminCookie(s);
    const csrf = await adminCsrf(s, cookie, `/admin/stores/${paid.id}`);
    assert.match(await (await fetch(`${s.base}/admin/stores/${paid.id}`, { headers: { cookie } })).text(), /Delete store/);
    assert.equal((await form(s.base, `/admin/stores/${paid.id}/delete`, { csrf }, cookie)).status, 400);
    const deleted = await form(s.base, `/admin/stores/${paid.id}/delete`, { csrf, confirm: 'yes' }, cookie);
    assert.equal(deleted.status, 302);
    assert.equal(s.service.storeDetail(paid.id), null);
    assert.deepEqual(s.service.listStores().map((x) => x.name), ['Trial store']);
  } finally { await s.close(); }
});

test('TASK-067: a database from before one-time licences opens with its stores and payments as they were', () => {
  const Database = require('better-sqlite3');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'licence-db-')), 'licences.db');
  const old = new Database(file);
  old.exec(`CREATE TABLE stores (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_sub TEXT NOT NULL, owner_email TEXT NOT NULL,
              plan TEXT NOT NULL DEFAULT 'monthly', paid_until TEXT NOT NULL, created_at TEXT NOT NULL);
            CREATE INDEX stores_owner ON stores(owner_sub);
            CREATE TABLE installations (id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id), secret_hash TEXT NOT NULL,
              platform TEXT, app_version TEXT, created_at TEXT NOT NULL, last_check_at TEXT, revoked_at TEXT);
            CREATE TABLE payments (id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id),
              method TEXT NOT NULL CHECK (method IN ('MANUAL','PLAY','TRIAL')), amount_centavos INTEGER, reference TEXT, note TEXT,
              paid_until_before TEXT, paid_until_after TEXT NOT NULL, recorded_by TEXT NOT NULL, created_at TEXT NOT NULL);
            INSERT INTO stores VALUES ('s1', 'Botika', 'g-1', 'rosa@example.com', 'monthly', '2026-10-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
            INSERT INTO installations VALUES ('inst-1', 's1', 'hash', 'Windows', '1.0.0', '2026-09-01T00:00:00.000Z', NULL, NULL);
            INSERT INTO payments VALUES ('p1', 's1', 'TRIAL', NULL, NULL, '14-day trial', NULL, '2026-09-15T00:00:00.000Z', 'rosa@example.com', '2026-09-01T00:00:00.000Z'),
                                        ('p2', 's1', 'MANUAL', 49900, 'GC-1', NULL, '2026-09-15T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'admin', '2026-09-10T00:00:00.000Z');`);
  old.close();

  const upgraded = db.open(file);
  try {
    assert.deepEqual(upgraded.prepare('SELECT id, plan, owner_sub, paid_until FROM stores').all(),
      [{ id: 's1', plan: 'MONTHLY', owner_sub: 'g-1', paid_until: '2026-10-01T00:00:00.000Z' }]);
    assert.deepEqual(upgraded.prepare('SELECT id, method, amount_centavos FROM payments ORDER BY id').all(),
      [{ id: 'p1', method: 'TRIAL', amount_centavos: null }, { id: 'p2', method: 'MANUAL', amount_centavos: 49900 }]);
    assert.equal(upgraded.prepare('SELECT store_id FROM installations').get().store_id, 's1');
    assert.deepEqual(upgraded.pragma('foreign_key_check'), []);
    assert.equal(upgraded.pragma('foreign_keys', { simple: true }), 1);

    // The new values are accepted, and a store may wait for its owner.
    upgraded.prepare("INSERT INTO stores (id, name, owner_sub, owner_email, plan, paid_until, created_at) VALUES ('s2', 'New', NULL, 'x@y.z', 'ONE_TIME', 'x', 'x')").run();
    upgraded.prepare("INSERT INTO payments (id, store_id, method, paid_until_after, recorded_by, created_at) VALUES ('p3', 's2', 'OVERRIDE', 'x', 'admin', 'x')").run();
    assert.throws(() => upgraded.prepare("INSERT INTO stores (id, name, owner_email, plan, paid_until, created_at) VALUES ('s3', 'Bad', 'x', 'monthly', 'x', 'x')").run(), /CHECK/);
  } finally { upgraded.close(); }

  const again = db.open(file);   // a second start rebuilds nothing
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM payments').get().n, 3);
  again.close();
});
