# TASK-036 — Catalogue screens

**Priority:** **P1** — the store cannot be stocked without it · **Blocks release:** yes ·
**Blocks:** cutover, `TASK-018` UAT · **Requirement:** `FR_2.1`–`FR_2.6`, screens
`SCR-201`–`SCR-204`, `NFR_1.3`, `NFR_4.3`, rules `UOM-001`–`UOM-005`, `INV-104`, `INV-108`,
`INV-109`, `PR-101`, `TX-410`, `TX-411`, `TX-412`, `AUD-601`, `AUD-603`

---

## Objective

Give the store a way to put its products into the system, price them, stock them and correct
them — from a screen, not from an HTTP client.

## Context

The v1.0 backlog assigned screens to `TASK-015`, `TASK-016` and `TASK-017` and assigned these
to nobody. Every service, repository and route behind them has existed since `TASK-006` and
`TASK-007` and is tested; there is simply no screen. The suite stayed green because the suite
tests the API.

Nothing here adds a business rule or an endpoint. It is a renderer task against an API that is
already complete: `GET /products`, `POST /products`, `PUT /products/:id`,
`POST|DELETE /products/:id/barcodes`, `POST|DELETE /products/:id/packs`,
`PUT /products/:id/prices`, `PUT /products/:id/cost`, `POST /products/:id/deactivate`,
`GET /inventory/:productId`, `GET /inventory/:productId/movements`,
`GET /inventory/low-stock`, `GET /inventory/meta/adjustment-reasons`,
`POST /inventory/adjustments`, and `GET|POST /categories|/brands|/units`.

Two things about this screen are easy to get wrong and expensive afterwards.

**The base unit is immutable once a movement exists** (`UOM-003`). The correction path is a new
product, not an edit. The editor must lock it *and say why*, because a locked field with no
explanation is a support call, and a base unit changed by force silently reinterprets every
movement in the product's history.

**Cost is absent, not disabled, for anyone but `OWNER`** (`TX-412`) — the same rule the POS
screen already honours. A greyed-out cost field still tells a cashier the margin exists and
roughly where; an absent one tells them nothing.

## Requirements

1. `SCR-201` product list: search across name, SKU, barcode and brand within `NFR_1.3`'s 500 ms
   at 5,000 products; columns for SKU, name, category, base unit, on-hand with its unit, retail
   price and status. Low-stock rows carry an amber left border; inactive rows are muted.
   Filters: category, low stock, inactive.
2. `SCR-202` product editor, five tabs as `04_UX_SPEC.md` §3 fixes them: **Identity** (SKU,
   name, category, brand, `tax_class`) · **Units** (base unit, locked once movements exist with
   the reason shown, and the pack table) · **Pricing** (average cost read-only with its as-of
   date, retail, wholesale, dealer) · **Stock** (on-hand read-only, minimum stock) ·
   **Barcodes** (many, `VR-205`).
3. Creating a product needs a category and a base unit, and both are creatable from the editor
   without leaving it — a store setting itself up has neither yet, and sending someone to a
   different screen to make a category is how a cutover stalls.
4. `UOM-002`: the pack table adds and removes `(unit, factor)` pairs against the base unit, and
   states the conversion in words (`1 SACK = 50 KG`) so a mistyped factor is visible rather than
   arithmetic nobody checks.
5. `UOM-003`: the base unit is locked once any movement exists, the lock says why, and the
   editor names the correction path (a new product and a transfer adjustment).
6. `TX-412`: average cost and the cost field are **absent** for every role but `OWNER`. The
   list's price column shows retail only.
7. `PR-101`: the pricing tab edits retail, wholesale and dealer, and a price change is audited
   with both values (`AUD-601`) — which the API already does; the screen must surface the
   refusal when it comes.
8. `SCR-203` adjustment: product, current on-hand, counted or new quantity, computed variance,
   reason from the configured list (`INV-108`), notes. Above `adjustment_authorisation_centavos`
   the inline authorisation panel appears and submit stays disabled until an approver has
   authenticated (`AUD-603`) — the same panel the POS screen uses, not a second one.
