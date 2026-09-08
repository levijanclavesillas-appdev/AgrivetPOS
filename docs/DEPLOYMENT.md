# Deployment — Chachi Agrivet POS v1.0

**For the person installing the system**, not for the store owner. The owner's document is
[`HANDOVER.md`](HANDOVER.md), and the two are handed over together.

This covers building the installer, putting it on the store's PC, configuring the hardware,
loading the opening data, and upgrading later. Work down it in order. Nothing here needs a
network connection at the store.

> ## ⚠ Read this before booking the visit
>
> **v1.0 cannot yet be deployed to a store**, and the reason is not the installer.
>
> Nine of the twenty-six screens in `04_UX_SPEC.md` do not exist yet — customers and
> collections, shift close, users, settings and the audit viewer (`06_TASKS/README.md`,
> *the screen gap*). Every service and API behind them is built and tested; there is simply
> no screen to reach them from.
>
> `TASK-036` has landed, so **section 6's catalogue half now works**: products, barcodes,
> packs, prices, opening stock and adjustments are all reachable from `SCR-201`–`SCR-204`, and
> `TC-E2E-10` walks that path from an empty install to a completed sale.
>
> What is still impossible as written: **section 4 (hardware)** and **section 5 (users)**,
> which need the settings and user screens, and the opening **credit balances** in section 6,
> which need the customer screens. A shift can be opened but **not closed**, which is the
> sharpest of the remaining gaps — a till that cannot be counted.
>
> Until `TASK-037`–`TASK-041` land, the only route to those operations is the HTTP API, which
> is not a thing to do on a store counter.
>
> **Do not schedule the cutover on the strength of a green test suite.** The suite is green
> because it tests the API.

---

## 0. Before you travel

| | |
| :--- | :--- |
| Reference machine (`NFR_4.1`) | Windows 10/11 x64, 4 GB RAM, dual core, 1366×768 |
| Rights needed on the store PC | **None.** The installer is per-user and never asks for administrator |
| Network needed | **None**, at install or at run (`NFR_3.1`) |
| Take with you | The signed `.exe` on a USB stick, a second blank USB stick for backups, [`HANDOVER.md`](HANDOVER.md) and [`UAT_RECORD.md`](UAT_RECORD.md) printed |

Confirm two answers before you go; both are settings you cannot sensibly change afterwards
without work:

- **Tax mode** (`TAX-001`, `Q-1`) — `NONE`, `NON_VAT` or `VAT`. Currently answered as
  **`NONE`** (not BIR-registered). Changing it after the store has traded needs `TX-425`, an
  audit row, and leaves reports straddling two modes.
- **The product list** (`Q-4`) — currently answered as small enough to key in by hand. If it
  turns out to be hundreds of SKUs in a spreadsheet, stop: `TASK-026` (CSV opening-data load)
  comes into v1.0 first.

---

## 1. Build the installer

**Build on Windows.** `electron-builder` needs Windows or `wine` to stamp the binary and
assemble NSIS; on a Linux build machine it packages the application correctly and then stops
at that step.

```bash
git clone <repo> && cd AgrivetPOS
npm ci
npm run test:all                 # the release gate — 07_TEST_PLAN.md §10
./tools/installer/check.sh       # the NSIS macros compile and say what they must
npm run build:exe                # -> dist/ChachiAgrivetPOS-Setup-1.0.0.exe
```

Signing is configured through electron-builder's standard environment variables and is not
kept in the repository:

```bash
set CSC_LINK=file://C:/path/to/certificate.pfx
set CSC_KEY_PASSWORD=...
npm run build:exe
```

An unsigned build installs, but Windows SmartScreen will warn the owner on first run — which
is exactly the moment you want them to trust the thing you just handed them.

> **`npm run build:exe` rebuilds `better-sqlite3` for the target platform.** On the build
> machine that leaves `npm test` failing with `invalid ELF header` until you run
> `npm rebuild better-sqlite3`. Run the gate **before** the build, or rebuild in between.

### What the build produces

`dist/ChachiAgrivetPOS-Setup-1.0.0.exe` — an NSIS installer with `oneClick: false`, a
selectable install directory, desktop and start-menu shortcuts, and
`requestedExecutionLevel: asInvoker`. It carries no updater and no publish target: the
application can never update itself, because a store PC that self-updates mid-shift is an
outage at the counter with a queue in front of it (`NFR_5.1`).

---

## 2. Install on the store PC

1. Copy the `.exe` from the USB stick and run it. **No administrator prompt should appear at
   any point.** If one does, stop — something is misconfigured, and an application that needs
   admin to run will need it again at every Windows update.
2. Accept or change the install directory.
3. Let it launch.

It creates, on first run:

```text
%LOCALAPPDATA%\ChachiAgrivetPOS\
  agrivet.db  agrivet.db-wal  agrivet.db-shm
  session.key
```

Nothing goes in `Program Files`, the registry is touched only by the installer's own uninstall
entry, and no service or scheduled task is created.

---

## 3. The setup wizard (`SCR-001`)

It cannot be skipped and cannot be run twice. Killing the application part-way resumes at
step 1; completing it is a single transaction.

