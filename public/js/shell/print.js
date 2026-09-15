// TASK-062 — printing through the browser's own print dialog.
//
// On the web version the server is not in the store, so it cannot reach the receipt
// printer; the device the cashier is using can. With the printer set to BROWSER the
// server answers each printed document with its text (printService.outcome), and this
// puts that text on a sheet of its own and opens the print dialog. The printer is
// whichever one the device has installed — a thermal receipt printer with its driver, or
// an office printer for a statement.
//
// The sheet is the only thing on the page when it prints (css/print.css): the text is
// the same monospaced record the ESC/POS printer receives, so the receipt reads the same
// on either.

export function printText(text) {
  if (typeof document === 'undefined' || !text || (Array.isArray(text) && text.length === 0)) return;
  let sheet = document.querySelector('#print-sheet');
  if (!sheet) {
    sheet = document.createElement('pre');
    sheet.id = 'print-sheet';
    sheet.setAttribute('aria-hidden', 'true');
    document.body.append(sheet);
  }
  // TASK-066: a café's sale prints two documents — the receipt and the kitchen's ticket —
  // and one print dialog carries both, each on its own page.
  sheet.replaceChildren(...[].concat(text).map((one) => {
    const page = document.createElement('div');
    page.className = 'print-page';
    page.textContent = one;
    return page;
  }));
  document.body.classList.add('printing-document');
  const done = () => {
    document.body.classList.remove('printing-document');
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  // After the screen that asked has drawn: the dialog blocks the page while it is open.
  setTimeout(() => { window.print(); }, 60);
}

/** A response with a document for this browser to print, printed. */
export function printIfBrowser(payload) {
  const forBrowser = (printed) => (printed && printed.transport === 'BROWSER' && printed.text ? [printed.text] : []);
  // POS-110: a sale's kitchen ticket rides beside its receipt.
  const texts = [...forBrowser(payload && payload.printed), ...forBrowser(payload && payload.kitchen && payload.kitchen.printed)];
  if (texts.length) printText(texts);
}
