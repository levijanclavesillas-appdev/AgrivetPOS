# TASK-038 — Shift screens

**Priority:** **P1** — a till that cannot be counted · **Blocks release:** yes ·
**Blocks:** `TASK-018` UAT check 6, go-live · **Requirement:** `FR_5.1`–`FR_5.4`, screens
`SCR-501`–`SCR-503`, `NFR_4.3`, rules `POS-501`–`POS-511`, `OPS-001`, `AUD-602`, `TX-418`,
`TX-419`, `TX-420`

---

## Objective

Let a cashier open a drawer, move cash in and out of it, and **close it against a count** —
from a screen.

## Context

This is the sharpest of the six screens the v1.0 backlog never assigned. Shift *open* exists,
buried in the POS screen's empty state as a two-field form; there is **no close screen at all**.

A shift that can be opened and not closed is a till that cannot be counted, and the close is
where most of `FR_5` happens: `POS-509`'s expected cash, `POS-510`'s per-method variance and
its required reason, `POS-511`'s immutability, `AUD-602`'s audit row, and `OPS-001`'s automatic
backup. None of it can be reached today without an HTTP client.

Every service and route exists and is tested (`TASK-010`, `TASK-013`). This is a renderer task.

**The one thing this screen must never do is make the drawer balance.** `POS-510` forbids a
silent forced balance, and the temptation is strongest exactly here — a cashier ₱200 short at
seven in the evening wants the number to go away. The screen shows expected and counted side by
side, computes the variance, and requires a reason beyond tolerance. It never pre-fills the
count with the expected figure, because a pre-filled count is a count nobody made.

## Requirements

1. `SCR-501` open: opening float, counted and confirmed (`POS-503`). The confirmation is a
   deliberate tick, and the server refuses without it — the screen does not pretend otherwise.
   A resumed shift (`POS-502`) says it resumed rather than looking like a fresh open.
2. `SCR-501` also shows the open drawer: opening float, cash sales, collections, cash in and
   out, change given, and the running expected cash — the terms of `POS-509`, so the arithmetic
   is checkable rather than a single number to be believed.
3. `SCR-502` till cash: direction, amount, a reason from the configured list (`POS-504`), notes,
   and the expected figure updating after each movement (`POS-505`). A withdrawal that would
   take the drawer below zero is refused with the figure quoted.
4. `SCR-503` close: expected against counted **per method, side by side**, with the variance
   per row coloured (`POS-510`). `CASH`, `GCASH` and `QRPH` are counted; `CREDIT` is shown with
   its figure and no variance, and the screen says why — a credit sale takes no money, so there
   is nothing to count against it.
5. The counted fields start **empty**, never pre-filled with the expected figure.
6. A variance beyond `cash_variance_tolerance_centavos` on any reconcilable row requires a
   reason before the close is accepted (`POS-510`), and the screen says which row and by how
   much before the cashier starts typing.
7. `POS-508`: a shift open past the maximum **and** closing with a variance needs owner
   authorisation. The inline authorisation panel appears — the same one the POS and adjustment
   screens use.
8. After closing: the summary on screen, and the outcome of the two things the close does on
   the cashier's behalf stated plainly — **whether the summary printed** (`FR_5.4`; the close
   prints it, and a failure queues it under `POS-208`) and **whether the backup ran and
   verified** (`OPS-001`, `OPS-002`). A close whose backup failed must say so on the screen
   that closed it, not only in the alert centre: the person who could still plug the drive back
   in before going home is standing there.
   > No reprint button. The close prints the summary and no endpoint reprints one, so a button
   > here would be a control that cannot work. If a shift-summary reprint is wanted, that is an
   > endpoint and belongs in its own task.
9. `POS-511`: a closed shift is immutable. The summary is a read; there is no edit path and no
   button that implies one.
10. `TX-419`: closing another user's shift is a different permission. A cashier closing their
    own drawer sees no mention of it; a manager closing somebody else's is told whose shift it
    is and that the count is not theirs.
11. Every view implements the five states, and a refusal renders the rule's plain-language text.
    Touch targets ≥ 44 px (`NFR_4.3`); the close is completable from the keyboard.
12. The POS screen's "open your shift" empty state links here instead of carrying its own form,
    so there is one open path rather than two that can drift.

## Business Rules

- `POS-501`, `POS-502`, `POS-503` — a sale needs an open shift; a second open resumes; the
  float is counted and confirmed.
- `POS-504`, `POS-505` — till movements carry a listed reason and change expected cash.
- `POS-508` — a shift open too long, closing with a variance, needs an owner.
- `POS-509` — what expected cash is made of.
- `POS-510` — per-method close, required reason beyond tolerance, never a forced balance.
- `POS-511` — a closed shift is immutable.
- `OPS-001`, `OPS-002` — the close triggers a verified backup, and the screen says so.
- `AUD-602` — the variance and its reason are audited.
- `TX-418`, `TX-419`, `TX-420` — own shift, another's shift, till cash.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `public/js/shift/open.js`, `till.js`, `close.js`, `summary.js`, `public/css/shift.css`, wiring in `public/js/shell/app.js` and `public/js/pos/view.js` |
| Schema | None. |
| API | Consumes `GET /shifts/current`, `GET /shifts/:id/expected`, `GET /shifts/:id/summary`, `GET /shifts/meta/till-reasons`, `POST /shifts/open`, `POST /shifts/:id/till`, `POST /shifts/:id/close`. **No new endpoint.** |
| Constraints | No build step, no framework (`05_TECH_SPEC.md` §2) · the client computes no figure that is banked — the variance on screen is for the reader, and the server recomputes every term at the close |

## Acceptance Criteria

- [ ] A cashier opens a shift, and a second attempt resumes it rather than opening another
- [ ] The open drawer shows every term of `POS-509`, and they add up to the expected figure
- [ ] Cash in and cash out move the expected figure, and a listed reason is required
- [ ] The close shows expected against counted per method, with `CREDIT` explained
- [ ] The counted fields are empty until somebody types in them
- [ ] A variance beyond tolerance cannot be closed without a reason, and the screen says which
      row and how much before the reason is typed
- [ ] A long shift closing with a variance opens the authorisation panel
- [ ] The summary prints, and the backup's outcome is on the screen that closed the shift
- [ ] A closed shift offers no edit
- [ ] A manager closing another user's shift is told whose it is

## Tests

| Case | Asserts | |
| :--- | :--- | :--- |
| `TC-UI-04` | The close screen never pre-fills a counted figure from the expected one | new |
| `TC-UI-05` | `CREDIT` is rendered as unreconcilable, with its reason, and carries no variance input | new |
| `TC-INT-50` – `TC-INT-53` | The shift rules themselves | **already exist** (`TASK-010`, `TASK-013`) |
| `TC-E2E-11` | A cashier's whole day from a screen: open → sell → cash out → close short → reason → summary → backup | new |

> The shift rules are covered by `TASK-010` and `TASK-013`; nothing is added to them. What is
> new is that a person can now reach them.

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
