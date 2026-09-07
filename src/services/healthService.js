'use strict';

// OPS-006: the health panel reports database size, row counts, last successful
// backup, last export, last integrity check, and the schema version.
//
// Backup, export and integrity history arrive with TASK-017 and its backup_log
// table. They are reported as null here rather than omitted, so the payload shape
// does not change when that task lands.

const db = require('../config/database');
const migrate = require('../config/migrate');
const clock = require('../config/clock');
const schemaRepository = require('../repositories/schemaRepository');
const pkg = require('../../package.json');

function health() {
  const counts = schemaRepository.rowCounts();
  return {
    status: 'ok',
    checked_at: clock.nowUtc(),
    app_version: pkg.version,
    schema: {
      version: migrate.schemaVersion(),
      binary_version: migrate.binaryVersion(),
    },
    database: {
      path: db.currentPath(),
      size_bytes: db.sizeBytes(),
      pragmas: db.pragmaState(),
      table_count: Object.keys(counts).length,
      row_counts: counts,
    },
    // TASK-017 (OPS-001..OPS-003) fills these in.
    last_successful_backup_at: null,
    last_export_at: null,
    last_integrity_check_at: null,
  };
}

module.exports = { health };
