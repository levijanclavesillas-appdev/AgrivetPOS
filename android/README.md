# Chachi Pharmacy POS for Android

**TASK-049**: the whole store on one tablet, with no PC. The app is the same server and
the same screens as the Windows build. `src/` and `public/` are packaged into the APK
unchanged, and Node runs inside the app ([nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile),
Node 18.20.4). Every business rule, report and backup behaves the same as on the PC, because
it is the same code.

## What you need

- **Android Studio** (2025.2 or later), with the **NDK 28.2.13676358** and **CMake 3.22.1**
  installed from *Settings → Languages & Frameworks → Android SDK → SDK Tools*.
- **Node.js 18 or later** on the `PATH`. The build uses it to package the server.
- This repository, with **`npm install`** run once in its root (the folder above this one).
  The build takes the server's dependencies and better-sqlite3's C source from `node_modules`.
- An internet connection **the first time**. The build downloads the Node runtime for Android
  (57 MB), checks it against a pinned SHA-256, and keeps it in `app/libnode/`.

## Build an APK

In Android Studio: **File → Open** and choose this `android` folder. Let it sync, then
**Build → Build App Bundle(s) / APK(s) → Build APK(s)**.

From a terminal, in this folder:

```sh
./gradlew assembleDebug          # Windows: gradlew.bat assembleDebug
```

The APK is `app/build/outputs/apk/debug/app-debug.apk`. Copy it to the tablet and open it
to install, allowing installs from that source when Android asks.

### A release build, signed with the store's own key

A debug build works, but it is signed with a key that exists only on the machine that built
it, so a later build from another machine cannot update it in place. For the store, make a
key once and keep it safe (lose it, and the app can never be updated, only reinstalled):

```sh
keytool -genkeypair -v -keystore chachi-pos.jks -alias chachi -keyalg RSA -keysize 4096 -validity 10000
```

Then create `android/keystore.properties` (it is git-ignored):

```properties
storeFile=chachi-pos.jks
storePassword=…
keyAlias=chachi
keyPassword=…
```

and build with `./gradlew assembleRelease`. The APK is
`app/build/outputs/apk/release/app-release.apk`.

## On the tablet

- **First launch** asks where backups may go. Allow *all files access*: backups then go to
  `Documents/ChachiPharmacyPOS Backups`, which survives the app being removed and can be
  copied off over USB. If you say *Not now*, backups go to the app's own folder and are
  **deleted if the app is uninstalled**. `05_TECH_SPEC.md` §7 still applies: a copy off the
  tablet is the owner's job, and matters more when the tablet is the only machine.
- **The setup wizard** is the same as on Windows, including step 6, the Excel workbook. The
  workbook is chosen with Android's file picker. A downloaded template or export goes to
  **Downloads**.
- **Receipt printer**: use a **network (LAN/Wi-Fi) ESC/POS printer**. In *Admin → Settings*,
  Sales section, set the printer connection to `LAN` and give its address. The port is 9100,
  ESC/POS's raw port. A USB printer on the PC's print share is a Windows arrangement and does
  not exist on a tablet. Bluetooth printers are not supported yet.
- **Barcode scanner**: any USB or Bluetooth scanner in keyboard mode works, as on the PC.
- **Screen**: phones and tablets, in either orientation (`TASK-051`). On a phone the menu is
  behind the ☰ button at the top; on a tablet it is the icon rail down the side. The POS
  puts the cart on top and the total and **PAY** under it when the screen is narrow.

## How it fits together

| Piece | What it does |
| :--- | :--- |
| `app/build.gradle.kts` | Fetches and verifies the Node runtime, stages the server, builds the native code |
| `scripts/stage-node-project.js` | Packs `src/` (without tests), `public/` and the production `node_modules` into `nodejs-project.zip`, one asset |
| `node/main.js` | The server's entry point on the tablet. Everything after it is `src/` |
| `app/src/main/cpp/` | `native-lib` starts Node on its own thread; `better_sqlite3` is better-sqlite3's addon compiled for the tablet |
| `NodeRuntime.java` | Unpacks the server on first launch and after updates, sets its environment, starts it once |
| `MainActivity.java` | The WebView, the file picker, saving downloads, and the backup-folder question |

The server learns everything about the tablet from its environment: `AGRIVET_DATA_DIR` (the
app's private storage), `AGRIVET_PORT`, `AGRIVET_SQLITE_ADDON` (`src/config/sqlite.js`) and
`AGRIVET_BACKUP_SUGGESTION` (`setupService`). Nothing else in `src/` knows it is on Android.

### Diagnosing

`adb logcat -s ChachiNode ChachiPOS` shows the server's own output and the app's. On a debug
build, `chrome://inspect` on the PC opens the tablet's WebView in DevTools.

## Known limits

- **Other apps on the tablet can reach `127.0.0.1:47800`.** Everything but setup and health
  needs a signed-in session, so they can do nothing without a password. Until the wizard
  finishes, though, an app could in principle complete setup first. Set up the store on the
  day you install the app, before installing anything else.
- **The store's data lives on the tablet.** Losing the tablet without a backup copied off it
  loses the store.
- Built and packaged on a Linux build machine, and **not yet run on a tablet or an
  emulator**. The first install on the store's tablet is the first real run; check the
  wizard, a sale, a printed receipt and a backup before trading on it.
