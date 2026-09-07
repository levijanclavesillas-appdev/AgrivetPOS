# TASK-003 — Authentication, RBAC, session, PIN, lockout and offline recovery

**Priority:** **P1** · **Blocks release:** yes · **Blocks:** every authorised route ·
**Requirement:** `FR_1.2`, `FR_1.3`, `FR_1.4`, rules `TX-401`–`TX-430`, `SEC-1`–`SEC-3`, `SEC-5`–`SEC-7`

---

## Objective

Implement local authentication, the server-side permission check every route depends on, the
cashier PIN, lockout, and the offline owner-recovery path — the one credential problem an
offline product cannot solve with an email.

## Context

The product is standalone and not federated with Chachi Central; the boundary and why local
passwords are **not** an `AC-1` violation are written in `01_PRODUCT_BRIEF.md` §8. Read that
before implementing, because a reviewer who has not will flag this task.

An offline app has no password-reset email. If the owner forgets their password there is no
recovery path at all unless one is built at setup — which is why `SEC-5` exists and why the code
is issued in `TASK-004`'s wizard rather than on demand.

## Requirements

1. Login by username and password, bcrypt cost ≥ 12, returning a JWT held in renderer memory
   only (`SEC-7`).
2. Idle timeout from settings, default 15 minutes, returning to the lock screen with the
   in-progress cart preserved (`POS-105`).
3. Failed-attempt counting **in the database**, locking the account for 15 minutes after 5
   failures; the lock survives an application restart (`SEC-3`).
4. A `requirePermission(TX_ID)` middleware checking the `TX-*` matrix server-side on every route,
   refusing with 403 and an audit row (`SEC-6`).
5. Cashier PIN unlock: 6 digits, bcrypt-hashed, permitted only while the user has an open shift,
   granting POS and collections only (`SEC-2`).
6. Owner recovery: single-use bcrypt-hashed code, consuming it resets the password, issues a
   replacement, and writes `AUD-604` **before** the reset commits. Rate-limited as `SEC-3`.
7. The last active `OWNER` cannot be deactivated or demoted (`VR-503`).

## Business Rules

- `TX-401`–`TX-430` — the permission matrix; the middleware is its only implementation.
- `VR-501`, `VR-502` — username and password/PIN validation.
- `VR-503` — last owner protection.
- `SEC-1`, `SEC-2`, `SEC-3`, `SEC-5`, `SEC-6`, `SEC-7`.
- `AUD-601`, `AUD-604` — user changes and recovery are audited.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/routes/auth.js`, `src/routes/users.js`, `src/services/authService.js`, `src/middleware/auth.js`, `src/repositories/userRepository.js` |
| Schema | `users` (already in `001_foundation.sql`) |
| API | `POST /auth/login`, `POST /auth/pin-unlock`, `POST /auth/recover`, `GET POST PUT /users` |
| Constraints | No endpoint returns `password_hash`, `pin_hash` or `recovery_code_hash` in any response or export |

## Acceptance Criteria

- [ ] Wrong password is rejected without disclosing which field was wrong
- [ ] 5 failures lock the account 15 minutes, and the lock survives a restart
- [ ] Idle past the timeout locks the screen and preserves the cart
- [ ] PIN unlock reaches POS and collections; refused on settings, users and cost fields
- [ ] Every route refuses an actor lacking its `TX-*` with 403, and the refusal is audited
- [ ] Recovery code works exactly once, is replaced, and audits before the reset
- [ ] The last active owner cannot be deactivated or demoted
- [ ] No response body anywhere contains a hash

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-UT-01` | bcrypt verify; hash never returned |
| `TC-INT-02` | Lockout, and its survival across a restart |
| `TC-INT-03` | PIN scope boundary |
| `TC-INT-04` | Recovery: single use, replacement, audit ordering |
| `TC-API-01` | Every route's permission refusal |
| `TC-API-02` | No hash in any response |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
