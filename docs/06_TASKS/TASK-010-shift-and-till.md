# TASK-010 — Cashier shift, till cash in/out and expected cash

**Priority:** **P1** · **Blocks release:** yes · **Blocks:** `TASK-011`, `TASK-013` ·
**Requirement:** `FR_5.1`, `FR_5.2`, rules `POS-501`–`POS-509`

---

## Objective

Make the shift the container every money movement belongs to, so that at close there is one
expected figure per payment method to check the drawer against.

## Context

`POS-501` — "no shift, no money" — is the rule that makes the closing report possible at all. A
sale with no shift cannot be attributed to a drawer, and a store that discovers this after a month
of trading has a month of unattributable cash.

`legacy/PRD_v1.1.md` §62 never said whether a shift belongs to a user or a terminal, or what
happens when the app dies mid-shift. Both are settled here: the shift belongs to the **user**
(`POS-502`), and a shift left open past the configured maximum raises an alert rather than being
auto-closed, because auto-closing invents a count nobody made (`POS-508`).

## Requirements

1. Open a shift with a counted, confirmed opening float (`POS-503`); one open shift per user, and
   a second open attempt resumes the existing one (`POS-502`).
2. A guard used by sales and collections refusing the action when the acting user has no open
   shift (`POS-501`).
3. Till cash in/out requiring amount, a reason from the configured list, and the actor
   (`POS-504`); cash out may not exceed expected cash currently in the drawer (`POS-505`).
4. A till movement touches nothing but the drawer — no inventory, no revenue, no customer ledger
   (`POS-506`).
5. `computeExpected(shiftId)` implementing `POS-509` exactly: `opening float + cash sales + cash
   collections + cash in − cash out − cash refunds`, plus per-method totals for non-cash.
6. The drawer is pulsed on any till movement (`POS-507`) — the printer integration itself is
   `TASK-014`; this task calls the interface.
7. A shift open past the configured maximum raises an alert (`POS-508`, `OPS-007`).

## Business Rules

- `POS-501`, `POS-502`, `POS-503` — the shift's existence and ownership.
- `POS-504`, `POS-505`, `POS-506` — till movements.
- `POS-507` — drawer pulse.
- `POS-508` — the long-open shift alert.
- `POS-509` — the expected-cash arithmetic. This is the rule the closing report rests on.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/shiftService.js`, `src/repositories/shiftRepository.js`, `src/routes/shifts.js` |
| Schema | `005_shifts.sql` — `cashier_shifts`, `till_movements`, `cashier_closings`, `closing_method_lines` |
| API | `POST /shifts/open`, `POST /shifts/:id/till`, `GET /shifts/:id/expected` |
| Constraints | `computeExpected` is a pure read; it never writes, so it can be called freely by the UI |

## Acceptance Criteria

- [x] A sale and a collection are both refused with no open shift, with a clear prompt
- [x] A second open attempt resumes the existing shift rather than creating a second
- [x] Opening float is required and confirmed
- [x] A till movement without a listed reason is rejected
- [x] Cash out exceeding drawer cash is refused
- [x] A till movement writes no inventory movement and no credit transaction
- [x] `computeExpected` matches a hand-computed scripted shift, to the centavo
- [x] A shift open past the maximum raises an alert
- [x] The drawer interface is called on every till movement

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-INT-50` | No shift, no money |
| `TC-INT-51` | Expected-cash arithmetic |
| `TC-INT-54` | Cash out ceiling |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
