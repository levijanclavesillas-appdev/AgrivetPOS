'use strict';

// The embedded Express application. main.js requires this in-process; nothing
// listens off-host (05_TECH_SPEC.md §1).
//
// Why an HTTP server for a single-machine app: it is the decision that makes v1.3
// LAN terminals additive rather than a rewrite. No business logic moves — a client
// changes a bind address and gains an authentication transport.

const express = require('express');
const path = require('path');
const healthRoutes = require('./routes/health');
const setupRoutes = require('./routes/setup');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const settingsRoutes = require('./routes/settings');
const auditRoutes = require('./routes/audit');
const productRoutes = require('./routes/products');
const referenceRoutes = require('./routes/reference');
const inventoryRoutes = require('./routes/inventory');
const batchRoutes = require('./routes/batches');
const customerRoutes = require('./routes/customers');
const pricingRoutes = require('./routes/pricing');
const shiftRoutes = require('./routes/shifts');
const saleRoutes = require('./routes/sales');
const collectionRoutes = require('./routes/collections');
const printRoutes = require('./routes/print');
const cartRoutes = require('./routes/carts');
const openOrderRoutes = require('./routes/openOrders');
const quickKeyRoutes = require('./routes/quickKeys');
const reportRoutes = require('./routes/reports');
const reconciliationRoutes = require('./routes/reconciliations');
const backupRoutes = require('./routes/backups');
const purchasingRoutes = require('./routes/purchasing');
const returnRoutes = require('./routes/returns');
const stockCountRoutes = require('./routes/stockCounts');
const dataRoutes = require('./routes/data');
const licenceRoutes = require('./routes/licence');
const syncRoutes = require('./routes/sync');
const { offlinePolicy, nudgeAfterWrite } = require('./middleware/sync');
const setupService = require('./services/setupService');
const { requireSetup } = require('./middleware/setup');

const API_BASE = '/api/v1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // TASK-062: the headers a page's own <meta> CSP cannot set. The pages already allow only
  // their own scripts, styles and connections; these add that no other site may frame
  // them (a sign-in inside somebody else's page is how a password is taken), that a file
  // is only ever read as the type it was sent as, and that no address leaks in a
  // Referer. Harmless on a store's PC; necessary once the web version is on the internet.
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Content-Security-Policy', "frame-ancestors 'none'");
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  // TASK-063: a device's push can carry product pictures; its own parser, ahead of the
  // 1 MB one every other route has (which then leaves the parsed body alone).
  // TASK-064: so can an import archive or an opening workbook. Behind the 1 MB parser,
  // any archive over about 750 KB was refused before routes/data.js's own 64 MB one ran.
  app.use(`${API_BASE}/sync`, express.json({ limit: '64mb' }));
  app.use(`${API_BASE}/data`, express.json({ limit: '64mb' }));
  app.use(express.json({ limit: '1mb' }));

  // Every authenticated answer carries a fresh session token (middleware/auth.js), so no
  // answer may be kept by the browser: a stored one would hand its token back later, to
  // whoever is signed in by then. A route that serves something cacheable (a product's
  // picture) overrides this and sends no token with it.
  app.use(API_BASE, (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  // FR_1.1: until the wizard has finished, /setup and /health are the only API this
  // installation has. The gate is mounted before every route rather than checked
  // inside them, so a route added later is refused by default rather than by memory.
  app.use(API_BASE, requireSetup);

  // TASK-063: on a store's device, what waits for a connection, and a sync after a write.
  app.use(API_BASE, offlinePolicy, nudgeAfterWrite);

  app.use(API_BASE, setupRoutes);
  app.use(API_BASE, healthRoutes);
  app.use(API_BASE, authRoutes);
  app.use(API_BASE, userRoutes);
  app.use(API_BASE, settingsRoutes);
  app.use(API_BASE, auditRoutes);
  app.use(API_BASE, productRoutes);
  app.use(API_BASE, referenceRoutes);
  app.use(API_BASE, inventoryRoutes);
  app.use(API_BASE, batchRoutes);
  app.use(API_BASE, customerRoutes);
  app.use(API_BASE, pricingRoutes);
  app.use(API_BASE, shiftRoutes);
  app.use(API_BASE, saleRoutes);
  app.use(API_BASE, collectionRoutes);
  app.use(API_BASE, printRoutes);
  app.use(API_BASE, cartRoutes);
  app.use(API_BASE, openOrderRoutes);
  app.use(API_BASE, quickKeyRoutes);
  app.use(API_BASE, reportRoutes);
  app.use(API_BASE, reconciliationRoutes);
  app.use(API_BASE, backupRoutes);
  app.use(API_BASE, purchasingRoutes);
  app.use(API_BASE, returnRoutes);
  app.use(API_BASE, stockCountRoutes);
  app.use(API_BASE, dataRoutes);
  app.use(API_BASE, licenceRoutes);
  app.use(API_BASE, syncRoutes);

  // The renderer. Vanilla ES modules, no build step (05_TECH_SPEC.md §2).
  //
  // An unconfigured installation is served the wizard at the root, so double-clicking
  // the shortcut on a fresh install lands on SCR-001 rather than on a shell whose every
  // request is refused. The server-side gate above is what actually enforces it; this
  // only decides which page a person sees.
  app.get('/', (req, res, next) => {
    try {
      const page = setupService.isComplete() ? 'index.html' : 'setup.html';
      res.sendFile(path.join(PUBLIC_DIR, page));
    } catch (err) {
      next(err);
    }
  });

  // The shell itself is not reachable before setup either. Its every request would be
  // refused by the gate above, so serving it would only show a person a screen that
  // cannot work — requirement 1's "no other screen is reachable", applied to the one
  // path express.static would otherwise answer directly.
  app.get('/index.html', (req, res, next) => {
    try {
      // Relative (TASK-065): behind /s/<store>/ an absolute '/' is the licence site.
      return setupService.isComplete() ? next() : res.redirect(302, './');
    } catch (err) {
      return next(err);
    }
  });

  app.use(express.static(PUBLIC_DIR));

  app.use(API_BASE, (req, res) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: `No such endpoint: ${req.method} ${req.originalUrl}` },
    });
  });

  // 05_TECH_SPEC.md §4: every error carries code, message, and where a rule refused
  // the action, the rule_id the UI needs to explain it (§8.6). A refusal the UI
  // cannot explain is an unfinished refusal.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    // The body parser's own refusals carry a type, not a code.
    const parser = {
      'entity.too.large': { code: 'TOO_LARGE', message: 'That is too large to send in one request.' },
      'entity.parse.failed': { code: 'BAD_REQUEST', message: 'The request was not valid JSON.' },
    }[err.type];
    res.status(status).json({
      error: {
        code: err.code || (parser && parser.code) || 'INTERNAL_ERROR',
        message: status === 500 ? 'Something went wrong. The error has been logged.' : (parser ? parser.message : err.message),
        rule_id: err.ruleId || null,
        requires_role: err.requiresRole || null,
      },
    });
    if (status === 500) process.stderr.write(`${JSON.stringify({ level: 'error', at: new Date().toISOString(), message: err.message, stack: err.stack })}\n`);
  });

  return app;
}

module.exports = { createApp, API_BASE, PUBLIC_DIR };