| Step | What to enter |
| :--- | :--- |
| 1 · Store | Name, address, contact number, TIN if there is one |
| 2 · Tax | **`NONE`** for this store (`TAX-001`) |
| 3 · Owner | Username, full name, password, and a 6-digit PIN for the counter |
| 4 · Recovery code | **Written down before you tick the box** |
| 5 · Backup folder | Somewhere outside the app data folder — see below |

### The recovery code — get this right or nothing else matters

It is shown **once**, in this wizard, and never again (`SEC-5`). It is the only route back in
if the owner password is lost. It is stored only as a hash: not in the database in readable
form, not in a file, not with you.

Write it on paper, hand it to the owner, and watch them put it somewhere that is not the
drawer beside the PC. Record where, on `HANDOVER.md` §1. The checkbox is enforced on the
server, not just in the browser — you cannot click past it.

### The backup folder

Default it to `Documents\ChachiAgrivetPOS Backups`. It must be **outside**
`%LOCALAPPDATA%\ChachiAgrivetPOS` (`OPS-001`) — a backup inside the folder being backed up
survives a mistake and none of the things a backup is actually for. The application refuses a
folder inside its own data directory and says so.

If the store has a second physical drive, use it.

---

## 4. Hardware

All three are configured in **Admin → Settings** (`SCR-702`, *not built yet — see the notice
above*). Test each one before you leave.

### Receipt printer (`INT-1`)

| Setting | Value |
| :--- | :--- |
| `printer_transport` | `USB`, `LAN`, or `NONE` while you test |
| `printer_device` | For USB: the Windows share or device the bridge writes to |
| `printer_host` / `printer_port` | For LAN: the printer's address, port `9100` (raw ESC/POS) |
| `receipt_width_columns` | **32** for 58 mm paper, **48** for 80 mm |

Get the width right by printing, not by measuring. A line one character too long does not
error on a thermal head — it wraps mid-figure, and ₱1,234.56 becomes ₱1,234 on one line and
`.56` on the next. **Print on both widths if the store has both rolls** (UAT check 2).

Prove it with a test page. The endpoint is `POST /print/test`; the button for it belongs on
`SCR-702`, which is not built yet. The test page carries the `TAX-006` line like every other
document, deliberately.

### Cash drawer (`INT-2`)

The drawer hangs off the printer's RJ11 port and opens on the printer's kick pulse
(`0x1B 0x70 0x00 0x19 0xFA`). There is nothing to configure: if the printer works and the
drawer is plugged into it, a cash sale opens it.

A drawer that does not open never rolls back a sale that has already taken the customer's
money. Test it with a real ₱1 cash sale and void it afterwards.

### Barcode scanner (`INT-3`)

Nothing to install. The scanner is a keyboard: it types the barcode and presses Enter, and the
POS screen routes keystrokes to the search field wherever the focus is. Set the scanner to
**suffix Enter** if it is not already — that is the only configuration it needs.

Scan twenty times in a row at counter speed before you accept it (UAT check 1).

---

## 5. Users

Create the real cashiers in **Admin → Users** (`SCR-701`, *not built yet*) before you leave. Do not let the store trade on
the owner login — a cashier signed in as the owner can see cost prices and reach Settings, and
every audit row will name the wrong person.

| Role | Sees | Typical |
| :--- | :--- | :--- |
| `CASHIER` | The counter, their own shift's figures. **No cost prices, no settings** | Everyone on the till |
| `INVENTORY` | Products and stock, no sales | A stock clerk, if there is one |
| `MANAGER` | Everything except user administration and settings | A supervisor |
| `OWNER` | Everything, including restore | One person |

Give every cashier a 6-digit PIN: it unlocks the screen after an idle timeout without losing
the cart. Check on their own login that cost is **absent** (not greyed out) and Settings is not
on the rail (UAT check 9).

---

## 6. Cutover — the opening data

Do this on the day the store starts, not a week before. Anything entered early is wrong by
the time they start.

*The catalogue screens (`SCR-201`–`SCR-204`) are built and this half is performable today. The
customer screens (`SCR-401`–`SCR-403`) are not, so opening **credit balances** still cannot be
entered — that part waits for `TASK-037`.*

### Products

**Products** on the rail (`SCR-201`) → **New product**. For each: SKU, name, category, base
unit, and the retail price — the price is asked for at creation because a product without one
cannot be sold (`PR-102`).

The category and the unit are creatable from inside the editor, so an empty catalogue does not
send you looking for another screen before the first product.

The **base unit** is the one decision that is hard to undo — it is immutable once any stock
movement exists (`UOM-003`), and the correction is a new product. For feed sold both ways,
the base unit is **KG**, and a sack is a *pack* on top of it with factor 50,000 (`UOM-002`).
Not the other way round.

Add barcodes on the **Barcodes** tab by scanning them into the field rather than typing them —
the box keeps focus, so a run of products goes at scanner speed. A barcode belongs to one
product only (`VR-205`) and the screen refuses a clash rather than moving the code.

