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

## How B is built

**`src/` runs on the tablet unchanged.** nodejs-mobile (Node 18.20.4) is embedded in the APK and
starts the same server the Windows build starts, on `127.0.0.1:47800`. A WebView shows the same
renderer. The alternative, porting the services to run in the WebView, would have forked every
business rule and every test. This way there is one product.

**Checked before the Android work started:** the whole integration and e2e suite (631 + 207
cases) passes on Node 18.20.4 with better-sqlite3 built for it. The 18 renderer unit tests that
fail there load browser ES modules through Node 20's `require()`, which is a test-harness
feature and not something the tablet runs.

| Piece | Where |
| :--- | :--- |
| The one server change: better-sqlite3's addon can be loaded from a path the app gives (`AGRIVET_SQLITE_ADDON`) | `src/config/sqlite.js`, used by `config/database.js` and `repositories/backupRepository.js` |
| The backup folder the wizard suggests comes from the app on Android (`AGRIVET_BACKUP_SUGGESTION`) | `setupService.suggestBackupFolder` |
| Downloads on Android go through the app's bridge; a WebView cannot save a blob | `public/js/shell/api.js` `saveAs` |
| The Android project, its build and its README | `android/` |

The native addon is compiled by Android Studio's CMake from better-sqlite3's own source, with
its SQLite options and the runtime's V8 settings (no pointer compression). The Node runtime is
downloaded on first sync and checked against a pinned SHA-256. The server ships as one zip
asset, because Android's asset packager drops the dot-files and `_`-directories that
`node_modules` contains.

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

## The first run on a phone, and what it found

The client installed the build on a phone. Two things came back.

**A red error straight after sign-in.** nodejs-mobile's Node is built **without ICU data**: no
time-zone database and no collation, which the build machine's Node has. `config/clock.js` asked
`Intl.DateTimeFormat` for `Asia/Manila`, which throws `RangeError: Invalid time zone specified`
there. Signing in formats no date, but the dashboard does, on its first request. Manila time is
now arithmetic, since Philippine time has been a constant UTC+8 since 1990. The one server
`localeCompare` (sales analysis) is a plain comparison. `no-icu.test.js` holds the arithmetic to
Intl's answer on 20,000 instants, runs it in a Node whose Intl knows no time zones, and fails if
any server file uses `Intl`, `localeCompare` or `toLocale…` again. The whole integration and e2e
suite also passes with time zones and collation disabled, as on the phone. The old clock, under
the same conditions, throws exactly the phone's error.

**The screens did not fit a phone**, and the app was locked to landscape. `TASK-051`.

## What was verified, and what was not

- **Built**: `./gradlew assembleDebug` succeeds from a clean checkout on a Linux build machine,
  and produces a 42 MB APK for arm64-v8a and x86_64.
- **The addon links to the runtime**: it exports `node_register_module_v108`, which is Node
  18's module version. Every one of the 58 Node and V8 symbols it imports is exported by the
  bundled `libnode.so`. The JNI entry point matches `NodeRuntime`.
- **The staged server runs**: unpacked from the APK's own asset and run with the environment
  the app sets, it migrates a fresh database through an addon loaded by path, answers
  `/health`, serves the renderer and suggests the app's backup folder. `sqlite-addon.test.js`
  holds the loading mechanism in the suite.
- **The server runs on the app's Node**: the integration and e2e suites pass on Node 18.20.4.
- **Not run on Android.** An emulator was tried on the build machine and killed by its own
  memory cap twice. The machine is shared and had under 2 GB free. The first install on the
  store's tablet is the first real run; `android/README.md` says what to check before trading.

**Status — 2026-09-14:** built and committed on the `pharmacy` branch; not yet run on a
device.

## Addendum, 2026-09-17: no "all files access"

Google Play asked for a declaration of `MANAGE_EXTERNAL_STORAGE`, which it permits only for
file managers, backup apps and the like. A point of sale is not one of those, so the permission
was removed.

- **Where backups go.** Still `Documents/ChachiPOS Backups`.
- **Android 11 and later.** An app creates and writes its own files there with no permission.
  `MainActivity` checks with a probe file at launch, and uses the app's own folder if the probe
  fails.
- **Android 8–10.** The app keeps `WRITE_EXTERNAL_STORAGE` (`maxSdkVersion` 29) and legacy
  storage.
- **What is lost.** After a reinstall, the Backups list does not show the backups the previous
  install made, because they are not this install's files. *Restore from a file* opens them
  through Android's picker, which needs no permission.
- **What is gone.** The first-launch dialog on Android 11+ and its strings.
- **Checked here.** A debug build succeeds, and its merged manifest has no
  `MANAGE_EXTERNAL_STORAGE`.
- **Still to do.** Confirm on a real phone (Android 11+) that a backup lands in Documents, and
  that *Restore from a file* opens one after a reinstall.

