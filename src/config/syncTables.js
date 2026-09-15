'use strict';

// TASK-063 — which tables a store shares between its web copy and its devices, and
// which belong to one installation only.
//
// The rule is "everything is the store's" and the exceptions are listed, so a table a
// later task adds is synced by default rather than silently left behind on one device.

/** Never synced: this installation's own. */
const LOCAL_TABLES = Object.freeze([
  'schema_migrations',
  'licence_state',       // each installation links its own subscription seat (TASK-048)
  'backups',             // each installation backs up its own disk (OPS-001)
  'carts',               // the cart on this counter (POS-105)
  'system_events',       // this machine's clock and launch checks (OPS-009)
  'alert_dismissals',    // what was dismissed on this screen
  'sync_identity', 'sync_state', 'sync_changes', 'sync_devices',
]);

/**
 * Derived on the hub from its merged ledgers, and pulled by devices, never pushed. A
 * device's own figure is right only for the rows it has seen; the hub's is right for the
 * store (INV-101: on hand is the sum of the movements).
 */
const HUB_DERIVED_TABLES = Object.freeze(['inventory']);

/** Columns a device's push may not set: the hub recomputes them (CR-103). */
const HUB_DERIVED_COLUMNS = Object.freeze({
  customer_credit_accounts: ['balance_centavos'],
});

/**
 * Settings that describe the machine, not the store: where its backups go and which
 * printer it has. A phone does not print to the PC's USB printer or back up to the
 * server's volume.
 */
const LOCAL_SETTINGS = Object.freeze([
  'backup_folder', 'backup_hour', 'backup_period_hours', 'backup_retention_count',
  'printer_transport', 'printer_device', 'printer_host', 'printer_port', 'receipt_width_columns',
]);

module.exports = { LOCAL_TABLES, HUB_DERIVED_TABLES, HUB_DERIVED_COLUMNS, LOCAL_SETTINGS };
