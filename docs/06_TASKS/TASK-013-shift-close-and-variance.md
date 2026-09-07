# TASK-013 — Shift close, per-method variance and the backup trigger

**Priority:** **P1** · **Blocks release:** yes · **Blocks:** `TASK-016` ·
**Requirement:** `FR_5.3`, `FR_5.4`, rules `POS-510`, `POS-511`, `AUD-602`, `OPS-001`

---

## Objective

Close a shift against a counted drawer, report the variance per payment method honestly, and take
the backup that makes the day recoverable.

## Context

This is the screen that tells the owner whether the day was right, and the one place where the
temptation to "make it balance" is strongest. `POS-510` therefore forbids a silent forced balance:
a variance beyond tolerance **requires a reason**, and the reason is audited (`AUD-602`).

`POS-511` makes a closed shift immutable. `legacy/PRD_v1.1.md` never said this, which would have
left the door open to back-dating a correction into a closed day — the single most common way a
POS's history stops being evidence.

## Requirements

1. `POST /shifts/:id/close` computing expected per method from `TASK-010`'s `computeExpected`, and
   capturing actual counted cash plus actual non-cash totals per method.
2. A `closing_method_lines` row per method with expected, actual and variance.
3. A variance beyond the configured tolerance **requires a reason**; closing without one is
   refused, and the close writes `AUD-602` (`POS-510`).
4. Closing a shift other than one's own requires `TX-419`.
5. The closed shift is immutable: no endpoint updates a closed shift, its sales, its till movements
   or its closing (`POS-511`).
6. A successful close triggers a backup (`OPS-001`) and the response says whether it was written
   and verified — the UI states it (`04_UX_SPEC.md` `SCR-503`).
7. A printable closing summary, subject to `TAX-006`.
8. A shift open past the configured maximum requires owner authorisation to close with a variance
   (`POS-508`).

## Business Rules

- `POS-509` — the expected figures being closed against.
- `POS-510` — actual capture, per-method variance, mandatory reason.
- `POS-511` — immutability.
- `AUD-602` — the variance audit row.
- `OPS-001`, `OPS-002` — the backup and its verification.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/shiftService.js`, `src/routes/shifts.js` |
| Schema | `cashier_closings`, `closing_method_lines` (from `TASK-010`) |
| API | `POST /shifts/:id/close`, `GET /shifts/:id/summary` |
| Constraints | The backup runs **after** the close commits, and its failure raises an alert without reopening the shift |

## Acceptance Criteria

- [ ] Expected per method matches a scripted shift to the centavo
- [ ] A ₱200 short close demands a reason and is refused without one
- [ ] The close writes `AUD-602` with the variance and the reason
- [ ] Closing another user's shift requires `TX-419`
- [ ] No endpoint mutates a closed shift or anything inside it
- [ ] A successful close writes a backup and reports its verification status
- [ ] A backup failure raises an alert and does not reopen the shift
- [ ] The closing summary prints with the `TAX-006` wording

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-INT-52` | Short close demands a reason and audits it |
| `TC-INT-53` | Closed shift immutability |
| `TC-INT-70` | Close triggers a verified backup |
| `TC-E2E-06` | Full day → close → variance → backup |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
