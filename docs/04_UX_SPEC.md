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
│               SCR-305 Return         SCR-306 Receipts    │
│  CUSTOMERS    SCR-401 List           SCR-402 Profile     │
│               SCR-403 Collection     SCR-404 Statement   │
│  STOCK        SCR-201 Products       SCR-202 Product     │
│               SCR-203 Adjustment     SCR-204 Low stock   │
│               SCR-205 Stock count    SCR-206 Batches     │
│               SCR-207 Recall                             │
│  SHIFT        SCR-501 Open           SCR-502 Till cash   │
│               SCR-503 Close                              │
│  BUYING       SCR-801 Orders         SCR-802 Order       │
│               SCR-803 Receive        SCR-804 Suppliers   │
│  REPORTS      SCR-601 Dashboard      SCR-602 Daily sales │
│               SCR-603 Payments       SCR-604 Inventory   │
│               SCR-605 Ageing         SCR-606 Reconcile   │
│               SCR-607 Analysis       SCR-608 Movements   │
│  ADMIN        SCR-701 Users          SCR-702 Settings    │
│               SCR-703 Audit          SCR-704 Backup      │
│               SCR-705 Health         SCR-706 Data        │
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
name, brand, category, base unit, on-hand with unit, retail price, status. The brand is beside
the name it qualifies, and an em dash where there is none — a shelf holds four makes of the same
feed, and a blank cell reads as a brand that failed to load rather than one that was never set. Low-stock rows carry an amber
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

### `SCR-206` — Batches · `FT-205` — v1.2

Behind `TX-422`, reached from `SCR-201`'s row for a batch-tracked product — and, more often, in
one step from the near-expiry and expired-stock alerts on `SCR-601`, because the alert is what
told anybody there was something to look at.

One product's batches, earliest expiry first: the supplier's own batch number, who it came from,
the date printed on the box, `INV-203`'s derived status with the days in words ("in 12 days",
"3 days ago"), and what the batch still holds with its unit (`UOM-005`). An expired row carries
the refusal's colour and a near-expiry row the amber left border `SCR-201`'s low-stock row
already uses — one visual language across the catalogue, so "this needs attention" reads the same
everywhere.

Exhausted batches are hidden until asked for, and the checkbox says why they are worth asking
for: *a recall still names them*.

**Two absences are the design, not an omission.**

**There is no quantity field anywhere on this screen.** `INV-201` makes a batch's quantity the
stock ledger's own sum — the same sum `INV-101` derives per product, grouped one column finer —
so a box that set it would be a box that makes the two figures disagree. The screen shows both
totals side by side for exactly that reason.

**There is no way to sell an expired batch, from here or from anywhere.** `INV-205` permits an
owner override only where the store's own policy allows it, and this store's does not. The one
write on the screen is the write-off (`TX-407`), which posts the `EXPIRY` movement `INV-103`
declared — so the store can total what expiry cost it, which an adjustment of the same quantity
would not say. A cashier sees the list and no button.

### `SCR-207` — Recall · `FT-205`, `INV-206` — v1.2

Behind `TX-422`, one step from any batch on `SCR-206` — which is where somebody holding a
manufacturer's notice arrives. Offered for exhausted batches too: a batch with nothing left on
the shelf is exactly the one whose stock is all in customers' sheds.

**A recall is not a report about stock, it is a list of people.** A customer, a telephone number,
a receipt, and how much of *this batch* they took. Three figures lead it, and the middle one is
what somebody plans their morning around:

- **Still out there** — this batch's share of each line, less what came back on it.
- **People to ring** — customers, not sales: one farm that bought three times is one call.
- **Cannot be reached** — the walk-ins, counted. A batch sold to eleven farms and four walk-ins
  is eleven calls and four you cannot make, and a screen that listed the eleven and omitted the
  four would let a store believe it had reached everybody.

