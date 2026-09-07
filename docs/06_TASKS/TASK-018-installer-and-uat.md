# TASK-018 — Windows installer, first-run migration and UAT on store hardware

**Priority:** **P1** — the release gate itself · **Blocks release:** yes ·
**Blocks:** go-live · **Requirement:** `NFR_1.4`, `NFR_4.1`, `NFR_5.1`, `05_TECH_SPEC.md` §7,
`07_TEST_PLAN.md` §8 and §10, rules `TAX-001`, `TAX-006`, `OPS-004`

---

## Before starting — 2 answers are needed

**1. Is the store BIR VAT-registered, non-VAT, or unregistered today?** (`01_PRODUCT_BRIEF.md`
`Q-1`.) `tax_mode` is chosen in the setup wizard at install (`TAX-001`, `SCR-001`) and it changes
what the receipt prints and what every report header states. It is not a build blocker — all three
modes are built — but installation cannot proceed without it, and changing it after the store has
traded means `TX-425`, an audit row, and reports that straddle two modes.

**2. What format is the client's product list, and how many SKUs?** (`Q-4`.) If manual entry of
the catalogue is impractical, `TASK-026` — the CSV opening-data load — is pulled into v1.0 and
this task waits for it (`06_TASKS/README.md`). That is the one planned exception to the release
ordering, and it is decided **before** the installer ships, not on cutover day. Opening stock must
post as `OPENING` movements carrying opening unit cost (`OPS-106`) and opening credit balances as
credit transactions dated at cutover (`OPS-107`), whichever way the data arrives — hand entry
included.

## Objective

Turn the built application into a signed `.exe` a non-technical owner can install, and then prove
on the store's own scanner, printer, drawer and PC that the eleven v1.0 gate criteria actually
hold.

## Context

This is the eleventh gate criterion and the only one that **cannot be automated**
(`06_TASKS/README.md`). Everything before it is assertable by `npm run test:all`; this is a person
in a store, with the store's hardware, on the store's mains power.

`NFR_5.1` forbids forced auto-update, and the reason is operational, not ideological: a store PC
that self-updates mid-shift is an outage at the counter with a queue in front of it. Delivery is a
signed installer by hand or USB.

The upgrade path is where small-product installers usually lose data. The installer preserves the
database, runs pending migrations on first launch, and **takes a pre-migration backup
automatically** (`05_TECH_SPEC.md` §7) — migrations are forward-only and never edited once applied
(§8.9), so the backup is the only way back.

## Requirements

1. `electron-builder` NSIS configuration: `oneClick: false`, selectable install directory, desktop
   and start-menu shortcuts, `requestedExecutionLevel: asInvoker` — **the app never requires
   administrator rights**.
2. `npm run build:exe` produces `dist/ChachiAgrivetPOS-Setup-<version>.exe`, code-signed, with the
   version stamped in the binary, in `GET /health`, and on `SCR-101`.
3. A clean install on a machine matching `NFR_4.1` (Windows 10/11 x64, 4 GB RAM, dual core,
   1366×768) creates `%LOCALAPPDATA%\ChachiAgrivetPOS\` per `05_TECH_SPEC.md` §7 and launches into
   `SCR-001`.
4. **Upgrade path, tested from a real prior install**: the database is preserved, pending
   migrations run on first launch, a pre-migration backup is written and verified first
   (`TASK-017`), and a migration failure leaves the old database intact and says so.
5. A database at a schema version **ahead of** the binary refuses to start with a plain message
   (`TASK-001`) — verified through the installer, not just in tests.
6. Uninstall removes the application and **never** the database or the backup folder, and says so
   on the uninstall screen.
7. Cold start to login ≤ 8 s on the reference machine (`NFR_1.4`, `TC-PERF-04`).
8. `TC-E2E-08` passes on the installed build **with networking disabled on the machine** — not
   mocked, not stubbed (`NFR_3.1`).
9. The `07_TEST_PLAN.md` §8 UAT script, all ten checks, executed on the store's own hardware with
   both the 58 mm and 80 mm receipt layouts checked against the real printer, and the owner's
   signature recorded.
10. `TAX-006` confirmed on the **physically printed** document — read on paper, in the tax mode the
    store will actually run (gate criterion 11).
11. Zero open S1 or S2 defects at sign-off (`07_TEST_PLAN.md` §9). Any defect touching `MON-*`,
    `INV-101`, `CR-103` or `POS-509` is S1 by definition regardless of how small it looks.
12. `07_TEST_PLAN.md` §10 updated with the real outcome per criterion — dated, and stating what was
    **not** met where anything was not met. A gate table of eleven ticks that nobody checked is
    worse than an honest one with a gap.
13. Handover to the owner covers, in writing: the recovery code and where it is kept (`SEC-5`), the
    restore procedure and its typed confirmation (`OPS-004`), and the **weekly off-machine copy of
    the backup folder — stated plainly as a process control the owner performs, not something the
    software does** (`05_TECH_SPEC.md` §7). Backups on the same machine are not a backup.

## Business Rules

- `TAX-001` — the tax mode set at install, from `Q-1`.
- `TAX-006` — the not-an-official-receipt wording, confirmed on paper.
- `OPS-004` — the restore procedure the owner is walked through.
- `OPS-106`, `OPS-107` — how opening stock and opening balances must be posted at cutover.
- `SEC-5` — the recovery code, shown once, and where the owner keeps it.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `package.json` build block, `build/installer.nsh`, `build/icon.ico`, `main.js` first-run migration path, `docs/HANDOVER.md` |
| Schema | None. This task runs migrations; it does not add one. |
| API | `GET /health` reports the binary version alongside the schema version (`OPS-006`) |
| Constraints | `asInvoker` — no administrator rights, ever · no forced auto-update (`NFR_5.1`) · no network dependency at install or at run (`NFR_3.1`) · the installer never touches the backup folder |

## Acceptance Criteria

- [ ] `npm run build:exe` produces a signed `ChachiAgrivetPOS-Setup-<version>.exe`
- [ ] A clean install on the reference machine reaches `SCR-001` without administrator rights
- [ ] An upgrade over a prior install preserves the data, backs up first, and migrates on launch
- [ ] A failed migration leaves the previous database intact and reports it plainly
- [ ] Uninstall leaves `agrivet.db` and the backup folder untouched
- [ ] Cold start to login ≤ 8 s on the reference machine
- [ ] `TC-E2E-08` passes on the installed build with the machine's networking disabled
- [ ] All ten `07_TEST_PLAN.md` §8 UAT checks pass on the store's hardware, owner signed
- [ ] "This is not an official receipt" read on a physically printed document
- [ ] Zero open S1 or S2 defects
- [ ] `07_TEST_PLAN.md` §10 updated with the dated, per-criterion outcome
- [ ] `docs/HANDOVER.md` exists and covers recovery code, restore, and the off-machine copy

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-E2E-00` | Fresh install → setup wizard → owner created → first login |
| `TC-E2E-08` | A full trading day and close, on the installed build, networking disabled |
| `TC-E2E-09` | Power-loss durability on the installed build |
| `TC-PERF-04` | Cold start to login ≤ 8 s on the reference machine |
| `TC-INST-01` | Upgrade over a prior install preserves data, pre-backs up, and migrates |
| `TC-INST-02` | A database ahead of the binary refuses to start through the installed app |
| `07_TEST_PLAN.md` §8 | The ten manual UAT checks, on the store's hardware, owner signed |

> `TC-INST-01`, `TC-INST-02` and `TC-PERF-04` are in `07_TEST_PLAN.md` §6. All three run against
> the **installed** build on the reference machine, not against the working tree.

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
