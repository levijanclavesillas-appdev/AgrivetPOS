// SCR-607 — sales analysis (TASK-033, FT-602, FT-605).
//
// The owner has the day's total. This screen has the reasons for it: which shelf, which
// till, which product, and what is not moving at all.
//
// **Four tabs and one screen, because they are one report seen four ways.** The range,
// the header and the export are the same in all four, and four files would be four
// places for RPT-106's disclosure to drift apart — the same reason SCR-602/603/604 share
// a view.
//
// **The screen computes nothing.** Every total, share, margin and reconciliation on it
// is a field the server sent. A percentage worked out in the renderer is a percentage
// that disagrees with the CSV of the same report the first time somebody rounds
// differently, and the reconciliation line is the whole point of the report.
//
// **What each tab reconciles to is printed on it.** Category figures are line-level and
// reconcile to revenue; cashier figures are sale-level and reconcile to net sales before
// returns. Those are different anchors for a good reason — a transaction discount
// belongs to a sale and not to any of its lines — and the report says which it is using
// rather than leaving a reader to add a column up and disbelieve it.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money, percent } from '../shell/format.js';

const TABS = [
  { id: 'by-category', label: 'By category' },
  { id: 'by-cashier', label: 'By cashier' },
  { id: 'by-product', label: 'By product' },
  { id: 'movers', label: 'Movers' },
];

const SORT_LABELS = {
  revenue: 'Revenue', quantity: 'Quantity', profit: 'Gross profit',
  transactions: 'Transactions', name: 'Name',
};

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });

