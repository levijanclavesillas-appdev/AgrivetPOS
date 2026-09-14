-- 901_licence.sql — the store's subscription licence (pharmacy edition, TASK-048)
-- Source of truth: docs/PHARMACY_EDITION.md §6. Conventions in 05_TECH_SPEC.md §3.1 are binding.
--
-- Forward-only. In the edition's own range (900–999): main never has this table.
--
-- One row: this installation. The licence is the signed token exactly as the licence
-- server sent it, verified on every read with the public key compiled into the build
-- (LIC-003); nothing here is trusted because it is in the database.
--
-- installation_secret is what the silent monthly renewal authenticates with. It is a
-- secret, so exportService never exports this table and a backup is as sensitive as the
-- database it copies — which it already was.
--
-- max_seen_at is the latest time this installation has ever seen: the licence is judged
-- against it rather than against the clock alone, so setting the clock back cannot buy
-- a lapsed store more days (LIC-003).

CREATE TABLE licence_state (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  installation_id      TEXT NOT NULL,
  licence              TEXT,
  installation_secret  TEXT,
  pending_device_code  TEXT,
  pending_user_code    TEXT,
  pending_uri          TEXT,
  pending_expires_at   TEXT,
  last_attempt_at      TEXT,
  last_error           TEXT,
  max_seen_at          TEXT,
  updated_at           TEXT NOT NULL
);
