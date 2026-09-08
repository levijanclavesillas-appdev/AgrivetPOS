'use strict';

// OPS-006: the health panel reports database size, row counts, last successful backup,
// last export, last integrity check, and the schema version.
//
// All six, and no more. A health panel that grows into a dashboard stops being read,
// and the six here are the ones that answer "is this installation still safe to trade
// on" — which is the only question SCR-705 is for.
//
// `/health` carries no TX-* (05_TECH_SPEC.md §4): main.js polls it before the window
// opens, so it must answer before anyone has authenticated. That is why the unauth-
// enticated payload is deliberately thin — a status, a version and whether the
// database is open. The six figures need TX-423 and are added when a session presents
// one, so an unauthenticated caller on the loopback learns nothing about the store.

const db = require('../config/database');
const migrate = require('../config/migrate');
const clock = require('../config/clock');
const schemaRepository = require('../repositories/schemaRepository');
const backupRepository = require('../repositories/backupRepository');
const backupService = require('./backupService');
const systemService = require('./systemService');
const pkg = require('../../package.json');

/** The liveness answer, for the launch poll. Safe to serve to anyone on 127.0.0.1. */
function liveness() {
  return {
    status: db.isOpen() ? 'ok' : 'starting',
    checked_at: clock.nowUtc(),
    app_version: pkg.version,
  };
}

/** OPS-006's six figures, for SCR-705. */
function panel() {
  const counts = schemaRepository.rowCounts();
  const lastBackup = safely(() => backupService.lastVerified(), null);
  const lastExport = safely(() => backupRepository.lastEvent('EXPORT'), null);
  const lastIntegrity = safely(() => backupRepository.lastEvent('INTEGRITY_CHECK'), null);
  const overdue = safely(() => backupService.overdue(), { overdue: false });
  const clockState = safely(() => systemService.checkClock(), { anomaly: false });

  return {
    ...liveness(),

    // 1 — the schema version.
    schema: {
      version: migrate.schemaVersion(),
      binary_version: migrate.binaryVersion(),
      // A database older than the binary is a migration that has not run, which is a
      // different problem from a corrupt one and needs saying differently.
      up_to_date: migrate.schemaVersion() === migrate.binaryVersion(),
    },

    // 2 and 3 — database size and row counts.
    database: {
      path: db.currentPath(),
      size_bytes: db.sizeBytes(),
      size_display: displayBytes(db.sizeBytes()),
      pragmas: db.pragmaState(),
      table_count: Object.keys(counts).length,
      row_counts: counts,
    },

    // 4 — the last successful backup. Verified, and nothing else counts (OPS-002).
    backup: {
      last_successful_at: lastBackup ? lastBackup.taken_at : null,
      last_successful_at_manila: lastBackup ? clock.toManila(lastBackup.taken_at) : null,
      last_successful_file: lastBackup ? lastBackup.filename : null,
      last_successful_size_bytes: lastBackup ? lastBackup.size_bytes : null,
      folder: safely(() => backupService.folder(), null),
      overdue: Boolean(overdue.overdue),
      hours_since: overdue.hours_since ?? null,
      period_hours: overdue.period_hours ?? null,
    },

    // 5 — the last export.
    last_export_at: lastExport ? lastExport.occurred_at : null,

    // 6 — the last integrity check of the live database.
    last_integrity_check_at: lastIntegrity ? lastIntegrity.occurred_at : null,
    last_integrity_check_ok: lastIntegrity ? Boolean(lastIntegrity.ok) : null,

    // Not one of the six, and here because SCR-705 is where someone looks when
    // timestamps stop making sense (OPS-009).
    clock: {
      anomaly: Boolean(clockState.anomaly),
      latest_recorded_at: clockState.latest_recorded_at || null,
      behind_by_hours: clockState.behind_by_hours || 0,
    },
    launch: systemService.lastLaunchResult(),
  };
}

/**
 * A figure that cannot be read is reported as absent, not as a crash.
 *
 * The health panel is the screen someone opens *because* something is wrong, so it is
 * the last screen that may fail to render when one of its sources does.
 */
function safely(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function displayBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Kept for the callers that predate the split, and for main.js's readiness poll. */
function health() {
  return liveness();
}

module.exports = { health, liveness, panel, displayBytes };
