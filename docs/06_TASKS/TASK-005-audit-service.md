# TASK-005 — Audit service and trail

**Priority:** **P1** · **Blocks release:** yes · **Blocks:** every authorised mutation ·
**Requirement:** `FR_1.5`, rules `AUD-601`–`AUD-606`, `SEC-11`

---

## Objective

Provide the single audit-writing service every other task calls, with the two-actor shape that
authorisation overrides require, so that no later task invents its own logging.

## Context

`AUD-603` is the rule that shapes this service: an override records the **requesting user and the
approving user as distinct actors**. A single `user_id` column would make every override in the
product unattributable, and retrofitting a second actor after ten tasks have written rows is a
migration plus a backfill that cannot be done honestly. Build it with both from the start.

`AUD-606` denormalises the username onto the row so that deactivating a user does not blank the
history.

## Requirements

1. `audit.write({ action, entityType, entityId, before, after, reason, actor, approver, shiftId })`,
   writing one row, inside the caller's transaction when there is one.
2. Every action in `AUD-601` is written. The service exposes named constants for them so a typo
   cannot create a silent second action name.
3. Before and after values are JSON, with hashes, tokens and PINs **stripped by the service
   itself**, not by each caller (`SEC-1`).
4. No `UPDATE` or `DELETE` path exists on `audit_logs` in any repository (`AUD-605`, `SEC-11`).
5. A browse endpoint filtering by actor, action, entity type, entity ID and date range, under
   `TX-429`, paginated, exportable to CSV.
6. Data import appends its own audit row and never replaces the trail (`AUD-605`).

## Business Rules

- `AUD-601` — the complete list of audited actions.
- `AUD-602` — shift variance beyond tolerance.
- `AUD-603` — the two-actor override shape.
- `AUD-605` — append-only, never deleted.
- `AUD-606` — the row's fields, including the denormalised username.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/auditService.js`, `src/repositories/auditRepository.js`, `src/routes/audit.js` |
| Schema | `audit_logs` (in `001_foundation.sql`) |
| API | `GET /audit`, `GET /audit/export` |
| Constraints | Writes join the caller's transaction; an audit write must never be the reason a business transaction fails to roll back cleanly |

## Acceptance Criteria

- [x] A price change writes exactly one row carrying both values
- [x] An override writes requester and approver as distinct actors
- [x] A hash or token placed in a `before`/`after` payload is stripped by the service
- [x] No repository method updates or deletes an audit row
- [x] Deactivating a user leaves their historical rows fully attributed
- [x] Browse filters work and are refused without `TX-429`
- [x] An audit write inside a rolled-back business transaction rolls back with it

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-UT-05` | One row, both values |
| `TC-INT-41` | Two distinct actors on an override |
| `TC-API-01` | `TX-429` enforced on browse |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
