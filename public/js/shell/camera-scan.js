// INT-3's second source: a barcode read by the device's own camera (TASK-069).
//
// A camera read is a scan. It is handed to the same function a wedge scanner's code goes
// to, so what a code sells, and what "not found" says, is decided in one place.
//
// Three readers, chosen once, in this order:
//
//   1. The Android app's bridge (`ChachiAndroid.scanBarcode`): Google's code scanner, which
//      shows its own screen and returns only the code. The app itself never sees a frame.
//   2. The browser's `BarcodeDetector`, where it exists (Chrome on Android and macOS).
//   3. ZXing, vendored under /vendor/zxing and loaded only when needed. It is pure
//      JavaScript: no eval and no WebAssembly, so the shell's CSP needs no exception.
//
// Frames are read in memory, a few times a second, and never stored or sent anywhere (SEC-10).
// QR codes are not read: a QR Ph code is a payment, not a product.

import { h } from './ui.js';

/** Product and label codes: what a shop's goods and a supplier's cartons carry. */
export const FORMATS = Object.freeze(['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39']);
const ZXING_FORMATS = Object.freeze(['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_128', 'CODE_39']);
const ZXING_SRC = 'vendor/zxing/zxing-library.min.js';
/** The same code is read again only after it has been out of sight this long. */
export const REPEAT_PAUSE_MS = 1500;
const FRAME_MS = 250;

/**
 * Holding a box in front of the lens must add it once, not four times a second. A code is
 * accepted when it differs from the last one seen, or when that one has been out of sight
 * for the pause. Every sighting restarts the pause, so a code held still is read once.
 */
export function createRepeatGuard({ pauseMs = REPEAT_PAUSE_MS } = {}) {
  let lastCode = null;
  let lastSeen = -Infinity;
  return {
    accept(code, now) {
      const fresh = code !== lastCode || now - lastSeen >= pauseMs;
      lastCode = code;
      lastSeen = now;
      return fresh;
    },
    reset() { lastCode = null; lastSeen = -Infinity; },
  };
}

/** A code worth handing on: digits and letters only, of a plausible length. */
export function cleanCode(raw) {
  const text = String(raw ?? '').trim();
  return /^[0-9A-Za-z\-. $/+%]{4,64}$/.test(text) ? text : null;
}

const hasBridge = () => Boolean(globalThis.ChachiAndroid && globalThis.ChachiAndroid.scanBarcode);
const hasCamera = () => Boolean(globalThis.navigator && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

/** Whether this device can scan with a camera at all. The button is shown only if so. */
export function cameraAvailable() {
  return hasBridge() || hasCamera();
}

/**
 * A "Scan with camera" button, or null where there is no camera. `onCode(code)` is called
 * for each code read; it may return a promise and a short label ("Ice tube added").
 */
export function cameraButton({ onCode, continuous = false, title = 'Scan a barcode', label = 'Camera', onOpen, onClose }) {
  if (!cameraAvailable()) return null;
  return h('button', {
    // An empty label is an icon-only button, for a field inside a table row.
    type: 'button', class: `camera-scan-button${label ? '' : ' icon-only'}`, icon: 'camera', text: label || null,
    title: 'Scan with the camera', 'aria-label': 'Scan with the camera',
    onclick: () => openCameraScanner({ onCode, continuous, title, onOpen, onClose }),
  });
}

// ── The Android bridge ──────────────────────────────────────────────────────

const bridgeWaiters = new Map();
let bridgeSeq = 0;
globalThis.__chachiScanResult = (id, code, error) => {
  const waiter = bridgeWaiters.get(id);
  if (!waiter) return;
  bridgeWaiters.delete(id);
  waiter({ code: code || null, error: error || null });
};

function bridgeScanOnce() {
  return new Promise((resolve) => {
    bridgeSeq += 1;
    const id = String(bridgeSeq);
    bridgeWaiters.set(id, resolve);
    try {
      globalThis.ChachiAndroid.scanBarcode(id, FORMATS.join(','));
    } catch (err) {
      bridgeWaiters.delete(id);
      resolve({ code: null, error: 'unavailable' });
    }
  });
}

// ── The web reader ──────────────────────────────────────────────────────────

let zxingLoading = null;
function loadZxing() {
  if (globalThis.ZXing) return Promise.resolve(globalThis.ZXing);
  if (!zxingLoading) {
    zxingLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = ZXING_SRC;
      script.onload = () => resolve(globalThis.ZXing);
      script.onerror = () => { zxingLoading = null; reject(new Error('The barcode reader could not be loaded.')); };
      document.head.append(script);
    });
  }
  return zxingLoading;
}

