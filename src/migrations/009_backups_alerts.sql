-- 009_backups_alerts.sql — the backup log and the alert centre
-- Source of truth: 05_TECH_SPEC.md §3.4. Conventions in §3.1 are binding.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).
--
-- OPS-002 is why `backups` exists at all. Until now SCR-704 listed the files on disk,
-- which answers "what is in the folder" and not the question that matters: **which of
-- these was opened and proved readable**. A row here is the record of that proof, and
-- a backup with `verification_result <> 'OK'` is not a backup — it does not satisfy
-- OPS-007's freshness check and it is never pruned in favour of.
--
-- The log survives the files. A backup deleted from the folder by hand still leaves
-- its row, so "the last backup verified three weeks ago and someone has been deleting
-- them" is answerable. That is a different fact from "the folder is empty", and only
-- one of the two tells an owner what went wrong.

CREATE TABLE backups (
  id            TEXT PRIMARY KEY,
  -- Nullable, and deliberately: a backup that failed before it had a name — no folder
  -- configured — is still an attempt, and it is the *worst* attempt to lose. A store
  -- with no backup folder is the most exposed state this product has, and requiring a
  -- filename here would have made that the one failure that left no trace.
  filename      TEXT,
  path          TEXT,
  size_bytes    INTEGER,
  taken_at      TEXT NOT NULL,
  trigger       TEXT NOT NULL
                  CHECK (trigger IN ('SCHEDULED','SHIFT_CLOSE','MANUAL','PRE_RESTORE','PRE_IMPORT','PRE_MIGRATION')),
  -- OPS-002: written and verified are two different events, and the gap between them
  -- is exactly where a bad backup hides. NULL verified_at means the check never
  -- completed — a crash mid-verify reads as unverified rather than as success.
  verified_at   TEXT,
  verification_result TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (verification_result IN ('PENDING','OK','FAILED')),
  error         TEXT,
  schema_version INTEGER,
  row_counts    TEXT,                                  -- JSON, for the health panel
  -- NULL for a scheduled backup: nobody pressed anything.
  created_by    TEXT REFERENCES users(id),
  -- OPS-003: a pruned backup keeps its row. The file is gone; the fact that it existed
  -- and verified is history, and deleting the row would make the retention policy look
  -- like data loss.
  pruned_at     TEXT
);

-- OPS-007's freshness question, asked on every launch: "is there a verified backup
-- inside the configured period".
CREATE INDEX idx_backups_verified ON backups (verification_result, taken_at DESC);
CREATE INDEX idx_backups_taken ON backups (taken_at DESC);

-- OPS-007 — the alert centre.
--
-- Alerts are **derived**, not stored: low stock is a query over inventory, overdue
-- credit is a query over the ledger, and a stored copy would go stale the moment
-- someone received stock. What is stored here is the one thing a query cannot derive —
-- **that a person dismissed it, and when**. The dismissal is the fact; the alert is
-- recomputed every time.
--
-- This is why there is no severity or message column: those come from the rule that
-- raised the alert, in the language that rule is written in, and a copy here would be
-- a second place for the wording to live.
CREATE TABLE alert_dismissals (
  id            TEXT PRIMARY KEY,
  -- The alert's identity: its kind plus whatever makes one instance different from
  -- another (a shift id, a product id). Recomputed the same way every time, so
  -- dismissing "this shift has been open too long" does not dismiss the next one.
  alert_key     TEXT NOT NULL,
  kind          TEXT NOT NULL,
  dismissed_at  TEXT NOT NULL,
  dismissed_by  TEXT NOT NULL REFERENCES users(id),
  -- OPS-007: backup overdue and clock anomaly are never dismissible. The CHECK is the
  -- enforcement, not a validation in a service that could be bypassed by the next
  -- caller: there is no way to write a row that dismisses one.
  CHECK (kind NOT IN ('BACKUP_OVERDUE','BACKUP_UNVERIFIED','CLOCK_ANOMALY')),
  UNIQUE (alert_key)
);

CREATE INDEX idx_dismissals_kind ON alert_dismissals (kind, dismissed_at DESC);

-- OPS-009 — the clock check, and OPS-006's "last integrity check".
--
-- One row per launch-time observation worth keeping. Not an alert table: the alert is
-- derived from these rows like every other, and this is the evidence behind it.
CREATE TABLE system_events (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL
                CHECK (kind IN ('CLOCK_ANOMALY','INTEGRITY_CHECK','EXPORT','RESTORE','LAUNCH')),
  occurred_at TEXT NOT NULL,
  ok          INTEGER NOT NULL DEFAULT 1 CHECK (ok IN (0, 1)),
  detail      TEXT,                                    -- JSON
  actor_id    TEXT REFERENCES users(id)
);

CREATE INDEX idx_sysevents_kind ON system_events (kind, occurred_at DESC);
