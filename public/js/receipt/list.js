// SCR-306 — this shift's receipts (TASK-044).
//
// The screen that was missing between a sale and its correction. SCR-304 appears when a
// sale completes and nowhere else, and the Enter key on it starts the next customer —
// so a cashier who notices the mis-scan three customers later still holds POS-402's
// right to void and has nowhere to exercise it from. The same is true of POS-208's
// reprint: the endpoint and the REPRINT stamp exist, and the button that reaches them is
// on a screen that has gone.
//
// **Nothing here edits a sale.** POS-107 makes a completed one immutable and there is no
// route that would change one; this is a way to *find* a receipt, not a way to alter it.
// The corrections are what they were — a void inside the shift that made the sale, a
// return afterwards — and both live where they already live.
//
// **The shift's, not the day's.** TX-421 governs who reads the day and SCR-602 shows it.
// The question asked at a till with a customer waiting is only ever "the one I just
// did", and a list of four hundred sales is not an answer to it.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money, manila } from '../shell/format.js';

const STATUS_TAG = {
  VOIDED: 'voided',
  RETURNED: 'returned',
  PARTIALLY_RETURNED: 'part returned',
};

export function createReceiptList({ root, onOpenSale, onBack = null }) {
  let shift = null;
  let sales = [];

  async function load() {
    ui.loading(root, { rows: 5 });
    try {
      shift = await api.get('/shifts/current');
      sales = shift.open
        ? (await api.get(`/sales?shiftId=${shift.shift.id}&limit=50`)).sales || []
        : [];
      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  function render() {
    clear(root).append(h('section', { class: 'receipts' }, [
      h('header', { class: 'admin-head' }, [
        onBack ? h('button', { class: 'report-back', text: '← Back', onclick: () => onBack() }) : null,
        h('h1', { text: 'Receipts' }),
        h('button', { class: 'row-action', text: 'Refresh', onclick: load }),
      ]),

      // What this list is, in the words that stop somebody looking for last week here.
      h('p', { class: 'muted', text: shift?.open
        ? 'The sales of this shift, newest first. Open one to reprint it, or to void it '
          + 'while the shift is still open (POS-402).'
        : 'This list is the current shift’s.' }),

      !shift?.open ? closedState() : (sales.length === 0 ? emptyState() : table()),
    ]));
  }

  /**
   * POS-402 said before it is needed.
   *
   * A closed shift is the one state where the answer is somewhere else entirely, and
   * saying "no sales" would send a cashier looking for a receipt that exists.
   */
  function closedState() {
    const host = h('div');
    ui.empty(host, {
      title: 'Your shift is closed, so there is nothing to correct from here. A sale made '
        + 'on a closed shift is corrected by a return (POS-402), and the day’s takings are '
        + 'on the daily report.',
    });
    return host;
  }

  function emptyState() {
    const host = h('div');
    ui.empty(host, { title: 'No sales on this shift yet.' });
    return host;
  }

  function table() {
    return h('table', { class: 'catalogue-list receipt-list' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', { text: 'Receipt' }), h('th', { text: 'Time' }),
        h('th', { text: 'Customer' }), h('th', { class: 'money', text: 'Total' }),
      ])]),
      h('tbody', {}, sales.map((sale) => h('tr', {
        class: sale.status === 'VOIDED' ? 'is-inactive' : '',
        tabindex: '0',
        onclick: () => onOpenSale(sale.id),
        onkeydown: (event) => { if (event.key === 'Enter') onOpenSale(sale.id); },
      }, [
        h('td', { class: 'sku' }, [
          h('span', { text: sale.sale_no }),
          // POS-404: a voided sale keeps its number and its place in the sequence, so it
          // is listed and marked rather than hidden — a gap in the numbers is the thing
          // an auditor looks for.
          STATUS_TAG[sale.status]
            ? h('span', { class: 'tag warn', text: STATUS_TAG[sale.status] })
            : null,
        ]),
        // TIME-001: the store's own time, never the browser's.
        h('td', { text: sale.occurred_at_manila || manila(sale.occurred_at) }),
        h('td', { text: sale.customer_name || 'Walk-in' }),
        h('td', { class: 'money', text: money(sale.total_centavos) }),
      ]))),
    ]);
  }

  return {
    mount: load,
    unmount() {},
  };
}
