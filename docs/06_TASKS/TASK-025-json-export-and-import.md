# TASK-025 — JSON export and validated import

**Priority:** **P2** for v1.1 · **Blocks release:** yes (v1.1) ·
**Blocks:** `TASK-026` (which reuses the validation) ·
**Requirement:** features `FT-705`, `FT-706`, rules `OPS-101`–`OPS-104`, `OPS-004`,
`AUD-601`, `TX-426`, `TX-427`

---

## Objective

Get the whole store out as a readable archive, and back in without ever half-writing it.

## Context

v1.0 exports reports as CSV and backs the database up as a verified `.zip`. Neither is a data
interchange: a backup is an opaque SQLite file that only this application opens, and a report is
a summary. `OPS-101` asks for something a person can read and another system could consume.

**`OPS-102` is the rule the whole task turns on: validate the manifest, the schema version,
referential integrity and the checksum *before writing anything*, and present a summary for
confirmation.** An import that validates as it writes is an import that fails halfway, and a
half-imported store is worse than an un-imported one because nobody can tell which it is.

**`OPS-104` is the second: never silently overwrite.** A colliding identity is reported and the
operator chooses skip, replace or abort **for the whole run** — not per row. Per-row choices at
three in the morning are how half a catalogue ends up replaced and half skipped.

## Requirements

1. `OPS-101`: one archive, one JSON file per entity, plus `manifest.json` carrying schema
   version, export timestamp, row counts and a checksum.
2. The archive uses the same zip codec as the backups (`src/config/zip.js`), extended to
   multiple entries — and validated against an independent implementation as that one is,
   because a format only its own reader accepts is not an interchange format.
3. `OPS-102`: validation is a complete pass before any write — manifest, schema version,
   referential integrity, checksum — and produces a summary the operator confirms.
4. `OPS-103`: a full verified backup before it writes (`OPS-004`), and the whole import in
   **one transaction**. If the backup cannot be taken, the import does not run.
5. `OPS-104`: collisions reported, and skip / replace / abort chosen for the run.
6. A schema version newer than this build refuses, in the words `upgradeService` already uses.
7. Export under `TX-426`, import under `TX-427` — importing is a restore in every way that
   matters. Both audited (`AUD-601`).
8. The export is deterministic: the same database twice produces byte-identical archives, so a
   diff between two exports means the data changed.

## Business Rules

- `OPS-101` — the archive and its manifest.
- `OPS-102` — validate everything before writing anything.
- `OPS-103` — backup first, one transaction.
- `OPS-104` — no silent overwrite; one decision for the run.
- `OPS-004` — the pre-write backup, as a restore takes one.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/exportService.js`, `importService.js`, `src/config/zip.js` (multi-entry), `src/routes/data.js`, `public/js/admin/data.js` |
| Schema | None. `system_events` already records `EXPORT` |
| API | `POST /data/export`, `POST /data/import/validate`, `POST /data/import` |
| Constraints | Validation before writes, always · one transaction · the zip writer cross-checked against Python's `zipfile`, as `TASK-017`'s was |

## Acceptance Criteria

- [ ] An export round-trips into an empty database and reproduces it exactly
- [ ] The same database exported twice gives byte-identical archives
- [ ] A corrupted checksum, a dangling reference and a future schema version each refuse before writing
- [ ] A collision is reported and the operator's one choice governs the run
- [ ] A failed import leaves the database exactly as it was, and names the pre-import backup
- [ ] The archive opens in a tool that is not this application

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-INT-94` | `OPS-102`: each invalid archive refuses **before** a single row is written |
| `TC-INT-95` | `OPS-103`: a failed import rolls back wholly and the pre-import backup restores |
| `TC-INT-96` | `OPS-104`: collisions reported; skip, replace and abort each behave |
| `TC-INT-97` | The export is deterministic |
| `TC-E2E-20` | Export a traded store, import into an empty one, and reconcile every ledger |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
