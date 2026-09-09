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

- [x] An export round-trips into an empty database and reproduces it exactly
- [x] The same database exported twice gives byte-identical archives
- [x] A corrupted checksum, a dangling reference and a future schema version each refuse before writing
- [x] A collision is reported and the operator's one choice governs the run
- [x] A failed import leaves the database exactly as it was, and names the pre-import backup
- [x] The archive opens in a tool that is not this application

## What it decided

**Credentials are not exported, and the consequence is stated everywhere it matters.** `SEC-1`
says no endpoint returns `password_hash`, `pin_hash` or `recovery_code_hash`, and an export is an
endpoint. They are removed **by column name across every table**, so a secret that moves or is
copied somewhere new is still caught, and a test greps the whole archive for a bcrypt prefix
rather than trusting the users file. The consequence — **an imported store has its people but
none of their passwords** — is in the manifest, in the validation summary and on `SCR-706` before
anybody makes a file, because discovering it at the counter the next morning is the wrong moment.
`importService` writes an impossible hash rather than leaving the column absent, so an imported
account cannot be signed into until somebody sets a password.

**Collisions are detected on every unique key, not on identity — and getting that wrong first is
what showed why.** The initial version checked `id`, which is a UUID: two stores set up
independently never collide on one. They collide constantly on `users.username`,
`categories.name`, `units.code` and `products.sku`, because those are what a person types and two
shops type the same words. `OPS-104` blind to those reports "no collisions" and the import then
fails on a constraint halfway through — the rule not working, wearing the clothes of a database
error. `dataRepository.uniqueKeysOf` now reads the primary key **and** every non-partial UNIQUE
index out of SQLite itself.

**The checksum covers the entity files and not the manifest.** The manifest holds the checksum,
so a checksum over it is a fixed point nobody can compute; and it holds `exported_at`, which must
vary between two exports of the same data. Including that would make the checksum a clock rather
than a statement about the contents — and requirement 8's whole value is that a diff between two
archives means the **data** changed.

**A constraint error is turned into a sentence.** `OPS-008` runs with foreign keys enforced, so
SQLite refuses a bad row at the row, before the `foreign_key_check` sweep. That refusal is
correct and arrives as `SQLITE_CONSTRAINT_FOREIGNKEY`, which nobody can act on. Each of the three
kinds that actually reach a caller now names the table, the rule and its own remedy — they are
different problems and a shared message would help with none of them.

**The `backup_folder` setting is deliberately not carried over**, and `TC-E2E-20` asserts the
difference rather than the sameness so nobody later "fixes" it. A backup folder is a property of
the **machine**; an import that copied it would point the new PC's backups at a drive letter on
the old one, and the store would find out the day it needed a backup.

**`api.download` grew a method and a body, and `api.saveAs` was extracted.** Two screens were
already hand-rolling the same object-URL dance and a third would have made three; the revoke is
deferred a tick, because doing it synchronously races the browser's own read in some builds and
silently produces an empty file.

**What it did not do.** An import **adds to** a store rather than becoming it: there is no
"replace this store entirely" mode, and the way to get one is to import into a fresh
installation. `TC-E2E-20` therefore compares row by row rather than asserting two byte-identical
archives, which was the first version of that assertion and was wrong — the target keeps its own
setup owner, store profile and seeded settings, and it should.

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