Voided and returned sales are listed and **marked**, never filtered out. A voided sale reversed
the stock and the goods may still have left with the customer; a partly returned line has the
unreturned part in somebody's shed. Both are the store's decision, and a report that made them
silently would be deciding who does not get a telephone call.

Exports to CSV, because the list is worked through with a telephone and not at the machine, and
the export is the same call the screen makes rather than a second query that can drift from it.

### `SCR-205` — Stock count · `FT-209` — v1.1

Behind `TX-407`, reached from `SCR-201` beside the valuation — the two answer the halves of one
question: what the system thinks is here, and what actually is.

Two views. **The list** of counts, where somebody comes back to one they left open, with the
frozen instant, how many of the scope have a figure, and how many differ. **The sheet** for one
count: every product in scope, its expected quantity *at the freeze*, a field for what was on the
shelf, and the variance.

Since `TASK-042`, **a batch-tracked product is counted one line per batch** — which is how the
person holding the boxes counts it — under a heading carrying the product's own frozen total,
because four rows that each look right can still be wrong together. Each batch line names its
batch and the date printed on it: two cartons of one product look identical, and the date is the
only thing that says which row is which. A batch the system believes is empty is still on the
sheet, because that is exactly the box that turns up at the back of the fridge.

The variance posts against the batch it was found in (`INV-201`). Posting it against the
earliest-expiring one would give the same product total and the wrong batch balance — and the
batch balance is what a recall reads.

Three things on this screen are stated rather than left to be worked out, and each of them
prevents a specific expensive misunderstanding.

**`INV-110`, twice.** The variance is measured against what the system held when the count was
**opened**, not against stock now, and posting adjusts by the difference — so anything sold while
the counting went on stays sold. A shopkeeper who expects a count to *set* the shelf figure will
look at the ledger afterwards and report a lost sale as a bug. The column is labelled "expected
at freeze", never "expected".

**A blank is not a zero.** An empty field is "nobody reached this shelf" and writes nothing; a
shelf that is genuinely empty is counted as `0` and writes the whole quantity off. Uncounted rows
are hatched and their field reads *not counted*, matched rows are quiet, and varying rows are
coloured by direction. A sheet that rendered a blank like a match is a sheet on which somebody
posts a half-finished count — so the footer says how many are still blank while there is time to
go and count them, and the posted summary says it again.

**`INV-112` before it refuses.** The counter is told on opening the sheet that somebody else will
have to approve it, because fetching that person is a thing to plan for rather than discover.
Where the store has one active account the rule is waived and the screen says so in those words.
`INV-113`'s staleness is flagged on the list row and at the head of the sheet, and posting a
stale count opens §4's authorisation panel for an owner.

Posted, it is immutable and offers no edit — the correction is an adjustment citing the count.

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

**And, from `TASK-027`, the discount the *statute* grants rather than the store** (`F8`, `TAX-004`).
The panel asks for the three things the law wants — which ID, its number, and the name on it — and
decides nothing: whether the store grants the discount at all, which of the products in the cart it
reaches, what the rate is and whether it beats a discount already on the line are every one of them
the server's answer. The rail shows the figure on its own row, never folded into "Discount", because
they are different claims; under it stands the beneficiary's name, which is what the cashier reads
back off the card. On the line itself the entitlement carries the accent a resolved price level
carries rather than the grey of a hand-typed discount, and where the line was VAT-exempted the
screen says so in those words — *VAT-exempt, less ₱120 VAT* — because that is a tax treatment the
customer is entitled to and not money the store gave away (`TAX-002`). Where a discount already on
the line was the larger, `TAX-005`'s own sentence appears under it: the customer receives the
larger, never both.

**And, from `TASK-023`, the discounts the store configured rather than typed.** Where a basket
earns a tier the rail names the band **in the owner's own words** (`PR-106`) — "why is there ₱300
off" is a question a customer asks and the cashier must be able to answer. Where an automatic
discount and a hand-typed one meet, the larger applies and the screen says which and why the
other did not (`PR-206`), because a cashier who entered ₱100 and sees ₱300 off would otherwise
conclude the till had added them together. Both sentences are the server's; the screen holds no
copy of a band, a threshold or a rate (`OPS-005`, and `TC-UI-07`'s obligation applied to the
counter).

