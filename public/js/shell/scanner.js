// INT-3 — the barcode scanner, which is a keyboard.
//
// A USB wedge scanner types its code and presses Enter. There is no driver and no
// pairing, so the only thing distinguishing a scan from a cashier typing is **speed**:
// a scanner emits a whole code in tens of milliseconds, a person cannot.
//
// 04_UX_SPEC.md §7: keystrokes route to the search field wherever focus is, provided no
// modal is open. That last clause is the important one — routing keystrokes out of an
// open dialog would make every field in the product unusable while a scanner is
// plugged in.
//
// Pure: it takes keystrokes and timestamps and decides. The DOM binding is in the view.

/** Between two keystrokes of one scan. A fast typist manages about 80 ms. */
export const SCAN_INTERVAL_MS = 35;

/** Shorter than this and a "scan" is somebody leaning on the keyboard. */
export const MIN_SCAN_LENGTH = 4;

export function createScanner({
  intervalMs = SCAN_INTERVAL_MS,
  minLength = MIN_SCAN_LENGTH,
  onScan = () => {},
} = {}) {
  let buffer = '';
  let lastAt = 0;

  /**
   * Feed one keystroke.
   *
   * Returns what it decided, so a test can assert the decision rather than the effect:
   * 'scan' when a terminating Enter arrived inside the interval on a long enough
   * buffer, 'type' when Enter arrived after human-speed keys, and null while a code is
   * still arriving.
   *
   * 'type' carries no payload on purpose. The buffer is only ever a scan detector —
   * what the person typed is already in the search field, put there by the browser,
   * and reading it from here would hand the view whatever fragment survived the last
   * pause.
   */
  function key({ key: pressed, at = Date.now(), modalOpen = false }) {
    // §7's proviso. A modal owns the keyboard; a scan while one is open belongs to
    // whatever field the person is filling in.
    if (modalOpen) {
      buffer = '';
      return null;
    }

    const gap = at - lastAt;
    lastAt = at;

    if (pressed === 'Enter') {
      const candidate = buffer;
      buffer = '';
      if (candidate.length >= minLength && gap <= intervalMs) {
        onScan(candidate);
        return 'scan';
      }
      if (candidate.length > 0) return 'type';
      return null;
    }

    // A single printable character. Anything else — a function key, a modifier — ends
    // whatever was accumulating, because a scanner never emits one mid-code.
    if (pressed.length !== 1) {
      buffer = '';
      return null;
    }

    // A pause longer than the interval means a person started typing; the buffer so
    // far was theirs, not a scanner's.
    buffer = gap > intervalMs ? pressed : buffer + pressed;
    return null;
  }

  function reset() {
    buffer = '';
    lastAt = 0;
  }

  return { key, reset, peek: () => buffer };
}
