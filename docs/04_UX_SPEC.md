# 04 — UX Specification

**Product**: Chachi Agrivet POS · **Version**: 2.0 · **Date**: 2026-09-07
**Owns**: flows, navigation, screens (`SCR-*`), component behaviour, UI states, the validation
surface, responsive and accessibility rules. Behaviour rules are cited from
`03_BUSINESS_RULES.md`, never restated.

**Design tokens are platform-level and are cited, not copied**:
`/root/AdWebsite/docs/branding.md` §3 (colour), `/root/AdWebsite/docs/brand_identity_and_strategy.md`.
Primary `--color-primary #2563EB`, canvas `--bg-main #F8FAFC`, surface `#FFFFFF`, heading
`#0F172A`, body `#334155`, success `--color-emerald #10B981`, borders `#E2E8F0`.

---

## 1. Design principles for this product

1. **The counter is the product.** Everything else may take a click more. `SCR-301` is the only
   screen tuned for speed.
2. **A cashier's hands are on a scanner and a keypad, not a mouse.** Every POS action has a
   keyboard path (§7).
3. **Money is never ambiguous.** Amounts render right-aligned, monospaced tabular figures, two
   decimals always, `₱` prefix. Quantities render with their unit attached, always.
4. **Refuse loudly, never silently.** A blocked action states the rule in plain language and
   names who can authorise it.
5. **1366×768 is the design target**, not an afterthought — that is what a store PC has.

## 2. Navigation

```text
┌─ Lock / Login ──────────────────────────────────────────┐
│  SCR-101 Login          SCR-102 PIN unlock              │
└───────────────────────┬─────────────────────────────────┘
                        ▼
┌─ Shell: left rail + top bar (store, user, shift, alerts) ┐
│                                                          │
│  SELL         SCR-301 POS            SCR-302 Park        │
│               SCR-303 Payment        SCR-304 Receipt     │
│  CUSTOMERS    SCR-401 List           SCR-402 Profile     │
│               SCR-403 Collection                         │
│  STOCK        SCR-201 Products       SCR-202 Product     │
│               SCR-203 Adjustment     SCR-204 Low stock   │
│  SHIFT        SCR-501 Open           SCR-502 Till cash   │
│               SCR-503 Close                              │
│  REPORTS      SCR-601 Dashboard      SCR-602 Daily sales │
│               SCR-603 Payments       SCR-604 Inventory   │
│  ADMIN        SCR-701 Users          SCR-702 Settings    │
│               SCR-703 Audit          SCR-704 Backup      │
│               SCR-705 Health                             │
└──────────────────────────────────────────────────────────┘
```

Role → landing screen: `CASHIER` → `SCR-301`. `INVENTORY` → `SCR-201`. `MANAGER`, `OWNER` →
`SCR-601`. Rail items the role cannot reach are **hidden**, and the route is refused server-side
regardless (`SEC-6`).

## 3. Screens

### `SCR-001` — First-run setup wizard · `FT-101`

Five steps, no exit: **Store** (name, address, TIN optional) → **Tax** (`NONE` / `NON_VAT` /
`VAT`, with one plain-language sentence each, per `TAX-001`) → **Owner** (username, password,
confirm) → **Recovery code** (generated, displayed once, "I have written this down" checkbox,
`SEC-5`) → **Backup folder** (picker, defaults outside app data, `OPS-001`).

*States*: cannot be skipped; killing the app resumes at step 1; completion is a single
transaction.

### `SCR-101` — Login · `SCR-102` — PIN unlock · `FT-103`

`SCR-101`: username, password, store name, version. Failure says "Incorrect username or
password" without naming which. Lockout after 5 failures shows the remaining minutes (`SEC-3`).
`SCR-102`: 6-digit keypad shown when a shift is open and the session idled out; the cart is
preserved behind it (`POS-105`). "Different user" returns to `SCR-101`.

### `SCR-201` — Products · `SCR-202` — Product editor · `FT-201`

List: search across name, SKU, barcode and brand (`FR_3.1` latency budget), columns for SKU,
name, category, base unit, on-hand with unit, retail price, status. Low-stock rows carry an amber
left border; inactive rows are muted. Filters: category, low stock, inactive.

