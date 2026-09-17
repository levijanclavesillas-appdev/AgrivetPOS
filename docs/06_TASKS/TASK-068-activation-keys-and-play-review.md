# TASK-068 — Activation keys, and a store for Google Play's reviewers

**Priority:** **P1**, it blocks the Play Store submission · **Rules:** `LIC-001`, `LIC-004`,
`LIC-008` (new, `PHARMACY_EDITION.md` §6) · **Follows:** [TASK-048](TASK-048-google-sign-in-and-subscription.md),
[TASK-067](TASK-067-one-time-licence-and-admin-override.md) · **Tests:** `licence-server/test/server.test.js`,
`src/tests/integration/licence.test.js`, `renderer.test.js` · **Status:** built and live 2026-09-17

## The ask

Google Play's *Sign in details* declaration (formerly *App access*) says:

> To review your app, we need to be able to access all parts of it using sign in details … We
> can't create new accounts, use personal accounts to make purchases, or use free trials to
> review your app.

A reviewer could not get past `LIC-001`:

- **What it needs.** A POS opens no shift until its owner links it.
- **What linking took.** A Google sign-in, approved in a browser, usually on another device.
- **Why Play refuses.** It will not do either one.

The owner (2026-09-17): "yes proceed with the activation keys and set up the review store".

## As built

**The rule.**

| ID | Rule |
| :--- | :--- |
| `LIC-008` | An activation key, made by Chachi's admin for one store, links a POS to that store with no Google sign-in. Only the owner enters it. Each key has a number of devices (1–100) and a number of days (1–365). Each device it links uses one, and the same device entering it again uses nothing more. A withdrawn or expired key links nothing new, and the devices it already linked stay until they are removed |

**The licence server.**

- **Where keys are kept.** `activation_keys` holds the store, the key's SHA-256, a label, the
  uses and their limit, the expiry, and when it was withdrawn. Nothing else changed in the schema:
  - the key itself is never stored;
  - `installations.activation_key_id` records which key linked a device.
- **Making one.** `createActivationKey` makes the key: 16 characters from the link-code
  alphabet, in fours (about 77 bits).
- **Using one.** `activate` checks the key, counts the use, and seats the device through
  `seat()`, the helper the Google link now shares. It returns the licence and the renewal secret
  in the same response.
- **The endpoint.** `POST /api/v1/device/activate` is limited to 10 requests a minute per
  address.
- **The admin page.** A store's page has an *Activation keys* card:
  - **Making a key.** Give it a label, a number of devices and a number of days.
  - **Seeing the key.** It is shown once, on the page that answers the form, and never again.
  - **The list.** Each key shows its uses and expiry, and is *active*, *used up*, *expired* or
    *withdrawn*, with a *Withdraw* button.
  - **Devices.** A device linked by a key is tagged *by key*.

**The POS.**

- **The service.** `licenceService.activate` refuses anyone but the owner (`LIC-004`) and a key
  that is not 16 characters. It then asks the licence server and saves what comes back.
- **Audit.** A link by key is audited as `LICENCE_LINKED`, with `by: 'ACTIVATION_KEY'`.
- **The route.** `POST /licence/activate`.
- **`SCR-707`.** Under the status, the owner has **Or enter an activation key**:
  - the field takes the key however it is typed;
  - the screen keeps what was typed while it redraws;
  - it is hidden while a Google link code is waiting.
- **Shared code.** `openExternally` moved to `shell/ui.js`.

**Tests.**

- **Licence server: 22** (was 20).
  - **The first.** A key made through the admin form:
    - shown once, and stored only as a hash;
    - it links two devices and refuses a third;
    - the same device again uses nothing more;
    - it renews;
    - a wrong key is refused.
  - **The second.** Expiry and withdrawal:
    - devices the key linked stay until removed;
    - a store with keys and no devices can still be deleted.
- **POS licence suite: 13** (was 12). An owner links with a key:
  - a cashier is refused;
  - a short key and a wrong key are refused, and leave the old licence alone;
  - the link is audited and renews.
- **`renderer.test.js`.** The key form.
- **Suites.** Unit, integration and e2e all pass.

## Live, 2026-09-17

- **The licence server.**
  - **Backup.** A copy of its database was taken first:
    `/var/lib/chachi-licence/licences.db.before-task-068-20260917-082052`.
  - **The rebuild.** It was rebuilt and is healthy. A wrong key is refused with 403.
- **The web image.** `chachi-pos:latest` was rebuilt. `demo` and `nam-nam` were **not**
  restarted, so they get the key screen at the next `web/store.sh upgrade`.
- **The review store.**
  - **The web store.** `web/store.sh create play-review` made
    `https://pos.chachisoftware.store/s/play-review/`, set up as a Pharmacy with tax mode `NONE`.
  - **Its owner.** The login is `reviewer`.
  - **Its products.** Six OTC products with stock and barcodes, loaded through the opening data.
    They are named by generic name, with no third-party brands (renamed 2026-09-17, for Play's metadata policy).
- **Its licence.** On the licence server it is *Chachi POS Review Store*:
  - **Plan.** One-time, not a trial, as Play requires.
  - **Registered to.** `chachisoftware@gmail.com`.
  - **Key.** *Google Play review* covers 25 devices and runs until 2027-09-17.
  - **The web copy.** It was linked with the key.
- **The credentials.** The password, the recovery code and the key are in
  `/root/play-review/credentials.txt`, readable by root only.
- **Checked on the web copy.** A shift opened, and a sale of two paracetamol tablets went through as
  `SALE-20260917-000001` (₱12.00, ₱8.00 change). The shift was then closed.
- **Checked as a reviewer's phone would do it.** A fresh local POS stood in for the phone:
  1. It connected to `pos.chachisoftware.store/s/play-review` as `reviewer`.
  2. Opening a shift was refused (`LIC-001`).
  3. The key was accepted: *Active, one-time*.
  4. The shift opened, and a barcode found the syrup.
  5. The shift was closed.
  6. The device was removed from the store and from the licence server.

  The key shows *2 of 25*.

## Sign in details for Play Console

Answer **Yes**, parts of the app are restricted. The instructions (the password and key are
in `/root/play-review/credentials.txt`):

1. On first launch, choose **Connect to a store on the web**.
   - Address: `pos.chachisoftware.store/s/play-review`
   - Username: `reviewer`
   - Password: from the file
2. Sign in with the same username and password.
3. Open **Admin → Subscription**, enter the activation key under **Or enter an activation
   key**, and press **Activate**.
4. Open **Counter**, open a shift with opening cash 0, and sell. The products have barcodes
   4800000000017 to 4800000000062, or can be searched by name.

## Still open

- **The Android app.** It has to be rebuilt from this commit before it is submitted, or it has
  no key field.
- **Other web stores.** `demo` and `nam-nam` get the key field at the next `web/store.sh
  upgrade`, which restarts them.
- **Upkeep.** Each review adds a device to `play-review` and uses a seat. Remove old devices
  from the licence admin page, or make a new key, when the 25 run out or the key expires.
