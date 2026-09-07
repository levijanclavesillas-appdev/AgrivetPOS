# TASK-014 — ESC/POS receipt, cash drawer, reprint and collection acknowledgement

**Priority:** **P1** · **Blocks release:** yes · **Blocks:** `TASK-018` UAT ·
**Requirement:** `FR_3.7`, rules `TAX-006`, `TAX-007`, `POS-208`, `POS-507`, `INT-1`, `INT-2`

---

## Objective

Print the internal transaction record and the collection acknowledgement on 58 mm and 80 mm
thermal printers, pulse the cash drawer, and make every reprint visible.

## Context

`TAX-006` is the rule with legal weight and it is **not configurable**: the document carries "This
is not an official receipt" and must never carry "Official Receipt", "Sales Invoice", "OR No.", a
BIR permit number, or an ATP serial range. `01_PRODUCT_BRIEF.md` §5 puts BIR receipting
permanently out of scope, and this is where that boundary is either honoured or quietly broken by
a helpful template.

`POS-208` marks every reprint, because an unmarked reprint is a shrinkage tool: a cashier can hand
a customer a receipt for a sale they pocketed the cash from and produce another for the drawer.

`INT-1` makes printing best-effort and **outside** the sale transaction — a jammed printer must
never roll back a committed sale.

## Requirements

1. An ESC/POS renderer producing 32-column (58 mm) and 48-column (80 mm) layouts, selected in
   settings, for: sale receipt, collection acknowledgement, shift closing summary.
2. Transport: USB via the printer bridge, LAN via raw TCP 9100 (`INT-1`).
3. Every document carries the store profile block and **"This is not an official receipt"**
   (`TAX-006`). No template contains any of the forbidden phrases — asserted by a test, not by
   review alone.
4. In `VAT` mode the receipt adds the VATable / exempt / zero-rated / VAT-amount summary block
   (`TAX-007`); in the other two modes it does not.
5. Non-cash tenders print with the word `RECORDED` beside the amount (`POS-206`).
6. Drawer pulse `0x1B 0x70 0x00 0x19 0xFA` on cash tender, cash collection and any till movement
   (`INT-2`, `POS-507`).
7. Reprint stamps `REPRINT` on the document and writes an audit row (`POS-208`), under `TX-430`.
8. A print failure raises a toast, queues the document for reprint, and **never** affects the
   committed transaction (`INT-1`).

## Business Rules

- `TAX-006` — the Official Receipt boundary. Not configurable, in any mode.
- `TAX-007` — the VAT summary block in `VAT` mode only.
- `POS-206` — `RECORDED`, never `VERIFIED`.
- `POS-208` — reprints marked and audited.
- `POS-507` — when the drawer opens.
- `CR-206` — the collection acknowledgement's contents.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/escpos.js`, `src/services/printService.js`, `src/services/drawerService.js`, `src/routes/print.js` |
| Schema | None |
| API | `POST /sales/:id/reprint`, `POST /print/test` |
| Constraints | Called **outside** every business transaction. Asynchronous. A failure is a toast, not a rollback. |

## Acceptance Criteria

- [ ] Both column widths render legibly against the real printer (`TASK-018` UAT)
- [ ] Every document carries "This is not an official receipt"
- [ ] **No template contains "Official Receipt", "Sales Invoice", "OR No.", a permit number or an ATP range** — asserted by test
- [ ] `VAT` mode prints the tax summary block; `NONE` and `NON_VAT` do not
- [ ] Non-cash tenders print `RECORDED`
- [ ] The drawer pulses on cash sale, cash collection and till movement; not on pure credit
- [ ] A reprint is stamped and audited, and requires `TX-430`
- [ ] Unplugging the printer mid-print leaves the sale committed and raises a toast

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-INT-36` | Drawer pulse conditions |
| `TC-INT-39` | Reprint stamped and audited |
| `TC-UT-17` | Tax block presence by mode |
| `TC-INT-43` | Collection acknowledgement |
| UAT §7.2, §7.3, §7.10 | Real hardware and the `TAX-006` wording |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
