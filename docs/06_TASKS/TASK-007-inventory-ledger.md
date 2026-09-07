# TASK-007 — Inventory ledger, on-hand, adjustments and low stock

**Priority:** **P1** · **Blocks release:** yes · **Blocks:** `TASK-011` ·
**Requirement:** `FR_2.4`, `FR_2.5`, `FR_2.6`, rules `INV-101`–`INV-109`

---

## Objective

Make stock on hand a derived, reconcilable consequence of an append-only movement ledger, so that
an inventory defect is always visible as a ledger discrepancy rather than hidden in a mutated
counter.

## Context

This is the table every future inventory bug will be diagnosed from. `INV-101` says on-hand is
**maintained only by the movement service, inside the same transaction as the movement** — a
materialised running balance, never an independently written figure. `TC-INT-20` asserts the
reconciliation after the full E2E day, and it is a permanent regression guard.

`legacy/PRD_v1.1.md` §19 listed a `STOCK_TRANSFER` type; it is withdrawn until v1.3 because no
location entity exists (`02_PRD.md` §7).

## Requirements

1. A movement service that is the **only** writer of `inventory_movements` and `inventory`, always
   writing both in one transaction and computing `balance_after_milli`.
2. All twelve movement types with their fixed signs (`INV-103`), each carrying type, source
   document reference, reason where required, and actor.
3. Movements are append-only — no update, no delete. A correction is a compensating movement
   citing `corrects_movement_id` (`INV-102`).
4. Negative stock blocked unless `allow_negative_stock` is on, in which case the movement is
   flagged `is_negative_stock` and a warning is returned (`INV-104`).
5. Average cost recomputed on `OPENING`, `RECEIPT` and positive costed `ADJUSTMENT` only, never on
   decreases (`INV-106`, `MON-004` from `TASK-002`).
6. Adjustments require a reason from the configured list and `TX-407`; above the configured value
   threshold they require owner authorisation, recorded two-actor (`INV-108`, `AUD-603`).
7. Low stock computed at read time as `qty_on_hand_milli ≤ min_stock_milli AND is_active`
   (`INV-109`) — never a stored flag.
8. A per-product ledger view returning date, type, quantity, reference and running balance.

## Business Rules

- `INV-101`, `INV-102` — derivation and append-only.
- `INV-103` — the type list and signs.
- `INV-104` — negative stock policy.
- `INV-105` — inactive products keep their stock and history.
- `INV-106` — what moves average cost.
- `INV-107` — the document and its movements commit together.
- `INV-108`, `INV-109`.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/inventoryService.js`, `src/repositories/inventoryRepository.js`, `src/routes/inventory.js` |
| Schema | `003_inventory.sql` — `inventory`, `inventory_movements` |
| API | `GET /inventory/:productId/movements`, `POST /inventory/adjustments`, `GET /inventory/low-stock` |
| Constraints | The service exposes no method that writes on-hand without a movement — enforced by review and `TC-INT-20` |

## Acceptance Criteria

- [ ] `SUM(movements.qty_milli) = inventory.qty_on_hand_milli` for every product after the E2E day
- [ ] No repository method updates or deletes a movement
- [ ] A correction cites the movement it corrects
- [ ] Negative stock blocked by default; permitted and flagged when the setting is on
- [ ] Average cost changes on receipt, and does not change on sale, damage or negative adjustment
- [ ] An adjustment without a listed reason is rejected
- [ ] An adjustment above the threshold requires owner authorisation and records both actors
- [ ] Selling down to the minimum surfaces the product in low stock within one refresh

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-INT-20` | The ledger reconciles — permanent regression guard |
| `TC-INT-21` | Negative stock, both modes |
| `TC-INT-22` | Low stock detection |
| `TC-INT-23` | Adjustment reason and threshold authorisation |
| `TC-INT-24` | Append-only and compensating correction |
| `TC-UT-16` | Average cost unchanged by decreases |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
