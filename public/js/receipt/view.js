// SCR-304 — the receipt.
//
// A preview of the internal transaction record, print and reprint. TAX-006's sentence
// is on it in every tax mode and TAX-007's block only in VAT mode, but neither is
// decided here: the server renders the document (TASK-014) and this shows what it
// rendered. A second template in the renderer is how the paper and the screen end up
// saying different things.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money } from '../shell/format.js';

export function createReceipt({ root, sale, printed, onNewSale }) {
  const paper = h('pre', { class: 'receipt-paper', 'aria-label': 'Receipt preview' });

  async function load() {
    ui.loading(paper.parentElement ?? root, { rows: 6 });
    try {
      const { document: doc } = await api.get(`/sales/${sale.sale.id}/receipt`);
      paper.textContent = doc.text;
    } catch (err) {
      ui.error(root, { message: err.message, retry: load });
    }
  }

  async function reprint() {
    try {
      const result = await api.post(`/sales/${sale.sale.id}/reprint`, {});
      paper.textContent = result.document.text;
      // POS-208: stamped and audited. The toast says so, because a reprint the cashier
      // did not realise was a reprint is the thing the rule exists to prevent.
      ui.toast(result.printed.delivered
        ? 'Reprinted and marked REPRINT.'
        : `Marked REPRINT. ${result.printed.error}`, { kind: result.printed.delivered ? 'success' : 'error' });
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
  }

  function mount() {
    clear(root).append(h('div', { class: 'receipt' }, [
      h('h1', { text: sale.sale.sale_no }),
      h('div', { class: 'receipt-figures' }, [
        h('div', { class: 'summary-line total' }, [
          h('span', { text: 'Total' }), h('span', { class: 'money', text: money(sale.sale.total_centavos) }),
        ]),
        sale.sale.change_centavos > 0
          ? h('div', { class: 'summary-line change' }, [
            h('span', { text: 'Change' }), h('span', { class: 'money', text: money(sale.sale.change_centavos) }),
          ])
          : null,
      ]),
      h('div', { class: 'receipt-sheet' }, [paper]),
      h('div', { class: 'receipt-actions' }, [
        h('button', { class: 'primary', text: 'New sale  Enter', onclick: onNewSale }),
        h('button', { text: 'Reprint', onclick: reprint }),
      ]),
    ]));

    // INT-1: printing already happened, asynchronously, and did not gate the sale. A
    // failure is a toast and a queued document, never an unwound sale.
    if (printed && !printed.delivered) {
      ui.toast(`The receipt did not print (${printed.error}). It is queued — press Reprint when the printer is ready.`, { kind: 'error' });
    }

    load();
  }

  function onKeyDown(event) {
    if (event.key === 'Enter') { event.preventDefault(); onNewSale(); }
  }
  document.addEventListener('keydown', onKeyDown);

  return { mount, unmount: () => document.removeEventListener('keydown', onKeyDown) };
}