export function createAnalysis({ root, onBack, tab = 'by-category', range = null }) {
  // The range the caller was already looking at, where there is one: arriving from the
  // daily report for last week and being shown today instead is how somebody reads the
  // wrong week's breakdown.
  let params = range && range.from
    ? { from: range.from, to: range.to || range.from }
    : { from: today(), to: today() };
  let active = TABS.some((entry) => entry.id === tab) ? tab : 'by-category';
  let sort = 'revenue';
  let data = null;

  const path = () => {
    const base = `/reports/${active}?from=${params.from}&to=${params.to}`;
    return active === 'by-product' ? `${base}&sort=${sort}&limit=200` : base;
  };

  async function load() {
    ui.loading(root, { rows: 6 });
    try {
      data = await api.get(path());
      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  function render() {
    clear(root).append(h('section', { class: `report report-analysis report-${active}` }, [
      controls(),
      h('nav', { class: 'admin-tabs', 'aria-label': 'Sales analysis' }, TABS.map((entry) => h('button', {
        class: `admin-tab${entry.id === active ? ' is-active' : ''}`,
        'aria-current': entry.id === active ? 'page' : null,
        text: entry.label,
        onclick: () => { active = entry.id; load(); },
      }))),
      headerBlock(data.header),
      body(),
      // RPT-104's basis and the limitation that comes with it, on every tab.
      h('p', { class: 'muted rule-note', text: data.basis }),
    ]));
  }

  function controls() {
    const from = h('input', { type: 'date', value: params.from, 'aria-label': 'From' });
    const to = h('input', { type: 'date', value: params.to, 'aria-label': 'To' });

    return h('header', { class: 'report-head' }, [
      h('button', { class: 'report-back', text: '← Dashboard', onclick: () => onBack() }),
      h('h1', { text: 'Sales analysis' }),
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
        href: `/api/v1/reports/${active}/export.csv?from=${params.from}&to=${params.to}`,
        // The token lives in memory only (SEC-7), so a plain link cannot carry it.
        onclick: (event) => { event.preventDefault(); exportCsv(); },
        text: 'Export CSV',
      }),
    ]);
  }

  async function exportCsv() {
    try {
      const filename = api.saveAs(await api.download(
        `/reports/${active}/export.csv?from=${params.from}&to=${params.to}`
        + (active === 'by-product' ? `&sort=${sort}&limit=200` : '')
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
      field('Voided sales', `Excluded — ${head.voided_excluded_count} (${money(head.voided_excluded_centavos)})`),
      field('Generated', `${head.generated_at_manila} by ${head.generated_by}`),
    ]);
  }

  const field = (label, value) => h('div', { class: 'meta-field' }, [
    h('dt', { text: label }), h('dd', { text: value }),
  ]);

  function body() {
    if (active === 'by-category') return categoryBody();
    if (active === 'by-cashier') return cashierBody();
    if (active === 'by-product') return productBody();
    return moversBody();
  }

  /**
   * FR_6.2's demand applied to a grouping: the check is printed, not ticked.
   *
   * A breakdown that quietly loses a line — an INNER JOIN to a category is exactly the
   * shape that does — looks entirely correct until somebody adds the column up.
   */
  function reconciliation(r) {
    return h('div', { class: `reconciliation ${r.balances ? 'balances' : 'does-not-balance'}` }, [
      h('p', { class: 'recon-line', text: r.statement }),
      h('p', {
        class: 'recon-verdict',
        role: r.balances ? null : 'alert',
        text: r.balances
          ? 'This breakdown adds up to the report it came from.'
          : `This breakdown does not add up — out by ${money(r.difference_centavos)}. `
            + 'That is a defect, not a rounding artefact (RPT-101). Report it before acting on these figures.',
      }),
      h('p', { class: 'recon-rule', text: r.rule_id }),
    ]);
  }

  function categoryBody() {
    if (data.categories.length === 0) {
      return h('p', { class: 'muted', text: 'Nothing was sold in this range.' });
    }
    return h('div', { class: 'report-body' }, [
      reconciliation(data.reconciliation),
      h('div', { class: 'table-scroll' }, [
        h('table', { class: 'lines' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: 'Category' }), h('th', { text: 'Products' }), h('th', { text: 'Lines' }),
            h('th', { class: 'money', text: 'Revenue' }), h('th', { class: 'money', text: 'Cost' }),
            h('th', { class: 'money', text: 'Gross profit' }), h('th', { text: 'Margin' }),
            h('th', { text: 'Share' }),
          ])]),
          h('tbody', {}, data.categories.map((row) => h('tr', {}, [
            h('td', { text: row.category_name }),
            h('td', { text: String(row.product_count) }),
            h('td', { text: String(row.line_count) }),
            h('td', { class: 'money', text: money(row.revenue_centavos) }),
            h('td', { class: 'money', text: money(row.cost_centavos) }),
            h('td', { class: 'money', text: money(row.gross_profit_centavos) }),
            h('td', { text: percent(row.margin_bp) }),
            h('td', { text: percent(row.share_bp) }),
          ]))),
          h('tfoot', {}, [h('tr', {}, [
            h('th', { text: 'Total' }), h('td', { text: String(data.totals.category_count) }), h('td', {}),
            h('td', { class: 'money', text: money(data.totals.revenue_centavos) }),
            h('td', { class: 'money', text: money(data.totals.cost_centavos) }),
            h('td', { class: 'money', text: money(data.totals.gross_profit_centavos) }),
            h('td', { text: percent(data.totals.margin_bp) }),
            h('td', { text: '100.0%' }),
          ])]),
        ]),
      ]),
    ]);
  }

  function cashierBody() {
    if (data.cashiers.length === 0) {
      return h('p', { class: 'muted', text: 'Nobody rang up a sale in this range.' });
    }
    return h('div', { class: 'report-body' }, [
      reconciliation(data.reconciliation),
      h('div', { class: 'table-scroll' }, [
        h('table', { class: 'lines' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: 'Cashier' }), h('th', { text: 'Shifts' }), h('th', { text: 'Transactions' }),
            h('th', { class: 'money', text: 'Net sales' }), h('th', { class: 'money', text: 'Average sale' }),
            h('th', { class: 'money', text: 'Discounts' }),
            h('th', { class: 'money', text: 'Gross profit' }), h('th', { text: 'Margin' }),
            h('th', { text: 'Share' }),
          ])]),
          h('tbody', {}, data.cashiers.map((row) => h('tr', {}, [
            h('td', {}, [
              h('span', { text: row.cashier }),
              h('small', { class: 'muted', text: row.role || '' }),
            ]),
            h('td', { text: String(row.shift_count) }),
            h('td', { text: String(row.sale_count) }),
            h('td', { class: 'money', text: money(row.net_centavos) }),
            h('td', { class: 'money', text: money(row.average_sale_centavos) }),
            h('td', { class: 'money', text: money(row.discount_centavos) }),
            h('td', { class: 'money', text: money(row.gross_profit_centavos) }),
            h('td', { text: percent(row.margin_bp) }),
            h('td', { text: percent(row.share_bp) }),
          ]))),
          h('tfoot', {}, [h('tr', {}, [
            h('th', { text: 'Total' }), h('td', {}),
            h('td', { text: String(data.totals.sale_count) }),
            h('td', { class: 'money', text: money(data.totals.net_centavos) }),
            h('td', { class: 'money', text: money(data.totals.average_sale_centavos) }),
            h('td', {}), h('td', {}), h('td', {}), h('td', { text: '100.0%' }),
          ])]),
        ]),
      ]),
    ]);
  }

  function productBody() {
    return h('div', { class: 'report-body' }, [
      h('div', { class: 'report-controls' }, [
        h('label', { text: 'Sort by' }, [
          h('select', {
            'aria-label': 'Sort products by',
            onchange: (event) => { sort = event.target.value; load(); },
          }, data.sorts.map((id) => h('option', {
            value: id, text: SORT_LABELS[id] || id, selected: id === data.sort ? '' : null,
          }))),
        ]),
        // Requirement 3's point: the limit is the reader's, and what it hides is said.
        h('p', {
          class: 'muted',
          text: `${data.totals.shown} rows — ${money(data.totals.shown_revenue_centavos)} of `
            + `${money(data.totals.revenue_centavos)} sold in this range.`,
        }),
      ]),
      productTable(data.products),
    ]);
  }

  const productTable = (rows) => (rows.length === 0
    ? h('p', { class: 'muted', text: 'Nothing was sold in this range.' })
    : h('div', { class: 'table-scroll' }, [
      h('table', { class: 'lines' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: 'SKU' }), h('th', { text: 'Product' }), h('th', { text: 'Category' }),
          h('th', { text: 'Sold' }), h('th', { text: 'Transactions' }),
          h('th', { class: 'money', text: 'Revenue' }), h('th', { class: 'money', text: 'Gross profit' }),
          h('th', { text: 'Margin' }), h('th', { text: 'On hand' }),
        ])]),
        h('tbody', {}, rows.map((row) => h('tr', {}, [
          h('td', { class: 'sku', text: row.sku }),
          h('td', { text: row.product_name }),
          h('td', { text: row.category_name }),
          h('td', { text: row.qty_display }),
          h('td', { text: String(row.sale_count) }),
          h('td', { class: 'money', text: money(row.revenue_centavos) }),
          h('td', { class: 'money', text: money(row.gross_profit_centavos) }),
          h('td', { text: percent(row.margin_bp) }),
          h('td', { text: row.qty_on_hand_display }),
        ]))),
      ]),
    ]));

  /**
   * Requirement 4, laid out as two rankings and never as one.
   *
   * A sack of feed at ₱1,400 and a sachet at ₱35 sort in opposite orders by money and by
   * units, and the store uses one figure to reorder and the other to decide what to
   * stock more of. A merged "top sellers" list answers neither question.
   */
  function moversBody() {
    return h('div', { class: 'report-body movers' }, [
      h('h2', { text: `Fast — top ${data.top} by revenue` }),
      productTable(data.by_revenue),

      h('h2', { text: `Fast — top ${data.top} by units` }),
      h('p', { class: 'muted', text: data.units_note }),
      ...data.by_units.map((group) => h('div', { class: 'mover-unit' }, [
        h('h3', { text: `In ${group.unit_code}` }),
        productTable(group.products),
      ])),

      h('h2', { text: 'Slow' }),
      h('p', { class: 'muted', text: data.slow_note }),
      data.slow.length === 0
        ? h('p', { class: 'muted', text: 'Everything on the shelves sold in this range.' })
        : h('div', { class: 'table-scroll' }, [
          h('table', { class: 'lines slow-movers' }, [
            h('thead', {}, [h('tr', {}, [
              h('th', { text: 'SKU' }), h('th', { text: 'Product' }), h('th', { text: 'Category' }),
              h('th', { text: 'Sold' }), h('th', { text: 'On hand' }),
              h('th', { class: 'money', text: 'Tied up' }), h('th', { text: 'Last sold' }),
            ])]),
            // Requirement 5: a product added inside the range has not had the range to
            // sell in, so it is flagged rather than judged.
            h('tbody', {}, data.slow.map((row) => h('tr', { class: row.new_in_range ? 'is-new' : null }, [
              h('td', { class: 'sku', text: row.sku }),
              h('td', { text: row.product_name }),
              h('td', { text: row.category_name }),
              h('td', { text: row.qty_display }),
              h('td', { text: row.qty_on_hand_display }),
              h('td', { class: 'money', text: money(row.on_hand_value_centavos) }),
              h('td', { text: row.verdict }),
            ]))),
          ]),
        ]),
    ]);
  }

  return { mount: load, unmount() {} };
}
