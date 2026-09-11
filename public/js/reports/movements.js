// SCR-608 — movement analysis (TASK-033, INV-102, INV-103, TX-422).
//
// Every increase and decrease has been append-only and typed since TASK-007, and until
// now nothing had ever summarised them. A store could not see that it wrote ₱18,000 of
// damage off this quarter, or that its count variances all fall on one shelf.
//
// **Behind `TX-422`, not `TX-421`, and that is the reason it is a separate screen.** The
// person who needs to know what was damaged is the inventory clerk, who has no business
// reading the day's takings. Folding this into the sales analysis would have handed them
// the takings or hidden the movements from them.
//
// **Two value columns, never one.** `INV-106` costs a movement on the way *in* and never
// on the way out — a sale or a write-off consumes at the average prevailing at the time,
// which is used and not stored. So what a receipt cost is a fact, and what a damaged
// sack was worth is an estimate at today's average cost. The screen says which is which
// per row, because a single merged figure is the comfortable report and the one that
// quietly restates last quarter's write-offs the next time a delivery moves an average.
//
// **The reconciliation is printed** (`INV-101`): opening plus what moved is closing, and
// closing is what the rest of the system reads as stock.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money } from '../shell/format.js';

const BASIS_LABELS = {
  MOVEMENT_COST: 'From the movement',
  ESTIMATE_AT_CURRENT_AVERAGE: 'Estimated at today’s average',
  MIXED: 'Part movement, part estimate',
};

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });

