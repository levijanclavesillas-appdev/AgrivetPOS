-- 907_sync.sql — one store on the web and on its devices, kept in step (TASK-063)
-- Source of truth: docs/PHARMACY_EDITION.md §12. Conventions in 05_TECH_SPEC.md §3.1 are binding.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).
--
-- A store can run on the web (its hosted copy, the HUB) and on phones and PCs (DEVICES)
-- at once. Each device keeps the whole store in its own database, sells from it offline,
-- and syncs with the hub when it can: its own changes go up, everybody else's come down.
-- A store with one device and no web copy is STANDALONE, and none of this runs for it.
--
-- Changes are captured by triggers (created at launch from the live schema by
-- syncRepository, so a later migration's columns are covered without editing them here)
-- into sync_changes: on a device it is the outbox, on the hub the log devices pull from.

-- This installation's place in the store. One row.
CREATE TABLE sync_identity (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  role            TEXT NOT NULL DEFAULT 'STANDALONE' CHECK (role IN ('STANDALONE', 'HUB', 'DEVICE')),
  device_id       TEXT,                 -- DEVICE: its id at the hub
  device_name     TEXT,                 -- DEVICE: "Counter 1", "Owner's phone"
  series          TEXT,                 -- DEVICE: its letter in every document number (SALE-A-…)
  hub_url         TEXT,                 -- DEVICE: https://<store>.pos.chachisoftware.store
  device_secret   TEXT,                 -- DEVICE: what it syncs with; the hub keeps a hash
  pulled_version  INTEGER NOT NULL DEFAULT 0,   -- DEVICE: the hub's log applied up to here
  pushed_change   INTEGER NOT NULL DEFAULT 0,   -- DEVICE: its own changes sent up to here
  linked_at       TEXT,
  last_sync_at    TEXT,                 -- the last time the hub answered
  last_error      TEXT,
  updated_at      TEXT NOT NULL
);
INSERT INTO sync_identity (id, role, updated_at) VALUES (1, 'STANDALONE', '1970-01-01T00:00:00.000Z');

-- Set only while rows arriving from elsewhere are written: a device applying the hub's
-- rows must not capture them as its own changes (applying = 1), and the hub notes which
-- device a row came from (origin) so the log says so.
CREATE TABLE sync_state (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  applying  INTEGER NOT NULL DEFAULT 0 CHECK (applying IN (0, 1)),
  origin    TEXT
);
INSERT INTO sync_state (id, applying) VALUES (1, 0);

CREATE TABLE sync_changes (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,   -- the version a device pulls from
  tbl     TEXT NOT NULL,
  pk      TEXT NOT NULL,                       -- JSON array of the row's key values
  op      TEXT NOT NULL CHECK (op IN ('I', 'U', 'D')),
  cols    TEXT,                                -- 'U': the columns that changed, comma-ended
  origin  TEXT,                                -- HUB: the device it came from; NULL = the hub itself
  at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_sync_changes_row ON sync_changes (tbl, pk);

-- HUB: the store's devices. The secret is never stored, only its hash.
CREATE TABLE sync_devices (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  series          TEXT NOT NULL UNIQUE,
  platform        TEXT,
  app_version     TEXT,
  secret_hash     TEXT NOT NULL,
  linked_at       TEXT NOT NULL,
  linked_by       TEXT REFERENCES users(id),
  last_seen_at    TEXT,
  pushed_through  INTEGER NOT NULL DEFAULT 0,   -- the device's own change id last applied
  pulled_version  INTEGER NOT NULL DEFAULT 0,   -- the hub version it last asked from
  revoked_at      TEXT,
  revoked_by      TEXT REFERENCES users(id)
);
