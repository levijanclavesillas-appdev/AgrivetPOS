// SCR-402 — a customer's credit.
//
// The first block is limit, balance, available credit and ageing (CR-104, CR-107),
// because that is the question anybody opening this screen is asking: can they buy
// today, and do they owe us anything late. Then the statement, then what each payment
// settled.
//
// **No figure here is computed by the screen.** CR-103 derives the balance from the
// transactions, and a screen that added up its own copy would eventually disagree with
// the ledger — the one disagreement a credit system cannot survive. Every number below
// is rendered as the server sent it.
//
// The credit limit is its own action under TX-414, not a field on the customer form.
// Folding it in would let a TX-413 holder raise a limit as a side effect of correcting
// a phone number, which is why the API separates them and why this screen does too.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money, manila } from '../shell/format.js';

export function createCustomerProfile({ root, customerId, onBack, onCollect }) {
  let customer = null;
  let credit = null;
  let openSales = [];
  let statement = { rows: [] };
  let collections = { collections: [] };
  let editingLimit = false;

  async function load() {
    ui.loading(root, { rows: 5 });
    try {
      const [detail, creditView] = await Promise.all([
        api.get(`/customers/${customerId}`),
        api.get(`/customers/${customerId}/credit`),
      ]);
      customer = detail.customer;
      credit = creditView.credit;
      openSales = creditView.open_sales || [];
      statement = creditView.transactions || { rows: [] };

      collections = credit
        ? await api.get(`/customers/${customerId}/collections`).catch(() => ({ collections: [] }))
        : { collections: [] };

      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  function render() {
    clear(root).append(h('section', { class: 'customers profile' }, [
      h('header', { class: 'admin-head' }, [
        h('button', { class: 'report-back', text: '← Customers', onclick: () => onBack() }),
        h('h1', { text: customer.name }),
        customer.is_active ? null : h('span', { class: 'tag', text: 'inactive' }),
        credit
          ? h('button', { class: 'primary', text: 'Take payment', onclick: () => onCollect(customerId) })
          : null,
      ]),

      creditBlock(),
      detailsBlock(),
      openSalesBlock(),
      statementBlock(),
      collectionsBlock(),
    ]));
  }

  /** CR-104 and CR-107 — the first block, because it is the first question. */
  function creditBlock() {
    if (!credit) {
      return h('div', { class: 'credit-summary none' }, [
        h('p', { class: 'muted', text: 'This customer pays cash. They have no credit account, '
          + 'so they cannot buy on credit (CR-102).' }),
      ]);
    }

    const overdue = credit.ageing_status === 'OVERDUE';

    return h('div', { class: `credit-summary ${overdue ? 'is-overdue' : ''}` }, [
      h('div', { class: 'credit-figures' }, [
        figure('Owes', money(credit.balance_centavos), 'balance'),
        figure('Limit', money(credit.credit_limit_centavos)),
        // CR-104: what they can still spend, which is the figure the counter needs.
        figure('Can still buy', money(credit.available_centavos), 'available'),
        figure('Terms', credit.terms_label),
      ]),
      overdue
        ? h('p', { class: 'overdue-note', role: 'alert',
          text: `Overdue by ${credit.days_overdue} day${credit.days_overdue === 1 ? '' : 's'} — `
            + `the oldest unpaid invoice was due ${manila(credit.oldest_due_at)}.` })
        : h('p', { class: 'muted', text: credit.balance_centavos === 0
          ? 'Nothing owing.'
          : `Ageing: ${credit.ageing_status.toLowerCase().replace(/_/g, ' ')}.` }),
      credit.store_credit_centavos > 0
        ? h('p', { class: 'muted', text: `They are ${money(credit.store_credit_centavos)} in credit `
          + 'with the store from an overpayment.' })
        : null,
      limitControl(),
    ]);
  }

  const figure = (label, value, cls = '') => h('div', { class: `credit-figure ${cls}` }, [
    h('span', { class: 'figure-label', text: label }),
    h('span', { class: 'figure-value', text: value }),
  ]);

  /** CR-106 — its own action, under TX-414, audited with both values. */
  function limitControl() {
    if (!editingLimit) {
      return h('button', {
        class: 'row-action', text: 'Change credit limit',
        onclick: () => { editingLimit = true; render(); },
      });
    }

    const limit = h('input', {
      type: 'text', inputmode: 'decimal',
      value: (credit.credit_limit_centavos / 100).toFixed(2),
      'aria-label': 'Credit limit in pesos',
    });
    const terms = h('input', {
      type: 'text', inputmode: 'numeric', value: String(credit.terms_days),
      'aria-label': 'Terms in days',
    });
    const reason = h('input', { type: 'text', placeholder: 'Why it is changing' });

    return h('form', {
      class: 'editor-form inline limit-form',
      onsubmit: async (event) => {
        event.preventDefault();
        try {
          await api.put(`/customers/${customerId}/credit-limit`, {
            creditLimitCentavos: Math.round(Number.parseFloat(limit.value || '0') * 100),
            termsDays: Number.parseInt(terms.value || '0', 10),
            reason: reason.value.trim() || null,
          });
          ui.toast('Credit limit changed.', { kind: 'success' });
          editingLimit = false;
          await load();
        } catch (err) {
          // TX-414: a cashier is refused here, with the rule named.
          ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
        }
      },
    }, [
      h('div', { class: 'field-row' }, [
        h('label', { text: 'Limit (₱)' }, [limit]),
        h('label', { text: 'Terms (days)' }, [terms]),
      ]),
      h('div', { class: 'field-row' }, [
        reason,
        h('button', { type: 'submit', class: 'row-action', text: 'Save limit' }),
        h('button', { type: 'button', text: 'Cancel', onclick: () => { editingLimit = false; render(); } }),
      ]),
      h('p', { class: 'refusal-rule', text: 'CR-106 · TX-414' }),
    ]);
  }

  function detailsBlock() {
    return h('dl', { class: 'admin-meta' }, [
      meta('Code', customer.code || '—'),
      meta('Type', customer.customer_type),
      meta('Price level', customer.price_level),
      meta('Contact', customer.contact_no || '—'),
      h('div', { class: 'meta-field' }, [
        h('dt', { text: '' }),
        h('dd', {}, [customer.is_active
          ? h('button', {
            class: 'row-action', text: 'Deactivate',
            onclick: deactivate,
          })
          : h('span', { class: 'muted', text: 'This customer is inactive.' })]),
      ]),
    ]);
  }

  const meta = (label, value) => h('div', { class: 'meta-field' }, [
    h('dt', { text: label }), h('dd', { text: value }),
  ]);

  async function deactivate() {
    if (!window.confirm(`Deactivate ${customer.name}?\n\n`
      + 'They stay on every sale and every credit row they are already on. They simply '
      + 'cannot be chosen at the counter.')) return;
    try {
      await api.post(`/customers/${customerId}/deactivate`, {});
      ui.toast('Deactivated.', { kind: 'success' });
      await load();
    } catch (err) {
      // VR-305: not while a balance stands. The refusal says so.
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    }
  }

  /** What is actually unpaid, oldest first — what a collection will settle. */
  function openSalesBlock() {
    if (openSales.length === 0) return null;

    return h('div', {}, [
      h('h2', { text: 'Unpaid invoices' }),
      h('table', { class: 'catalogue-list' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: 'Document' }), h('th', { text: 'Due' }),
          h('th', { text: 'Outstanding' }), h('th', { text: '' }),
        ])]),
        h('tbody', {}, openSales.map((sale) => h('tr', { class: sale.is_overdue ? 'is-overdue-row' : '' }, [
          h('td', { class: 'sku', text: sale.document_no }),
          h('td', { text: sale.due_at ? manila(sale.due_at) : '—' }),
          h('td', { class: 'money', text: money(sale.outstanding_centavos) }),
          h('td', { text: sale.is_overdue ? `${sale.days_overdue} days late` : '' }),
        ]))),
      ]),
      // CR-203, said before the payment rather than explained afterwards.
      h('p', { class: 'muted', text: 'A payment settles these oldest first (CR-203).' }),
    ]);
  }

  function statementBlock() {
    if (!credit || statement.rows.length === 0) return null;

    return h('div', {}, [
      h('h2', { text: 'Statement' }),
      h('table', { class: 'catalogue-list statement' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: 'When' }), h('th', { text: 'Document' }), h('th', { text: 'What' }),
          h('th', { text: 'Amount' }), h('th', { text: 'Balance after' }),
        ])]),
        h('tbody', {}, statement.rows.map((row) => h('tr', {}, [
          h('td', { text: row.occurred_at_manila }),
          h('td', { class: 'sku', text: row.document_no || '—' }),
          h('td', { text: row.type_label || row.txn_type }),
          // Signed, deliberately: a statement is read down the balance column, and a
          // payment that did not appear as a subtraction would make it unfollowable.
          h('td', {
            class: `money ${row.amount_centavos < 0 ? 'credit' : ''}`,
            text: money(row.amount_centavos),
          }),
          // CR-103: the running balance the ledger recorded, not one added up here.
          h('td', { class: 'money', text: money(row.balance_after_centavos) }),
        ]))),
      ]),
      statement.total > statement.rows.length
        ? h('p', { class: 'muted', text: `Showing the most recent ${statement.rows.length} of `
          + `${statement.total}.` })
        : null,
    ]);
  }

  function collectionsBlock() {
    if (collections.collections.length === 0) return null;

    return h('div', {}, [
      h('h2', { text: 'Payments received' }),
      h('table', { class: 'catalogue-list' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: 'When' }), h('th', { text: 'Document' }), h('th', { text: 'Method' }),
          h('th', { text: 'Amount' }), h('th', { text: 'Settled' }),
        ])]),
        h('tbody', {}, collections.collections.map((row) => h('tr', {}, [
          h('td', { text: row.occurred_at_manila }),
          h('td', { class: 'sku', text: row.document_no || '—' }),
          h('td', { text: row.method || '—' }),
          // The ledger stores a payment signed — it reduces the balance — which reads
          // correctly on the statement and wrongly under a heading that already says
          // "received". The magnitude is what a person is checking here.
          h('td', { class: 'money', text: money(Math.abs(row.amount_centavos)) }),
          // CR-203: which invoices this payment went against. A cashier who cannot see
          // that cannot answer the customer standing in front of them.
          h('td', {
            text: row.allocations.length === 0
              ? '—'
              : row.allocations.map((a) => `${a.sale_document_no} ${money(a.amount_centavos)}`).join(', '),
          }),
        ]))),
      ]),
    ]);
  }

  return { mount: load, unmount() {} };
}
