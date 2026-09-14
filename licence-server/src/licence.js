'use strict';

// The licence: a signed statement of what a store has paid for, which the POS checks
// offline with the public key compiled into it (TASK-048).
//
//   CPL1.<payload, base64url JSON>.<Ed25519 signature over "CPL1.<payload>", base64url>
//
// The POS has the same format in src/services/licenceService.js; the two are tested
// against each other.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PREFIX = 'CPL1';
const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

/** The signing key, generated on first use. The private half never leaves this file. */
function loadOrCreateKey(file) {
  if (fs.existsSync(file)) return crypto.createPrivateKey(fs.readFileSync(file));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return privateKey;
}

const publicPem = (privateKey) => crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });

function sign(payload, privateKey) {
  const body = `${PREFIX}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign(null, Buffer.from(body), privateKey);
  return `${body}.${b64url(signature)}`;
}

/** The payload, or null when the token is not one this key signed. */
function verify(token, publicKey) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const ok = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url'));
  if (!ok) return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
}

module.exports = { PREFIX, loadOrCreateKey, publicPem, sign, verify };
