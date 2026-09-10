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

/**
 * The mirror image: credits with something left to give (`CR-108`).
 *
 * A collection that overpaid and a return credit are both money the customer has with
 * the store, and `credit_allocations` records what each has been used for. What is left
 * of one is its amount less everything allocated **from** it — the same derivation as
 * `openDebits` above, read from the other end of the same table, which is why neither
 * needs a status column.
 *
 * Oldest first, so the credit a customer has held longest is the one spent next. That
 * is the same ordering `CR-203` fixes for a payment, and for the same reason: money
 * should not sit on an account gathering questions.
 */
function openCredits(accountId) {
  return db.get().prepare(`
    SELECT t.id, t.amount_centavos, t.txn_type, t.occurred_at, t.document_no,
           COALESCE(alloc.used_centavos, 0) AS used_centavos,
           -t.amount_centavos - COALESCE(alloc.used_centavos, 0) AS available_centavos
      FROM customer_credit_transactions t
      LEFT JOIN (
        SELECT collection_txn_id, SUM(amount_centavos) AS used_centavos
          FROM credit_allocations GROUP BY collection_txn_id
      ) alloc ON alloc.collection_txn_id = t.id
     WHERE t.account_id = ?
       AND t.amount_centavos < 0
       AND -t.amount_centavos - COALESCE(alloc.used_centavos, 0) > 0
     ORDER BY t.occurred_at, t.id
  `).all(accountId);
}

/**
 * `CR-302`: the balance an account carried **before** an instant.
 *
 * The opening balance of a statement, derived rather than stored — there is nowhere to
 * store it that would not be a second answer to a question `CR-103` has already
 * answered once. A statement is the ledger read over a window, and its opening figure
 * is the same sum with a different `WHERE`.
 */
function balanceBefore(accountId, at) {
  return db.get().prepare(`
    SELECT COALESCE(SUM(amount_centavos), 0) AS balance
      FROM customer_credit_transactions
     WHERE account_id = ? AND occurred_at < ?
  `).get(accountId, at).balance;
}

/** The same sum, up to and including an instant — a statement's closing figure. */
function balanceAsOf(accountId, at) {
  return db.get().prepare(`
    SELECT COALESCE(SUM(amount_centavos), 0) AS balance
      FROM customer_credit_transactions
     WHERE account_id = ? AND occurred_at <= ?
  `).get(accountId, at).balance;
}

/**
 * `CR-301` — every unsettled debit in the store, with the customer it belongs to.
 *
 * **One query for the whole ageing report**, not one per account: a store with two
 * hundred credit customers would otherwise pay two hundred round trips for a report
 * somebody reads while deciding who to telephone. The bucketing itself is not done here
 * — that is arithmetic on a due date, and it belongs in one function that a unit test
 * can pin, rather than in a `CASE` expression nobody can test in isolation.
 *
 * The outstanding figure is the debit less what `credit_allocations` has settled
 * against it, which is the same derivation `openDebits` makes for one account. A debit
 * with nothing left is not here at all.
 */
function openDebitsForAll() {
  return db.get().prepare(`
    SELECT t.id, t.account_id, t.amount_centavos, t.due_at, t.occurred_at, t.document_no,
           t.sale_id,
           COALESCE(alloc.settled_centavos, 0) AS settled_centavos,
           t.amount_centavos - COALESCE(alloc.settled_centavos, 0) AS outstanding_centavos,
           a.customer_id, c.name AS customer_name, c.code AS customer_code,
           c.contact_no AS customer_contact_no, a.terms_days
      FROM customer_credit_transactions t
      JOIN customer_credit_accounts a ON a.id = t.account_id
      JOIN customers c ON c.id = a.customer_id
      LEFT JOIN (
        SELECT sale_txn_id, SUM(amount_centavos) AS settled_centavos
          FROM credit_allocations GROUP BY sale_txn_id
      ) alloc ON alloc.sale_txn_id = t.id
     WHERE t.amount_centavos > 0
       AND t.amount_centavos - COALESCE(alloc.settled_centavos, 0) > 0
     ORDER BY c.name COLLATE NOCASE, t.due_at, t.occurred_at
  `).all();
}

/**
 * Every unused credit in the store, in one query (`CR-108`).
 *
 * The other half of what an account's balance is made of. A balance is not "the debits"
 * — it is unsettled debits **less** credits nobody has spent yet: an overpayment, a
 * return credit, money the store is holding. `credit_allocations` records what has been
 * used, so what is left is the same derivation `openCredits` makes for one account.
 *
 * The ageing report needs it because ageing sums debts gross and a balance nets them.
 * Without this figure the two cannot be made to agree, and a report whose totals do not
 * tie to the ledger is a report somebody stops believing at exactly the wrong moment.
 */
function openCreditsForAll() {
  return db.get().prepare(`
    SELECT t.id, t.account_id, t.txn_type, t.occurred_at, t.document_no,
           -t.amount_centavos - COALESCE(alloc.used_centavos, 0) AS available_centavos,
           a.customer_id, c.name AS customer_name
      FROM customer_credit_transactions t
      JOIN customer_credit_accounts a ON a.id = t.account_id
      JOIN customers c ON c.id = a.customer_id
      LEFT JOIN (
        SELECT collection_txn_id, SUM(amount_centavos) AS used_centavos
          FROM credit_allocations GROUP BY collection_txn_id
      ) alloc ON alloc.collection_txn_id = t.id
     WHERE t.amount_centavos < 0
       AND -t.amount_centavos - COALESCE(alloc.used_centavos, 0) > 0
     ORDER BY c.name COLLATE NOCASE, t.occurred_at
  `).all();
}

/**
 * Every account's balance, in one query, for the ageing report's reconciliation.
 *
 * `CR-108`: an account in credit has a negative balance and is not a receivable. It is
 * returned here rather than filtered, because the report has to be able to say that the
 * buckets and the not-yet-due total account for the whole of what is owed **and**
 * nothing else — and an account quietly dropped is the sort of thing that makes two
 * figures differ by an amount nobody can find.
 */
function balancesForAll() {
  return db.get().prepare(`
    SELECT a.id AS account_id, a.customer_id, c.name AS customer_name,
           COALESCE(SUM(t.amount_centavos), 0) AS balance_centavos
      FROM customer_credit_accounts a
      JOIN customers c ON c.id = a.customer_id
      LEFT JOIN customer_credit_transactions t ON t.account_id = a.id
     GROUP BY a.id
     ORDER BY c.name COLLATE NOCASE
  `).all();
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

/**
 * The ledger rows one sale created, so a void can reverse exactly what it wrote.
 *
 * `sale_id` is a soft reference (004's own note explains why it is not a foreign key),
 * which changes nothing here: it is still the only column that says which credit rows
 * belong to which sale, and a void that guessed from the amount would reverse the
 * wrong row the first time a farm bought twice for the same money.
 */
function transactionsForSale(saleId) {
  return db.get().prepare(`
    SELECT ${TXN_COLUMNS} FROM customer_credit_transactions
     WHERE sale_id = ? ORDER BY occurred_at, id
  `).all(saleId);
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
  insertTransaction, findTransaction, transactionsFor, countTransactionsFor, transactionsForSale,
  ledgerSum, reconciliationBreaks, openDebits, openCredits,
  openDebitsForAll, openCreditsForAll, balanceBefore, balanceAsOf, balancesForAll,
  insertAllocation, allocationsForCollection, allocationsForSale, accountsWithBalance,
};