Editor tabs: **Identity** (SKU, name, category, brand, `tax_class`) · **Units** (base unit —
locked once movements exist per `UOM-003`, with the reason shown — and the pack table) ·
**Pricing** (average cost read-only with its as-of date, retail, wholesale, dealer) ·
**Stock** (on-hand read-only, minimum stock) · **Barcodes** (many, `VR-205`).

*Cost is visible only to `OWNER`* (`TX-412`); the field is absent, not disabled, for others.

### `SCR-203` — Inventory adjustment · `FT-207`

Product, current on-hand, counted or new quantity, computed variance, reason from the configured
list (`INV-108`), notes. Above the value threshold the screen shows an authorisation panel before
the submit button is enabled (`AUD-603`).

### `SCR-301` — Point of sale · `FT-301` — **the critical screen**

```text
┌──────────────────────────────────────────────┬──────────────────────┐
│ [ scan or search ⌕                        ]  │  CUSTOMER            │
│                                              │  Walk-in      [F2]   │
│ ┌──────────────────────────────────────────┐ │  ──────────────────  │
│ │ Hog Feed Grower                          │ │  Price: RETAIL       │
│ │ 2 sack (100.000 KG)  ₱1,650.00  ₱3,300.00│ │                      │
│ │ ─────────────────────────────────────────│ │  Subtotal  ₱3,378.44 │
│ │ Vitamin B-Complex 100ml                  │ │  Discount     ₱0.00  │
│ │ 1.255 KG × ₱62.50/KG          ₱78.44     │ │  ─────────────────── │
│ │ stock after: 448.745 KG                  │ │  TOTAL     ₱3,378.44 │
│ └──────────────────────────────────────────┘ │                      │
│                                              │  [F9]  PAY           │
│ [F3] qty  [F4] discount  [F6] park           │  [F12] park & new    │
└──────────────────────────────────────────────┴──────────────────────┘
```

Rules surfaced here: `POS-102` (both units shown, base stored), `POS-104` (stock-after per line),
`PR-101` (resolved price level named), `INV-104` (a line that would go negative is blocked or
warned per setting), `PR-105` (below-cost opens the authorisation panel).

*States* — **empty**: "Scan an item to begin" with the search focused. **Unknown barcode**: a bar
offering "Attach `4800xxxx` to a product" — never a silent no-op (`FR_3.1`). **Out of stock**:
line refused with the on-hand figure quoted. **Offline**: no indicator at all, because offline is
the normal condition and a permanent warning trains people to ignore warnings.

### `SCR-303` — Payment · `FT-302`, `FT-303`

Amount due fixed at the top. Tender rows added by method; each row is amount plus, for `GCASH`
and `QRPH`, a required reference (`POS-205`) and a duplicate-reference warning (`POS-207`).
Running "remaining" and, once cash exceeds the balance, "change" (`MON-007`). `CREDIT` shows the
customer's limit, balance and available credit, and blocks with the manager-override panel when
over limit (`CR-104`). Complete is disabled until `SUM(tenders) ≥ due` (`POS-204`).

Non-cash rows carry the word **RECORDED** next to the amount (`POS-206`) — in the UI, on the
receipt, and in reports.

### `SCR-304` — Receipt · `FT-304`

Preview of the internal transaction record, print and reprint. Reprints are stamped `REPRINT`
and audited (`POS-208`). The document always carries "This is not an official receipt"
(`TAX-006`); in `VAT` mode it adds the tax summary block (`TAX-007`).

### `SCR-401`/`402` — Customers · `FT-401`, `FT-402`

Profile shows credit limit, current balance, available credit and ageing status (`CR-107`) as the
first block, then sale history, then collection history. `OVERDUE` renders in the error colour
with the day count. Credit limit is editable only under `TX-414`.

### `SCR-403` — Collection · `FT-403`

Customer, outstanding balance, amount (with a "pay in full" shortcut), method, reference where
non-cash, and a preview of the resulting balance before confirming. On confirm it prints the
acknowledgement (`CR-206`). Overpayment requires explicit confirmation and states that the excess
becomes store credit (`CR-204`).

### `SCR-501`/`502`/`503` — Shift · `FT-701`, `FT-702`

