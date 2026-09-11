# TASK-004 — First-run setup, store profile, tax mode and the settings registry

**Priority:** **P1** · **Blocks release:** yes · **Blocks:** `TASK-009`, `TASK-017` ·
**Requirement:** `FR_1.1`, rules `TAX-001`, `OPS-005`, `SEC-5`

---

## Objective

Make a fresh installation configure itself in one guided pass — store identity, tax mode, the
owner account with its recovery code, and the backup folder — and put every operator-owned figure
into one registry rather than scattered constants.

## Context

The client answered the tax question "cater both non-VAT, VAT, and not registered"
(`01_PRODUCT_BRIEF.md` D-3), so registration status is chosen here at install rather than assumed
at build. This also makes the product resellable to another agrivet store without a schema change.

`OPS-005` exists because `legacy/PRD_v1.1.md` referred to "the configured threshold" fourteen
times without ever listing what was configurable. The registry is that list.

## Requirements

1. On an empty database the app serves only the wizard; no other route or screen is reachable.
2. Five steps per `SCR-001`: store → tax mode → owner → recovery code → backup folder.
3. Tax mode presents `NONE`, `NON_VAT`, `VAT` with one plain-language sentence each, and is
   stored on `store_profile` (`TAX-001`).
4. The recovery code is generated, displayed **once**, stored bcrypt-hashed, and requires an
   explicit "I have written this down" acknowledgement (`SEC-5`).
5. The backup folder defaults **outside** the application data directory and is validated as
   writable before the wizard completes (`OPS-001`).
6. Completion is a single transaction producing exactly one `store_profile`, one `OWNER` user, and
   the full seeded `system_settings`.
7. The settings registry seeds every key in `OPS-005` with its documented default, typed, and
   exposes read/write with `TX-424` (owner-only for `TX-425`, the tax mode).
8. A settings change writes an audit row with both values (`AUD-601`).

## Business Rules

- `TAX-001` — the three modes and who may change one.
- `OPS-005` — the complete list of operator-owned figures. This task's registry **is** that list.
- `SEC-5` — recovery code generation and storage.
- `VR-501`, `VR-502` — the owner account's validation.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/routes/setup.js`, `src/routes/settings.js`, `src/services/settingsService.js`, `src/repositories/settingsRepository.js`, `public/setup.html` |
| Schema | `store_profile`, `system_settings` (in `001_foundation.sql`) |
| API | `GET POST /setup`, `GET PUT /settings` |
| Constraints | No hard-coded threshold anywhere in the codebase; every one reads the registry |

## Acceptance Criteria

- [x] A fresh install serves the wizard and refuses every other route
- [x] Killing the app mid-wizard resumes at step 1 with nothing written
- [x] Completion writes exactly one profile, one owner and the full settings set, atomically
- [x] The recovery code is shown once and never retrievable afterwards
- [x] An unwritable backup folder blocks completion with a clear message
- [x] Changing the tax mode requires `TX-425` and is audited with both values
- [x] A `grep` for a numeric threshold literal in `services/` returns nothing

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-E2E-00` | Fresh install → wizard → owner → first login |
| `TC-UT-17` | `NONE` / `NON_VAT` compute no tax |
| `TC-UT-05` | A settings change writes one audit row with both values |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
