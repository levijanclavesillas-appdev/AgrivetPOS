# TASK-015 — POS, payment and receipt screens

**Priority:** **P1** — the counter is the product · **Blocks release:** yes ·
**Blocks:** `TASK-018` · **Requirement:** `FR_3.1`, `FR_3.2`, screens `SCR-301`–`SCR-304`,
`SCR-102`, `NFR_1.1`–`NFR_1.3`, `NFR_4.3`, rules `POS-102`–`POS-106`, `POS-203`–`POS-208`,
`PR-101`, `PR-105`, `CR-104`, `INV-104`, `TAX-006`

---

## Objective

Put a cashier in front of the sale transaction: scan, price, tender and print, at 1366×768,
entirely from the keyboard, fast enough that nobody reaches for the notebook.

## Context

`TASK-011` made the sale correct. This task is the only thing standing between a correct
`POST /sales` and a store that can actually sell — and it is where the product is judged, because
it is the one screen used a hundred times a day.

The renderer is vanilla ES modules against `public/` with **no build step** (`05_TECH_SPEC.md`
§2): a store PC gets a folder that runs. That constraint is deliberate and is not to be solved
with a bundler.

Two things about this screen are easy to get wrong and expensive to correct later.
**The client computes nothing that is banked.** It displays totals for the cashier's benefit and
posts lines and tenders; the server re-resolves every price and recomputes every total
(`05_TECH_SPEC.md` §4.1), and a mismatch rejects the sale. **There is no offline indicator**
(`04_UX_SPEC.md` `SCR-301`) — offline is the normal condition of this product, and a permanent
warning trains people to ignore warnings.

## Requirements

1. `SCR-301` at the `04_UX_SPEC.md` §3 layout, usable at **1366×768 with the cart and totals rail
   visible without scrolling** (`NFR_4.1`). Below 1024 px the rail collapses to icons.
2. Scanner input per `INT-3`: keystrokes route to the search field wherever focus is, provided no
   modal is open; a terminating `Enter` inside the scan interval marks it a scan rather than
   typing. Scan → cart line in ≤ 300 ms at 5,000 products (`NFR_1.2`, `FR_3.1`).
3. An unknown barcode shows the **"attach `4800xxxx` to a product"** bar. A silent no-op or a
   swallowed 404 is a defect (`FR_3.1`, `TC-INT-30`).
4. Each cart line renders product, quantity **in both the entered pack and the base unit**, the
   resolved unit price with its **price level named**, discount, line total, and remaining stock
   after the line (`POS-102`, `POS-104`, `PR-101`, `UOM-002`).
5. Quantity entry (`F3`) accepts base unit or a defined pack. A line that would drive stock
   negative is refused with the on-hand figure quoted, or warned, per the setting (`INV-104`).
6. Below-cost pricing (`PR-105`) and a discount above the actor's ceiling (`PR-201`) open the
   **inline authorisation panel** — never a modal over a modal. It names the rule, states which
   role may approve, takes the approver's username and password, and both actors reach the server
   (`AUD-603`).
7. The cart survives an idle logout and an application restart and is recoverable by the same user
   on the same shift (`POS-105`). `SCR-102` PIN unlock renders **over** a preserved cart;
   "Different user" returns to `SCR-101` and does not silently discard it.
8. `SCR-302`: park and resume (`F6`, `F7`, `F12`). Parked carts expire at shift close (`POS-106`).
9. `SCR-303` payment: tender rows per method; `GCASH` and `QRPH` require a non-empty reference
   that is neither defaulted nor generated (`POS-205`); a same-day duplicate reference warns and
   requires **explicit acceptance** (`POS-207`); running "remaining" and, once cash exceeds the
   balance, "change" (`MON-007`, `POS-203`); `CREDIT` shows limit, balance and available credit,
   and blocks over limit behind the override panel (`CR-104`). Complete stays disabled until
   `SUM(tenders) ≥ due` (`POS-204`). Non-cash rows carry the word **RECORDED** (`POS-206`).
10. `SCR-304`: receipt preview, print, and reprint stamped `REPRINT` (`POS-208`). The document
    always carries "This is not an official receipt" (`TAX-006`); `VAT` mode adds the tax summary
    block (`TAX-007`). Printing is asynchronous — **a printer failure never unwinds a committed
    sale** (`INT-1`); it queues for reprint and raises a toast.
11. Every view implements the five states — loading, empty, populated, error, **refused** —
    and a refusal renders the plain-language text for the `rule_id` the API returned
    (`04_UX_SPEC.md` §5, `05_TECH_SPEC.md` §4).
