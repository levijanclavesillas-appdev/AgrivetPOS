// SCR-801 — purchase orders.
//
// The default filter is "open": the two statuses that mean sent and not yet fully
// here. That is the list a buyer actually wants — a screen defaulting to everything
// puts last year's completed orders in front of the one delivery arriving today.
//
// The status words come from `GET /purchase-orders`, which serves its own
// enumeration. A screen holding its own copy of a list the server validates against is
// a screen that is wrong the day the list changes, and it fails by offering a filter
// the server then refuses (the reasoning TC-UI-07 and TC-UI-09 already enforce).

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money, manila } from '../shell/format.js';

const PAGE = 50;

export function createPurchaseOrders({ root, onOpen, onNew, onReceive, onSuppliers }) {
  let query = '';
  let status = '';
  let openOnly = true;
  let offset = 0;
  let statuses = [];
  let searchTimer = null;
  let latest = 0;

  async function load() {
    ui.loading(root, { rows: 6 });
    await refresh();
  }

  async function refresh() {
    const mine = ++latest;
    try {
      const data = await api.get(`/purchase-orders?q=${encodeURIComponent(query)}`
        + `&status=${status}&open=${openOnly && !status}`
        + `&limit=${PAGE}&offset=${offset}`);

      if (mine !== latest) return;
      statuses = data.statuses || statuses;
      render(data);
    } catch (err) {
      if (mine !== latest) return;
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: refresh });
    }
  }

  function render(data) {
    clear(root).append(h('section', { class: 'purchasing' }, [
      header(),
      controls(),
      data.purchase_orders.length === 0 ? emptyState() : table(data),
      pager(data),
    ]));
  }

  function header() {
    return h('header', { class: 'admin-head' }, [
      h('h1', { text: 'Purchase orders' }),
      h('button', { class: 'row-action', text: 'Suppliers', onclick: () => onSuppliers() }),
      // FT-504's counter purchase: a delivery with no order behind it. Offered from
      // here because that is where somebody who has just been handed a delivery note
      // starts looking, and PO-207 makes it a normal case rather than an exception.
      h('button', { class: 'row-action', text: 'Receive without an order', onclick: () => onReceive(null) }),
      h('button', { class: 'primary', text: 'New order', onclick: () => onNew() }),
    ]);
  }

  function controls() {
    const search = h('input', {
      type: 'search', class: 'catalogue-search', value: query,
      placeholder: 'Order number, reference or supplier', 'aria-label': 'Search purchase orders',
      oninput: (event) => {
        query = event.target.value;
        offset = 0;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(refresh, 200);
      },
    });

    return h('div', { class: 'catalogue-controls' }, [
      search,
      h('select', {
        'aria-label': 'Status',
        onchange: (event) => { status = event.target.value; offset = 0; refresh(); },
      }, [
        h('option', { value: '', text: openOnly ? 'Still awaited' : 'All statuses' }),
        ...statuses.map((entry) => h('option', {
          value: entry.status, text: entry.label, selected: entry.status === status,
        })),
      ]),
      h('label', { class: 'check' }, [
        h('input', {
          type: 'checkbox', checked: openOnly,
          onchange: (event) => { openOnly = event.target.checked; offset = 0; refresh(); },
        }),
        h('span', { text: 'Only what is still awaited' }),
      ]),
    ]);
  }

  function emptyState() {
    return h('div', { class: 'state state-empty' }, [
      h('p', {
        class: 'state-title',
        text: openOnly && !query && !status
          ? 'Nothing is on order. Raise one, or record a delivery that arrived without an order.'
          : 'No purchase orders match that.',
      }),
      h('button', { class: 'primary', text: 'New order', onclick: () => onNew() }),
    ]);
  }

  function table(data) {
    return h('div', { class: 'table-scroll' }, [
      h('table', { class: 'catalogue-list' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: 'Order' }),
          h('th', { text: 'Supplier' }),
          h('th', { text: 'Ordered' }),
          h('th', { text: 'Expected' }),
          h('th', { class: 'qty', text: 'Lines' }),
          h('th', { class: 'money', text: 'Total' }),
          h('th', { text: 'Status' }),
          h('th', { text: '' }),
        ])]),
        h('tbody', {}, data.purchase_orders.map((po) => h('tr', {
          class: po.is_open ? 'is-open' : null,
          tabindex: '0',
          onclick: () => onOpen(po.id),
          onkeydown: (event) => { if (event.key === 'Enter') onOpen(po.id); },
        }, [
          h('td', {}, [
            h('strong', { text: po.po_no }),
            po.revision > 1 ? h('span', { class: 'tag', text: `rev ${po.revision}` }) : null,
          ]),
          h('td', { text: po.supplier.name }),
          h('td', { text: po.ordered_at ? manila(po.ordered_at) : '—' }),
          h('td', { text: po.expected_at || '—' }),
          h('td', { class: 'qty', text: String(po.line_count ?? '—') }),
          h('td', { class: 'money', text: money(po.total_centavos) }),
          h('td', {}, [h('span', { class: `status status-${po.status.toLowerCase()}`, text: po.status_label })]),
          h('td', {}, [
            // PO-103: this button opens SCR-803. Nothing on the order screen moves
            // stock, and the shortcut says so by going straight to the delivery.
            po.can_receive
              ? h('button', {
                class: 'row-action', text: 'Receive',
                onclick: (event) => { event.stopPropagation(); onReceive(po.id); },
              })
              : null,
          ]),
        ]))),
      ]),
    ]);
  }

  function pager(data) {
    const pages = Math.ceil(data.total / PAGE);
    if (pages <= 1) return null;
    return h('div', { class: 'pager' }, [
      h('button', {
        text: 'Previous', disabled: offset === 0,
        onclick: () => { offset = Math.max(offset - PAGE, 0); refresh(); },
      }),
      h('span', { text: `${offset + 1}–${Math.min(offset + PAGE, data.total)} of ${data.total}` }),
      h('button', {
        text: 'Next', disabled: offset + PAGE >= data.total,
        onclick: () => { offset += PAGE; refresh(); },
      }),
    ]);
  }

  return { mount: load, unmount() { clearTimeout(searchTimer); } };
}
