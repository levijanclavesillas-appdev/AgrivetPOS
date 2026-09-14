'use strict';

// Where the subscription licence comes from — TASK-048.
//
// Licensing is **on** when there is a licence server to ask: PRODUCTION_SERVER below,
// or AGRIVET_LICENCE_SERVER for a test or staging server. While both are empty — as
// now, until pos.chachisoftware.store is live — it is off, and nothing in the product
// asks the network for anything (NFR_3.1, TC-E2E-08 unchanged).
//
// The public key is the licence server's (GET /api/v1/public-key), compiled in below
// once the production server has generated it. AGRIVET_LICENCE_PUBLIC_KEY overrides it
// for tests and for a staging server.

// Filled in together, in the commit that goes live with pos.chachisoftware.store.
const PRODUCTION_SERVER = '';
const PRODUCTION_PUBLIC_KEY = '';

// AGRIVET_LICENSING=off turns the production default off: the test runner and the
// browser smoke set it, so the suite never needs a licence server once the constants
// above are filled.
const server = () => (process.env.AGRIVET_LICENCE_SERVER
  || (process.env.AGRIVET_LICENSING === 'off' ? '' : PRODUCTION_SERVER)).replace(/\/$/, '') || null;
const publicKey = () => process.env.AGRIVET_LICENCE_PUBLIC_KEY || PRODUCTION_PUBLIC_KEY || null;

module.exports = { server, publicKey };
