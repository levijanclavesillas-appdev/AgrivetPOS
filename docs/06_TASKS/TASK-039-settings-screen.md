# TASK-039 — Settings screen

**Priority:** **P1** — the printer, the receipt width and the backup folder are all settings ·
**Blocks release:** yes · **Blocks:** `DEPLOYMENT.md` §4, `TASK-018` UAT checks 2, 3 and 8 ·
**Requirement:** `FR_1.1`, screen `SCR-702`, rules `OPS-005`, `OPS-001`, `TAX-001`, `INT-1`,
`TX-424`, `TX-425`, `AUD-601`

---

## Objective

Let the owner change the figures the store runs on — and let the installer set the printer, the
receipt width and the backup folder without an HTTP client.

## Context

The fifth of the six screens the v1.0 backlog never assigned, and the one the *installer* hits
first. `DEPLOYMENT.md` §4 tells them to set `printer_transport`, `receipt_width_columns` and the
backup folder before they leave; there is no screen, so today the only route is `PUT /settings`
from a terminal on a shop counter.

`OPS-005` is the rule this screen exists to serve: **every operator-owned figure lives in the
settings registry, not in code.** Twenty-nine of them do — `TC-UT-06` has caught four attempts
to leave one in a service during this project — and until now none could be changed by the
person who owns them.

`settingsService.describe()` already returns everything the screen needs per key: the value, its
type, its group, its rule id, what it does, its default, its bounds or enumeration, whether it is
owner-only, and who last changed it. This is a renderer task.

**The screen must not hold a second copy of the registry.** Every field is built from what
`describe()` returned — the label, the bounds, the enumeration, the rule id — so a setting added
to `settingsService` appears here with no edit, and one whose bounds change cannot be validated
here against the old ones. A screen that knew the registry independently would be the second
place `OPS-005` says must not exist.

## Requirements

1. `SCR-702`: one section per `OPS-005` group, in the registry's own order, with the group's
   label from the server (`GROUPS`).
2. Every field is rendered from its declaration: `INT` with its `min`/`max`, `BOOL` as a tick,
   `STRING` free or as a select when `one_of` is present, `JSON` as an editable list of lines.
   **No field is described by anything this file knows independently.**
3. Every field carries its **rule id**, visible rather than in a tooltip only — a cashier reading
   "POS-510" to an owner over the phone is the fastest support call this product will have, and
   the same is true of an owner reading it to their supplier.
4. Each field says what it does (`what`), its default, and whether it is still at that default —
   a store that has never changed a figure should be able to see that at a glance.
5. Owner-only settings (`ownerOnly`) are marked. `TX-424` is `LIMITED` for a manager, and the
   server refuses the write (`assertMayChange`); the screen shows the refusal rather than
   pre-empting it, because the matrix is the server's.
6. Save is per section, in one request, and states what changed. `settingsService.setMany` owns
   the transaction (`§8.3`), and every change is audited with both values (`AUD-601`).
7. A value outside its bounds or outside its enumeration is refused by the server and the
   message names the rule; the screen surfaces it against the field rather than as a bare toast.
8. **The store profile and the tax mode** are on this screen too: name, address, contact, TIN,
   and `TAX-001`'s mode behind `TX-425` with the warning that changing it after trading leaves
   reports straddling two modes.
9. **A print test button** (`INT-1`). The installer's first need is to know the printer works,
   and the endpoint exists (`POST /print/test`); without a button it is unreachable. The result
   says whether the document was delivered or queued.
10. The backup folder is a `STRING` and there is no folder picker in a browser. The field says
    what a good answer looks like and the server refuses one inside the application's own data
    directory (`OPS-001`) — the refusal is surfaced, not pre-empted.
11. Five states, plain-language refusals, touch targets ≥ 44 px (`NFR_4.3`).

## Business Rules

- `OPS-005` — the registry is the only home for an operator-owned figure.
- `OPS-001` — the backup folder defaults outside the application data directory.
- `TAX-001` — the tax mode, owner-only, audited with both values.
- `INT-1` — the printer transport and the receipt width.
- `TX-424`, `TX-425` — who may change a setting, and who may change the tax mode.
- `AUD-601` — every settings change is audited with before and after.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `public/js/admin/settings.js`, `public/css` additions, wiring in `public/js/shell/app.js` |
| Schema | None. |
| API | Consumes `GET /settings`, `PUT /settings`, `GET /store-profile`, `PUT /store-profile`, `PUT /store-profile/tax-mode`, `POST /print/test`. **No new endpoint.** |
| Constraints | No build step, no framework · **no second copy of the registry in the renderer** · the screen validates nothing the server validates |

## Acceptance Criteria

- [ ] Every registered setting appears, grouped, with its rule id and what it does
- [ ] A new setting added to `settingsService` appears on the screen with no change to it
- [ ] An `INT` outside its bounds is refused and the message names the rule
- [ ] A `STRING` with `one_of` renders as a select and cannot be given another value
- [ ] A manager is refused an owner-only setting by the server, and the screen shows why
- [ ] The printer transport, the receipt width and the backup folder can all be set here
- [ ] The print test button prints, or says it queued
- [ ] The tax mode can be changed by an owner, with the consequence stated first
- [ ] A settings change is audited with both values

## Tests

| Case | Asserts | |
| :--- | :--- | :--- |
| `TC-UI-07` | The screen holds no copy of the registry — every field is built from `describe()` | new |
| `TC-UT-06` | No service declares an operator-owned figure of its own | **already exists** (`TASK-004`) |
| `TC-E2E-13` | An installer configures a store from the screen: printer, width, test print, backup folder, a bounded figure refused, tax mode changed | new |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
