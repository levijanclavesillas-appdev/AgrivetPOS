# TASK-032 — Payment reconciliation

**Priority:** **P2** for v1.2 — the store can reconcile GCash on paper, but not for long ·
**Blocks release:** yes (v1.2) ·
**Requirement:** feature `FT-606`, rules `RPT-105`, `RPT-102`, `POS-206`, `POS-510`, `AUD-601`,
`TX-421`

---

## Objective

Compare what the system recorded per payment method against what actually settled into the
store's accounts, and report the difference without touching either figure.

## Context

**`POS-206` is the honest limitation this task exists to work around.** No payment API confirms a
GCash or QRPh transfer for this store, so `sale_tenders.status` admits exactly one value —
`RECORDED`, meaning *the cashier saw it* — and the `CHECK` constraint is deliberately written so
that there is no way to store `VERIFIED`. `05_TECH_SPEC.md` says why in as many words: a column
that could say "confirmed" is one a report would eventually print.

Reconciliation is what a store does instead. The GCash statement arrives, somebody reads the
day's total off it, and the question is whether it matches the ₱14,320 the POS recorded. Today
that comparison happens on paper against `reportService.payments`, which already groups tenders by
method with a recorded total and a count per method (`RPT-102`).

**`RPT-105`'s second sentence is the rule, and it is a prohibition: it never adjusts the recorded
figure.** The temptation is obvious — the settlement says ₱14,270, the POS says ₱14,320, and a
"correct to actual" button would make the discrepancy go away. It would also destroy the only
record of a ₱50 sale that a cashier recorded and no customer ever paid. The variance is the
output. Nothing is corrected; the recorded figure is what the sales say, and the sales are not
edited (`POS-107`).

**The precedent is the shift close, and it should be followed rather than reinvented.**
`TASK-013` already asks a human for a counted figure, compares it to an expected one, computes a
per-method variance and requires a reason beyond tolerance (`POS-510`). This is the same shape
one level up: per method, per period, against a bank or wallet statement instead of a drawer.
Cash is the method that is *already* reconciled this way and should be shown as such rather than
asked for twice.

## Requirements

1. A reconciliation covers a date range and a method (`GCASH`, `QRPH`, `OTHER` — the methods that
   settle somewhere else). `CASH` is reconciled at the shift close and is shown from there.
2. `CREDIT` and `STORE_CREDIT` settle nowhere and are excluded, with that stated on the screen
   rather than left as an unexplained absence.
3. The recorded total and count come from the same query `RPT-102` already serves.
4. The operator enters the actual settled amount, and optionally a statement reference.
5. `RPT-105`: variance is `actual − recorded`, reported per method with its count, and **no
   recorded figure is written, adjusted or annotated**.
6. A variance beyond a configured tolerance requires a reason, following `POS-510`'s shape and
   its existing tolerance setting where that is the right one — a new setting if it is not.
7. A reconciliation is saved, so the next one starts where the last left off and a range cannot
   be quietly reconciled twice with different answers.
8. Drilling from a variance to the tenders that make up the recorded total, so somebody can find
   the ₱50 rather than only be told it exists.
9. Audited (`AUD-601`): who reconciled what range, to what actual, with what variance and reason.
10. Behind `TX-421`, and `RPT-106`'s header applies.

## Business Rules

- `RPT-105` — the comparison, and the prohibition on adjusting.
- `RPT-102` — the per-method recorded totals this reads.
- `POS-206` — why `RECORDED` is all the store knows, and why this task exists.
- `POS-510` — the tolerance-and-reason shape being reused.
- `POS-107` — the sales behind the figures are not edited.
- `RPT-106` — range, tax mode, and whether voids are included.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/reportService.js` or a `reconciliationService.js` beside it, `src/repositories/reportRepository.js`, `public/js/reports/reconciliation.js` |
| Schema | `015_reconciliation.sql`: `payment_reconciliations` (range, method, recorded, actual, variance, reference, reason, actor). No column on `sale_tenders` — that is the prohibition, expressed as schema |
| API | `GET /reports/reconciliation`, `POST /reconciliations` |
| Constraints | Recorded totals are read, never written · overlapping ranges for one method are refused or flagged, not silently allowed · the drill-down reuses the payment report's query |

## Acceptance Criteria

- [ ] Recorded per-method totals match the payment report exactly for the same range
- [ ] Entering an actual produces a variance and changes nothing about any sale or tender
- [ ] A variance beyond tolerance cannot be saved without a reason
- [ ] `CREDIT` and `STORE_CREDIT` are excluded, and the screen says why
- [ ] Cash shows its shift-close reconciliation rather than asking for a second count
- [ ] Reconciling the same range twice for one method is refused or flagged
- [ ] A variance drills through to the tenders behind the recorded total
- [ ] The audit row carries the range, both figures, the variance and the reason

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-INT-117` | `RPT-105`: variance computed, and every tender and sale byte-identical afterwards |
| `TC-INT-118` | Tolerance: a reason is required beyond it and not within it |
| `TC-INT-119` | Recorded totals agree with `RPT-102`'s payment report for the same range |
| `TC-E2E-26` | A week of mixed tenders, a GCash statement short by one sale, and the variance that finds it |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