9. `SCR-204` low stock: the products at or below their minimum, with on-hand, minimum and
   shortfall in the base unit (`UOM-005`, `INV-109`), and a link into the editor. Reachable from
   the dashboard's low-stock tile, which currently opens nothing.
10. Every view implements the five states — loading, empty, populated, error, **refused** — and
    a refusal renders the plain-language text for the `rule_id` the API returned.
11. Keyboard: the list is navigable and searchable without a mouse, and the editor saves on
    `Ctrl+S`. Touch targets ≥ 44 px (`NFR_4.3`).
12. `INVENTORY` role lands on `SCR-201` (`04_UX_SPEC.md` §2) and can reach the catalogue and
    adjustments but no sales screen; the rail already hides what the role cannot reach and the
    route is refused server-side regardless (`SEC-6`).

## Business Rules

- `UOM-001`, `UOM-002`, `UOM-003`, `UOM-005` — one base unit, packs against it, the lock, and
  thresholds expressed in the base unit.
- `INV-104` — negative stock, blocked or warned per setting.
- `INV-108` — an adjustment reason comes from the configured list.
- `INV-109` — the low-stock threshold and its list.
- `PR-101` — the price levels the pricing tab edits.
- `TX-410`, `TX-411`, `TX-412` — who may edit a product, change a price, and see cost.
- `AUD-601`, `AUD-603` — price and cost changes audited; an adjustment above the threshold
  carries requester and approver as distinct actors.
- `VR-205` — a barcode is unique across products.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `public/js/catalogue/list.js`, `editor.js`, `adjustment.js`, `lowstock.js`, `public/css/catalogue.css`, wiring in `public/js/shell/app.js` |
| Schema | None. This task adds no table and no migration. |
| API | Consumes only what is listed in Context. **No new endpoint.** If one seems necessary, that is a finding to report, not to build around |
| Constraints | No build step, no framework, no bundler (`05_TECH_SPEC.md` §2) · the client computes no figure that is banked · `NFR_1.3` ≤ 500 ms search at 5,000 products · designed at 1366×768 |

## Acceptance Criteria

- [x] A store with an empty catalogue can create a category, a unit and a product without
      leaving the editor
- [x] A product with movements shows its base unit locked, with the reason and the correction
      path named
- [x] A pack states its conversion in words, and selling by that pack deducts base units
- [x] Cost is absent — not disabled — for `MANAGER`, `CASHIER` and `INVENTORY`
- [x] A price change is refused for a role without `TX-411`, and the refusal names the rule
- [x] An adjustment below the threshold posts; one above it requires an approver and posts both
      actors
- [x] An adjustment reason outside the configured list cannot be chosen
- [x] The low-stock screen lists exactly what `GET /inventory/low-stock` returns, and the
      dashboard tile opens it
- [ ] Search returns a first result within 500 ms at 5,000 products — `NFR_1.3` on the reference machine (§10 item 6)
- [x] The whole of a cutover — category, unit, product, barcode, pack, price, opening stock —
      is completable from these screens with no HTTP client

## Tests

| Case | Asserts | |
| :--- | :--- | :--- |
| `TC-UI-02` | Cost is absent from the editor's DOM for every role but `OWNER` | new |
| `TC-UI-03` | The base unit is locked when movements exist, and the reason is rendered | new |
| `TC-INT-23` | An adjustment above the threshold posts requester and approver as distinct actors | **already exists** (`TASK-007`) |
| `TC-INT-24` | An adjustment reason outside `INV-108`'s list is refused | **already exists** (`TASK-007`) |
| `TC-E2E-10` | A cutover from an empty catalogue: category → unit → product → barcode → pack → price → opening stock → sell it | new |

> `TC-UI-02` and `TC-UI-03` are renderer guards in `src/tests/unit/renderer.test.js`.
> `TC-INT-23` and `TC-INT-24` were written by `TASK-007` and already cover the rules this task
> surfaces; nothing is added to them, and the table lists them so the coverage is visible rather
> than assumed. `TC-E2E-10` is the case that proves the acceptance criterion this task exists
> for — that a cutover is completable from these screens with no HTTP client.

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
