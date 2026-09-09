// SCR-303 — payment.
//
// Amount due fixed at the top, tender rows by method, running remaining and change.
// Complete stays disabled until SUM(tenders) ≥ due (POS-204) and says *why* it is
// disabled, because 04_UX_SPEC.md §6 puts rule validation at the point of action and a
// greyed-out button with no explanation is what cashiers ring the owner about.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money } from '../shell/format.js';
import { createTenders, METHODS, NEEDS_REFERENCE } from './tenders.js';

export function createPayment({ root, cart, priced, approver = null, onComplete, onCancel }) {
  const tenders = createTenders(priced.total_centavos);
  const rowsHost = h('div', { class: 'tender-rows' });
  const summaryHost = h('div', { class: 'payment-summary' });
  const creditHost = h('div', { class: 'credit-block', hidden: true });
  const completeButton = h('button', { class: 'primary complete', text: 'Complete  Enter' });
  const blockedNote = h('p', { class: 'blocked-note' });

  function renderRows() {
    clear(rowsHost);

    for (const row of tenders.rows) {
      const amount = h('input', {
        type: 'text', inputmode: 'decimal', class: 'tender-amount',
        value: row.amountCentavos ? (row.amountCentavos / 100).toFixed(2) : '',
        'aria-label': `${row.method} amount`,
        oninput: (event) => {
          const pesos = Number.parseFloat(event.target.value);
          row.amountCentavos = Number.isFinite(pesos) ? Math.round(pesos * 100) : 0;
          renderSummary();
        },
      });

      const reference = NEEDS_REFERENCE.includes(row.method)
        ? h('input', {
          type: 'text', class: 'tender-reference', value: row.referenceNo,
          placeholder: 'Reference number', autocomplete: 'off',
          'aria-label': `${row.method} reference number`,
          // POS-205: read from the customer's screen, never generated or defaulted.
          oninput: (event) => { row.referenceNo = event.target.value; row.duplicate = false; row.duplicateAccepted = false; renderSummary(); },
          onblur: () => checkDuplicate(row),
        })
        : null;

      rowsHost.append(h('div', { class: 'tender-row' }, [
        h('span', { class: 'tender-method', text: row.method }),
        amount,
        reference,
        // POS-206: on screen, on the receipt and in reports alike.
        METHODS.includes(row.method) && row.method !== 'CASH'
          ? h('span', { class: 'tender-status', text: row.status })
          : null,
        row.duplicate
          ? h('label', { class: 'duplicate-accept' }, [
            h('input', {
              type: 'checkbox', checked: row.duplicateAccepted,
              onchange: (event) => { row.duplicateAccepted = event.target.checked; renderSummary(); },
            }),
            // POS-207: double-keying the same reference is the common till error.
            h('span', { text: `Used today already — confirm this is a second payment` }),
          ])
          : null,
        h('button', {
          class: 'tender-remove', 'aria-label': `Remove ${row.method}`,
          text: '×', onclick: () => { tenders.remove(row.key); renderRows(); renderSummary(); },
        }),
      ]));
    }
  }

  /** POS-207, checked when the cashier leaves the field rather than at Complete. */
  async function checkDuplicate(row) {
    const reference = String(row.referenceNo || '').trim();
    if (!reference) return;
    try {
      const { duplicates } = await api.get(
        `/sales/tender-references?method=${row.method}&reference=${encodeURIComponent(reference)}`
      );
      row.duplicate = duplicates.length > 0;
      renderRows();
      renderSummary();
    } catch { /* the server re-checks at the sale regardless (POS-207) */ }
  }

  function renderSummary() {
    const blocked = tenders.blockedReason();

    clear(summaryHost).append(...[
      line('Amount due', money(priced.total_centavos), 'due'),
      // TAX-004, restated where the money changes hands: the cashier confirms the name
      // on the ID out loud, and the figure is separate from every other discount
      // because it is a different claim.
      priced.statutory
        ? line(`${priced.statutory.id_type_label} discount`, money(-priced.statutory_discount_centavos), 'statutory')
        : null,
      priced.statutory
        ? h('p', { class: 'payment-statutory', text: `${priced.statutory.name} · ${priced.statutory.id_no}` })
        : null,
      line('Tendered', money(tenders.tenderedCentavos())),
      tenders.remainingCentavos() > 0
        ? line('Remaining', money(tenders.remainingCentavos()), 'remaining')
        // MON-007: change appears only once cash exceeds the balance.
        : line('Change', money(tenders.changeCentavos()), 'change'),
    ].filter(Boolean));

    completeButton.disabled = Boolean(blocked);
    blockedNote.textContent = blocked || '';
    blockedNote.hidden = !blocked;
  }

  const line = (label, value, cls = '') => h('div', { class: `summary-line ${cls}` }, [
    h('span', { text: label }),
    h('span', { class: 'money', text: value }),
  ]);

  /** CR-104: the customer's limit, balance and available credit, before they pay. */
  async function renderCredit() {
    if (!cart.customer) return;
    try {
      const { credit } = await api.get(`/customers/${cart.customer.id}/credit`);
      if (!credit) return;

      const over = priced.total_centavos > credit.available_centavos;
      clear(creditHost).append(
        h('h3', { text: `${cart.customer.name} — credit` }),
        line('Limit', money(credit.credit_limit_centavos)),
        line('Balance', money(credit.balance_centavos)),
        line('Available', money(credit.available_centavos), over ? 'over' : ''),
        over
          ? h('p', { class: 'credit-warning', text: 'This sale is over their available credit. A manager or owner must authorise it.' })
          : null
      );
      creditHost.hidden = false;
    } catch { /* not credit-eligible; the server refuses a credit tender anyway */ }
  }

  async function complete() {
    const blocked = tenders.blockedReason();
    if (blocked) return ui.toast(blocked, { kind: 'error' });

    completeButton.disabled = true;
    const request = {
      ...cart.toRequest(),
      tenders: tenders.toRequest(),
      // §4.1: sent so the server can compare and reject a stale screen. Never banked.
      clientTotalCentavos: priced.total_centavos,
      acceptDuplicateReference: tenders.anyDuplicateAccepted(),
      approver: approver ? { id: approver.id, username: approver.username, role: approver.role } : null,
    };

    try {
      const sale = await api.post('/sales', request);
      await api.del('/carts/active').catch(() => {});
      onComplete(sale);
    } catch (err) {
      completeButton.disabled = false;
      if (err.isRefusal) {
        // 04_UX_SPEC.md §5's refused state, with the rule and the role.
        const host = h('div', { class: 'payment-refusal' });
        ui.refused(host, err);
        clear(blockedNote).append(host);
        blockedNote.hidden = false;
      } else {
        ui.toast(err.message, { kind: 'error' });
      }
    }
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
    if (event.key === 'Enter' && !completeButton.disabled) { event.preventDefault(); complete(); }
    if (event.key === 'F10') {
      // The exact-amount shortcut: one cash row for precisely what is due.
      event.preventDefault();
      const row = tenders.add('CASH', priced.total_centavos);
      renderRows();
      renderSummary();
      return row;
    }
  }

  function mount() {
    clear(root).append(h('div', { class: 'payment' }, [
      h('h1', { text: 'Payment' }),
      summaryHost,
      creditHost,
      rowsHost,
      h('div', { class: 'tender-add' }, METHODS.map((method) => h('button', {
        class: 'tender-add-button',
        text: method,
        disabled: method === 'CREDIT' && !cart.customer,
        title: method === 'CREDIT' && !cart.customer ? 'A walk-in cannot buy on credit (CR-102)' : null,
        onclick: () => {
          // Cash defaults to what is still owed; the cashier changes it when the
          // customer hands over more.
          tenders.add(method, method === 'CASH' ? tenders.remainingCentavos() : 0);
          renderRows();
          renderSummary();
        },
      }))),
      blockedNote,
      h('div', { class: 'payment-actions' }, [
        completeButton,
        h('button', { text: 'Back  Esc', onclick: onCancel }),
      ]),
    ]));

    completeButton.addEventListener('click', complete);
    document.addEventListener('keydown', onKeyDown);
    renderRows();
    renderSummary();
    renderCredit();
  }

  const unmount = () => document.removeEventListener('keydown', onKeyDown);

  return { mount, unmount, tenders };
}