A `PR-202` refusal reads differently from a `PR-203` one and deliberately so: where a **category**
cap binds, no approver is offered, because no manager can release a cap the owner set on the
category and offering one would send the cashier on an errand that ends in the same refusal.

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

**`STORE_CREDIT` (`CR-108`, `TASK-028`)** appears only where the customer has a balance, and the
button carries the figure — *STORE CREDIT ₱400.00* — because the first question a cashier asks is
how much of the bill it covers. It defaults to exactly that: as much of what is due as the balance
reaches, which is what "pay with my credit" means at a counter. The credit block above the rows
says **In credit** rather than showing a negative balance, and says in words that the store owes
them and that it can pay for this sale. Tendering more than they hold is refused on the screen with
the figure, before Complete rather than after it — and refused again at the server, which is where
the balance actually lives.

Non-cash rows carry the word **RECORDED** next to the amount (`POS-206`) — in the UI, on the
receipt, and in reports.

Where a statutory discount was claimed on `SCR-301`, the amount due is followed by the discount and
the beneficiary's name and ID number (`TAX-004`). Restated here rather than left behind on the
previous screen because this is where the money changes hands and the name is the thing the cashier
says out loud before taking it.

### `SCR-304` — Receipt · `FT-304`, and the void · `FT-308` — v1.1

Preview of the internal transaction record, print and reprint. Reprints are stamped `REPRINT`
and audited (`POS-208`). The document always carries "This is not an official receipt"
(`TAX-006`); in `VAT` mode it adds the tax summary block (`TAX-007`).

**The void lives here**, because this is the screen the cashier is looking at in the moment
`POS-401` exists for: the customer is still standing there and the mis-scan has just printed.
Whether it is offered at all is the server's answer, from `GET /sales/:id/voidable` — a screen
that worked out for itself whether the shift was still open would offer the button after a close
and explain the refusal afterwards, by which time the cashier has already told the customer it
can be undone. Where it is refused, **the refusal is shown in the button's place** (`POS-402`:
"that shift has been closed, so the correction is a return"), because a control that is simply
absent is the one thing worse than a refusal.

Pressing it opens a panel, not a confirmation: `POS-401`'s reason is a field, and for a cashier
§4's inline authorisation sits under it (`POS-403` — a cashier may never void unaided). A
manager or owner sees only the reason, and the trail records `self_authorised` so that "a
manager did this himself" and "no authorisation was needed" stay distinguishable. Submit is dead
until both are answered. Enter is bound to "new sale" on this screen and is **suspended while the
panel is open**, or it would fire a destructive action mid-sentence.

Afterwards the screen states `POS-404` rather than leaving it to be noticed: the sale keeps its
receipt number, the sequence has no gap, it is out of the day's takings, and here is what to hand
back.

### `SCR-306` — Receipts · `FT-304`, `FT-308` — v1.2

Behind `TX-401`, in the rail beside the POS. **This shift's** sales, newest first: receipt
number, the time in Manila, the customer or "Walk-in", and the total. Choosing one opens
`SCR-304` on it, with everything that screen already does — the rendered document, `POS-208`'s
stamped reprint, and the void where `GET /sales/:id/voidable` allows it.

It exists because `SCR-304` appears when a sale completes and nowhere else, and Enter on that
screen starts the next customer. A cashier who notices the mis-scan three customers later still
holds `POS-402`'s right to void — same shift, still open — and had no screen to exercise it
from. The reprint was in the same position: the endpoint and the REPRINT stamp exist, and the
button that reaches them had gone.

