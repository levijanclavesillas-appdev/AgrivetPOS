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
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');

const API_BASE = '/api/v1';

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.use(API_BASE, healthRoutes);
  app.use(API_BASE, authRoutes);
  app.use(API_BASE, userRoutes);

  // The renderer. Vanilla ES modules, no build step (05_TECH_SPEC.md §2).
  app.use(express.static(path.join(__dirname, '..', 'public')));

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

module.exports = { createApp, API_BASE };
