// SCR-403 — take a payment on account.
//
// FR_4.3, and the reason this screen matters: a store that sells on credit and cannot
// record a payment has a ledger that only grows.
//
// **The resulting balance is not computed here.** CR-103 derives a balance from the
// transactions; a screen that subtracted its own would eventually disagree with the
// ledger, and that is the one disagreement a credit system cannot survive. The preview
// below is arithmetic on the figures the server already sent for display, and it is
// labelled as an estimate — the figure that counts is the one the server returns after
// the payment is posted, and that is what the screen then shows.
//
// **An overpayment is never accepted quietly.** CR-204 makes the excess store credit
// and requires the cashier to say so explicitly. The tick starts off, and the amount of
// the excess is named before it is ticked, not after.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money } from '../shell/format.js';

const METHODS = ['CASH', 'GCASH', 'QRPH'];
const NEEDS_REFERENCE = ['GCASH', 'QRPH'];

export function createCollection({ root, customerId, onDone, onBack }) {
  let customer = null;
  let credit = null;
  let amount = '';
  let method = 'CASH';
  let referenceNo = '';
  let notes = '';
  let acceptOverpayment = false;
  let result = null;

  async function load() {
    ui.loading(root, { rows: 4 });
    try {
      const view = await api.get(`/customers/${customerId}/credit`);
      customer = view.customer;
      credit = view.credit;
      if (!credit) {
        ui.empty(root, {
          title: `${customer.name} has no credit account, so there is nothing to pay off.`,
          action: 'Back',
          onAction: () => onBack(),
        });
        return;
      }
      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  const centavos = () => {
    const value = Number.parseFloat(String(amount).trim());
    return Number.isFinite(value) ? Math.round(value * 100) : null;
  };

  const overpaymentCentavos = () => {
    const paid = centavos();
    return paid === null ? 0 : Math.max(0, paid - credit.balance_centavos);
  };

  function render() {
    if (result) return renderResult();

    const paid = centavos();
    const excess = overpaymentCentavos();

    clear(root).append(h('section', { class: 'customers collection' }, [
      h('header', { class: 'admin-head' }, [
        h('button', { class: 'report-back', text: '← Customer', onclick: () => onBack() }),
        h('h1', { text: `Payment from ${customer.name}` }),
      ]),

      h('dl', { class: 'admin-meta' }, [
        metaField('Owes now', money(credit.balance_centavos)),
        metaField('Terms', credit.terms_label),
        credit.ageing_status === 'OVERDUE'
          ? metaField('Ageing', `overdue by ${credit.days_overdue} days`)
          : null,
      ]),

      h('form', {
        class: 'editor-form',
        onsubmit: (event) => { event.preventDefault(); submit(); },
      }, [
        h('div', { class: 'editor-field' }, [
          h('label', { text: 'Amount (₱)' }),
          h('div', { class: 'field-row' }, [
            h('input', {
              type: 'text', inputmode: 'decimal', value: amount, class: 'collection-amount',
              'aria-label': 'Amount in pesos', autofocus: true,
              oninput: (event) => { amount = event.target.value; renderPreview(); },
            }),
            h('button', {
              type: 'button', class: 'row-action', text: 'Pay in full',
              onclick: () => {
                amount = (credit.balance_centavos / 100).toFixed(2);
                acceptOverpayment = false;
                render();
              },
            }),
          ]),
        ]),

        h('div', { class: 'editor-field' }, [
          h('label', { text: 'Method' }),
          h('select', {
            onchange: (event) => { method = event.target.value; render(); },
          }, METHODS.map((m) => h('option', { value: m, text: m, selected: m === method }))),
          // CR-205: a cash collection is till cash and opens the drawer. A cashier who
          // does not expect the drawer will not have it ready.
          method === 'CASH'
            ? h('small', { class: 'muted', text: 'Cash goes into the till and the drawer opens '
              + 'when this is recorded (CR-205).' })
            : null,
        ]),

        NEEDS_REFERENCE.includes(method)
          ? h('div', { class: 'editor-field' }, [
            h('label', { text: 'Reference number' }),
            h('input', {
              type: 'text', value: referenceNo, autocomplete: 'off',
              oninput: (event) => { referenceNo = event.target.value; },
            }),
            // POS-205's sibling: read from the customer's screen, never generated.
            h('small', { class: 'muted', text: 'Read it off the customer’s phone (CR-202). '
              + 'Nothing here confirms the money arrived — it is recorded, not verified.' }),
          ])
          : null,

        h('div', { class: 'editor-field' }, [
          h('label', { text: 'Notes' }),
          h('input', {
            type: 'text', value: notes, placeholder: 'Optional',
            oninput: (event) => { notes = event.target.value; },
          }),
        ]),

        h('div', { class: 'preview', id: 'preview' }, [preview(paid, excess)]),

        h('div', { class: 'editor-actions' }, [
          h('button', {
            type: 'submit', class: 'primary', text: 'Record payment',
            disabled: paid === null || paid <= 0 || (excess > 0 && !acceptOverpayment),
          }),
          h('button', { type: 'button', text: 'Cancel', onclick: () => onBack() }),
        ]),
      ]),
    ]));
  }

  /**
   * What the balance will be — an estimate, and labelled as one.
   *
   * The figure that counts is the server's, after the payment posts. Saying so here
   * matters because a cashier reading a number off a screen will quote it to the
   * customer, and it must be the one the ledger agrees with.
   */
  function preview(paid, excess) {
    if (paid === null || paid <= 0) {
      return h('p', { class: 'muted', text: 'Enter the amount handed over.' });
    }

    const after = Math.max(0, credit.balance_centavos - paid);

    return h('div', {}, [
      h('p', { class: 'preview-line' }, [
        h('span', { text: `${money(credit.balance_centavos)} owing − ${money(paid)} paid = ` }),
        h('strong', { text: after === 0 && excess === 0 ? 'nothing owing' : `${money(after)} owing` }),
      ]),
      excess > 0 ? overpaymentBlock(excess) : null,
    ]);
  }

  /** CR-204 — explicit, unticked, and the excess named before it is ticked. */
  function overpaymentBlock(excess) {
    const tick = h('input', {
      type: 'checkbox', checked: acceptOverpayment,
      onchange: (event) => { acceptOverpayment = event.target.checked; renderPreview(); },
    });

    return h('div', { class: 'overpayment' }, [
      h('p', { role: 'alert', text: `That is ${money(excess)} more than they owe.` }),
      h('label', { class: 'check' }, [
        tick,
        h('span', { text: `Yes — keep the extra ${money(excess)} as store credit against their `
          + 'next purchase.' }),
      ]),
      h('p', { class: 'refusal-rule', text: 'CR-204' }),
    ]);
  }

  function renderPreview() {
    const host = root.querySelector('#preview');
    if (!host) return;
    clear(host).append(preview(centavos(), overpaymentCentavos()));

    const submitButton = root.querySelector('.editor-actions .primary');
    const paid = centavos();
    if (submitButton) {
      submitButton.disabled = paid === null || paid <= 0
        || (overpaymentCentavos() > 0 && !acceptOverpayment);
    }
  }

  async function submit() {
    try {
      result = await api.post(`/customers/${customerId}/collections`, {
        amountCentavos: centavos(),
        method,
        referenceNo: referenceNo.trim() || null,
        notes: notes.trim() || null,
        acceptOverpayment,
      });
      render();
    } catch (err) {
      // CR-201's open shift, CR-202's reference, CR-204's overpayment — each names its
      // rule, and this is where the cashier reads it.
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    }
  }

  // ── After it is recorded ──────────────────────────────────────────────────

  function renderResult() {
    clear(root).append(h('section', { class: 'customers collection-done' }, [
      h('header', { class: 'admin-head' }, [h('h1', { text: 'Payment recorded' })]),

      h('p', { class: 'close-verdict balanced',
        // Signed in the ledger; a magnitude on a screen that says who it came from.
        text: `${money(Math.abs(result.collection.amount_centavos))} from ${customer.name}.` }),

      // The server's figure, not the preview's.
      h('p', { class: 'preview-line', text: result.balance_centavos === 0
        ? 'They owe nothing now.'
        : `They still owe ${money(result.balance_centavos)}.` }),

      result.store_credit_centavos > 0
        ? h('p', { class: 'muted', text: `${money(result.store_credit_centavos)} is held as store `
          + 'credit against their next purchase (CR-204).' })
        : null,

      // CR-203: which invoices this settled, oldest first.
      result.allocations && result.allocations.length > 0
        ? h('div', {}, [
          h('h2', { text: 'What it settled' }),
          h('ul', {}, result.allocations.map((a) => h('li', {
            text: `${a.document_no || a.sale_document_no || 'invoice'} — ${money(a.amount_centavos)}`,
          }))),
        ])
        : null,

      // CR-206: printed by the collection itself, as the shift close prints its summary.
      result.printed
        ? h('p', { class: 'muted', text: result.printed.delivered
          ? 'The acknowledgement printed. Hand it over.'
          : `The acknowledgement did not print (${result.printed.error}). It is queued, and the `
            + 'figures above are the same ones on it.' })
        : null,

      h('div', { class: 'editor-actions' }, [
        h('button', { class: 'primary', text: 'Done', onclick: () => onDone(customerId) }),
      ]),
    ]));
  }

  const metaField = (label, value) => h('div', { class: 'meta-field' }, [
    h('dt', { text: label }), h('dd', { text: value }),
  ]);

  return { mount: load, unmount() {} };
}
