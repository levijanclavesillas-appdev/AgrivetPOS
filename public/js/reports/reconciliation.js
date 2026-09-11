// SCR-606 — payment reconciliation (TASK-032, RPT-105).
//
// The wallet's statement has arrived and somebody is holding it. This screen asks one
// question per method — *what actually settled?* — and answers with the difference.
//
// **Nothing on this screen changes a figure, and that is the feature.** `RPT-105`
// forbids adjusting the recorded total, because the temptation is exactly the problem:
// the statement says ₱14,270, the POS says ₱14,320, and a "correct to actual" button
// would make the discrepancy go away along with the only record of a ₱50 sale a cashier
// recorded and nobody ever paid. The variance is the output.
//
// **The absences are stated.** Cash is reconciled at the drawer (`POS-510`) and is shown
// from there rather than counted twice; credit and store credit settle nowhere at all. A
// screen that simply omitted three of the five methods would be a screen somebody
// distrusts on the day they notice.
//
// A variance drills through to the tenders behind it, because "we are ₱50 short" is
// answered by reading down a list until the ₱50 turns up — a missing reference, a
// duplicate, a transfer that never arrived.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money } from '../shell/format.js';

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });

export function createReconciliation({ root, onBack, range = null }) {
  // The range the caller was already looking at, where there is one: arriving from the
  // payments report for the first week of the month and being shown today instead is
  // how somebody reconciles the wrong week.
  let params = range && range.from
    ? { from: range.from, to: range.to || range.from }
    : { from: today(), to: today() };
  let data = null;
  let drilled = null;   // { method, tenders }

  async function load() {
    ui.loading(root, { rows: 5 });
    try {
      data = await api.get(`/reports/reconciliation?from=${params.from}&to=${params.to}`);
      drilled = null;
      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  function render() {
    clear(root).append(h('section', { class: 'report report-reconciliation' }, [
      controls(),

      h('dl', { class: 'report-meta' }, [
        metaField('Range', params.from === params.to ? params.from : `${params.from} to ${params.to}`),
        metaField('Tolerance', money(data.tolerance_centavos)),
        // POS-206, on the screen that exists because of it.
        metaField('What the POS knows', 'RECORDED — the cashier saw it'),
      ]),

      h('div', { class: 'table-scroll' }, [
        h('table', { class: 'catalogue-list reconcile-list' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: 'Method' }),
            h('th', { class: 'money', text: 'Recorded' }),
            h('th', { text: 'Settled' }),
            h('th', { class: 'money', text: 'Variance' }),
            h('th', { text: '' }),
          ])]),
          h('tbody', {}, data.methods.map(methodRow)),
        ]),
      ]),

      drilled ? drillBlock() : null,

      // Requirement 2: what is not here, and why — rather than three methods quietly
      // missing from a screen about payments.
      h('div', { class: 'reconcile-excluded' }, [
        h('h2', { text: 'Not reconciled here' }),
        h('dl', { class: 'report-meta' }, [
          metaField('Cash', `${data.cash.recorded_display} — ${data.cash.why}`),
          ...data.excluded
            .filter((row) => row.method !== 'CASH')
            .map((row) => metaField(row.method === 'STORE_CREDIT' ? 'Store credit' : 'Credit', row.why)),
        ]),
      ]),

      h('p', { class: 'muted rule-note', text: data.basis }),
    ]));
  }

  function controls() {
    const from = h('input', { type: 'date', value: params.from, 'aria-label': 'From' });
    const to = h('input', { type: 'date', value: params.to, 'aria-label': 'To' });

    return h('header', { class: 'report-head' }, [
      h('button', { class: 'report-back', text: '← Dashboard', onclick: () => onBack() }),
      h('h1', { text: 'Reconciliation' }),
      h('form', {
        class: 'report-range',
        onsubmit: (event) => {
          event.preventDefault();
          params = { from: from.value, to: to.value };
          load();
        },
      }, [from, to, h('button', { type: 'submit', class: 'row-action', text: 'Show' })]),
    ]);
  }

  function methodRow(row) {
    // Requirement 7: a range already reconciled is said so on the row, with the answer
    // that was given — rather than refusing at the end of the typing.
    const done = row.already_reconciled[0] || null;

    return h('tr', { class: done ? 'is-matched' : '' }, [
      h('td', {}, [
        h('span', { text: row.method }),
        h('small', { class: 'muted', text: `${row.tender_count} tender${row.tender_count === 1 ? '' : 's'}` }),
      ]),
      h('td', { class: 'money' }, [
        h('span', { text: row.recorded_display }),
        h('small', { class: 'muted', text: row.recorded_label }),
      ]),
      h('td', {}, done
        ? [h('span', { text: done.actual_display }), h('small', { class: 'muted', text: `by ${done.reconciled_by}` })]
        : [settleForm(row)]),
      h('td', { class: 'money' }, done
        ? [
          h('span', { text: done.variance_label }),
          done.reason ? h('small', { class: 'muted', text: done.reason }) : null,
        ]
        : [h('span', { class: 'muted', text: '—' })]),
      h('td', {}, [
        h('button', {
          class: 'row-action', text: 'Show tenders',
          onclick: () => showTenders(row.method),
        }),
      ]),
    ]);
  }

  /** One method's answer: what the statement says, its reference, and why if it differs. */
  function settleForm(row) {
    const amount = h('input', {
      type: 'text', inputmode: 'decimal', class: 'money settle-amount',
      placeholder: '0.00', 'aria-label': `Amount settled for ${row.method}`,
    });
    const reference = h('input', {
      type: 'text', class: 'settle-reference', placeholder: 'Statement reference',
      'aria-label': `Statement reference for ${row.method}`,
    });
    const reason = h('input', {
      type: 'text', class: 'settle-reason', placeholder: 'Why, if it differs',
      'aria-label': `Reason for the ${row.method} variance`,
    });

    return h('form', {
      class: 'settle-form',
      onsubmit: async (event) => {
        event.preventDefault();
        const pesos = Number.parseFloat(amount.value);
        if (!Number.isFinite(pesos) || pesos < 0) {
          ui.toast('Enter what the statement says settled, in pesos.', { kind: 'error' });
          return;
        }
        try {
          const saved = await api.post('/reconciliations', {
            from: params.from,
            to: params.to,
            method: row.method,
            actualCentavos: Math.round(pesos * 100),
            reference: reference.value.trim() || null,
            reason: reason.value.trim() || null,
          });
          ui.toast(`${row.method}: ${saved.variance_label}.`, { kind: 'success' });
          await load();
        } catch (err) {
          // A refusal here is RPT-105 asking for a reason, which is a sentence worth
          // showing whole rather than a field turning red.
          ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
        }
      },
    }, [amount, reference, reason, h('button', { type: 'submit', class: 'row-action', text: 'Record' })]);
  }

  async function showTenders(method) {
    try {
      drilled = await api.get(
        `/reports/reconciliation/tenders?from=${params.from}&to=${params.to}&method=${method}`
      );
      render();
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
  }

  function drillBlock() {
    return h('div', { class: 'reconcile-drill' }, [
      h('h2', { text: `${drilled.method} — what the POS recorded` }),
      h('p', { class: 'muted', text: 'The tenders behind the figure, so a difference can be found '
        + 'rather than only stated. A missing reference is the first thing to look at.' }),
      h('div', { class: 'table-scroll' }, [
        h('table', { class: 'catalogue-list' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: 'Receipt' }), h('th', { text: 'When' }), h('th', { text: 'Cashier' }),
            h('th', { text: 'Reference' }), h('th', { class: 'money', text: 'Amount' }),
          ])]),
          h('tbody', {}, drilled.tenders.map((tender) => h('tr', {
            class: tender.reference_no ? '' : 'is-low',
          }, [
            h('td', { class: 'sku', text: tender.sale_no }),
            h('td', { text: tender.occurred_at_manila }),
            h('td', { text: tender.cashier || '—' }),
            h('td', { text: tender.reference_no || 'no reference' }),
            h('td', { class: 'money', text: tender.amount_display }),
          ]))),
        ]),
      ]),
    ]);
  }

  const metaField = (label, value) => h('div', { class: 'meta-field' }, [
    h('dt', { text: label }), h('dd', { text: value }),
  ]);

  return { mount: load, unmount() {} };
}
