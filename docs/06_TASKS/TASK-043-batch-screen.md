# TASK-043 — `SCR-206`, the batch list

**Priority:** **P1** for v1.2 — without it `TASK-029`'s API is unreachable and its alert
points at nothing · **Blocks release:** yes (v1.2) · **Depends on:** `TASK-029` ·
**Blocks:** `TASK-030` (the recall hangs off this list) ·
**Requirement:** feature `FT-205`, rules `INV-201`–`INV-205`, `OPS-007`, `TX-422`, `TX-407`,
screen `SCR-206`

---

## Objective

Show a product's batches, with what each holds and when it expires, and let expired stock be
written off from the screen that shows it.

## Context

**This is the gap `TASK-029` left, and it is the same shape as the one `TASK-036` was written
for.** The services, the repository and both routes exist and are tested:
`GET /products/:id/batches` and `POST /batches/:id/expire`. Nothing in `public/` calls either.
So a store running v1.2 today gets a `CRITICAL` alert saying three batches on the shelf have
expired and may not be sold, and has nowhere to go from it — the only way to clear one is an
HTTP client, which is not a thing a store has.

`SCR-206` is the next free id in the catalogue range. It is deliberately **not** in
`04_UX_SPEC.md` yet: `TC-UI-10` asserts that every screen the spec names has a view, and a
specified screen with no view would turn a guard that has been green since `TASK-036` red.
Adding the section and the view belong in the same commit.

**Where it lives.** A sixth tab on `SCR-202` was considered and rejected: the product editor's
five tabs are fixed by `04_UX_SPEC.md` §3, and a batch is not a property of the product the way
a pack or a barcode is — it is stock, with a quantity that no editor may write. It is reached
from the product list beside the adjustment, and from the near-expiry and expired alerts, which
is the path somebody actually arrives by.

## Requirements

1. `SCR-206` lists one product's batches: batch number, supplier, expiry date, `INV-203`'s
   derived status, days to expiry, and the quantity held with its unit (`UOM-005`).
2. Expired rows are marked as `04_UX_SPEC.md` §3 marks a refusal, near-expiry as it marks a
   warning — the same treatment the low-stock row already gets, so one visual language covers
   "this needs attention" across the catalogue.
3. Exhausted batches are hidden by default and shown on a toggle (`?includeEmpty=true`), because
   a shop looking for what it holds should not scroll two years of empties to find three tins —
   and a recall needs to find them.
4. `INV-205`: an expired batch offers **Write off**, behind `TX-407`, which posts the `EXPIRY`
   movement and says what left. It is the only write on this screen. There is no quantity field
   anywhere on it — `INV-201` makes a batch's quantity the ledger's own sum.
5. Reached from `SCR-201`'s row action for a batch-tracked product, and in one step from the
   `NEAR_EXPIRY` and `EXPIRED_STOCK` alerts on `SCR-601`, which already carry `batch_id` and
   `product_id` in their detail.
6. A product that is not batch-tracked has no batches and the API refuses the question
   (`INV-201`); the row action is absent for it rather than present and refusing.
7. `04_UX_SPEC.md` §3 gains its `SCR-206` section in the same commit as the view.

## Business Rules

- `INV-201`, `INV-202` — what a batch is, and that its quantity is not editable.
- `INV-203` — the status and the days, derived at read time, never stored.
- `INV-205` — the write-off, and that there is no way to sell expired stock from here either.
- `OPS-007` — the alerts this screen is the destination for.
- `TX-422` to read, `TX-407` to write off.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `public/js/catalogue/batches.js`, `public/css/catalogue.css`, `public/js/shell/app.js` (the route), `docs/04_UX_SPEC.md` |
| Schema | **None** |
| API | **None** — `GET /products/:id/batches` and `POST /batches/:id/expire` already exist |
| Constraints | No build step, no framework (`05_TECH_SPEC.md` §2) · `ui.ask` for the write-off reason, never `window.prompt`, which Electron does not implement · the five states of `04_UX_SPEC.md` §5 |

## Acceptance Criteria

- [ ] A batch-tracked product's batches are listed with quantity, expiry and status
- [ ] An expired batch can be written off from this screen, and the list updates
- [ ] A cashier sees the list and no write-off button (`TX-407`)
- [ ] Exhausted batches appear only when asked for
- [ ] The expired-stock alert reaches this screen in one step
- [ ] There is no field anywhere on the screen that writes a quantity
- [ ] `TC-UI-10` stays green: the spec section and the view land together

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-UI-11` | The screen renders the four states and carries no quantity input |
| `TC-E2E-26` | From the expired alert to the write-off, over HTTP, in the browser smoke |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
