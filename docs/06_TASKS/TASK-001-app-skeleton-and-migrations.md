# TASK-001 — Application skeleton, layering, migrations and pragmas

**Priority:** **P1** — nothing else can start · **Blocks release:** yes ·
**Blocks:** every other task · **Requirement:** `05_TECH_SPEC.md` §1, §2, §3.2, §3.5, §8

---

## Objective

Stand up the Electron + Express + better-sqlite3 shell with the four-layer structure and a
forward-only migration runner, so that every later task adds a slice rather than a foundation.

## Context

Nothing exists — the repository is documentation only. `CHACHI_LOAN_STANDARD` is the working
reference for this exact shape (`main.js` starting an embedded `src/app.js`); copy the shape,
not the domain code. The layering rule in `05_TECH_SPEC.md` §8.1 is the whole of the SQLite →
PostgreSQL portability requirement, and it is cheap now and expensive later.

## Requirements

1. `main.js` starts the Express server in-process, waits for `/api/v1/health`, then opens the
   `BrowserWindow`. A server already running on the port is reused, not duplicated.
2. Express binds **`127.0.0.1` only** (`SEC-8`). Binding `0.0.0.0` is not configurable in v1.0.
3. Directory structure exactly: `src/routes/`, `src/services/`, `src/repositories/`,
   `src/config/`, `src/migrations/`, `public/`, `src/tests/`.
4. `src/config/database.js` opens the database at `%LOCALAPPDATA%\ChachiAgrivetPOS\agrivet.db`,
   applies the four pragmas, and exposes a `transaction(fn)` helper — the **only** way a service
   opens a transaction.
5. A migration runner applies `src/migrations/NNN_*.sql` in order, each in its own transaction,
   recording `schema_migrations`. It **refuses to start** when the database version exceeds the
   binary's highest known migration.
6. `001_foundation.sql` creates `schema_migrations`, `store_profile`, `system_settings`, `users`,
   `audit_logs` per `05_TECH_SPEC.md` §3.4. `audit_logs.shift_id` carries **no** foreign key —
   see the annotation in §3.4 and the convention 8 exception in §3.1; guarded by `TC-INT-05`.
7. `GET /api/v1/health` returns schema version, database size and row counts (`OPS-006`).
8. A test runner exists and `npm run test`, `test:unit`, `test:all`, `build:exe` are wired.

## Business Rules

- `OPS-008` — WAL, `synchronous = NORMAL`, foreign keys on; power-loss durability rests here.
- `VR-101` — UUIDv7 identity generator, application-side.
- `VR-102` — UTC storage helper; no local-time write path anywhere.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `main.js`, `src/app.js`, `src/config/database.js`, `src/config/migrate.js`, `src/config/ids.js`, `src/config/clock.js`, `src/routes/health.js` |
| Schema | `001_foundation.sql` |
| API | `GET /api/v1/health` |
| Constraints | No SQL outside `repositories/`; no `better-sqlite3` import outside `repositories/` and `config/`; cold start ≤ 8 s (`NFR_1.4`) |

## Acceptance Criteria

- [x] `npm start` serves `/api/v1/health` on `127.0.0.1` and nothing on the LAN interface
- [x] `npm run start:electron` opens a window against that server
- [x] A fresh database applies `001` and records it in `schema_migrations`
- [x] Re-running migrations is a no-op
- [x] A database at version 99 against a binary knowing 1 **refuses to start** with a clear message
- [x] All four pragmas verified as set on an open connection
- [x] `TC-UT-99` passes on the empty skeleton
- [x] `npm run build:exe` produces `ChachiAgrivetPOS-Setup-<version>.exe`

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-UT-99` | Layering: no SQL or driver import outside the permitted layers |
| `TC-UT-90` | UTC storage, `Asia/Manila` render |
| `TC-INT-01` | Migration applies once, is idempotent, and refuses a newer database |
| `TC-INT-05` | An audit row is writable at schema version 1, before `cashier_shifts` exists |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
