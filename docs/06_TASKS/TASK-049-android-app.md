# TASK-049 — An Android build the client compiles themselves

**Priority:** **P2** · **Blocks release:** no · **Decided:** `A-1` = **B, a standalone store on
the device** (client, 2026-09-14) · **Requirement:** `D-2` (Android was deferred to
v1.3 "Network"), `02_PRD.md` §1, `05_TECH_SPEC.md` §1, `SEC-8`

---

## Objective

Give the client Android project source they can open in Android Studio and build into an APK on
their own machine.

## Context

The client asked:

> can you do the codes for android and ill just build the apk on my local device?

The specs already place Android: `02_PRD.md` §1 puts an **Android companion** in v1.3
"Network", next to LAN multi-terminal, and `05_TECH_SPEC.md` §1 says LAN terminals and the
Android companion "become clients of the same API". The renderer in `public/` is plain HTML,
CSS and ES modules with no build step, so it can run in an Android WebView unchanged.

**What the renderer depends on is the server**, which is Node, Express and `better-sqlite3`, a
native module. That is what separates the two options, and why this cannot start until one is
chosen.

## The decision

| # | Option | What it is | Size |
| :-: | :--- | :--- | :--- |
| `A-1` · **A** | **Companion / second till** | An Android app (WebView shell) that connects to the store PC's server over the shop Wi-Fi. The PC stays the one database; the phone or tablet is another counter. | Small on the app side. On the server side it needs `SEC-8`'s **device pairing and authentication** before the API may listen on the LAN, which is a security task in its own right |
| `A-1` · **B** | **Standalone store on the device** | The whole product on the tablet: its own database, no PC. | Large. The Node server would have to run on Android (nodejs-mobile, with `better-sqlite3` compiled for ARM) or be ported. Backups, printing and the cash drawer each need an Android answer |

**The client chose B.** A was recommended, being what the specs plan and much smaller. B is what
the store wants: a tablet that is the whole store, with no PC. What B commits to is recorded
below, so the size is known before the work starts.

## What B has to answer

1. **Where the server runs.** The renderer needs the API. On the device, that means Node on
   Android (nodejs-mobile) running `src/` unchanged, or the services ported to run inside the
   WebView. Running `src/` unchanged keeps every business rule and test as it is.
2. **The database.** `better-sqlite3` is a native module and has to be compiled for Android's
   ARM ABIs as part of the client's own build (the NDK in Android Studio).
3. **Backups** (`OPS-001`, `OPS-003`) go to the device's shared storage or an SD card. The
   tablet is the only copy of the store's data, so `05_TECH_SPEC.md` §7's off-machine copy
   matters more, not less.
4. **Printing and the cash drawer**: a Bluetooth ESC/POS printer, whose drawer port opens the
   drawer.
5. **Screen size**: `TASK-045` designed for 1366×768; a 10-inch tablet in landscape is close to
   that, and a phone is not in scope for B.

## Requirements (option A, recorded for the day a second till is wanted)

1. `android/` holds a Capacitor (or plain Android Studio) project whose WebView loads the paired
   store server's URL. It builds with `./gradlew assembleDebug` / `assembleRelease` and needs no
   step on this repo's side.
2. **Pairing** (`SEC-8`): the owner shows a one-time pairing code or QR on the PC; the device
   exchanges it for a device credential; the server accepts LAN requests **only** from paired
   devices, and a device can be revoked. Until this exists, the server stays on `127.0.0.1`.
3. The device signs in as a user like any till. `SEC-7` holds: the token is in memory only.
4. Printing from the device: Bluetooth ESC/POS, or print through the PC (to be decided with
   the store's hardware).
5. Works at a phone's width as well as a tablet's. `TASK-045` designed for 1366×768; narrow
   layouts need their own pass.

## Tests (to be numbered when started)

Pairing, revocation, and refusal of unpaired LAN clients (integration); the renderer at 390 px
and 800 px widths (browser smoke); a sale from the device reconciles on the PC.

**Status — 2026-09-14:** **not started.** `A-1` answered: B.
