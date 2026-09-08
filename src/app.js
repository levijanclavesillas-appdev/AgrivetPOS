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
const customerRoutes = require('./routes/customers');
const pricingRoutes = require('./routes/pricing');
const shiftRoutes = require('./routes/shifts');
const setupService = require('./services/setupService');
const { requireSetup } = require('./middleware/setup');

const API_BASE = '/api/v1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // FR_1.1: until the wizard has finished, /setup and /health are the only API this
  // installation has. The gate is mounted before every route rather than checked
  // inside them, so a route added later is refused by default rather than by memory.
  app.use(API_BASE, requireSetup);

  app.use(API_BASE, setupRoutes);
  app.use(API_BASE, healthRoutes);
  app.use(API_BASE, authRoutes);
  app.use(API_BASE, userRoutes);
  app.use(API_BASE, settingsRoutes);
  app.use(API_BASE, auditRoutes);
  app.use(API_BASE, productRoutes);
  app.use(API_BASE, referenceRoutes);
  app.use(API_BASE, inventoryRoutes);
  app.use(API_BASE, customerRoutes);
  app.use(API_BASE, pricingRoutes);
  app.use(API_BASE, shiftRoutes);

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
      return setupService.isComplete() ? next() : res.redirect(302, '/');
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
    res.status(status).json({
      error: {
        code: err.code || 'INTERNAL_ERROR',
        message: status === 500 ? 'Something went wrong. The error has been logged.' : err.message,
        rule_id: err.ruleId || null,
        requires_role: err.requiresRole || null,
      },
    });
    if (status === 500) process.stderr.write(`${JSON.stringify({ level: 'error', at: new Date().toISOString(), message: err.message, stack: err.stack })}\n`);
  });

  return app;
}

module.exports = { createApp, API_BASE, PUBLIC_DIR };
