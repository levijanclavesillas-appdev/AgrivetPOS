# TASK-041 — Audit trail viewer

**Priority:** **P1** — a trail nobody can read deters nobody · **Blocks release:** yes ·
**Blocks:** the last of the screen gap · **Requirement:** `FR_1.5`, screen `SCR-703`,
rules `AUD-601`–`AUD-606`, `SEC-1`, `TX-429`, `TX-426`

---

## Objective

Let the owner read the trail — who changed what, when, and what it was before.

## Context

The last of the six screens the v1.0 backlog never assigned. `AUD-601` writes a row for every
price change, cost change, discount rule change, credit limit change, inventory adjustment,
stock count posting, sale void, return, receipt reprint, user create/modify/deactivate, role
change, permission change, tax mode change, settings change, data import, data export, backup
restore, password reset and login failure beyond the threshold. The trail is complete, it is
append-only by construction (`AUD-605` — there is no update or delete path anywhere), and the
owner it exists for cannot read a line of it.

That is not a cosmetic gap. **A trail nobody can read deters nobody.** The reason `TX-412`
hides cost, `AUD-603` records two actors on an override and `POS-511` freezes a closed shift is
that somebody can look afterwards. Without this screen the deterrent is theoretical and the
answer to "who dropped this price" is a support call.

`routes/audit.js` was written for this screen in `TASK-005`: it already serves the row list,
the total, and the **action and actor lists the two dropdowns are built from** — so the screen
does not hard-code an action list that would drift from `ACTIONS` the first time one is added.
This is a renderer task.

## Requirements

1. `SCR-703`: the trail newest first — when, who, what, which entity, and the reason.
2. Filters: **actor, action, entity type, and a date range** (`04_UX_SPEC.md` §3). The actor and
   action dropdowns are built from what the endpoint returns, never from a list held here.
3. A row expands to show **before and after**. `AUD-606`'s whole point is that a change is
   legible afterwards, and a row that shows only "price changed" answers nothing.
4. `AUD-603`: where a row carries an approver, both actors are shown — who asked and who
   allowed. An override that names one person is an override nobody authorised.
5. **Nothing is editable.** `AUD-605` gives the trail no application path that changes it; the
   screen offers no control that implies one, and says so where somebody would look.
6. Export to CSV under `TX-429` — not `TX-426`, because exporting the trail is reading the
   trail. The export is itself audited (`AUD-601`), and the screen says so: a copy of who-did-
   what leaving the machine is exactly the event somebody would later want to find.
7. `SEC-1`: no hash, password or PIN appears — the service redacts before the row is stored, and
   the screen renders what it is given without reconstructing anything.
8. Paging, because the trail is the largest table in the store and a screen that loads all of it
   is a screen that stops opening after a month.
9. Five states, plain-language refusals, touch targets ≥ 44 px (`NFR_4.3`).

## Business Rules

- `AUD-601` — what is written, without exception.
- `AUD-602` — the till variance and its reason.
- `AUD-603` — requester and approver as distinct actors.
- `AUD-605` — append-only: no update, no delete, no application path to either.
- `AUD-606` — a change is legible afterwards: before and after, both readable.
- `SEC-1` — no secret in the trail, and none on the screen.
- `TX-429` — who may read it, and therefore who may export it.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `public/js/admin/audit.js`, `public/css` additions, wiring in `public/js/shell/app.js` |
| Schema | None. |
| API | Consumes `GET /audit`, `GET /audit/export`. **No new endpoint.** `05_TECH_SPEC.md` §4 is missing the `/audit/export` row — `routes/audit.js` says so in its own comment; add it |
| Constraints | No build step, no framework · the screen holds no action list, no actor list and no permission logic · nothing on it writes |

## Acceptance Criteria

- [x] The trail renders newest first, with actor, action, entity and reason
- [x] Filtering by actor, action, entity and date range narrows it, and the dropdowns come
      from the server
- [x] A row expands to before and after, and both are readable
- [x] An override row shows both actors
- [x] No control on the screen writes anything
- [x] The export downloads, matches the filters, and is itself audited
- [x] A manager and a cashier are refused the screen server-side
- [x] No secret appears anywhere in the trail or on the screen

## Tests

| Case | Asserts | |
| :--- | :--- | :--- |
| `TC-UI-09` | The viewer holds no action list and writes nothing | new |
| `TC-INT-06` – `TC-INT-08` | The trail's own rules | **already exist** (`TASK-005`) |
| `TC-E2E-15` | A day's work is legible afterwards: a price change, an override, a settings change and a reprint are all findable by actor, by action and by date, with before and after | new |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
