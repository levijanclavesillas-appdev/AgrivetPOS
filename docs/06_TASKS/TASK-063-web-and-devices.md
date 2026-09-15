# TASK-063 — One store on the web and on its devices

**Priority:** **P1** · **Rules:** `SYNC-001`–`SYNC-005` (new, `PHARMACY_EDITION.md` §12), `POS-108`, `INV-101`, `CR-103`, `PO-102` · **Tests:** `sync.test.js`, `renderer.test.js`

## The ask

The store owner (2026-09-15): the web version is always online, and only the desktop and mobile
apps work offline. A client may start on mobile or on the web, and should have both no matter
where they started.

The owner's decisions:

- **Offline scope:** the counter, stock and customers all work offline.
- **Receipt numbers:** one series per device.
- **Sync:** the web copy is the hub.

## As built

- **Roles.** An installation is `STANDALONE` (as before, and nothing here runs), the store's
  web copy (`HUB`), or one of its devices (`DEVICE`). A hosted copy is its store's hub. A hub's
  backup restored on a PC is standalone.
- **Change capture.** Triggers are generated at launch from the live schema, so a later
  migration's columns are covered without editing them. They record every insert, update and
  delete on the synced tables into `sync_changes`, and an update names its changed columns
  (`907_sync.sql`, `syncRepository`). `config/syncTables.js` lists what is never synced: carts,
  backups, licence, clock checks, dismissed alerts, the sync tables themselves, and each
  machine's printer and backup-folder settings.
- **Exchange.** A device pushes its captured rows (`POST /sync/push`, only the changed columns
  for an update) and pulls the hub's log as whole rows (`GET /sync/pull`). It pulls only once
  nothing of its own is waiting, and pushes first when something is. The hub applies a push as
  that device, column by column and idempotently, with foreign keys checked at the end.
  - A customer code conflict gets the device's letter.
  - An orphan row is dropped.
  - Both are audited `SYNC_CONFLICT`.
  - The hub then recomputes stock on hand, customer balances and purchase-order status from its
    merged ledgers.
  - The log is pruned through the lowest version every live device has pulled.
- **Numbers.** Each device's documents carry its letter (`sequenceService`), each series
  gapless. The hub continues the store's own series.
- **Device authentication.** `Authorization: Device <id>.<secret>`. The secret is shown to the
  device once, and the hub keeps a SHA-256 hash, compared in constant time. The owner connects a
  device (`TX-423`) and can remove it.
- **Offline rules** (`middleware/sync.js`). On a device without a recent answer from its hub,
  products, categories, brands, units, users, own password and PIN, settings, the store profile,
  customer prices and data loads are refused with `SYNC-005`. Everything else trades on. After
  any write the device syncs within a couple of seconds, and every 15 seconds anyway.
- **Web first.** The wizard's *Connect to a store on the web*. The owner signs in to the hub
  (`POST /setup/connect`); the hub registers the device and hands over a snapshot, which the
  device installs. The device keeps its own licence seat, printer and backup folder.
- **Mobile first.** *Admin → Web & devices → Put this store on the web*. The device installs its
  triggers first, uploads its snapshot into the waiting hub with the setup code (restoring there
  as the store's first device), signs in and registers as device A. Changes made during the
  upload are pushed after it.
- **Screens.**
  - *Admin → Web & devices* (owner): the device list on the hub, the status and *Sync now* on a
    device, and the go-online form on a standalone store.
  - A sync indicator at the foot of the menu on a device: *Synced* or *Offline · 3 waiting*.
  - The wizard's connect path.

## Tests

`sync.test.js` runs every installation as its own server process on its own database, over
HTTP:

1. **Web first.** A hub is set up and stocked. Device A connects; a wrong password is refused.
   A starts with the hub's stock, its own backup folder and printer, and appears in the hub's
   list.
2. **Numbering.** A sells `SALE-A-…-000001`, and the hub counts it.
3. **Offline.** With the hub stopped, A's sync reports unreachable (`SYNC-004`). A sells on
   credit (`SALE-A-…-000002`, gapless) and adds a customer. Renaming a product is refused
   (`SYNC-005`), and changes wait.
4. **Merge.** The hub comes back, sells (`SALE-…-000001`, its own series) and renames the
   product. A syncs, and both agree: stock 94 of 100 on both, all three sales on both, the
   rename on A, A's customer on the hub, and the offline credit sale on the balance on both.
5. **Second device.** Device B joins as letter B with everything so far. Its sale reaches A,
   and stock is 93 on A.
6. **Conflict.** A and B each give a customer the code `DUP` offline. The hub, A and B all end
   with `DUP` and `DUP-B`, and the conflict is audited.
7. **Removal.** The owner removes B, and B's sync is refused (`SYNC-001`).
8. **Mobile first.** A standalone store with a sale goes online; a wrong setup code changes
   nothing. The hub has its history and stock, and the phone becomes device A. The phone's next
   sale is `SALE-A-…-000001` and reaches the hub. The hub's next sale continues the store's
   original series (`…-000002`).

`renderer.test.js` checks the wizard's connect path, the Admin tab and the rail indicator.

Walked in the renderer with separate server processes:

- **Web first.** A fresh install connected through the wizard ("Botika sa Web is on this device
  as Counter 1, letter A"), signed in, and showed *Synced* in the menu and its status in
  *Web & devices*.
- **The hub.** It listed Counter 1 (A), last synced, up to date.
- **Mobile first.** A standalone store with a sale went online from *Web & devices*. It became
  device A, and its sale was on the new web copy.

## Known limits

- **Average cost.** When two devices receive the same product offline, the average cost is the
  one from whichever receipt synced last.
- **Running balance.** A movement's `balance_after` is the balance as its device saw it.
- **Restoring the web copy.** Its devices must connect again.
- **Updates.** A device and its web copy must be on the same version, so upgrade the web copy
  first.
- **Licence seats.** Each device links its own seat.
