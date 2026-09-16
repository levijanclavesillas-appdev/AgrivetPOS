'use strict';

// The licence server's own database. One file, forward-only schema, like the POS's.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const STORES = `CREATE TABLE IF NOT EXISTS stores (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     owner_sub TEXT,                   -- the owner's Google account (L-1); null until a store Chachi's registered is first linked (TASK-067)
     owner_email TEXT NOT NULL,
     plan TEXT NOT NULL DEFAULT 'MONTHLY' CHECK (plan IN ('MONTHLY','ONE_TIME')),   -- LIC-005
     paid_until TEXT NOT NULL,         -- ISO UTC; per store (L-6). A one-time store's is 9999-12-31
     created_at TEXT NOT NULL)`;

const PAYMENTS = `CREATE TABLE IF NOT EXISTS payments (
     id TEXT PRIMARY KEY,
     store_id TEXT NOT NULL REFERENCES stores(id),
     method TEXT NOT NULL CHECK (method IN ('MANUAL','PLAY','TRIAL','ONE_TIME','OVERRIDE')),
     amount_centavos INTEGER, reference TEXT, note TEXT,
     paid_until_before TEXT, paid_until_after TEXT NOT NULL,
     recorded_by TEXT NOT NULL,
     created_at TEXT NOT NULL)`;

const SCHEMA = [
  STORES,
  `CREATE INDEX IF NOT EXISTS stores_owner ON stores(owner_sub)`,
  `CREATE TABLE IF NOT EXISTS installations (
     id TEXT PRIMARY KEY,              -- the POS's own installation id
     store_id TEXT NOT NULL REFERENCES stores(id),
     secret_hash TEXT NOT NULL,        -- sha256 of the renewal secret; the secret is never stored
     platform TEXT, app_version TEXT,
     created_at TEXT NOT NULL,
     last_check_at TEXT,
     revoked_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS device_links (
     device_code_hash TEXT PRIMARY KEY,
     user_code TEXT NOT NULL UNIQUE,
     installation_id TEXT NOT NULL,
     store_name TEXT, platform TEXT, app_version TEXT,
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','DENIED','PICKED_UP')),
     store_id TEXT, approved_by TEXT)`,
  PAYMENTS,
  `CREATE TABLE IF NOT EXISTS play_purchases (
     purchase_token TEXT PRIMARY KEY,
     store_id TEXT NOT NULL REFERENCES stores(id),
     product_id TEXT NOT NULL,
     expiry TEXT, state TEXT,
     updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('owner','admin')),
     subject TEXT NOT NULL, email TEXT, name TEXT,
     csrf TEXT NOT NULL,
     created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS oauth_states (
     state TEXT PRIMARY KEY,
     verifier TEXT NOT NULL, nonce TEXT NOT NULL,
     user_code TEXT,
     created_at TEXT NOT NULL)`,
];

/**
 * Columns added after a table was first made. ADD COLUMN has no IF NOT EXISTS, so each is
 * added only when missing — the same file opens a new database and an old one alike.
 */
const COLUMNS = [
  // TASK-065: where a store's web copy is, so the owner's Google sign-in can list it.
  ['device_links', 'web_url', 'TEXT'],
  ['installations', 'web_url', 'TEXT'],
  // TASK-065: where Google sign-in returns to: a link being approved, or "Your stores".
  ['oauth_states', 'return_to', 'TEXT'],
];

/**
 * TASK-067: tables whose CHECK or NOT NULL changed. SQLite cannot alter either, so a table
 * made before the change is rebuilt once: the same columns, every row copied, under a
 * transaction with foreign keys off (other tables point at `stores`), then checked.
 */
const REBUILDS = [
  {
    table: 'stores',
    stale: (db) => db.prepare('PRAGMA table_info(stores)').all().some((c) => c.name === 'owner_sub' && c.notnull),
    create: STORES,
    copy: `INSERT INTO stores_new (id, name, owner_sub, owner_email, plan, paid_until, created_at)
           SELECT id, name, owner_sub, owner_email, CASE WHEN plan = 'ONE_TIME' THEN 'ONE_TIME' ELSE 'MONTHLY' END, paid_until, created_at FROM stores`,
    after: ['CREATE INDEX IF NOT EXISTS stores_owner ON stores(owner_sub)'],
  },
  {
    table: 'payments',
    stale: (db) => !/'OVERRIDE'/.test(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'payments'").get().sql),
    create: PAYMENTS,
    copy: 'INSERT INTO payments_new SELECT * FROM payments',
    after: [],
  },
];

function rebuild(db, { table, create, copy, after }) {
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(create.replace(`IF NOT EXISTS ${table} (`, `${table}_new (`));
      db.exec(copy);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
      for (const statement of after) db.exec(statement);
      const broken = db.pragma('foreign_key_check');
      if (broken.length) throw new Error(`Rebuilding ${table} left ${broken.length} broken reference(s).`);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  for (const statement of SCHEMA) db.exec(statement);
  for (const [table, column, type] of COLUMNS) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  for (const step of REBUILDS) if (step.stale(db)) rebuild(db, step);
  return db;
}

module.exports = { open };
