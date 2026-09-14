'use strict';

// Google Play subscriptions (TASK-048, L-4). The phone reports a purchase token; this
// asks Google what that token has actually bought and until when, with the store's
// service account. The phone's own word is never taken for a payment.
//
// Needs PLAY_SERVICE_ACCOUNT_FILE (a service account with access to the Play
// Developer API for the app). Until then `configured` is false and the endpoint says so.

const crypto = require('crypto');
const fs = require('fs');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

function createPlay({ packageName, serviceAccountFile, products, fetch = globalThis.fetch, now = () => Date.now() }) {
  const account = serviceAccountFile && fs.existsSync(serviceAccountFile)
    ? JSON.parse(fs.readFileSync(serviceAccountFile, 'utf8')) : null;
  let token = { value: null, expiresAt: 0 };

  async function accessToken() {
    if (token.value && token.expiresAt - 60e3 > now()) return token.value;
    const iat = Math.floor(now() / 1000);
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
      iss: account.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600,
    })}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), account.private_key).toString('base64url');
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`Google refused the service account (${body.error || response.status})`);
    token = { value: body.access_token, expiresAt: now() + body.expires_in * 1000 };
    return token.value;
  }

  /** { productId, expiry (ISO), state } for a purchase token, as Google has it. */
  async function verify({ productId, purchaseToken }) {
    if (!products.includes(productId)) throw new Error(`${productId} is not this store's subscription`);
    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/`
      + `${encodeURIComponent(packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
    const response = await fetch(url, { headers: { authorization: `Bearer ${await accessToken()}` } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Google does not recognise the purchase (${response.status})`);
    const item = (body.lineItems || []).find((line) => line.productId === productId) || (body.lineItems || [])[0];
    return { productId, expiry: item ? item.expiryTime : null, state: body.subscriptionState || 'UNKNOWN' };
  }

  return { configured: Boolean(account), verify };
}

module.exports = { createPlay };
