# TASK-017 — Automatic backup, verification, restore, health and alerts

**Priority:** **P1** — this is the task that decides whether a bad day costs an afternoon or a
year of history · **Blocks release:** yes · **Blocks:** `TASK-013`, `TASK-018` ·
**Requirement:** `FR_7.1`–`FR_7.4`, screens `SCR-704`, `SCR-705`, `NFR_3.2`,
rules `OPS-001`–`OPS-004`, `OPS-006`–`OPS-009`, `SEC-9`, `TX-427`, `TX-428`, `AUD-601`

---

## Objective

Make the store's data survive a corrupt file, a dead PC and a power cut — and prove after every
single backup that it actually can, rather than assuming it.

## Context

`legacy/PRD_v1.1.md` §71 raised an alert on "backup overdue" while §73 specified only manual
backups, so nothing could ever satisfy or trigger it (contradiction 7). The resolution is that
**automatic, verified backup is v1.0**, and this task is where it lands.

`OPS-002` is the requirement that makes the rest worth anything: a backup that has not been opened
and integrity-checked is not a backup, it is a file. Most backup features in small systems fail
here — they write, report success, and are discovered unreadable on the day they are needed.

**Sequencing note.** `TASK-013` requirement 6 already calls this task's service on shift close
(`OPS-001`) and reports its verification status on `SCR-503`. The dependency runs backwards
against the `README.md` ordering. Either land `backupService.runVerifiedBackup()` before
`TASK-013` closes, or `TASK-013` ships against a stub and this task is what makes its acceptance
criterion true — decide explicitly rather than discovering it at review.

`FR_7.4` durability rests on the pragmas set in `TASK-001` (`OPS-008`). This task does not set
them; it **proves** them, and owns the checkpoint discipline that makes a backup taken during
trading a consistent one.

## Requirements

1. A backup service that produces a **consistent** copy of a live WAL database — `better-sqlite3`'s
   backup API or `VACUUM INTO`, checkpointing first. A filesystem copy of `agrivet.db` while
   `-wal` and `-shm` are live is not a backup and must not be the implementation.
2. Backups run automatically on **every shift close** and at the configured daily hour, writing
   `agrivet_backup_YYYY-MM-DD_HH-mm.zip` to the configured folder, which defaults **outside** the
   application data directory (`OPS-001`, `05_TECH_SPEC.md` §7).
3. Every backup is verified **immediately after writing** by opening the copy and running an
   integrity check. A failed verification raises an alert, is audited, and **does not count as a
   backup** — it does not update "last successful backup" and does not satisfy `OPS-007`
   (`OPS-002`, `FR_7.2`).
4. Retention by count, default 30, configurable in the settings registry. Pruning is oldest-first
   and happens **only after a newer backup has verified** (`OPS-003`, `FR_7.1`).
5. `POST /backups` runs a manual backup under `TX-428` and returns the file, its size and its
   verification status.
6. `POST /backups/:id/restore` under `TX-427` (**owner only**): takes a fresh verified backup of
   the current database first, requires typed confirmation naming the file being restored, and
   writes an audit row (`OPS-004`, `AUD-601`). A restore is refused while a shift is open.
7. On launch, when no **successful** backup exists within the configured backup period, a warning
   is shown that is **not dismissible** (`OPS-007`, `FR_7.3`).
8. On launch, a system clock earlier than the latest recorded transaction timestamp raises a
   clock-anomaly alert and is audited. **Transactions continue** — the sale sequence does not
   depend on the clock (`OPS-009`, `VR-103`).
9. `SCR-705` health panel per `OPS-006`: database size, row counts, last successful backup, last
   export, last integrity check, and the schema version — served by `GET /health`.
10. `SCR-704` backup screen: last backup with its verification status, manual backup, restore
    behind typed confirmation, and the plain statement that **a backup on a shared drive is
    readable by anyone with that drive** (`SEC-9`).
11. The alert centre is fed by one service so `SCR-601` and the shell top bar cannot disagree.
    Backup overdue and clock anomaly are never dismissible (`OPS-007`).
