'use strict';

// Where the subscription licence comes from — TASK-048.
//
// Licensing is **on** when there is a licence server to ask: PRODUCTION_SERVER below,
// or AGRIVET_LICENCE_SERVER for a test or staging server. The product asks it for
// nothing but a licence: to link this POS, and to renew (NFR_3.1 and TC-E2E-08 as
// amended by TASK-048).
//
// The public key is the licence server's (GET /api/v1/public-key); the private half
// never leaves that server. AGRIVET_LICENCE_PUBLIC_KEY overrides it for tests and for a
// staging server. The two change together or not at all: a key that does not match
// the server makes every licence it signs invalid (LIC-003).

// Live since 2026-09-14.
const PRODUCTION_SERVER = 'https://pos.chachisoftware.store';
const PRODUCTION_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAL3U4XBCqzvlFKU5sggRZAxdvLtR4LQJgm66zvU0B4ec=
-----END PUBLIC KEY-----
`;

// AGRIVET_LICENSING=off turns the production default off: the test runner and the
// browser smoke set it, so the suite never needs a licence server once the constants
// above are filled.
const server = () => (process.env.AGRIVET_LICENCE_SERVER
  || (process.env.AGRIVET_LICENSING === 'off' ? '' : PRODUCTION_SERVER)).replace(/\/$/, '') || null;
const publicKey = () => process.env.AGRIVET_LICENCE_PUBLIC_KEY || PRODUCTION_PUBLIC_KEY || null;

module.exports = { server, publicKey };