**Nothing on it edits a sale**, and there is no field of any kind: `POS-107` makes a completed
sale immutable, the corrections are the void and the return, and this is a way to *find* a
receipt rather than to change one. A voided sale is listed and marked rather than hidden —
`POS-404` keeps its number and its place in the sequence, and a gap in the numbers is what an
auditor looks for.

**The shift's, not the day's.** `TX-421` governs who reads the day and `SCR-602` shows it. Where
the shift is closed the screen says so and says where else to look, because "no sales" would send
somebody hunting for a receipt that exists.

### `SCR-305` — Return · `FT-307` — v1.1

Behind `TX-406`, so an owner, a manager and the cashier reach it and the inventory clerk does
not. Its own rail item rather than a corner of `SCR-301`: a return is a different conversation
from a sale and it starts with a receipt in somebody's hand, not a barcode.

Two phases on one screen, because they are one conversation. **Find the sale** — by receipt
number or customer, listing only what still has something to give back (`POS-301`), so a voided
sale is never offered and then refused. **Then decide what comes back**, per line: the quantity
sold, what has already been returned, what is coming back now with "up to *n*" beside the field,
and **what happens to it**.

That last column is the screen's reason for existing. `POS-304` makes a medicine, a vaccine and
any batch-tracked product default to **write-off**, and the screen shows the rule's own sentence
under the control — *"…is batch-tracked, so the store cannot attest to how it was stored while it
was out"* — quietly, because for those lines that is the normal case. Only when somebody changes
it to restock does the warning appear, naming `POS-304` and the role. A screen that shouted at
every medicine line would teach the cashier to stop reading, which is exactly how a returned
bottle of antibiotic gets back onto the shelf.

`POS-307`'s window is answered **at the top, on load** rather than as a refusal at the bottom:
authorising a late return means asking somebody to walk over, and that is worth knowing before
the goods come out of the bag. `POS-304` and `POS-307` each open §4's inline authorisation panel
on refusal, naming the rule; the submit stays disabled until a manager or owner has
authenticated in it.

The refund preview states **how** it will be paid before it is confirmed — off the balance, in
cash, or held as store credit — because being handed store credit instead of notes is not a
thing to discover after the fact (`POS-305`, `POS-306`). It is labelled as this screen's
arithmetic: the figures that count are the server's, on the slip the return prints (`TAX-006`).

Posted, it is immutable and the screen offers no edit. What it does offer is a per-line account
of what happened to each thing — *"back on the shelf"* or *"written off, not resold"* — so the
cashier can say it out loud while handing the slip over.

### `SCR-401`/`402` — Customers · `FT-401`, `FT-402`

Profile shows credit limit, current balance, available credit and ageing status (`CR-107`) as the
first block, then sale history, then collection history. `OVERDUE` renders in the error colour
with the day count. Credit limit is editable only under `TX-414`.

**A customer the store owes is never rendered as one who owes** (`CR-108`, `TASK-028`). The list
shows the figure without its minus sign and tags the row **in credit** — in the accent the
"available" figure carries, not the error colour a debt carries — instead of an ageing word, because
there is no debt there to age. The profile says it in a sentence: the store owes them this much,
from an overpayment or a return, and it can pay for their next purchase in whole or in part. That
last clause is the point of saying it at all: before `TASK-028` a customer ₱500 in credit was told
so and then asked for cash.

### `SCR-403` — Collection · `FT-403`

Customer, outstanding balance, amount (with a "pay in full" shortcut), method, reference where
non-cash, and a preview of the resulting balance before confirming. On confirm it prints the
acknowledgement (`CR-206`). Overpayment requires explicit confirmation and states that the excess
becomes store credit (`CR-204`).

`SCR-402` also carries the **write-off** (`FT-409`, `CR-303`) — the owner's alone, and hidden
rather than disabled for everybody else, because a greyed-out "write off" is an invitation to ask
why. It asks two things: how much, and **why**, the second free text because "why did this money
never arrive" has no list of five options and it is the field the store's accountant reads. The
panel says what it will do before it does it — the balance falls, the invoices stop being chased,
it is counted as a write-off and never as a collection, and it cannot be undone.

