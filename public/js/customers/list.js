// SCR-401 — customers.
//
// Name, code, type, price level, balance and ageing. CR-107's OVERDUE renders in the
// error colour with its day count, because a list where an overdue account looks like
// every other row is a list nobody acts on.
//
// The customer types and price levels come from the server with the list. A screen with
// its own copy of a list the server validates against is a screen that is wrong the day
// the list changes — and it fails by offering a choice the server then refuses, which
// is the worst way for it to fail.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money } from '../shell/format.js';

const PAGE = 50;

export function createCustomerList({ root, onOpen, onCollect }) {
  let query = '';
  let creditOnly = false;
  let includeInactive = false;
  let offset = 0;
  let meta = { customer_types: [], price_levels: [] };
  let creating = false;
  let searchTimer = null;
  let latest = 0;

  async function load() {
    ui.loading(root, { rows: 6 });
    await refresh();
  }

  async function refresh() {
    const mine = ++latest;
    try {
      const data = await api.get(`/customers?q=${encodeURIComponent(query)}`
        + `&creditOnly=${creditOnly}&includeInactive=${includeInactive}`
        + `&limit=${PAGE}&offset=${offset}`);
      if (mine !== latest) return;
      meta = { customer_types: data.customer_types, price_levels: data.price_levels };
      render(data);
    } catch (err) {
      if (mine !== latest) return;
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: refresh });
    }
  }

  function render(data) {
    clear(root).append(h('section', { class: 'customers' }, [
      h('header', { class: 'admin-head' }, [
        h('h1', { text: 'Customers' }),
        h('button', {
          class: 'primary', text: 'New customer',
          onclick: () => { creating = !creating; refresh(); },
        }),
      ]),

      controls(),
      creating ? newCustomerForm() : null,
      data.customers.length === 0 ? emptyState() : table(data),
      pager(data),
    ]));
  }

  function controls() {
    const search = h('input', {
      type: 'search', class: 'catalogue-search', value: query,
      placeholder: 'Name or code', 'aria-label': 'Search customers',
      oninput: (event) => {
        query = event.target.value;
        offset = 0;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(refresh, 120);
      },
    });

    return h('div', { class: 'catalogue-controls' }, [
      search,
      h('label', { class: 'check' }, [
        h('input', {
          type: 'checkbox', checked: creditOnly,
          onchange: (event) => { creditOnly = event.target.checked; offset = 0; refresh(); },
        }),
        h('span', { text: 'On credit only' }),
      ]),
      h('label', { class: 'check' }, [
        h('input', {
          type: 'checkbox', checked: includeInactive,
          onchange: (event) => { includeInactive = event.target.checked; offset = 0; refresh(); },
        }),
        h('span', { text: 'Show inactive' }),
      ]),
    ]);
  }

  function emptyState() {
    const host = h('div');
    ui.empty(host, {
      title: query || creditOnly
        ? 'No customer matches that.'
        : 'No customers yet. A walk-in sale needs none — add the ones who buy on credit.',
      action: creating ? null : 'New customer',
      onAction: () => { creating = true; refresh(); },
    });
    return host;
  }

  function table(data) {
    return h('table', { class: 'catalogue-list customer-list' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', { text: 'Name' }), h('th', { text: 'Code' }), h('th', { text: 'Type' }),
        h('th', { text: 'Price level' }), h('th', { text: 'Balance' }),
        h('th', { text: 'Status' }), h('th', { text: '' }),
      ])]),
      h('tbody', {}, data.customers.map((customer) => h('tr', {
        class: customer.is_active ? '' : 'is-inactive',
        tabindex: '0',
        onclick: () => onOpen(customer.id),
        onkeydown: (event) => { if (event.key === 'Enter') onOpen(customer.id); },
      }, [
        h('td', { text: customer.name }),
        h('td', { class: 'sku', text: customer.code || '—' }),
        h('td', { text: customer.customer_type }),
        h('td', { text: customer.price_level }),
        h('td', {
          class: 'money',
          // CR-103: the figure the ledger derives, never one added up here.
          text: customer.credit ? money(customer.credit.balance_centavos) : '—',
        }),
        h('td', {}, [ageing(customer)]),
        h('td', {}, [
          customer.credit
            ? h('button', {
              class: 'row-action', text: 'Take payment',
              onclick: (event) => { event.stopPropagation(); onCollect(customer.id); },
            })
            : null,
        ]),
      ]))),
    ]);
  }

  /** CR-107, in the error colour with the day count. */
  function ageing(customer) {
    if (!customer.credit) return h('span', { class: 'muted', text: 'cash only' });
    const { ageing_status: status, days_overdue: days } = customer.credit;

    if (status === 'OVERDUE') {
      return h('span', { class: 'tag overdue', text: `overdue ${days} day${days === 1 ? '' : 's'}` });
    }
    if (status === 'DUE_SOON') return h('span', { class: 'tag warn', text: 'due soon' });
    if (customer.credit.balance_centavos === 0) return h('span', { class: 'muted', text: 'clear' });
    return h('span', { class: 'muted', text: status.toLowerCase().replace(/_/g, ' ') });
  }

  // ── Creating (VR-301 – VR-303) ────────────────────────────────────────────

  function newCustomerForm() {
    const name = h('input', { type: 'text', required: true });
    const code = h('input', { type: 'text', placeholder: 'Optional short code' });
    const contactNo = h('input', { type: 'text' });
    const type = h('select', {}, meta.customer_types.map((t) => h('option', {
      value: t, text: t.replace(/_/g, ' '), selected: t === 'REGULAR',
    })));
    const priceLevel = h('select', {}, meta.price_levels.map((l) => h('option', {
      value: l, text: l, selected: l === 'RETAIL',
    })));
    const eligible = h('input', { type: 'checkbox' });
    const limit = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0.00', disabled: true });
    const terms = h('input', { type: 'text', inputmode: 'numeric', value: '30', disabled: true });

    // VR-303: a credit-eligible customer must have a limit and terms, so the fields
    // open together with the tick rather than being a second screen.
    eligible.addEventListener('change', () => {
      limit.disabled = !eligible.checked;
      terms.disabled = !eligible.checked;
    });

    return h('form', {
      class: 'editor-form customer-form',
      onsubmit: async (event) => {
        event.preventDefault();
        const body = {
          name: name.value.trim(),
          code: code.value.trim() || null,
          contactNo: contactNo.value.trim() || null,
          customerType: type.value,
          priceLevel: priceLevel.value,
          isCreditEligible: eligible.checked,
        };
        if (eligible.checked) {
          body.creditLimitCentavos = Math.round(Number.parseFloat(limit.value || '0') * 100);
          body.termsDays = Number.parseInt(terms.value || '0', 10);
        }
        try {
          const result = await api.post('/customers', body);
          ui.toast(`${result.customer.name} added.`, { kind: 'success' });
          creating = false;
          onOpen(result.customer.id);
        } catch (err) {
          ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
        }
      },
    }, [
      field('Name', name),
      field('Code', code, 'What the store calls them in the notebook.'),
      field('Contact number', contactNo),
      field('Type', type),
      field('Price level', priceLevel, 'Which price list applies to them (PR-101).'),
      h('label', { class: 'check' }, [eligible, h('span', { text: 'Buys on credit' })]),
      field('Credit limit (₱)', limit),
      field('Terms (days)', terms, '0 means cash on delivery.'),
      h('div', { class: 'editor-actions' }, [
        h('button', { type: 'submit', class: 'primary', text: 'Add customer' }),
        h('button', { type: 'button', text: 'Cancel', onclick: () => { creating = false; refresh(); } }),
      ]),
    ]);
  }

  const field = (label, input, note = null) => h('div', { class: 'editor-field' }, [
    h('label', { text: label }), input,
    note ? h('small', { class: 'muted', text: note }) : null,
  ]);

  function pager(data) {
    if (data.total <= PAGE) return null;
    return h('div', { class: 'pager' }, [
      h('button', {
        text: '← Previous', disabled: offset === 0,
        onclick: () => { offset = Math.max(0, offset - PAGE); refresh(); },
      }),
      h('span', { text: `${offset + 1}–${Math.min(offset + PAGE, data.total)} of ${data.total}` }),
      h('button', {
        text: 'Next →', disabled: offset + PAGE >= data.total,
        onclick: () => { offset += PAGE; refresh(); },
      }),
    ]);
  }

  return {
    mount: load,
    unmount() { clearTimeout(searchTimer); latest += 1; },
  };
}
