'use strict';

// Google sign-in for the owner, on the licence server's own pages (TASK-048, L-1).
//
// The web authorization-code flow with PKCE: /auth/google sends the owner to Google,
// Google sends them back to /auth/google/callback with a code, and the code is exchanged
// here for an ID token. The token's signature is checked against Google's published
// keys and its issuer, audience, expiry and nonce against what we asked for — a token
// is never trusted because of where it came from.
//
// `fetch` is injected so the flow is testable without Google.

const crypto = require('crypto');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function createGoogle({ clientId, clientSecret, redirectUri, fetch = globalThis.fetch, now = () => Date.now() }) {
  let certs = { keys: [], fetchedAt: 0 };

  const configured = Boolean(clientId && clientSecret);

  function authorizationUrl({ state, nonce, challenge }) {
    const params = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
      scope: 'openid email profile', state, nonce,
      code_challenge: challenge, code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    return `${AUTH_URL}?${params}`;
  }

  async function keys(kid) {
    // Google rotates its keys; they are cached for an hour and refetched for an unknown kid.
    const stale = now() - certs.fetchedAt > 3600e3;
    if (stale || !certs.keys.some((k) => k.kid === kid)) {
      const response = await fetch(CERTS_URL);
      if (!response.ok) throw new Error(`Google's keys could not be fetched (${response.status})`);
      certs = { keys: (await response.json()).keys || [], fetchedAt: now() };
    }
    return certs.keys.find((k) => k.kid === kid) || null;
  }

  /** The verified claims of a Google ID token, or an Error saying why not. */
  async function verifyIdToken(idToken, { nonce }) {
    const [h, p, s] = String(idToken).split('.');
    if (!h || !p || !s) throw new Error('not an ID token');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    if (header.alg !== 'RS256') throw new Error(`unexpected signing algorithm ${header.alg}`);
    const jwk = await keys(header.kid);
    if (!jwk) throw new Error('the token was signed by a key Google does not publish');
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const valid = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
    if (!valid) throw new Error('the token signature is not valid');

    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (!ISSUERS.has(claims.iss)) throw new Error('the token was not issued by Google');
    if (claims.aud !== clientId) throw new Error('the token was issued for another application');
    if (!(claims.exp * 1000 > now())) throw new Error('the token has expired');
    if (claims.nonce !== nonce) throw new Error('the token does not answer this sign-in');
    if (!claims.email || claims.email_verified === false) throw new Error('the Google account has no verified email');
    return { sub: claims.sub, email: claims.email, name: claims.name || claims.email };
  }

  async function exchange({ code, verifier, nonce }) {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: clientId, client_secret: clientSecret,
        redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.id_token) throw new Error(`Google refused the sign-in (${body.error || response.status})`);
    return verifyIdToken(body.id_token, { nonce });
  }

  return { configured, authorizationUrl, exchange, verifyIdToken };
}

module.exports = { createGoogle, pkce };
