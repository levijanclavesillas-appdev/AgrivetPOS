# TASK-035 — Evaluate SQLCipher encryption against POS latency

**Priority:** **P3** for v1.2 — a decision, not a feature, and the wrong answer is expensive ·
**Blocks release:** no · **Depends on:** the store visit (`docs/UAT_RECORD.md`) ·
**Requirement:** `SEC-9`, `NFR_1.1`–`NFR_1.5`, `NFR_2.1`, rules `OPS-001`–`OPS-004`

---

## Before starting — 1 thing is needed, and it is not an answer

**The reference machine.** `SEC-9` gates this on *measured* POS latency, and
`07_TEST_PLAN.md` §6 says in as many words that a figure from a build machine is not a
measurement. Every performance number in `§10` currently carries "not measured" beside it for
that reason: `TC-PERF-01` reads a median of 20 ms against a 2 s budget, which sounds like room
for anything and is evidence of nothing, because the shop PC is not this machine. **This task
cannot be completed before `TASK-018`'s UAT visit and should not be started before it** — a
recommendation derived from build-machine numbers would be a guess wearing a table.

## Objective

Decide whether the store's database is encrypted at rest, on evidence, and record the decision
and its reasoning where the next person will find it.

## Context

**This task's deliverable is a written decision, not a shipped feature.** It may conclude "no",
and a well-argued "no" closes it. `SEC-9` says: backups are written to a configured folder with
OS permissions, the operator is told plainly on `SCR-704` that a backup on a shared drive is
readable by anyone with the drive, and full database encryption "as in ChachiLoan" is a v1.2
option gated on measured latency. The gate is the whole point — encryption that makes a sale take
three seconds fails `NFR_1.1` and would be removed again by the first cashier who noticed.

**What is actually being protected against needs stating before anything is measured, because it
decides the answer.** SQLCipher protects a database file read *elsewhere* — a stolen shop PC, a
copied disk, a backup `.zip` carried off on a USB stick. It does not protect the running store:
the key must be available to the application on a machine that boots unattended behind a counter,
so a key stored on the same PC defends against the disk leaving and not against somebody sitting
at it. If the store's real exposure is the second, encryption answers the wrong question and the
honest recommendation is the `SCR-704` warning and OS permissions, which is what ships today.

**The backup is where this bites hardest.** `OPS-001`–`OPS-004` back up on shift close, verify by
reopening the copy, and `restoreService` reads one back. An encrypted database changes what a
backup *is*: a verified `.zip` whose contents nobody can open without a key that lives on the
machine that just died is not a backup. Any recommendation to encrypt has to say where the key
lives, who else has it, and what the owner does when the PC does not start — and if the answer to
the last one is not written on paper in `HANDOVER.md`, encryption has made the store less safe,
not more.

**The dependency cost is real and belongs in the recommendation.** The application has four
runtime dependencies and no build step, which is why `TASK-018`'s installer works and why the
thing can be reasoned about at all. SQLCipher means swapping `better-sqlite3` for a build linked
against it — a native module compiled per platform, inside an Electron packaging step that
currently just copies JavaScript.

## Requirements

1. State the threat model first, in one paragraph, and get the store's answer to *what are we
   afraid of* — a stolen PC, a copied backup, a curious employee — before measuring anything.
2. Measure `TC-PERF-01`–`TC-PERF-05` **on the reference machine, encrypted and plain**, on the
   same seeded database (`TC-PERF-06`: 5,000 products, 2,000 customers, 60,000 sales).
3. Measure the operations encryption hits hardest and that the budgets do not cover: application
   start, backup, backup verification, restore, and the reports from `TASK-033`.
4. Establish the key story concretely: where the key is derived from or stored, who can read it,
   what happens on a fresh install against an existing database, and what the owner does when the
   PC will not boot. A recommendation without this is not a recommendation.
5. Cost the packaging change: the native build per platform, `TASK-018`'s installer, and the
   upgrade path for a store already running an unencrypted database (`upgradeService`).
6. Establish the migration: an existing store's database is not encrypted, so adopting this is a
   one-way rekey with a backup taken first and a verified way back.
7. **Recommend, with the numbers in the document.** Yes, no, or yes-conditionally, with the
   condition named.
8. Record the decision in `05_TECH_SPEC.md` at `SEC-9` and in `docs/legacy/README.md`'s
   contradiction table if it changes a shipped position — in place, the way a withdrawn rule is
   marked withdrawn in place.
9. If the answer is no, `SEC-9` is rewritten to say so and why, so that this is not re-opened
   from scratch in v1.3.

## Business Rules

- `SEC-9` — the gate, and what ships in its place today.
- `OPS-001`–`OPS-004` — backup on close, verification, retention, restore, all of which change
  meaning under encryption.
- `NFR_1.1`–`NFR_1.5` — the budgets that are the gate.
- `NFR_2.1` — the scale the measurement runs at.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/tests/perf/*`, `tools/` for the harness; `docs/05_TECH_SPEC.md` `SEC-9` for the outcome. Application code changes **only if the recommendation is yes** |
| Schema | None. Encryption is whole-file, not per-column |
| API | None |
| Constraints | Measured on the reference machine, not a build machine · encrypted and plain on the same seeded data · the harness lives beside `TC-PERF-06`'s seeder and reuses it |

## Acceptance Criteria

- [ ] The threat model is written down and the store has agreed with it
- [ ] Every `TC-PERF` budget measured both ways on the reference machine, in one table
- [ ] Start, backup, verify and restore measured both ways
- [ ] The key story answers where it lives, who has it, and what happens when the PC dies
- [ ] The packaging and upgrade cost is costed, not estimated in adjectives
- [ ] A recommendation is made, with the numbers beside it
- [ ] `SEC-9` is updated to the decision either way, and says why

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-PERF-08` | Encrypted versus plain across `TC-PERF-01`–`TC-PERF-05` at `TC-PERF-06`'s scale, on the reference machine |
| `TC-PERF-09` | Backup, verification and restore, encrypted versus plain |
| — | No functional cases unless the recommendation is yes, in which case they are written with the change and this file gains them |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