export function createMovements({ root, onBack, range = null }) {
  let params = range && range.from
    ? { from: range.from, to: range.to || range.from }
    : { from: today(), to: today() };
  let type = null;
  let data = null;

  async function load() {
    ui.loading(root, { rows: 6 });
    try {
      data = await api.get(
        `/reports/movements?from=${params.from}&to=${params.to}${type ? `&type=${type}` : ''}`
      );
      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  function render() {
    clear(root).append(h('section', { class: 'report report-movements' }, [
      controls(),
      headerBlock(data.header),
      reconciliation(data.reconciliation),
      typeTable(),
      productTable(),
      h('p', { class: 'muted rule-note', text: data.value_basis }),
    ]));
  }

  function controls() {
    const from = h('input', { type: 'date', value: params.from, 'aria-label': 'From' });
    const to = h('input', { type: 'date', value: params.to, 'aria-label': 'To' });

    return h('header', { class: 'report-head' }, [
      h('button', { class: 'report-back', text: '← Dashboard', onclick: () => onBack() }),
      h('h1', { text: 'Movement analysis' }),
      h('form', {
        class: 'report-range',
        onsubmit: (event) => {
          event.preventDefault();
          params = { from: from.value, to: to.value };
          load();
        },
      }, [
        h('label', { text: 'From' }, [from]),
        h('label', { text: 'To' }, [to]),
        h('button', { type: 'submit', text: 'Show' }),
      ]),
      h('a', {
        class: 'report-export',
        href: `/api/v1/reports/movements/export.csv?from=${params.from}&to=${params.to}`,
        // SEC-7: the token is in memory, so the click fetches and saves a blob.
        onclick: (event) => { event.preventDefault(); exportCsv(); },
        text: 'Export CSV',
      }),
    ]);
  }

  async function exportCsv() {
    try {
      const filename = api.saveAs(await api.download(
        `/reports/movements/export.csv?from=${params.from}&to=${params.to}`
      ));
      ui.toast(`${filename} saved`, { kind: 'success' });
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
  }

  function headerBlock(head) {
    return h('dl', { class: 'report-meta' }, [
      field('Range', head.from_date === head.to_date ? head.from_date : `${head.from_date} to ${head.to_date}`),
      field('Scope', 'WHOLE STORE'),
      field('Generated', `${head.generated_at_manila} by ${head.generated_by}`),
    ]);
  }

  const field = (label, value) => h('div', { class: 'meta-field' }, [
    h('dt', { text: label }), h('dd', { text: value }),
  ]);

  /** INV-101, as arithmetic the reader can follow rather than a tick. */
  function reconciliation(r) {
    const onHand = r.matches_on_hand;
    return h('div', { class: `reconciliation ${r.balances ? 'balances' : 'does-not-balance'}` }, [
      h('h2', { text: 'Reconciliation' }),
      h('p', { class: 'recon-line', text: r.statement }),
      h('p', {
        class: 'recon-verdict',
        role: r.balances && onHand !== false ? null : 'alert',
        text: r.balances
          ? (onHand === false
            // The one that matters: the ledger agrees with itself and disagrees with the
            // figure the POS sells against, which is a defect in INV-101's materialised
            // balance rather than in this report.
            ? 'The ledger balances, but it does not match the on-hand figure the rest of the '
              + 'system reads. That is a defect (INV-101). Report it before acting on these figures.'
            : 'This ledger reconciles.')
          : `The ledger does not reconcile — out by ${r.difference_milli / 1000}. `
            + 'That is a defect, not a rounding artefact (INV-101).',
      }),
      h('p', { class: 'muted', text: r.units_note }),
      h('p', { class: 'recon-rule', text: r.rule_id }),
    ]);
  }

  /** Requirement 7's first half: what happened, by INV-103 type, for the whole store. */
  function typeTable() {
    if (data.types.length === 0) {
      return h('p', { class: 'muted', text: 'Nothing moved in this range.' });
    }
    return h('div', { class: 'table-scroll' }, [
      h('table', { class: 'lines movement-types' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: 'Type' }), h('th', { text: 'Movements' }), h('th', { text: 'Products' }),
          h('th', { class: 'money', text: 'Costed' }), h('th', { class: 'money', text: 'Estimated' }),
          h('th', { class: 'money', text: 'Value' }), h('th', { text: 'Where the value comes from' }),
          h('th', { text: '' }),
        ])]),
        h('tbody', {}, data.types.map((row) => h('tr', {
          class: row.movement_type === type ? 'is-matched' : null,
        }, [
          h('td', {}, [
            h('span', { text: row.label }),
            h('small', { class: 'muted', text: row.movement_type }),
          ]),
          h('td', { text: String(row.movement_count) }),
          h('td', { text: String(row.product_count) }),
          h('td', { class: 'money', text: money(row.costed_value_centavos) }),
          h('td', { class: 'money', text: money(row.estimated_value_centavos) }),
          h('td', { class: 'money', text: money(row.value_centavos) }),
          h('td', { class: 'muted', text: BASIS_LABELS[row.value_basis] || row.value_basis }),
          h('td', {}, [
            h('button', {
              class: 'row-action',
              text: row.movement_type === type ? 'Show all' : 'Only this',
              onclick: () => { type = row.movement_type === type ? null : row.movement_type; load(); },
            }),
          ]),
        ]))),
      ]),
    ]);
  }

  /**
   * Requirement 7's second half — the grain at which a quantity means anything.
   *
   * UOM-001 is why there is no store-wide quantity total above: 40 KG of feed and 40
   * sachets of dewormer are not 80 of the same thing. A product's own base unit is the
   * only scope in which a quantity can be summed, and it is on every row here.
   */
  function productTable() {
    if (data.products.length === 0) return null;
    return h('div', {}, [
      h('h2', { text: data.filter_type ? `${data.filter_type} — by product` : 'By product' }),
      h('div', { class: 'table-scroll' }, [
        h('table', { class: 'lines' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: 'SKU' }), h('th', { text: 'Product' }), h('th', { text: 'Type' }),
            h('th', { text: 'Net' }), h('th', { class: 'money', text: 'Costed' }),
            h('th', { class: 'money', text: 'Estimated' }),
          ])]),
          h('tbody', {}, data.products.map((row) => h('tr', {}, [
            h('td', { class: 'sku', text: row.sku }),
            h('td', { text: row.product_name }),
            h('td', { text: row.label }),
            h('td', { class: row.net_milli < 0 ? 'is-low' : null, text: row.net_display }),
            h('td', { class: 'money', text: money(row.costed_value_centavos) }),
            h('td', { class: 'money', text: money(row.estimated_value_centavos) }),
          ]))),
        ]),
      ]),
    ]);
  }

  return { mount: load, unmount() {} };
}
