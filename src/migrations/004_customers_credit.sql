-- 004_customers_credit.sql — customers, credit accounts, the credit ledger, allocations
-- Source of truth: 05_TECH_SPEC.md §3.4. Conventions in §3.1 are binding.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).
--
-- CR-103 is the shape of this migration, exactly as INV-101 was the shape of 003:
-- `customer_credit_accounts.balance_centavos` is a materialised figure derived from
-- `customer_credit_transactions`, written only by creditService inside the transaction
-- that writes the ledger row, and reconcilable to SUM(amount_centavos) at any moment.
--
-- That is not a preference. The store's credit is a notebook today
-- (01_PRODUCT_BRIEF.md §1), and the cutover succeeds when the system's balances
-- reconcile against it (§6.3). A stored balance with no ledger behind it cannot be
-- reconciled against anything.

CREATE TABLE customers (
  id            TEXT PRIMARY KEY,
  code          TEXT UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,                                      -- VR-301
  contact_no    TEXT,                                               -- VR-302
  address       TEXT,
  customer_type TEXT NOT NULL DEFAULT 'RETAIL'
                  CHECK (customer_type IN ('WALK_IN','RETAIL','REGULAR','WHOLESALE','DEALER','FARM')),
  price_level   TEXT NOT NULL DEFAULT 'RETAIL'
                  CHECK (price_level IN ('RETAIL','WHOLESALE','DEALER')),
  is_credit_eligible INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  notes         TEXT,
  created_at TEXT NOT NULL, created_by TEXT REFERENCES users(id),
  updated_at TEXT, updated_by TEXT REFERENCES users(id)
);
CREATE INDEX idx_customers_name ON customers (name);

CREATE TABLE customer_credit_accounts (
  id                    TEXT PRIMARY KEY,
  customer_id           TEXT NOT NULL UNIQUE REFERENCES customers(id),
  credit_limit_centavos INTEGER NOT NULL DEFAULT 0 CHECK (credit_limit_centavos >= 0),  -- VR-303
  balance_centavos      INTEGER NOT NULL DEFAULT 0,   -- CR-103; negative = store credit (CR-108)
  terms_days            INTEGER NOT NULL DEFAULT 0,   -- 0 = COD
  updated_at            TEXT NOT NULL
);

CREATE TABLE customer_credit_transactions (     -- CR-103: the balance derives from here
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES customer_credit_accounts(id),
  txn_type      TEXT NOT NULL CHECK (txn_type IN
                  ('CREDIT_SALE','COLLECTION','RETURN_CREDIT','WRITE_OFF','OPENING','ADJUSTMENT')),
  amount_centavos INTEGER NOT NULL,      -- signed: debit +, credit -
  balance_after_centavos INTEGER NOT NULL,
  --
  -- sale_id and shift_id are soft references, and this is the one deviation in this
  -- file from 05_TECH_SPEC.md §3.4, which declares both as foreign keys.
  --
  -- It is the same trap the spec already documented for audit_logs.shift_id in 001,
  -- for the same reason: SQLite resolves a foreign key's parent table at INSERT time,
  -- so a declared REFERENCES sales(id) makes *every* insert here fail with "no such
  -- table" until migration 006 creates it — including an insert whose sale_id is NULL.
  -- Verified, not assumed: with foreign_keys = ON, an INSERT of (NULL, NULL) into a
  -- table declaring both fails outright.
  --
  -- An OPENING balance (TASK-026's notebook migration) and an ADJUSTMENT both carry no
  -- sale and no shift, and both must be writable the day this table exists. Declaring
  -- the constraint and enforcing it later would mean rebuilding the table in 006, which
  -- 001 already weighed and rejected. §3.4 should be amended to mark these soft, as it
  -- was for audit_logs.shift_id. TC-INT-47 guards it.
  --
  sale_id       TEXT,                    -- soft reference to sales(id)
  due_at        TEXT,                    -- CR-105, fixed at the moment of sale
  document_no   TEXT NOT NULL,           -- COLL-YYYYMMDD-NNNNNN for collections
  method        TEXT CHECK (method IN ('CASH','GCASH','QRPH','STORE_CREDIT')),
  reference_no  TEXT,
  shift_id      TEXT,                    -- soft reference to cashier_shifts(id)
  reason        TEXT,
  occurred_at   TEXT NOT NULL,
  created_by    TEXT NOT NULL REFERENCES users(id)
);
CREATE INDEX idx_credit_account ON customer_credit_transactions (account_id, occurred_at);

-- CR-107 derives ageing from each unsettled credit sale's due date, at read time. That
-- query filters to debits with a due date on one account, so it runs on this.
CREATE INDEX idx_credit_due ON customer_credit_transactions (account_id, txn_type, due_at);

CREATE TABLE credit_allocations (        -- CR-203: which invoices a payment settled
  id TEXT PRIMARY KEY,
  collection_txn_id TEXT NOT NULL REFERENCES customer_credit_transactions(id),
  sale_txn_id       TEXT NOT NULL REFERENCES customer_credit_transactions(id),
  amount_centavos   INTEGER NOT NULL CHECK (amount_centavos > 0),
  created_at        TEXT NOT NULL
);

-- Both directions are read: "what did this payment settle" on the acknowledgement
-- (CR-206), and "how much of this sale is still outstanding" by the ageing derivation.
CREATE INDEX idx_alloc_collection ON credit_allocations (collection_txn_id);
CREATE INDEX idx_alloc_sale       ON credit_allocations (sale_txn_id);
