'use strict';

// POS-108's counter, read from the documents themselves.
//
// The table and column are interpolated, so they may only ever come from
// sequenceService.SEQUENCES — never from a request. That is asserted here rather than
// assumed, because an interpolated identifier is the one place in this codebase where
// a caller could reach past the parameter binding.

const db = require('../config/database');

const ALLOWED = Object.freeze({
  sales: ['sale_no'],
  customer_credit_transactions: ['document_no'],
  purchase_orders: ['po_no'],
  goods_receipts: ['gr_no'],
});

function assertTarget(table, column) {
  const columns = ALLOWED[table];
  if (!columns || !columns.includes(column)) {
    throw new RangeError(`not a document sequence target: ${table}.${column}`);
  }
}

function tableExists(name) {
  return Boolean(
    db.get().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  );
}

/**
 * The highest counter issued for one prefix on one day, or null where none has been.
 *
 * The counter is the last six characters of `PREFIX-YYYYMMDD-NNNNNN`, read as an
 * integer so that MAX orders numerically rather than as text — 000010 sorts after
 * 000009 either way, but 000100 against 000099 does not survive a text comparison if
 * the width ever changes.
 */
function highestForDay({ table, column, prefix, dateKey }) {
  assertTarget(table, column);
  if (!tableExists(table)) return null;

  const row = db.get().prepare(`
    SELECT MAX(CAST(substr(${column}, length(@stem) + 1) AS INTEGER)) AS highest
      FROM ${table}
     WHERE ${column} LIKE @like
  `).get({ stem: `${prefix}-${dateKey}-`, like: `${prefix}-${dateKey}-%` });

  return row.highest === null ? null : row.highest;
}

function numbersForDay({ table, column, prefix, dateKey }) {
  assertTarget(table, column);
  if (!tableExists(table)) return [];

  return db.get()
    .prepare(`SELECT ${column} AS document_no FROM ${table} WHERE ${column} LIKE ? ORDER BY ${column}`)
    .all(`${prefix}-${dateKey}-%`)
    .map((row) => row.document_no);
}

module.exports = { ALLOWED, assertTarget, highestForDay, numbersForDay };