12. The `04_UX_SPEC.md` §7 keyboard map in full, with a visible focus ring at all times and touch
    targets ≥ 44 px on POS and payment (`NFR_4.3`).
13. With no open shift, the POS refuses with an "open your shift" prompt rather than failing at
    payment (`POS-501`, `FR_5.1`).
14. Role landing and rail visibility per `04_UX_SPEC.md` §2 — `CASHIER` lands on `SCR-301`,
    unreachable rail items are **hidden**, and the route is refused server-side regardless
    (`SEC-6`). Cost is **absent**, not disabled, for anyone but `OWNER` (`TX-412`).

## Business Rules

- `POS-102`, `POS-104` — what a cart line must show, and in which unit the ledger stores it.
- `POS-105`, `POS-106` — cart survival and parking.
- `POS-203`–`POS-207` — change, the tender floor, references, `RECORDED`, duplicates.
- `POS-208` — the reprint stamp.
- `PR-101`, `PR-105`, `PR-201` — price precedence, below-cost, discount ceilings.
- `CR-104` — the over-limit block and its override.
- `INV-104` — negative stock.
- `TAX-006`, `TAX-007` — the not-an-OR wording and the VAT block.
- `AUD-603` — requester and approver recorded as distinct actors.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `public/js/pos/*.js`, `public/js/payment/*.js`, `public/js/receipt/*.js`, `public/js/shell/*.js`, `public/css/*.css` |
| Schema | None. This task adds no table and no migration. |
| API | Consumes `GET /products/barcode/:code`, `GET /products?q=`, `POST /sales/price-check`, `POST /sales`, `POST /sales/:id/reprint`, `GET /customers/:id/credit` |
| Constraints | No build step, no framework, no bundler (`05_TECH_SPEC.md` §2) · client totals are display-only and never persisted (§4.1) · `NFR_1.1` ≤ 2 s confirm-to-receipt, `NFR_1.2` ≤ 300 ms scan, `NFR_1.3` ≤ 500 ms search · designed at 1366×768 |

**Parked carts and cart survival need somewhere to live.** `05_TECH_SPEC.md` §3.4 has no table for
them. Either add a `parked_carts` migration in this task or persist to the renderer's storage —
persisting to the renderer fails `POS-105`'s restart clause on a reinstall, so the table is the
expected answer. Record the choice in `05_TECH_SPEC.md` §3.4 either way.

## Acceptance Criteria

- [ ] 20 consecutive scans add lines with no misses, each under 300 ms at 5,000 products — the scans are asserted by the browser smoke; the 300 ms is `NFR_1.2` on the reference machine (§10 item 6)
- [x] An unknown barcode offers to attach it; nothing is ever silently dropped
- [x] A sack line and a kilo line of the same product both show base unit and pack, and stock-after
- [x] The resolved price level is named on the line for a dealer, a wholesale and a walk-in customer
- [x] A below-cost price opens the inline authorisation panel and posts both actors
- [x] Idle logout, PIN unlock and an app restart each return the cashier to the same cart
- [x] A `GCASH` tender with an empty reference cannot complete; a duplicate reference warns and needs acceptance
- [x] Complete is disabled until tendered ≥ due; cash over-tender shows change, non-cash cannot
- [x] Every non-cash row reads `RECORDED` on screen and on the printed document
- [x] The receipt carries the `TAX-006` line in every tax mode; a reprint is stamped `REPRINT`
- [x] A tampered client total is rejected by the server and surfaced as a refusal, not a crash
- [x] The whole sale — search, quantity, discount, payment, print — is completable without a mouse

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-INT-30` | Unknown barcode returns an attach-offer, not a swallowed 404 |
| `TC-INT-32` | Split tender completes at ≥ due and not below |
| `TC-INT-37` | A tampered client total is rejected |
| `TC-INT-38` | Duplicate GCash reference warns and requires explicit acceptance |
| `TC-UT-33` | GCash tender with an empty reference rejected |
| `TC-E2E-01` | Open shift → 3 scans → fractional kilo line → cash → change → receipt, under `NFR_1.1` |
| `TC-E2E-05` | Cash + GCash + credit in one sale |
| `TC-PERF-02` | Scan to cart line ≤ 300 ms at 5,000 products |
| `TC-PERF-03` | Product search first result ≤ 500 ms at 5,000 products |
| `TC-UI-01` | Touch targets ≥ 44 px on POS and payment |

> `TC-PERF-02`, `TC-PERF-03` and `TC-UI-01` are in `07_TEST_PLAN.md` §6 — the non-functional
> cases. They are budgets: measure them on the reference machine (`NFR_4.1`) against a database
> seeded to `NFR_2.1` scale, never on the developer's machine.

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
