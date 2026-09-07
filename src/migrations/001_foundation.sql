-- 001_foundation.sql — users, settings, store profile, audit
-- Source of truth: 05_TECH_SPEC.md §3.4. Conventions in §3.1 are binding:
-- TEXT UUIDv7 keys (VR-101), INTEGER centavos (MON-001), ISO-8601 UTC text (VR-102),
-- enumerations as TEXT + CHECK, every foreign key declared.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).

CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TEXT NOT NULL
);

CREATE TABLE store_profile (
  id            TEXT PRIMARY KEY,
  store_name    TEXT NOT NULL,
  address       TEXT,
  contact_no    TEXT,
  tin           TEXT,
  tax_mode      TEXT NOT NULL CHECK (tax_mode IN ('NONE','NON_VAT','VAT')),  -- TAX-001
  currency      TEXT NOT NULL DEFAULT 'PHP',
  created_at    TEXT NOT NULL,
  updated_at    TEXT,
  updated_by    TEXT REFERENCES users(id)
);

CREATE TABLE system_settings (           -- OPS-005: every operator-owned figure
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  value_type  TEXT NOT NULL CHECK (value_type IN ('INT','STRING','BOOL','JSON')),
  updated_at  TEXT,
  updated_by  TEXT REFERENCES users(id)
);

CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  username          TEXT NOT NULL UNIQUE COLLATE NOCASE,       -- VR-501
  full_name         TEXT NOT NULL,
  password_hash     TEXT NOT NULL,                              -- SEC-1, bcrypt cost 12
  pin_hash          TEXT,                                       -- SEC-2, 6 digits
  role              TEXT NOT NULL CHECK (role IN ('OWNER','MANAGER','CASHIER','INVENTORY')),
  recovery_code_hash TEXT,                                      -- SEC-5, owner only
  failed_attempts   INTEGER NOT NULL DEFAULT 0,                 -- SEC-3
  locked_until_at   TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  created_by        TEXT REFERENCES users(id)
);

CREATE TABLE audit_logs (                -- AUD-605/606: append-only, never deleted
  id            TEXT PRIMARY KEY,
  occurred_at   TEXT NOT NULL,
  actor_id      TEXT REFERENCES users(id),
  actor_username TEXT NOT NULL,          -- denormalised: AUD-606
  approver_id   TEXT REFERENCES users(id),
  approver_username TEXT,                -- AUD-603: two distinct actors
  action        TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT,
  before_value  TEXT,                    -- JSON
  after_value   TEXT,                    -- JSON
  reason        TEXT,
  -- NOT a foreign key, deliberately: 05_TECH_SPEC.md §3.4 and the convention 8
  -- exception in §3.1. SQLite resolves a parent table at INSERT time, so declaring
  -- REFERENCES cashier_shifts(id) here makes every audit write fail until migration
  -- 005 — NULL shift_id included. Guarded by TC-INT-05; do not add the constraint.
  shift_id      TEXT                     -- soft reference to cashier_shifts(id)
);
CREATE INDEX idx_audit_time   ON audit_logs (occurred_at DESC);
CREATE INDEX idx_audit_entity ON audit_logs (entity_type, entity_id);
