// SCR-303 — payment.
//
// Amount due fixed at the top, tender rows by method, running remaining and change.
// Complete stays disabled until SUM(tenders) ≥ due (POS-204) and says *why* it is
// disabled, because 04_UX_SPEC.md §6 puts rule validation at the point of action and a
// greyed-out button with no explanation is what cashiers ring the owner about.
//
// TASK-060: CR-104's approval happens here. The screen said "a manager or owner must
// authorise it" and offered nobody a way to: the only way through was to split the bill
// or raise the limit. Now Complete, with more on credit than the customer has available,
// opens the authorisation panel under the tenders; the manager signs, gives the reason
// CR-104 records, and the sale completes with an approval that names CR-104. It replaces
// any approval the counter already got for a discount, and covers those rules too.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money } from '../shell/format.js';
import { createTenders, METHODS, NEEDS_REFERENCE, NEEDS_CUSTOMER } from './tenders.js';

export function createPayment({ root, cart, priced, approver = null, onComplete, onCancel }) {
  // The approval the sale will carry, and the rules it was given for (TASK-060).
  const counterRules = (priced.authorisations || []).map((a) => a.rule_id);
  let approval = approver ? { username: approver.username, token: approver.token } : null;
  let approvedFor = new Set(approver ? counterRules : []);
  let credit = null;                         // GET /customers/:id/credit, when there is one
  const authHost = h('div', { class: 'payment-authorisation' });
  // CR-108: what the store is holding for this customer, fetched with their credit
  // below. Nothing is offered against it until the server has said what it is — a
  // screen that guessed would offer a tender the sale then refuses.
  let storeCreditCentavos = 0;
  const tenders = createTenders(priced.total_centavos, { storeCreditCentavos });
  const rowsHost = h('div', { class: 'tender-rows' });
  const summaryHost = h('div', { class: 'payment-summary' });
  const creditHost = h('div', { class: 'credit-block', hidden: true });
  const completeButton = h('button', { class: 'primary complete', icon: 'check', text: 'Complete  Enter' });
  const blockedNote = h('p', { class: 'blocked-note' });
  // Its own host: which tenders may be offered depends on the customer's credit, which
  // the server has not answered when the screen is first drawn.
  const addBar = h('div', { class: 'tender-add' });

  function renderAddBar() {
    clear(addBar).append(...METHODS.map((method) => {
      // CR-102 / CR-108: both of these belong to a customer, and neither is offered to
      // a walk-in. Store credit is further conditioned on there being some — a button
      // for a balance of nothing is a button that only ever refuses.
      const needsCustomer = NEEDS_CUSTOMER.includes(method);
      const noBalance = method === 'STORE_CREDIT' && storeCreditCentavos === 0;
      if (noBalance) return null;

      return h('button', {
        class: 'tender-add-button',
        text: method === 'STORE_CREDIT' ? `STORE CREDIT ${money(storeCreditCentavos)}` : method,
        disabled: needsCustomer && !cart.customer,
        title: needsCustomer && !cart.customer
          ? 'A walk-in has no account to pay from (CR-102, CR-108)'
          : null,
        onclick: () => {
          // Cash defaults to what is still owed; the cashier changes it when the
          // customer hands over more. Store credit defaults to as much of the bill as
          // the balance covers, which is what "pay with my credit" means at a counter.
          const amount = method === 'CASH'
            ? tenders.remainingCentavos()
            : (method === 'STORE_CREDIT'
              ? Math.min(tenders.remainingCentavos(), storeCreditCentavos - tenders.storeCreditTendered())
              : 0);
          tenders.add(method, Math.max(0, amount));
          renderRows();
          renderSummary();
        },
      });
    }).filter(Boolean));
  }

  function renderRows() {
    renderAddBar();
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
          icon: 'x', onclick: () => { tenders.remove(row.key); renderRows(); renderSummary(); },
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
      // TASK-066: which order is being paid for, where a café's counter knows.
      orderLine() ? h('p', { class: 'payment-order', text: orderLine() }) : null,
      line('Amount due', money(priced.total_centavos), 'due'),
      // POS-112: already in the amount due, and said, because the customer asks.
      priced.service_charge_centavos > 0
        ? line(`incl. service charge ${priced.service_charge_bp / 100}%`, money(priced.service_charge_centavos), 'service-charge')
        : null,
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

  /** "Order 12 · Dine-in · Table 4", or nothing for a shop's sale. */
  function orderLine() {
    const served = { DINE_IN: 'Dine-in', TAKE_OUT: 'Take-out', DELIVERY: 'Delivery' }[cart.orderType];
    return [cart.openOrder ? `Order ${cart.openOrder.order_no}` : null, served || null, cart.tableLabel || null]
      .filter(Boolean).join(' · ');
  }

  const line = (label, value, cls = '') => h('div', { class: `summary-line ${cls}` }, [
    h('span', { text: label }),
    h('span', { class: 'money', text: value }),
  ]);

  /** CR-104: the customer's limit, balance and available credit, before they pay. */
  async function renderCredit() {
    if (!cart.customer) return;
    try {
      ({ credit } = await api.get(`/customers/${cart.customer.id}/credit`));
      if (!credit) return;

      // CR-108: the balance the customer holds, and the tender that spends it. Set
      // before the rows are drawn, so the STORE_CREDIT button appears with the figure
      // on it rather than appearing and then being refused.
      storeCreditCentavos = credit.store_credit_centavos || 0;
      tenders.setStoreCreditHeld(storeCreditCentavos);

      const over = priced.total_centavos > credit.available_centavos;
      clear(creditHost).append(...[
        h('h3', { text: `${cart.customer.name} — credit` }),
        line('Limit', money(credit.credit_limit_centavos)),
        // CR-108: never rendered as a debt. A negative balance is money the store owes
        // them, and the row says so in those words rather than with a minus sign.
        storeCreditCentavos > 0
          ? line('In credit', money(storeCreditCentavos), 'store-credit')
          : line('Balance', money(credit.balance_centavos)),
        line('Available', money(credit.available_centavos), over ? 'over' : ''),
        storeCreditCentavos > 0
          ? h('p', { class: 'muted', text: `The store owes ${cart.customer.name} ${money(storeCreditCentavos)}. `
            + 'It can pay for this sale, in whole or in part (CR-108).' })
          : null,
        over
          ? h('p', { class: 'credit-warning', text: `This sale is more than their available credit. Put up to `
            + `${money(Math.max(0, credit.available_centavos))} on CREDIT, or a manager or owner approves the rest `
            + 'when you press Complete.' })
          : null,
      ].filter(Boolean));
      creditHost.hidden = false;
      renderRows();
      renderSummary();
    } catch { /* not credit-eligible; the server refuses a credit tender anyway */ }
  }

  const creditTendered = () => tenders.rows
    .filter((row) => row.method === 'CREDIT')
    .reduce((sum, row) => sum + (row.amountCentavos || 0), 0);

  /**
   * CR-104's panel, under the tenders rather than over them: the approver reads the
   * figures they are approving on the screen behind it (04_UX_SPEC.md §4).
   */
  function askCreditApproval(message = null) {
    const onCredit = creditTendered();
    // Over by what the balance will exceed the limit, not by what exceeds "available"
    // shown as zero: a customer already past their limit goes further past it.
    const availableNow = credit ? credit.available_centavos : 0;
    const text = message || `${cart.customer.name} has ${money(Math.max(0, availableNow))} of credit available. `
      + `This sale puts ${money(onCredit)} on credit, taking them ${money(onCredit - availableNow)} over their `
      + `limit of ${money(credit ? credit.credit_limit_centavos : 0)}.`;
    clear(authHost).append(ui.authorisationPanel({
      message: text,
      ruleId: 'CR-104',
      requiresRole: 'MANAGER or OWNER',
      askReason: true,
      onCancel: () => { clear(authHost); completeButton.focus(); },
      onApprove: async ({ username, password, reason }) => {
        if (!reason) throw new Error(`Say why ${cart.customer.name} may go over their limit.`);
        // One approval for the sale: whatever the counter already needed, and the credit.
        const rules = [...new Set([...counterRules, 'CR-104'])];
        const given = await api.approve(username, password, rules);
        // Said in the panel, not after a round trip: the server refuses it again anyway.
        if (!['MANAGER', 'OWNER'].includes(given.role)) {
          throw new Error(`${given.username} is a ${String(given.role).toLowerCase()} and cannot approve this. `
            + 'A manager or owner must.');
        }
        approval = { username: given.username, token: given.token, reason };
        approvedFor = new Set(rules);
        clear(authHost);
        await complete();
      },
    }));
  }

  async function complete() {
    const blocked = tenders.blockedReason();
    if (blocked) return ui.toast(blocked, { kind: 'error' });

    // CR-104, asked before the sale is sent rather than discovered in its refusal.
    if (credit && creditTendered() > credit.available_centavos && !approvedFor.has('CR-104')) {
      askCreditApproval();
      return undefined;
    }

    completeButton.disabled = true;
    const request = {
      ...cart.toRequest(),
      tenders: tenders.toRequest(),
      // §4.1: sent so the server can compare and reject a stale screen. Never banked.
      clientTotalCentavos: priced.total_centavos,
      acceptDuplicateReference: tenders.anyDuplicateAccepted(),
      approver: approval,
    };

    try {
      const sale = await api.post('/sales', request);
      await api.del('/carts/active').catch(() => {});
      onComplete(sale);
    } catch (err) {
      completeButton.disabled = false;
      // The limit moved under the screen (another till, a payment), or the approval did
      // not cover it: the panel again, with the server's own sentence.
      if (err.ruleId === 'CR-104') {
        approvedFor.delete('CR-104');
        askCreditApproval(err.message);
        return;
      }
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
    // Keys typed into the approval panel are the panel's: Enter approves, Escape closes it.
    if (authHost.contains(event.target)) {
      if (event.key === 'Escape') { event.preventDefault(); clear(authHost); completeButton.focus(); }
      return undefined;
    }
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
      addBar,
      authHost,
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