### `SCR-404` — Statement · `FT-407` — v1.2

Behind `TX-421`, from `SCR-402` beside the payment button — *"what do I owe"* and *"here is some
of it"* are the two halves of one conversation.

**A document handed to a customer who is standing there**, so it is built to be checked by hand:
the balance carried in, every movement in the period with a running total beside it, and the
closing figure large enough to read across a counter. Somebody who disagrees can point at the line
where the two of you part company, which is the whole reason a statement exists rather than a
number read aloud.

`CR-203`'s allocations sit under the payment they belong to — *which invoices this ₱3,000
settled*. `CR-108`: an account in credit closes with the store owing **them**, in words, because a
minus sign is a minus sign somebody will read past.

**The closing balance is the account's own** (`CR-302`), and the server refuses to build a
statement whose walked total disagrees with the ledger. The screen therefore derives nothing: a
figure it computed itself would be a second answer to a question already settled.

Prints on the receipt printer — `CR-206`'s precedent for a document a customer takes away, with
`TAX-006`'s notice on it like everything else this shop prints — and exports to CSV.

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

### `SCR-605` — Ageing · `FT-406` — v1.2

Behind `TX-421` at store scope — a cashier holds `TX-421` for their own shift's figures, and the
receivable has no shift to scope it to. Reached from the dashboard's two credit tiles, which is
what somebody pressing "Overdue accounts" was always trying to open.

Five columns — not yet due, 1–30, 31–60, 61–90, over 90 — and **a row can be in several of them
at once**, because `CR-301` buckets a debit and not an account. One farm ₱2,000 in the 1–30 and
₱5,000 in the 90+ is the ordinary case; a screen that put the whole account in its oldest bucket
would tell the owner their problem is more than twice what it is.

Sorted by oldest debt, with the telephone number on the row, because that is the order somebody
works a morning in. A row opens the customer, where the statement is.