Packs go on the **Units** tab, and the screen states each one in words — `1 SACK = 50 KG` — so
a factor typed as 5,000 instead of 50,000 is visible rather than arithmetic nobody checks.

### Opening stock (`OPS-106`)

Post each product's counted quantity as a **`RECEIPT`** movement carrying the **opening unit
cost**. Not an adjustment: an adjustment with no cost leaves the average cost at zero, and
every gross-profit figure the store ever sees will be wrong by the whole cost of goods.

Check it afterwards on the editor's **Pricing** tab: the average cost should be what you paid.
If it reads ₱0.00, the receipt went in without a cost and the stock must be reversed and
reposted before the store trades.

Count it physically. The count you post is the number check 4 of the UAT will be measured
against.

### Opening credit balances (`OPS-107`)

For each customer who owes money: create the customer, make them credit-eligible with their
limit and terms, then post their balance as a credit transaction **dated at cutover**.

Reconcile against the store's notebook, customer by customer, and have the owner agree each
figure before you post it (UAT check 5). A credit ledger that starts wrong stays wrong: the
balance is derived from the transactions and there is no field to correct.

---

## 7. Prove it, then hand it over

Work down [`UAT_RECORD.md`](UAT_RECORD.md) — the ten checks from `07_TEST_PLAN.md` §8 plus
eight for the installer and recovery. Fill it in by hand, in ink, on the day. A pre-ticked UAT
record is not evidence of anything.

Four of them are the ones that actually decide whether the system is safe to leave:

- **Pull the mains plug mid-sale** (check 7). Not a shutdown — the plug. It is the only test
  that establishes durability against a power cut; the automated `TC-E2E-09` kills a process,
  which does not empty the operating system's write cache.
- **Take the network off at the wall** (check F). Wi-Fi off and cable out, then trade a full
  day. Aeroplane mode is not enough.
- **Restore a backup onto a second machine** (check G). Until this has been done once, the
  store's backups are untested where it counts.
- **Read `TAX-006` on paper** (check 10). On the printed receipt, in the store's own tax mode.
  It is a legal requirement about a physical document handed to a customer.

Then go through [`HANDOVER.md`](HANDOVER.md) with the owner — sections 1 and 2 out loud — and
get both signatures.

---

## 8. Upgrading later

Updates arrive as a signed `.exe`, by hand or on a USB stick. There is no auto-update and
there will not be one.

1. **Close every shift** and quit the application.
2. Run the new installer over the existing one, same directory.
3. Launch it.

On that first launch the application:

- takes a **backup of the current database and verifies it** before running a single migration
  statement, because migrations are forward-only and never edited (`§8.9`) — that backup is
  the only way back;
- runs the pending migrations, each in its own transaction;
- if the backup cannot be taken or verified, **does not migrate at all** and says so, leaving a
  working store on the previous version rather than a broken one on this;
- if a migration fails, leaves the database at its previous version and names the backup file.

A database written by a **newer** version refuses to open, by name and version number. Install
the newer build again; running an older binary against a newer schema loses data.

Check afterwards, in **Admin → Health**: the schema version, and that the last verified backup
is the pre-migration one you just took.

---

## 9. Uninstalling

Windows **Settings → Apps → Chachi Agrivet POS → Uninstall**.

It removes the application. It does **not** remove:

- `%LOCALAPPDATA%\ChachiAgrivetPOS\` — the database lives here;
- the backup folder, whose location the installer has never been told.

The uninstaller says both on screen before it does anything. Reinstalling finds the same data
and carries on.

To decommission a machine properly, take a final backup, copy the folder off, and *then*
delete the data folder by hand.

---

## 10. When something is wrong

Open **Admin → Health** first. The version and the last verified backup answer most questions.

| Symptom | Where to look |
| :--- | :--- |
| Nothing prints | `printer_transport` and the width. `Admin → Settings → Print test page`. A failed print queues for reprint and never loses the sale |
| The drawer does not open | It opens on a **cash** sale only. Check the RJ11 cable at the printer, not the PC |
| The scanner types into the wrong place | It needs an Enter suffix. Without one, the POS reads it as typing, not a scan |
| "No verified backup for N hours" | The folder is missing or the drive is unplugged. This warning cannot be dismissed, deliberately |
| Dates on new records are wrong | The PC's clock. Selling is unaffected — receipt numbers do not come from the clock (`VR-103`) — but fix it |
| The owner password is lost | The recovery code from wizard step 4. If that is lost too, the data cannot be reached |
| A cashier sees cost prices | They are signed in on the wrong account. Cost is absent for every role but `OWNER` |
| A rail item says "not built yet" | It is one of the nine screens still in the gap. The API exists; the screen does not |
| The base unit cannot be changed | Deliberate (`UOM-003`): stock has moved and every movement is recorded in that unit. Make a new product and move the stock across |
| The application will not start | The message says why. A database ahead of the binary, or a failed pre-migration backup, are the two that stop it deliberately |

The audit trail answers "who changed this" — `GET /audit` today, `SCR-703` once it is built. Every price change, cost
change, credit limit change, adjustment, void, reprint, user change, settings change, export
and restore is on it, with both actors where an override was involved.

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
