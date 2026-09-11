// SCR-602, SCR-603, SCR-604 — the three v1.0 reports.
//
// One view for three reports, because they are the same screen: a header stating what
// the figures cover (RPT-106), a body, and an export. Three near-identical files would
// be three places for the header to drift out of agreement with itself.
//
// The reconciliation on SCR-602 is rendered as arithmetic the reader can follow rather
// than as a tick, because FR_6.2 asks the report to reconcile *on the report*. A green
// tick asserting that two numbers agree is worth nothing to someone who suspects they
// do not.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money, percent, manila } from '../shell/format.js';

const TITLES = {
  daily: 'Daily sales',
  payments: 'Payments',
  valuation: 'Inventory valuation',
};

const PATHS = {
  daily: (p) => `/reports/daily?from=${p.from}&to=${p.to}${p.shiftId ? `&shiftId=${p.shiftId}` : ''}`,
  payments: (p) => `/reports/payments?from=${p.from}&to=${p.to}${p.shiftId ? `&shiftId=${p.shiftId}` : ''}`,
  valuation: () => '/reports/inventory/valuation',
};

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });

export function createReport({ root, session, report, onBack, onReconcile = null }) {
  let params = { from: today(), to: today(), shiftId: null };

  async function load() {
    ui.loading(root, { rows: 5 });
    try {
      render(await api.get(PATHS[report](params)));
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  function render(data) {
    clear(root).append(h('section', { class: `report report-${report}` }, [
      controls(),
      headerBlock(data.header),
      body(data),
    ]));
  }

  function controls() {
    const from = h('input', { type: 'date', value: params.from, 'aria-label': 'From' });
    const to = h('input', { type: 'date', value: params.to, 'aria-label': 'To' });

    return h('header', { class: 'report-head' }, [
      h('button', { class: 'report-back', text: '← Dashboard', onclick: onBack }),
      h('h1', { text: TITLES[report] }),
      report === 'valuation' ? null : h('form', {
        class: 'report-range',
        onsubmit: (event) => {
          event.preventDefault();
          params = { ...params, from: from.value, to: to.value };
          load();
        },
      }, [
        h('label', { text: 'From' }, [from]),
        h('label', { text: 'To' }, [to]),
        h('button', { type: 'submit', text: 'Show' }),
      ]),
      h('a', {
        class: 'report-export',
        href: `/api/v1/reports/${report}/export.csv?from=${params.from}&to=${params.to}`,
        // The token lives in memory only (SEC-7), so a plain link cannot carry it.
        // The click fetches with the header and hands the browser a blob instead.
        onclick: (event) => { event.preventDefault(); exportCsv(); },
        text: 'Export CSV',
      }),
      // RPT-105 (TASK-032), from the screen somebody is already on when the wallet's
      // statement arrives: this report is the recorded figure, and reconciliation is
      // the question about it. It changes nothing here — SCR-606 writes no figure back.
      report === 'payments' && onReconcile
        ? h('button', { class: 'row-action', text: 'Reconcile', onclick: () => onReconcile(params) })
        : null,
    ]);
  }

  /** TX-426. A refusal is shown as a refusal, not as a broken download. */
  async function exportCsv() {
    try {
      // Saved through the shell's own helper (TASK-025), so the object-URL dance —
      // including revoking it a tick late, which some builds need — lives once.
      const filename = api.saveAs(await api.download(
        `/reports/${report}/export.csv?from=${params.from}&to=${params.to}`
      ));
      ui.toast(`${filename} saved`, { kind: 'success' });
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
  }

  /** RPT-106, on every report without exception. */
  function headerBlock(head) {
    return h('dl', { class: 'report-meta' }, [
      field('Range', head.from_date === head.to_date ? head.from_date : `${head.from_date} to ${head.to_date}`),
      field('Scope', head.store_scope),
      field('Tax mode', head.tax_modes_in_range.length > 1
        ? `${head.tax_mode} (range contains ${head.tax_modes_in_range.join(', ')})`
        : head.tax_mode),
      field('Voided sales', head.includes_voided
        ? 'Included'
        : `Excluded — ${head.voided_excluded_count} (${money(head.voided_excluded_centavos)})`),
      head.as_of ? field('As of', manila(head.as_of)) : null,
      field('Generated', `${head.generated_at_manila} by ${head.generated_by}`),
    ]);
  }

  const field = (label, value) => h('div', { class: 'meta-field' }, [
    h('dt', { text: label }),
    h('dd', { text: value }),
  ]);

  function body(data) {
    if (report === 'daily') return dailyBody(data);
    if (report === 'payments') return paymentsBody(data);
    return valuationBody(data);
  }

  // ── SCR-602 ───────────────────────────────────────────────────────────────

  function dailyBody(data) {
    const t = data.totals;
    const r = data.reconciliation;

    return h('div', { class: 'report-body' }, [
      h('table', { class: 'totals' }, [
        h('tbody', {}, [
          row('Gross', t.gross_centavos),
          row('Line discounts', -t.line_discount_centavos),
          row('Transaction discounts', -t.txn_discount_centavos),
          // POS-301 is v1.1. Shown at zero, because RPT-101's identity has four terms
          // and a reader who cannot see the fourth cannot check the arithmetic.
          row('Returns', -t.returns_centavos),
          h('tr', { class: 'total-row' }, [h('th', { text: 'Net' }), h('td', { class: 'money', text: money(t.net_centavos) })]),
          row('VAT', t.vat_centavos),
          row('Tendered', t.tendered_centavos),
          row('Change given', -t.change_centavos),
          h('tr', {}, [h('th', { text: 'Transactions' }), h('td', { text: String(t.sale_count) })]),
        ]),
      ]),

      // FR_6.2: the reconciliation is printed, not merely checked.
      h('div', { class: `reconciliation ${r.reconciles ? 'balances' : 'does-not-balance'}` }, [
        h('h2', { text: 'Reconciliation' }),
        h('p', { class: 'recon-line', text: r.statement }),
        h('p', { class: 'recon-line', text: `${r.tender_statement} = net` }),
        h('p', {
          class: 'recon-verdict',
          role: r.reconciles ? null : 'alert',
          // RPT-101: a report that does not reconcile is a defect, and it says so in
          // those words rather than showing a red mark someone might read as rounding.
          text: r.reconciles
            ? 'This report reconciles.'
            : `This report does not reconcile — out by ${money(r.difference_centavos)}. `
              + 'That is a defect, not a rounding artefact (RPT-101). Report it before acting on these figures.',
        }),
        h('p', { class: 'recon-rule', text: 'RPT-101' }),
      ]),

      h('div', { class: 'profit' }, [
        h('h2', { text: 'Gross profit' }),
        h('p', { class: 'profit-figure', text: money(data.profit.gross_profit_centavos) }),
        h('p', { class: 'profit-margin', text: `${percent(data.profit.margin_bp)} margin` }),
        h('p', { class: 'profit-basis', text: data.profit.basis }),
      ]),

      data.lines.length === 0
        ? h('p', { class: 'muted', text: 'Nothing was sold in this range.' })
        : h('table', { class: 'lines' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: 'Product' }), h('th', { text: 'Quantity' }),
            h('th', { text: 'Revenue' }), h('th', { text: 'Cost' }), h('th', { text: 'Gross profit' }),
          ])]),
          h('tbody', {}, data.lines.map((line) => h('tr', {}, [
            h('td', { text: line.product_name }),
            h('td', { text: line.qty_display }),
            h('td', { class: 'money', text: money(line.revenue_centavos) }),
            h('td', { class: 'money', text: money(line.cost_centavos) }),
            h('td', { class: 'money', text: money(line.gross_profit_centavos) }),
          ]))),
        ]),

      voidsBlock(data.sales),
    ]);
  }

  const row = (label, centavos) => h('tr', {}, [
    h('th', { text: label }),
    h('td', { class: 'money', text: money(centavos) }),
  ]);

  /** RPT-106: out of net, not out of sight. */
  function voidsBlock(sales) {
    const voided = sales.filter((s) => s.excluded_from_net);
    if (voided.length === 0) return null;

    return h('div', { class: 'voids' }, [
      h('h2', { text: 'Voided — excluded from every figure above' }),
      h('ul', {}, voided.map((s) => h('li', {
        text: `${s.sale_no} · ${s.occurred_at_manila} · ${money(s.total_centavos)} · ${s.cashier_username}`,
      }))),
    ]);
  }

  // ── SCR-603 ───────────────────────────────────────────────────────────────

  function paymentsBody(data) {
    if (data.methods.length === 0) {
      return h('p', { class: 'muted', text: 'No payments were taken in this range.' });
    }

    return h('div', {}, [
      h('table', { class: 'methods' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: 'Method' }), h('th', { text: 'Status' }), h('th', { text: 'Sales' }),
          h('th', { text: 'Tenders' }), h('th', { text: 'Tendered' }),
          h('th', { text: 'Change' }), h('th', { text: 'Net' }), h('th', { text: 'Share' }),
        ])]),
        h('tbody', {}, data.methods.map((m) => h('tr', {}, [
          h('td', { text: m.method }),
          // POS-206: RECORDED, on screen and on the printed document alike. Nothing
          // here may ever read "verified" — no payment API confirms these.
          h('td', { class: 'recorded', text: m.recorded_label || '' }),
          h('td', { text: String(m.sale_count) }),
          h('td', { text: String(m.tender_count) }),
          h('td', { class: 'money', text: money(m.amount_centavos) }),
          h('td', { class: 'money', text: m.change_centavos ? money(-m.change_centavos) : '' }),
          h('td', { class: 'money', text: money(m.net_centavos) }),
          h('td', { text: percent(m.share_bp) }),
        ]))),
        h('tfoot', {}, [h('tr', {}, [
          h('th', { text: 'Total' }), h('td', {}), h('td', {}), h('td', {}),
          h('td', { class: 'money', text: money(data.tendered_centavos) }),
          h('td', { class: 'money', text: money(-data.change_centavos) }),
          h('td', { class: 'money', text: money(data.total_centavos) }),
          h('td', { text: '100.0%' }),
        ])]),
      ]),
      // Why there are two columns and not one: the tendered figure is what crossed the
      // counter, the net is what stayed in the drawer, and only the second reconciles
      // to the daily report (RPT-101).
      h('p', { class: 'methods-note', text: 'Net is what was tendered less the change given. '
        + 'It is the figure that agrees with net sales on the daily report.' }),
    ]);
  }

  // ── SCR-604 ───────────────────────────────────────────────────────────────

  function valuationBody(data) {
    return h('div', { class: 'report-body' }, [
      h('p', { class: 'valuation-total' }, [
        h('span', { class: 'money', text: money(data.total_value_centavos) }),
        h('span', { class: 'muted', text: ` across ${data.product_count} products` }),
      ]),
      h('table', { class: 'valuation' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: 'SKU' }), h('th', { text: 'Product' }), h('th', { text: 'On hand' }),
          h('th', { text: 'Average cost' }), h('th', { text: 'Value' }),
        ])]),
        h('tbody', {}, data.products.map((p) => h('tr', { class: p.is_active ? null : 'inactive' }, [
          h('td', { text: p.sku }),
          h('td', { text: p.name }),
          h('td', { text: p.qty_on_hand_display }),
          h('td', { class: 'money', text: money(p.avg_cost_centavos) }),
          h('td', { class: 'money', text: money(p.value_centavos) }),
        ]))),
      ]),
    ]);
  }

  return {
    mount: load,
    unmount() {},
    get params() { return params; },
  };
}
