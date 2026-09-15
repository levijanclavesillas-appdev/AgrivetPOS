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

