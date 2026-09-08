'use strict';

// The credit account, its ledger and the allocations between them.
//
// CR-103: the ledger is the record and the balance is derived from it. As with
// inventory_movements, there is no update and no delete on
// customer_credit_transactions anywhere in this file — a correction is another
// transaction, not an edit. TC-INT-46 reads the source to prove it.
//
// The one UPDATE here is on customer_credit_accounts, whose balance_centavos is a
// materialised figure rather than a record of anything, reachable only from
// creditService inside the transaction that writes the row justifying it.

const db = require('../config/database');

const ACCOUNT_COLUMNS = 'id, customer_id, credit_limit_centavos, balance_centavos, terms_days, updated_at';

const TXN_COLUMNS = `
  id, account_id, txn_type, amount_centavos, balance_after_centavos, sale_id, due_at,
  document_no, method, reference_no, shift_id, reason, occurred_at, created_by
`;

// ── Accounts (CR-101) ───────────────────────────────────────────────────────

function findAccount(id) {
  return db.get().prepare(`SELECT ${ACCOUNT_COLUMNS} FROM customer_credit_accounts WHERE id = ?`).get(id) || null;
}

function findAccountByCustomer(customerId) {
  return db.get()
    .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM customer_credit_accounts WHERE customer_id = ?`)
    .get(customerId) || null;
}

function insertAccount(row) {
  db.get().prepare(`
    INSERT INTO customer_credit_accounts
      (id, customer_id, credit_limit_centavos, balance_centavos, terms_days, updated_at)
    VALUES (@id, @customer_id, @credit_limit_centavos, @balance_centavos, @terms_days, @updated_at)
  `).run(row);
  return findAccount(row.id);
}

const ACCOUNT_UPDATABLE = ['credit_limit_centavos', 'balance_centavos', 'terms_days', 'updated_at'];

function updateAccountFields(id, fields) {
  const keys = Object.keys(fields).filter((k) => ACCOUNT_UPDATABLE.includes(k));
  if (keys.length === 0) return findAccount(id);

  db.get()
    .prepare(`UPDATE customer_credit_accounts SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`)
    .run({ ...fields, id });
  return findAccount(id);
}

// ── The ledger (CR-103) ─────────────────────────────────────────────────────

function insertTransaction(row) {
  db.get().prepare(`
    INSERT INTO customer_credit_transactions (${TXN_COLUMNS})
    VALUES (@id, @account_id, @txn_type, @amount_centavos, @balance_after_centavos,
            @sale_id, @due_at, @document_no, @method, @reference_no, @shift_id,
            @reason, @occurred_at, @created_by)
  `).run(row);
  return row;
}

function findTransaction(id) {
  return db.get().prepare(`SELECT ${TXN_COLUMNS} FROM customer_credit_transactions WHERE id = ?`).get(id) || null;
}

/** The statement view, newest first. The id tiebreak orders within a millisecond. */
function transactionsFor(accountId, { limit = 100, offset = 0, from = null, to = null, type = null } = {}) {
  return db.get().prepare(`
    SELECT t.${TXN_COLUMNS.trim().split(/,\s*/).join(', t.')}, u.username AS created_by_username
      FROM customer_credit_transactions t
      LEFT JOIN users u ON u.id = t.created_by
     WHERE t.account_id = @accountId
       AND (@type IS NULL OR t.txn_type = @type)
       AND (@from IS NULL OR t.occurred_at >= @from)
       AND (@to   IS NULL OR t.occurred_at <= @to)
     ORDER BY t.occurred_at DESC, t.id DESC
     LIMIT @limit OFFSET @offset
  `).all({ accountId, limit, offset, from, to, type });
}

function countTransactionsFor(accountId, { from = null, to = null, type = null } = {}) {
  return db.get().prepare(`
    SELECT COUNT(*) AS n FROM customer_credit_transactions
     WHERE account_id = @accountId
       AND (@type IS NULL OR txn_type = @type)
       AND (@from IS NULL OR occurred_at >= @from)
       AND (@to   IS NULL OR occurred_at <= @to)
  `).get({ accountId, from, to, type }).n;
}

function ledgerSum(accountId) {
  const row = db.get()
    .prepare('SELECT COALESCE(SUM(amount_centavos), 0) AS n FROM customer_credit_transactions WHERE account_id = ?')
    .get(accountId);
  return row.n;
}

/**
 * Every account whose stored balance disagrees with its ledger.
 *
 * The CR-103 invariant, as one query. Empty is the answer TC-INT-46 asserts, and when
 * it is not empty "which accounts" is the first question anyone asks.
 */
function reconciliationBreaks() {
  return db.get().prepare(`
    SELECT a.id AS account_id, a.customer_id, c.name AS customer_name,
           a.balance_centavos,
           COALESCE(t.ledger_centavos, 0) AS ledger_centavos,
           a.balance_centavos - COALESCE(t.ledger_centavos, 0) AS difference_centavos
      FROM customer_credit_accounts a
      JOIN customers c ON c.id = a.customer_id
      LEFT JOIN (
        SELECT account_id, SUM(amount_centavos) AS ledger_centavos
          FROM customer_credit_transactions GROUP BY account_id
      ) t ON t.account_id = a.id
     WHERE a.balance_centavos <> COALESCE(t.ledger_centavos, 0)
     ORDER BY c.name COLLATE NOCASE
  `).all();
}

// ── Ageing (CR-107) ─────────────────────────────────────────────────────────

/**
 * Unsettled credit sales, with how much of each is still outstanding.
 *
 * A sale is settled by allocations against it (CR-203). What remains is the debit less
 * everything allocated to it — which is why this is derived rather than a status
 * column somebody has to remember to clear.
 */
function openDebits(accountId) {
  return db.get().prepare(`
    SELECT t.id, t.amount_centavos, t.due_at, t.occurred_at, t.document_no, t.sale_id,
           COALESCE(alloc.settled_centavos, 0) AS settled_centavos,
           t.amount_centavos - COALESCE(alloc.settled_centavos, 0) AS outstanding_centavos
      FROM customer_credit_transactions t
      LEFT JOIN (
        SELECT sale_txn_id, SUM(amount_centavos) AS settled_centavos
          FROM credit_allocations GROUP BY sale_txn_id
      ) alloc ON alloc.sale_txn_id = t.id
     WHERE t.account_id = ?
       AND t.amount_centavos > 0
       AND t.amount_centavos - COALESCE(alloc.settled_centavos, 0) > 0
     ORDER BY t.occurred_at, t.id
  `).all(accountId);
}

// ── Allocations (CR-203) ────────────────────────────────────────────────────

function insertAllocation(row) {
  db.get().prepare(`
    INSERT INTO credit_allocations (id, collection_txn_id, sale_txn_id, amount_centavos, created_at)
    VALUES (@id, @collection_txn_id, @sale_txn_id, @amount_centavos, @created_at)
  `).run(row);
  return row;
}

function allocationsForCollection(collectionTxnId) {
  return db.get().prepare(`
    SELECT a.id, a.sale_txn_id, a.amount_centavos, a.created_at,
           s.document_no AS sale_document_no, s.due_at, s.occurred_at AS sale_occurred_at
      FROM credit_allocations a
      JOIN customer_credit_transactions s ON s.id = a.sale_txn_id
     WHERE a.collection_txn_id = ?
     ORDER BY s.occurred_at
  `).all(collectionTxnId);
}

function allocationsForSale(saleTxnId) {
  return db.get().prepare(`
    SELECT id, collection_txn_id, amount_centavos, created_at
      FROM credit_allocations WHERE sale_txn_id = ? ORDER BY created_at
  `).all(saleTxnId);
}

/** Accounts carrying a balance, for the dashboard and the ageing report. */
function accountsWithBalance() {
  return db.get().prepare(`
    SELECT a.id AS account_id, a.customer_id, c.name AS customer_name, c.code AS customer_code,
           a.credit_limit_centavos, a.balance_centavos, a.terms_days, c.is_active
      FROM customer_credit_accounts a
      JOIN customers c ON c.id = a.customer_id
     WHERE a.balance_centavos <> 0
     ORDER BY a.balance_centavos DESC
  `).all();
}

module.exports = {
  findAccount, findAccountByCustomer, insertAccount, updateAccountFields,
  insertTransaction, findTransaction, transactionsFor, countTransactionsFor,
  ledgerSum, reconciliationBreaks, openDebits,
  insertAllocation, allocationsForCollection, allocationsForSale, accountsWithBalance,
};