**Open**: opening float, counted and confirmed (`POS-503`). **Till cash**: direction, amount,
reason from the list, running expected cash (`POS-504`, `POS-505`). **Close**: expected versus
actual per method side by side, variance per row coloured, a required reason where any variance
exceeds tolerance (`POS-510`), then a summary the cashier can print. Closing triggers a backup
(`OPS-001`) and the screen says so.

### `SCR-601` — Dashboard · `FT-601`

Seven tiles: today's sales, transactions, payment mix, credit outstanding, overdue accounts, low
stock, and gross profit (`RPT-104`, see `FR_6.1`). Each tile is a link to the report behind it. Alerts (`OPS-007`) sit above the tiles as a
dismissible-per-session list; **backup overdue and clock anomaly are not dismissible**.

### `SCR-602`/`603`/`604` — Reports

Every report header states the date range, the tax mode (`RPT-106`) and whether voided sales are
included. Every report is exportable to CSV. Daily sales shows the reconciliation line
`gross − discounts − returns = net` explicitly, because a report that quietly fails to reconcile
is worse than one that shows it (`RPT-101`).

### `SCR-701`–`SCR-705` — Admin

**Users** (`TX-423`), **Settings** — one section per group in `OPS-005`, every field labelled
with its rule ID in a tooltip — **Audit** (filter by actor, action, entity, date; export),
**Backup** (last backup and its verification status, manual backup, restore behind typed
confirmation per `OPS-004`), **Health** (`OPS-006`).

## 4. Component rules

| Component | Rule |
| :--- | :--- |
| Money field | Right-aligned, tabular numerals, always 2 decimals, `₱` prefix, never a bare number |
| Quantity field | Up to 3 decimals, unit label always attached, base unit and pack shown together (`UOM-002`) |
| Authorisation panel | Inline, not a modal-over-modal: names the rule, states which role may approve, takes approver username + password, and records both actors (`AUD-603`) |
| Destructive confirm | Typed confirmation for restore and import only (`OPS-004`); everything else is a two-step button |
| Toast | Success 3 s auto-dismiss; error persists until dismissed |
| Table | Sticky header, zebra rows, keyboard row navigation, no horizontal page scroll — wide tables scroll inside their own container |

## 5. UI states

Every data view implements five states explicitly: **loading** (skeleton, never a spinner over
stale data), **empty** (what it is, and the one action that fills it), **populated**, **error**
(what failed, what to do, never a stack trace), **refused** (the rule ID's plain-language text
and who may authorise).

## 6. Validation surface

Field validation is inline on blur, message below the field, red border, the field keeps focus on
submit failure. Rule validation (`03_BUSINESS_RULES.md`) is surfaced at the point of action, not
at submit: an over-limit credit customer is flagged when they are selected, not after payment is
entered. **Server-side validation is authoritative**; the client's copy is a courtesy (`SEC-6`).

## 7. Keyboard map — POS

| Key | Action | Key | Action |
| :--- | :--- | :--- | :--- |
| `F1` | Search products | `F7` | Retrieve parked cart |
| `F2` | Select customer | `F9` | Payment |
| `F3` | Set line quantity | `F10` | Cash exact-amount shortcut |
| `F4` | Line discount | `F12` | Park and start new |
| `F5` | Transaction discount | `Del` | Remove line |
| `F6` | Park cart | `Esc` | Cancel current field, never the cart |

A barcode scanner in keyboard-wedge mode types into the search field wherever focus is, provided
no modal is open.

## 8. Responsive and accessibility

- **1366×768 minimum**, designed at that width; the POS keeps the cart and totals visible without
  scrolling at that size. Below 1024 px the rail collapses to icons.
- Touch targets ≥ 44 px on POS and payment (`NFR_4.3`).
- Contrast ≥ 4.5:1 for body text, ≥ 3:1 for large text; the brand tokens already satisfy this.
- **Colour is never the only signal**: variance, overdue and low stock each carry an icon or a
  word beside the colour.
- Full keyboard operability for POS, payment and collection; visible focus ring at all times.
- Errors are announced to assistive technology via a live region.

---

*Chachi's Software Development Service · DTI BN 8089738 · BIR OCN 111RC20260000002455 · TIN 752-951-092-00000*