**Credit a customer is holding is its own column and is never netted into a bucket** — a debt
three months old does not become younger for a payment landing later. The reconciliation is
stated as arithmetic rather than a tick (`FR_6.2`'s demand, applied to the debt): aged debt, less
the credit customers hold, is exactly what the ledger says the store is owed.

### `SCR-606` — Reconciliation · `FT-606` — v1.2

Behind `TX-421` at store scope, from the payments report — which is the screen somebody is
already on when the wallet's statement arrives. The range travels with them.

One row per method that settles somewhere else: what the POS **recorded** on the left, what the
statement says settled in the middle, the difference on the right. `POS-206` is stated on the
recorded figure — *RECORDED, the cashier saw it* — because that is all this store can know
without a payment API, and it is the reason the screen exists.

**Nothing on it writes back to the recorded column** (`RPT-105`), and the layout is meant to make
that obvious rather than only true. A "correct to actual" button would make a discrepancy
disappear along with the only record of a ₱50 sale a cashier recorded and nobody ever paid.

A variance beyond the configured tolerance cannot be saved without a reason — `POS-510`'s shape,
one level up, against a statement instead of a drawer — and the refusal names the three things it
usually turns out to be: a fee, a transfer that landed late, or a sale nobody paid for.

**What is not on it is stated on it.** Cash is reconciled at the shift close and is shown from
there rather than counted twice; credit and store credit settle nowhere at all. And any variance
drills through to the tenders behind the recorded figure, because "we are ₱50 short" is answered
by reading down a list until the ₱50 turns up — a missing reference is the first thing to look at.

### `SCR-607` — Sales analysis · `FT-602`, `FT-605` — v1.2

Behind `TX-421`, reached from the daily report with its range — which is the screen somebody is
already on when they ask *why* the total is what it is. Four tabs over one report: **by category**,
**by cashier**, **by product** and **movers**. One range, one header, one export in all four.

**What each tab reconciles to is printed on it, because the two anchors are genuinely different.**
Category figures are line-level and reconcile to revenue net of VAT; cashier figures are sale-level
and reconcile to net sales before returns. A transaction discount belongs to the sale and not to
any of its lines, so there is no honest way to split ₱50 off a mixed basket between feed and
veterinary supplies — and this report does not invent one. A return is its own document with its
own operator, so it is not charged back to the cashier who made the sale.

**A category is read from the product as it is filed today.** Nothing snapshots it — `MON-005`
keeps money off the live record and a category is not money — so recategorising a product moves
its history with it. Stated in the report's own basis line rather than left for somebody to
discover the month they reorganise the shelves.

**Movers is two rankings and never one.** A sack of feed at ₱1,400 and a sachet at ₱35 sort in
opposite orders by money and by units; the store reorders on the second and decides what to stock
more of on the first. The units ranking is **partitioned by base unit** (`UOM-001`) rather than
filtered to one the reader has to know to ask for — 40 KG and 40 sachets are not 40 of the same
thing. Slow movers are built from the catalogue outward, so a product that sold nothing appears;
each row carries what is on the shelf, what it is worth, and when it last sold, because 200 units
last sold in March is a different problem from two. A product added inside the range is **flagged
rather than judged** — it has not had the range to sell in.

### `SCR-608` — Movement analysis · `FT-602` — v1.2

Behind `TX-422`, not `TX-421`, and that is why it is a separate screen rather than a fifth tab:
the person who needs to know what was damaged this quarter is the inventory clerk, who has no
business reading the day's takings. Reached from the valuation report, because what is on the
shelf and how it got there are the same question from two sides.

`INV-102`'s ledger summarised by `INV-103`'s types — received, sold, damaged, expired, counted,
used internally — with the count, the products affected and the value, and a filter down to one
type and the products behind it.

**Two value columns, never one.** `INV-106` costs a movement on the way *in* and never on the way
out: a sale or a write-off consumes at the average prevailing at the time, which is used and not
stored. So what a receipt cost is a fact and what a damaged sack was worth is an estimate at
today's average — and each row says which it is. A single merged figure would be the comfortable
report and the one that quietly restates last quarter's write-offs the next time a delivery moves
an average.

**Quantities are per product, in that product's base unit.** There is no store-wide quantity
total, because 40 KG of feed and 40 sachets of dewormer are not 80 of anything (`UOM-001`). The
one place quantities are added across products is the reconciliation, which is a check on the
ledger's own arithmetic and says so: opening plus what moved is closing (`INV-101`), and closing
is what the rest of the system reads as stock.

### `SCR-602`/`603`/`604` — Reports

Every report header states the date range, the tax mode (`RPT-106`) and whether voided sales are
included. Every report is exportable to CSV. Daily sales shows the reconciliation line
`gross − discounts − returns = net` explicitly, because a report that quietly fails to reconcile
is worse than one that shows it (`RPT-101`).

### `SCR-801`–`SCR-804` — Buying · `FT-501`–`FT-504` — v1.1

Behind `TX-409`, so an owner, a manager and the inventory clerk reach it and a cashier does not.

`SCR-801` **Orders** — the list, filtered by supplier and status, defaulting to the two statuses
that mean "sent and not yet fully here". Each row shows the number, the supplier, what was
ordered against what has arrived, and the status word from `PO-102`. The status filter is served
by `GET /purchase-orders`; the screen keeps no copy of it.

`SCR-802` **Order** — one purchase order. Lines of product, quantity and unit cost, with the
running total. The product on a line is **chosen from a list**, the same picker the POS search
uses — type two letters, see the SKU, the buying unit and what is on the shelf, and pick one.
A line binds because somebody chose a row and never because the search returned one: a buyer who
typed "feed" at a shop with four feeds must not walk away having ordered the wrong one. Editing
the field after a choice unbinds the line, so what it says and what it resolved to cannot
disagree. **A `DRAFT` is edited in place; a sent order is amended into a new revision**
(`PO-104`), and the screen says which of the two it is about to do before the buyer presses
save — the supplier is holding a printed copy of something, and "rev 2" is the word that tells
them which. **Nothing on this screen moves stock** (`PO-103`); the only thing that does is
`SCR-803`, and the order says so where a reader might expect a "receive" shortcut to appear.
Cancel is offered only while `PO-102` allows it and is refused outright once anything has
arrived (`PO-105`).

`SCR-803` **Receive** — the delivery. Per line: what was ordered, what arrived, **how much of
what arrived was damaged**, and the unit cost actually charged. The screen computes the sound
quantity — arrived less damaged — and states it as the figure that will become stock (`PO-202`),
because a shopkeeper counting sacks off a van is entitled to see the arithmetic rather than
discover it in the ledger. Over-receipt (`PO-204`) and a cost outside tolerance (`PO-205`) each
raise §4's inline authorisation panel, naming the rule and the amount by which it was exceeded;
the post button stays disabled until a manager or owner has authenticated in it. Reached with no
order for the counter purchase, which still requires a supplier (`PO-207`). Posted, it is
immutable (`PO-206`) and the screen offers no edit.

`SCR-804` **Suppliers** — name, code, contact, terms, and the purchase history that answers
"what did this supplier charge us last time". Deactivated, never deleted (`VR-401`), and refused
while an order is still outstanding.

### `SCR-701`–`SCR-705` — Admin

**Users** (`TX-423`), **Settings** — one section per group in `OPS-005`, every field labelled
with its rule ID in a tooltip — **Audit** (filter by actor, action, entity, date; export),
**Backup** (last backup and its verification status, manual backup, restore behind typed
confirmation per `OPS-004`), **Health** (`OPS-006`).

### `SCR-706` — Export and import · `FT-705`, `FT-706` — v1.1

Two halves of one screen, shaped differently on purpose.

**Export is one button.** `OPS-101` fixes what an archive contains, so there is nothing to
configure; the screen's job is to hand over a file and say what is in it — including, before
anybody makes one, that credentials are never exported and a store restored from it has its
people but none of their passwords.

**Import is a conversation, and `OPS-102` is why.** Choosing a file validates the whole of it
server-side, **writing nothing**, and the screen then shows what would happen: rows per entity,
how many are already here, what the one choice does to the overlap, and every problem found.
Only then is there a button, and it stays disabled until the validation says the archive may be
imported. A single button that validated and wrote in one call would put "present a summary for
confirmation" inside a spinner.

Skip / replace / abort is chosen **once for the whole run** (`OPS-104`) and changing it
re-validates, because what it does to the overlap is part of the summary rather than a footnote
to it. Afterwards the screen keeps the pre-import backup's filename on display: it is the thing
the operator needs if the import turns out to have been a mistake (`OPS-103`).

## 4. Component rules

| Component | Rule |
| :--- | :--- |
| Money field | Right-aligned, tabular numerals, always 2 decimals, `₱` prefix, never a bare number |
| Quantity field | Up to 3 decimals, unit label always attached, base unit and pack shown together (`UOM-002`). `F3` asks for the **unit** beside the quantity where the product has packs, shows what it comes to in the base unit as it is typed, and states `UOM-004`'s refusal — a unit that cannot be halved — before the submit rather than after it |
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
| `F8` | Senior citizen / PWD discount | | |

`F8` is mapped in every store and appears in the foot bar **only where the owner has switched the
statutory discount on** (`TAX-004` ships it off). A key advertised to every store and refused in
most of them is a key cashiers learn to skip past, and this is the one key that has to work on the
day somebody puts an ID on the counter — so it stays mapped, and pressing it in a store that does
not grant the discount says so in a sentence rather than doing nothing.

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
