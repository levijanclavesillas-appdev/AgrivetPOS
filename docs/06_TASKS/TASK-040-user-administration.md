# TASK-040 — User administration

**Priority:** **P1** — without it the store trades on the owner login · **Blocks release:** yes ·
**Blocks:** `DEPLOYMENT.md` §5, `TASK-018` UAT check 9 · **Requirement:** `FR_1.2`–`FR_1.4`,
screen `SCR-701`, rules `SEC-1`–`SEC-3`, `VR-501`–`VR-503`, `TX-412`, `TX-423`, `AUD-601`

---

## Objective

Let the owner create the store's cashiers, give them PINs, change a role, and reset a forgotten
password — from a screen.

## Context

The fourth of the six screens the v1.0 backlog never assigned, and the one whose absence is
worst in a way that is easy to miss: **without it the store trades on the owner login.** Every
audit row then carries the owner's name, `TX-412` puts cost prices in front of whoever is at
the counter, and `SCR-102`'s PIN unlock has nobody to unlock. The deployment manual's §5 tells
the installer to create the real cashiers before leaving, and there is no screen to do it on.

`userService` has done all of this since `TASK-003` — list, get, create, update, with `VR-503`'s
last-owner guard and `SEC-1`'s hash that never leaves the server. This is a renderer task.

## Before starting — 1 answer is needed

**Does an owner resetting a password also clear a lockout?** Today it does not. `SEC-3` locks an
account for fifteen minutes after five failed attempts, and the only paths that clear it are
waiting or the offline recovery code. So the sequence a store will actually hit — cashier
forgets password, tries five times, owner resets it, cashier still cannot log in — leaves the
owner standing at the counter having apparently fixed nothing.

`SEC-3` exists to stop somebody guessing at the login screen. An owner authenticated under
`TX-423` deliberately setting a new password is not that, and the lock has nothing left to
protect: the password it was guarding no longer exists. **Resolved: an admin password reset
clears `failed_attempts` and `locked_until_at`.** A lock that survives the reset teaches people
the reset is broken, which is worse for security than clearing it — they stop using it.

This is a change to `userService.update`, not only to the screen, and it is recorded here
because it is a security-adjacent decision rather than a rendering one.

## Requirements

1. `SCR-701` list: username, full name, role, PIN set or not, active or not, and **locked** with
   the minutes remaining (`SEC-3`). Inactive rows muted, locked rows marked.
2. Create: username, full name, role, password, and an optional 6-digit PIN (`VR-501`,
   `VR-502`). The rules for each are stated next to the field, not discovered on submit.
3. Edit: username, full name, role, active or not. `VR-503` — the last active owner cannot be
   demoted or deactivated, and the refusal explains why rather than greying the control out
   with no reason.
4. Reset password: sets a new password, and clears the lockout (see the decision above). The
   password is never displayed back and never reaches the trail (`SEC-1`); that it changed does.
5. Set or clear a PIN. A cashier without a PIN cannot use `SCR-102`, and the list says which of
   them have one, because that is the thing an owner is checking when they look.
6. Deactivate rather than delete. History references a user, and `AUD-606` requires their rows
   to stay attributed — the screen says so where somebody would look for a delete button.
7. `TX-423` is owner-only. The rail already hides Admin from everyone else and the route is
   refused server-side regardless (`SEC-6`); the screen assumes neither.
8. Every mutation is audited under its own action — `USER_CREATED`, `USER_MODIFIED`,
   `ROLE_CHANGED`, `USER_DEACTIVATED`, `PASSWORD_RESET` — which `userService` already does. The
   screen surfaces the refusals.
9. Five states, plain-language refusals, touch targets ≥ 44 px (`NFR_4.3`).

## Business Rules

- `SEC-1` — a hash never leaves the server, and never reaches the audit trail.
- `SEC-2` — a PIN unlocks a session; it is not an alternative login.
- `SEC-3` — five failures, fifteen minutes, and what clears it.
- `VR-501`, `VR-502` — full name, and the six-digit PIN.
- `VR-503` — there is always at least one active owner.
- `TX-412`, `TX-423` — cost is owner-only, and so is managing users.
- `AUD-601`, `AUD-606` — every user change is audited, and history stays attributed.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `public/js/admin/users.js`, `public/css/admin.css` additions, wiring in `public/js/shell/app.js`; `src/services/userService.js` for the lockout decision |
| Schema | None. |
| API | Consumes `GET /users`, `GET /users/:id`, `POST /users`, `PUT /users/:id`. **No new endpoint.** |
| Constraints | No build step, no framework · a password is never rendered back · the screen never decides who may do what — it renders the server's refusal |

## Acceptance Criteria

- [x] The owner creates a cashier with a PIN, and that cashier can sign in and use `SCR-102`
- [x] The last active owner cannot be demoted or deactivated, and the screen says why
- [x] A password reset clears a lockout, and the reset user can sign in immediately
- [x] A locked account shows the minutes remaining
- [x] No password or hash appears anywhere in the DOM or on the trail
- [x] Deactivation, not deletion, and past audit rows still name the user
- [x] A manager and a cashier are refused the screen server-side, not merely hidden from it

## Tests

| Case | Asserts | |
| :--- | :--- | :--- |
| `TC-UI-06` | No password or PIN value is ever rendered back into the DOM | new |
| `TC-INT-03` | The lockout, and what clears it | **extended** — the reset path is added |
| `TC-E2E-12` | The owner creates a cashier who then trades: sign in, PIN unlock, sell, and appear by name on the audit trail | new |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
