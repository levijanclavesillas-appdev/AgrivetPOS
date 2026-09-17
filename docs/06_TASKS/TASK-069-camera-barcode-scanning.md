# TASK-069 — Scanning barcodes with the device's camera

**Priority:** **P1**, most small stores have a phone and no scanner · **Blocks release:** no ·
**Rules:** `INT-3`, `POS-101`, `SEC-10`, `NFR_3.1` · **Follows:** `TASK-015` (the counter),
`TASK-049` (Android), `TASK-052` (the camera for product pictures), `TASK-062` (the web version) ·
**Status:** open, 2026-09-17

---

## The ask

The owner (2026-09-17): "make a task to allow scanning of barcode using device camera."

**Today a barcode reaches the POS in one way only:**

- **How.** A USB or Bluetooth scanner that types the code and presses Enter.
- **Where it is read.** `public/js/shell/scanner.js` (`INT-3`) tells a scan from typing by its
  speed.
- **What is missing.** A store with only a phone or tablet, the common case for a sari-sari
  store (TASK-070), types every code by hand or searches by name.
- **The camera today.** The Android app uses the camera for one thing: a product's picture,
  through the phone's camera app (`TASK-052`).

## Before starting — 3 answers are needed

**1. On Android, which scanner?** Recommended: **Google's code scanner (ML Kit, through Play
services).**

- **Why it fits.**
  - Play services shows its own scanning screen and hands back only the code, so the app needs
    **no camera permission**. That keeps the Play review and the privacy policy simple.
  - It reads fast and works offline once its module is on the phone.
- **The cost.** It needs Google Play services. A phone without them, some Huawei phones for
  example, falls back to the web scanner in answer 2, and that path needs the camera permission.
- **The alternative.** The web scanner everywhere: one code path, but the camera permission on
  every Android install.

**2. On the web and on Windows, which decoder?** Recommended: **the browser's own
`BarcodeDetector` where it exists, and a vendored pure-JavaScript ZXing build where it does not.**

- **Where the built-in one is missing.** `BarcodeDetector` is in Chrome on Android and macOS.
  It is **not** in Chrome or Electron on Windows or Linux.
- **Why pure JavaScript.** A WebAssembly decoder would need `'wasm-unsafe-eval'` in the
  shell's CSP, and `renderer.test.js` refuses any exception there.
- **The cost.** About 400 KB of vendored script.

**3. Which barcodes?** Recommended:

- **Read:** EAN-13, EAN-8, UPC-A, UPC-E (retail goods), Code 128 and Code 39 (store-printed
  labels, suppliers' cartons).
- **Not read:** QR codes. A QR Ph code is a payment, not a product, and reading one as a product
  would only confuse the counter.

## Objective

A cashier with only a phone, a tablet or a laptop's webcam scans a product at the counter, and the
product lands in the cart exactly as a USB scanner's would.

## Requirements

1. **At the counter.**
   - **The button.** `SCR-301` has a **Scan with camera** button beside the search field. It is
     shown only when the device has a camera, and it has a keyboard shortcut in the keymap.
   - **What a read does.** A code read goes through the same path as a wedge scan (`onScan` →
     `GET /products/barcode/:code`), with the same outcomes:
     - a product;
     - a pack, which sells a pack (`TASK-055`);
     - "not found", with the option to search.
2. **Scanning many items.**
   - **The camera stays open.** Each read adds the item, beeps or vibrates, and shows the item's
     name for a moment.
   - **The same code again.** It is read again only after a short pause (default 1.5 s). A
     code held in front of the lens does not add ten items.
   - **Closing.** **Done** closes the camera. So do Esc and the back button.
3. **Other places a barcode is typed.** The same button appears on:
   - the product editor's barcode field (`SCR-202`), where it fills the field and adds nothing;
   - the stock count sheet (`SCR-205`);
   - receiving a delivery (`SCR-803`);
   - the returns lookup (`SCR-305`).
4. **The Android app** (answer 1).
   - **The bridge.** `ChachiAndroid.scanBarcode(formats)` opens Google's scanner and returns the
     code to the page through a callback.
   - **Scanning many items.** The page reopens the scanner after each read until the cashier
     presses Done, because Google's scanner reads one code at a time.
   - **Without Play services.** The page falls back to requirement 5, with a runtime camera
     permission request (`CAMERA`, asked only when first used). The WebView then needs
     `onPermissionRequest` for video capture.
5. **The web version and Windows** (answer 2).
   - **The camera.** It opens with `getUserMedia`, preferring the rear camera.
   - **The decoder.** `BarcodeDetector` where available, else the vendored decoder. Frames are
     decoded in memory, a few a second, and never stored or sent anywhere.
   - **Permissions.** A web store needs HTTPS, which it has, and the browser's camera
     permission. A refusal shows a sentence saying how to allow it.
   - **Electron.** It grants `media` only to the POS's own origin, through
     `session.setPermissionRequestHandler`.
6. **Light and focus.** A torch button where the camera has one. A guide box on the video
   shows where to hold the code.
7. **Policy and privacy.**
   - **Privacy policy.** The Android table gains *Camera (scanning)*:
     - frames are read on the device and never stored;
     - no picture is kept;
     - with Google's scanner, the app itself gets only the code.
   - **The Data safety form** is unchanged: no photos or videos are collected.
8. **Offline.** Scanning works with no internet on every platform (`NFR_3.1`). Google's
   scanner module is downloaded by Play services ahead of time; until it is there, the page
   uses requirement 5.

## Business rules

- `INT-3`. A camera read is a scan: it is not typing, and it goes where a wedge scan goes. The
  rule gains the camera as a second source.
- `POS-101`, `TASK-055`. What a code sells is unchanged.
- `SEC-10`. No picture leaves the device. With the web decoder, no picture leaves the page.

## Technical requirements

| Area | Detail |
| :--- | :--- |
| Renderer | `public/js/shell/camera-scan.js`: the overlay, the loop, the shared "a code arrived" path, the repeat pause, the torch. Its decoder is chosen once: the Android bridge, `BarcodeDetector`, or the vendored ZXing |
| Vendored decoder | `public/vendor/zxing/` (Apache-2.0), with its licence, loaded only when needed. No `eval` and no WebAssembly, so the CSP is unchanged |
| Android | `app/build.gradle.kts` adds `com.google.android.gms:play-services-code-scanner`. `MainActivity`: `scanBarcode` in the bridge, `onPermissionRequest` for the fallback, and `CAMERA` in the manifest only if the fallback is kept (answer 1) |
| Electron | `main.js`: a permission handler that allows `media` for `http://127.0.0.1:<port>` only |
| Hosted | nginx sends `Permissions-Policy: camera=(self)` for `/s/<store>/` |
| Screens | `SCR-301`, `SCR-202`, `SCR-205`, `SCR-803`, `SCR-305`, and the keymap (`04_UX_SPEC.md` §7) |
| Docs | The privacy policy's Android table; the guide's *Selling* chapter; `android/README.md`; the Play listing (a screenshot of scanning, optional) |

## Acceptance criteria

- [ ] **Android phone.** On a phone with Play services, the camera button adds three different
      products and a box to the cart in one session. The app asks for no camera permission.
- [ ] **Android without Play services** (or with the module blocked). The web scanner opens
      after one permission prompt and adds a product.
- [ ] **Web store.** On a phone browser at `pos.chachisoftware.store/s/<store>/`, the rear
      camera reads an EAN-13, and the item lands in the cart.
- [ ] **Windows app.** A laptop webcam reads a Code 128 label through the vendored decoder.
- [ ] **Repeats.** Holding one code in front of the camera for 5 seconds adds it once. Showing
      it again after the pause adds a second.
- [ ] **Unknown code.** It says so and offers to search. Nothing is added.
- [ ] **Product editor.** Scanning fills the barcode field and does not touch the cart.
- [ ] **Permission refused.** The screen says how to allow the camera, and typing and a USB
      scanner still work.
- [ ] **Offline.** With the network off, scanning still works on Android and Windows.
- [ ] **Tests.** `renderer.test.js` still passes its CSP test with no exception added.

## Tests

- **`renderer.test.js`.**
  - A camera read and a wedge scan call the same handler.
  - The repeat pause.
  - The button is hidden without `mediaDevices` or the bridge.
  - The formats list.
  - No script from outside `public/`.
- **Unit tests for `camera-scan.js`'s decision logic** (pure, as `scanner.js` is): what a read
  does when a dialog is open, a repeat, an unknown code.
- **Android.** A debug build's manifest has no `CAMERA` permission (answer 1). This is checked
  from the merged manifest, because this build machine cannot run an emulator.
- **The walk on real devices.** It is recorded in this file: an Android phone, a phone browser
  and a Windows laptop.