12. `FR_7.4`: `kill -9` mid-sale leaves no partial sale and loses no committed one, asserted by
    `TC-E2E-09` against the real pragmas, on a database with a shift open.
13. The **off-machine copy is a process control, not a software control** (`05_TECH_SPEC.md` §7).
    The product does not pretend to perform it; `SCR-704` states the instruction, and the handover
    in `TASK-018` repeats it. Do not build a cloud sync.

## Business Rules

- `OPS-001` — when a backup runs, and where it is written.
- `OPS-002` — verification, and the failure that is not a backup.
- `OPS-003` — retention, and the ordering of the prune.
- `OPS-004` — restore: owner authority, pre-backup, typed confirmation.
- `OPS-006` — what the health panel must report.
- `OPS-007` — the alert list, and the two that are never dismissible.
- `OPS-008` — the pragmas this task proves, set in `TASK-001`.
- `OPS-009`, `VR-103` — the clock anomaly, and why the sequence does not depend on the clock.
- `SEC-9` — backup file permissions and what the operator is told.
- `AUD-601` — restore and backup failure are audited.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/backupService.js`, `src/services/alertService.js`, `src/services/healthService.js`, `src/repositories/backupRepository.js`, `src/routes/backups.js`, `src/routes/health.js`, `public/js/admin/backup.js`, `public/js/admin/health.js` |
| Schema | `backups` (id, filename, path, size_bytes, taken_at, trigger, verified_at, verification_result, error) and `alerts` (id, type, severity, raised_at, dismissible, dismissed_at, payload) — migration required, add both to `05_TECH_SPEC.md` §3.4 |
| API | `POST /backups`, `GET /backups`, `POST /backups/:id/restore`, `GET /health`, `GET /alerts`, `POST /alerts/:id/dismiss` — add the alert rows to `05_TECH_SPEC.md` §4 |
| Constraints | Backup runs **after** a shift close commits and its failure never reopens the shift (`TASK-013`) · a backup must not block a sale in progress for longer than a checkpoint · the daily backup is scheduled in the Electron main process and must survive the renderer being closed · no network path, no cloud target (`NFR_3.1`) |

## Acceptance Criteria

- [ ] A shift close writes a timestamped backup and reports whether it verified
- [ ] The 31st backup prunes the oldest, and only after the 31st has verified
- [ ] A deliberately corrupted backup target fails verification, raises an alert, and does **not** update "last successful backup"
- [ ] A backup taken while a sale is mid-flight restores to a consistent database
- [ ] A restore is owner-only, takes a pre-restore backup, needs the filename typed, and is audited
- [ ] A restore is refused while a shift is open
- [ ] Clock advanced past the backup period raises a non-dismissible launch warning
- [ ] Clock set earlier than the last transaction raises the anomaly alert, is audited, and selling continues
- [ ] `SCR-705` reports all six `OPS-006` figures against a seeded database
- [ ] `SCR-704` states the shared-drive warning in plain words
- [ ] `kill -9` during the E2E sale loop leaves a consistent ledger with no partial and no lost sale

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-INT-70` | Shift close writes a backup; the 31st prunes the oldest |
| `TC-INT-71` | A corrupt backup target fails verification and raises an alert |
| `TC-INT-72` | Clock advanced past the backup period raises the launch warning |
| `TC-INT-73` | Clock set earlier than the last transaction raises the anomaly alert |
| `TC-INT-74` | Restore is owner-only, takes a pre-restore backup, requires typed confirmation, and is audited |
| `TC-INT-75` | A backup taken mid-sale restores to a consistent database |
| `TC-E2E-09` | `kill -9` mid-sale → restart → ledger consistent, no partial sale, no lost committed sale |

> `TC-INT-74` and `TC-INT-75` were added to `07_TEST_PLAN.md` §4 for this task. Before them
> `OPS-004` had no case at all, which for a restore path is the wrong place to be thin.

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