async function makeDecoder() {
  if ('BarcodeDetector' in globalThis) {
    try {
      const supported = await globalThis.BarcodeDetector.getSupportedFormats();
      const formats = FORMATS.filter((f) => supported.includes(f));
      if (formats.includes('ean_13')) {
        const detector = new globalThis.BarcodeDetector({ formats });
        return async (video) => {
          const found = await detector.detect(video);
          return found.length ? found[0].rawValue : null;
        };
      }
    } catch { /* fall through to ZXing */ }
  }
  const ZXing = await loadZxing();
  const hints = new Map();
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, ZXING_FORMATS.map((f) => ZXing.BarcodeFormat[f]));
  hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
  const reader = new ZXing.MultiFormatReader();
  reader.setHints(hints);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  return async (video) => {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;
    // A frame at most 640 wide is plenty for a label, and a quarter of the work.
    const scale = Math.min(1, 640 / width);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    try {
      const source = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
      const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(source));
      return reader.decode(bitmap).getText();
    } catch {
      return null;             // NotFoundException, most frames
    } finally {
      reader.reset();
    }
  };
}

function signal() {
  try { if (navigator.vibrate) navigator.vibrate(60); } catch { /* not a phone */ }
  try {
    const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Audio) return;
    const audio = new Audio();
    const tone = audio.createOscillator();
    const gain = audio.createGain();
    tone.frequency.value = 1760;
    gain.gain.value = 0.08;
    tone.connect(gain).connect(audio.destination);
    tone.start();
    tone.stop(audio.currentTime + 0.08);
    tone.onended = () => audio.close();
  } catch { /* silent is fine */ }
}

/** Why the camera would not open, in words a cashier can act on. */
function refusalText(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'The camera is not allowed. Allow it for this app in the browser or phone settings, then try again. '
      + 'Typing the code or a scanner still works.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device.';
  if (name === 'NotReadableError') return 'The camera is in use by another app. Close it and try again.';
  return err && err.message ? err.message : 'The camera could not be opened.';
}

/**
 * The scanner itself. On Android with Google's scanner, its own screen, opened again after
 * each read until the cashier backs out; elsewhere, an overlay over the page.
 */
export async function openCameraScanner({ onCode, continuous = false, title = 'Scan a barcode', onOpen, onClose }) {
  if (hasBridge()) {
    if (onOpen) onOpen();
    try {
      for (;;) {
        const { code, error } = await bridgeScanOnce();
        if (error === 'unavailable') break;               // no Play services: the web reader
        if (!code) return;                                // backed out
        const clean = cleanCode(code);
        if (clean) await onCode(clean);
        if (!continuous) return;
      }
    } finally {
      if (onClose) onClose();
    }
    if (!hasCamera()) return;
  }
  return webScanner({ onCode, continuous, title, onOpen, onClose });
}

async function webScanner({ onCode, continuous, title, onOpen, onClose }) {
  const video = h('video', { class: 'camera-video', autoplay: true, muted: true, playsinline: true });
  video.muted = true;
  const status = h('p', { class: 'camera-status', role: 'status', text: 'Starting the camera…' });
  const torch = h('button', { type: 'button', class: 'camera-torch', hidden: true, text: 'Light' });
  const done = h('button', { type: 'button', class: 'primary', text: continuous ? 'Done' : 'Cancel' });
  const overlay = h('div', { class: 'camera-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
    h('div', { class: 'camera-sheet' }, [
      h('h2', { text: title }),
      h('div', { class: 'camera-frame' }, [video, h('div', { class: 'camera-guide', 'aria-hidden': 'true' })]),
      status,
      h('div', { class: 'camera-actions' }, [torch, done]),
    ]),
  ]);

  let stream = null;
  let timer = null;
  let closed = false;
  const guard = createRepeatGuard();
  const onKey = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (stream) for (const track of stream.getTracks()) track.stop();
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    if (onClose) onClose();
  }
  done.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  if (onOpen) onOpen();

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (err) {
    status.textContent = refusalText(err);
    status.classList.add('is-error');
    done.textContent = 'Close';
    return;
  }
  if (closed) { for (const track of stream.getTracks()) track.stop(); return; }
  video.srcObject = stream;
  try { await video.play(); } catch { /* autoplay with muted video is allowed */ }

  const [track] = stream.getVideoTracks();
  const capabilities = track && track.getCapabilities ? track.getCapabilities() : {};
  if (capabilities.torch) {
    let on = false;
    torch.hidden = false;
    torch.addEventListener('click', async () => {
      on = !on;
      try { await track.applyConstraints({ advanced: [{ torch: on }] }); } catch { /* not this camera */ }
      torch.classList.toggle('is-on', on);
    });
  }

  let decode;
  try {
    decode = await makeDecoder();
  } catch (err) {
    status.textContent = err.message;
    status.classList.add('is-error');
    return;
  }
  status.textContent = 'Hold the barcode inside the box.';

  let busy = false;
  const tick = async () => {
    if (closed) return;
    if (!busy) {
      busy = true;
      try {
        const raw = await decode(video);
        const code = raw ? cleanCode(raw) : null;
        if (code && guard.accept(code, Date.now())) {
          signal();
          status.textContent = `Read ${code}…`;
          const said = await onCode(code);
          if (!continuous) { close(); return; }
          status.textContent = said || `Read ${code}. Scan the next one, or press Done.`;
        }
      } catch (err) {
        status.textContent = err.message || String(err);
      } finally {
        busy = false;
      }
    }
    timer = setTimeout(tick, FRAME_MS);
  };
  tick();
}

export const _internals = { refusalText };
