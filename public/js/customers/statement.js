// SCR-404 — the statement (TASK-031, CR-302).
//
// **A document handed to a customer who is standing there asking what they owe.** So it
// is built to be checked by hand rather than read: the balance carried in, every
// movement in the period with a running total beside it, and the balance at the end.
// Somebody who disagrees with the closing figure can point at the line where the two of
// you part company, which is the whole reason a statement exists rather than a number
// read aloud across the counter.
//
// **The closing balance is the account's own**, and the server refuses to build a
// statement whose walked total disagrees with the ledger (`CR-302`'s last clause). This
// screen therefore never computes a balance: it prints the ones it was given, and a
// figure it derived itself would be a second answer to a question already settled.
//
// `CR-203`'s allocations sit under the payment they belong to — *which invoices this
// ₱3,000 settled* is the sentence a customer is actually asking for.
//
// `CR-108`: an account in credit closes with the store owing *them*, in words. A minus
// sign is a minus sign somebody will read past.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money } from '../shell/format.js';

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
const firstOfMonth = () => `${today().slice(0, 8)}01`;

export function createStatement({ root, customerId, onBack }) {
  let params = { from: firstOfMonth(), to: today() };
  let statement = null;

  async function load() {
    ui.loading(root, { rows: 5 });
    try {
      statement = await api.get(
        `/customers/${customerId}/statement?from=${params.from}&to=${params.to}`
      );
      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  function render() {
    clear(root).append(h('section', { class: 'statement' }, [
      controls(),

      h('dl', { class: 'admin-meta' }, [
        metaField('Customer', statement.customer.name),
        metaField('Period', `${statement.from_date} to ${statement.to_date}`),
        metaField('Brought forward', money(statement.opening_balance_centavos)),
      ]),

      statement.lines.length === 0 ? quietPeriod() : table(),

      // The figure the customer came in for, said in the words SCR-401 uses.
      h('div', { class: `statement-closing${statement.is_in_credit ? ' is-credit' : ''}` }, [
        h('span', { class: 'statement-closing-amount', text: money(Math.abs(statement.closing_balance_centavos)) }),
        h('span', { class: 'statement-closing-label', text: statement.closing_label }),
      ]),

      // RPT-106.
      h('p', { class: 'muted rule-note', text: statement.basis }),
    ]));
  }

  function controls() {
    const from = h('input', { type: 'date', value: params.from, 'aria-label': 'From' });
    const to = h('input', { type: 'date', value: params.to, 'aria-label': 'To' });

    return h('header', { class: 'report-head' }, [
      h('button', { class: 'report-back', text: '← Customer', onclick: () => onBack() }),
      h('h1', { text: 'Statement of account' }),
      h('form', {
        class: 'report-range',
        onsubmit: (event) => {
          event.preventDefault();
          params = { from: from.value, to: to.value };
          load();
        },
      }, [from, to, h('button', { type: 'submit', class: 'row-action', text: 'Show' })]),
      h('button', { class: 'row-action', text: 'Print', onclick: print }),
      h('button', { class: 'row-action', text: 'Export CSV', onclick: exportCsv }),
    ]);
  }

  function quietPeriod() {
    const host = h('div');
    ui.empty(host, {
      title: 'Nothing was bought or paid in this period. The balance is unchanged, and both '
        + 'figures above are the account’s own.',
    });
    return host;
  }

  function table() {
    return h('div', { class: 'table-scroll' }, [
      h('table', { class: 'catalogue-list statement-list' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: 'Date' }), h('th', { text: 'What' }), h('th', { text: 'Document' }),
          h('th', { class: 'money', text: 'Amount' }), h('th', { class: 'money', text: 'Balance' }),
        ])]),
        h('tbody', {}, statement.lines.map((line) => h('tr', {}, [
          h('td', { text: line.occurred_at_manila }),
          h('td', {}, [
            h('span', { text: line.type_label }),
            // CR-203, under the payment it belongs to: which invoices this settled.
            ...(line.settled || []).map((settled) => h('small', {
              class: 'muted settled',
              text: `settled ${settled.document_no} — ${money(settled.amount_centavos)}`,
            })),
            line.reason ? h('small', { class: 'muted', text: line.reason }) : null,
          ]),
          h('td', { class: 'sku', text: line.document_no || '—' }),
          h('td', { class: 'money', text: money(line.amount_centavos) }),
          h('td', { class: 'money', text: money(line.running_balance_centavos) }),
        ]))),
      ]),
    ]);
  }

  /** CR-206's precedent: a document a customer takes away goes on the printer. */
  async function print() {
    try {
      const result = await api.post(`/customers/${customerId}/statement/print`, {
        from: params.from, to: params.to,
      });
      ui.toast(result.printed?.delivered ? 'Statement printed.' : 'Statement queued for the printer.',
        { kind: 'success' });
    } catch (err) {
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    }
  }

  async function exportCsv() {
    try {
      const filename = api.saveAs(await api.download(
        `/customers/${customerId}/statement/export.csv?from=${params.from}&to=${params.to}`
      ));
      ui.toast(`${filename} saved`, { kind: 'success' });
    } catch (err) {
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    }
  }

  const metaField = (label, value) => h('div', { class: 'meta-field' }, [
    h('dt', { text: label }), h('dd', { text: value }),
  ]);

  return { mount: load, unmount() {} };
}
