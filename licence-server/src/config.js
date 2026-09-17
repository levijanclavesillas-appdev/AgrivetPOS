'use strict';

// Everything the licence server needs to know about where it runs, from the environment.
// Nothing secret is in this repository: the Google client secret, the Play service
// account and the admin password hash are supplied where the server is deployed.

const path = require('path');

function fromEnv(env = process.env) {
  const dataDir = env.LICENCE_DATA_DIR || path.join(__dirname, '..', 'data');
  return {
    port: Number(env.PORT) || 8790,
    // Loopback only, unless in a container whose port is published on the host's loopback.
    host: env.HOST || '127.0.0.1',
    // Where the server is reached from outside: links in pages and the Google redirect.
    baseUrl: (env.BASE_URL || 'http://127.0.0.1:8790').replace(/\/$/, ''),
    dataDir,
    databaseFile: env.LICENCE_DATABASE || path.join(dataDir, 'licences.db'),
    // Ed25519. Generated on first start if missing; the private key never leaves this
    // machine, and the POS carries only the public key (GET /api/v1/public-key).
    keyFile: env.LICENCE_KEY_FILE || path.join(dataDir, 'licence-signing-key.pem'),

    // TASK-048 decisions: a licence is good for 30 days from its last check (L-3 counts
    // from there), and the grace after that is 7 days. A new store's trial is the owner's
    // choice; 14 days until they say otherwise.
    validityDays: Number(env.VALIDITY_DAYS) || 30,
    graceDays: Number(env.GRACE_DAYS) || 7,
    // From day 23 of 30 the POS says the licence is running out (TASK-048).
    warningDays: Number(env.WARNING_DAYS) || 7,
    trialDays: env.TRIAL_DAYS === undefined ? 14 : Number(env.TRIAL_DAYS),

    google: {
      clientId: env.GOOGLE_CLIENT_ID || null,
      clientSecret: env.GOOGLE_CLIENT_SECRET || null,
    },
    play: {
      packageName: env.PLAY_PACKAGE_NAME || 'store.chachisoftware.pharmacypos',
      serviceAccountFile: env.PLAY_SERVICE_ACCOUNT_FILE || null,
      // Product ids that count as this subscription, comma-separated.
      products: (env.PLAY_PRODUCTS || 'pos_monthly').split(',').map((s) => s.trim()).filter(Boolean),
    },
    admin: {
      // bcrypt hash of the admin password: `node src/tools/hash-password.js`.
      passwordHash: env.ADMIN_PASSWORD_HASH || null,
    },
    // Behind nginx over HTTPS: cookies are Secure and the client address is the proxy's.
    behindProxy: env.BEHIND_PROXY === '1',
  };
}

module.exports = { fromEnv };
