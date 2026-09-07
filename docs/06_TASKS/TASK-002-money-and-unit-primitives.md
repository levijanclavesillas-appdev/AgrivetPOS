# TASK-002 — Money, quantity and unit-conversion primitives

**Priority:** **P1** — every money figure in the product depends on it · **Blocks release:** yes ·
**Blocks:** `TASK-009`, `TASK-011` · **Requirement:** `FR_2.3`, rules `MON-001`–`MON-008`,
`UOM-001`–`UOM-005`

---

## Objective

Implement the money and quantity primitives as pure, exhaustively tested functions before any
feature uses them, so that rounding is decided once rather than re-invented per screen.

## Context

`legacy/PRD_v1.1.md` introduced fractional kilos (§31.1) and stacked percentage discounts (§47–49)
without stating decimal places, rounding direction, or the order of operations. That omission is
the classic source of the ₱0.01 daily variance that destroys trust in the closing report, and of
credit balances that never quite reach zero. This task closes it before a single price is
computed.

## Requirements

1. A money type: signed integer centavos, with `fromPesos`, `toDisplay`, `add`, `sub`, `mulQty`,
   `percent`, and `apportion`. **No `Number` division on money outside `percent` and the VAT
   decomposition**, both of which round explicitly.
2. A quantity type: signed integer thousandths, with parse, format-with-unit, and a rejection
   (not a truncation) of a fourth decimal place.
3. `roundHalfUp(value, places)` used by both; the single rounding function in the codebase.
4. `computeLineTotal({ unitPrice, qtyMilli, lineDiscount })` implementing `MON-003`'s fixed order
   exactly, returning every intermediate for the test to assert.
5. `apportionDiscount(lineTotals, txnDiscount)` implementing `MON-006`: proportional, summing
   exactly to the input, remainder to the largest line.
6. `toBaseUnits(qtyMilli, packFactorMilli)` and its inverse, for `UOM-002`.
7. `computeMovingAverage(existingQty, existingCost, receivedQty, receivedCost)` per `MON-004`.

## Business Rules

- `MON-001`, `MON-002` — the storage representations; nothing else may represent money or quantity.
- `MON-003` — the fixed order of operations, and half-up.
- `MON-004` — moving weighted average.
- `MON-006` — apportionment and the remainder rule.
- `MON-008` — cash rounding is a setting defaulting to off.
- `UOM-002` — pack factor arithmetic.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/money.js`, `src/services/quantity.js`, `src/services/costing.js` |
| Schema | None |
| API | None — pure functions |
| Constraints | Zero floating-point arithmetic on stored values. No dependency on any other service. |

## Acceptance Criteria

- [ ] 1.255 KG at ₱62.50/KG bills ₱78.44 (half-up)
- [ ] 1,000 such lines sum to exactly 1,000× the single line — no drift
- [ ] A quantity with four decimals is **rejected**, never silently truncated
- [ ] A transaction discount apportions to the centavo with the remainder on the largest line
- [ ] Moving average across two receipts at different costs matches a hand-computed figure
- [ ] Sale, damage and negative adjustment leave average cost untouched
- [ ] A `grep` for `parseFloat`, `Number(` or `/ 100` on a money path returns nothing outside the display edge

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-UT-12` | Fractional line total and 1,000-line drift |
| `TC-UT-13` | Fourth decimal rejected |
| `TC-UT-14` | Apportionment and remainder |
| `TC-UT-15` | Moving average |
| `TC-UT-16` | Average cost unchanged by decreases |
| `TC-UT-11` | Pack factor conversion |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
