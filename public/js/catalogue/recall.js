// SCR-207 — the recall (TASK-030, INV-206).
//
// **A recall is not a report about stock, it is a list of people.** The store has a
// notice from a manufacturer naming a batch, and what it needs is a customer, a
// telephone number and how much they took — in that order, because somebody is about to
// spend a morning ringing them.
//
// So the figure the screen leads with is not the quantity sold, it is **what is still
// out there**: this batch's share of each line, less whatever came back on it. And
// beside it, the two numbers that decide what the morning looks like — how many people
// there are to ring, and how many buyers cannot be reached at all.
//
// **The walk-ins are the honest half.** A batch sold to eleven farms and four walk-ins
// is eleven calls and four you cannot make. A screen that listed the eleven and omitted
// the four would let a store believe it had reached everybody, which is the one belief
// a recall must not leave anybody holding.
//
// Voided and returned sales are here and marked, never filtered. A voided sale reversed
// the stock and the goods may still have left with the customer; a partly returned line
// has the unreturned part in somebody's shed. Both are decisions for the store, and a
// report that made them silently would be deciding who does not get a telephone call.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';

export function createRecall({ root, batchId, onClose }) {
  let report = null;

  async function load() {
    ui.loading(root, { rows: 5 });
    try {
      report = await api.get(`/batches/${batchId}/recall`);
      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  function render() {
    const { batch, summary } = report;

    clear(root).append(h('section', { class: 'catalogue recall' }, [
      h('header', { class: 'admin-head' }, [
        h('button', { class: 'report-back', text: '← Batches', onclick: () => onClose() }),
        h('h1', { text: `Recall — batch ${batch.batch_no}` }),
        h('button', { class: 'row-action', text: 'Export CSV', onclick: exportCsv }),
      ]),

      h('dl', { class: 'admin-meta' }, [
        metaField('Product', `${batch.product_sku} — ${batch.product_name}`),
        metaField('Supplier', batch.supplier_name),
        metaField('Expires', `${batch.expiry_date} (${batch.expiry_status.toLowerCase().replace('_', ' ')})`),
        // The other half of acting on a recall: what is still in the shop to pull off
        // the shelf. The telephone is the half everybody thinks of first.
        metaField('Still in the shop', summary.on_hand_display),
      ]),

      h('div', { class: 'recall-figures' }, [
        figure('Still out there', summary.outstanding_display, 'the quantity to chase'),
        figure('People to ring', String(summary.customers_count),
          summary.customers_count === 1 ? 'customer with a name' : 'customers with names'),
        // Stated as its own figure, because it is the number a store would otherwise
        // never learn: these are buyers it cannot reach.
        figure('Cannot be reached', String(summary.walk_in_count),
          summary.walk_in_count === 1 ? 'walk-in sale' : 'walk-in sales'),
      ]),

      // RPT-106: what this list includes, in the words a printed copy needs.
      h('p', { class: 'muted rule-note', text: report.basis }),

      report.sales.length === 0 ? emptyState() : table(),
    ]));
  }

  function emptyState() {
    const host = h('div');
    ui.empty(host, {
      title: 'Nothing from this batch has been sold. What is left is on the shelf, and '
        + 'pulling it is the whole of the recall.',
    });
    return host;
  }

  function table() {
    return h('div', { class: 'table-scroll' }, [
      h('table', { class: 'catalogue-list recall-list' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: 'Customer' }), h('th', { text: 'Contact' }),
          h('th', { text: 'Receipt' }), h('th', { text: 'When' }),
          h('th', { class: 'qty', text: 'Took' }), h('th', { class: 'qty', text: 'Still out' }),
        ])]),
        h('tbody', {}, report.sales.map((sale) => h('tr', {
          class: [sale.is_walk_in ? 'is-walk-in' : '', sale.is_voided ? 'is-inactive' : '']
            .filter(Boolean).join(' '),
        }, [
          h('td', {}, [
            // The word, never a blank: an empty cell in a column of names reads as
            // something that failed to load rather than as the answer.
            h('span', { text: sale.customer_name || 'Walk-in' }),
            sale.is_voided ? h('span', { class: 'tag warn', text: 'voided' }) : null,
            sale.is_returned ? h('span', { class: 'tag', text: 'part returned' }) : null,
          ]),
          h('td', { text: sale.customer_contact_no || (sale.is_walk_in ? 'no way to reach them' : '—') }),
          h('td', { class: 'sku', text: sale.sale_no }),
          h('td', { text: sale.occurred_at_manila }),
          h('td', { class: 'qty', text: sale.qty_display }),
          h('td', { class: 'qty', text: sale.outstanding_display }),
        ]))),
      ]),
    ]);
  }

  /** The list gets worked through with a telephone, away from the machine. */
  async function exportCsv() {
    try {
      const filename = api.saveAs(await api.download(`/batches/${batchId}/recall/export.csv`));
      ui.toast(`${filename} saved`, { kind: 'success' });
    } catch (err) {
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    }
  }

  const figure = (label, value, note) => h('div', { class: 'recall-figure' }, [
    h('span', { class: 'recall-figure-value', text: value }),
    h('span', { class: 'recall-figure-label', text: label }),
    h('small', { class: 'muted', text: note }),
  ]);

  const metaField = (label, value) => h('div', { class: 'meta-field' }, [
    h('dt', { text: label }), h('dd', { text: value }),
  ]);

  return {
    mount: load,
    unmount() {},
  };
}
