// SCR-804 — suppliers.
//
// The list, the editor, and the answer to the question v1.0 could not give: what did
// this supplier charge us last time. That figure comes off the deliveries, not the
// orders — PO-203 makes the actual cost the one that matters, and the ordered figure
// is only what the store expected to pay.
//
// VR-401: never deleted, only deactivated, and not even that while an order is still
// outstanding. Switching off a supplier the store is still waiting on hides the
// delivery from every screen that filters to active ones, and the goods arrive anyway.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money, manila } from '../shell/format.js';

const PAGE = 50;

export function createSuppliers({ root, onBack }) {
  let query = '';
  let includeInactive = false;
  let offset = 0;
  let editing = null;      // null = the list, {} = a new one, {…} = an existing one
  let searchTimer = null;
  let latest = 0;

  async function load() {
    ui.loading(root, { rows: 6 });
    await refresh();
  }

  async function refresh() {
    const mine = ++latest;
    try {
      const data = await api.get(`/suppliers?q=${encodeURIComponent(query)}`
        + `&includeInactive=${includeInactive}&limit=${PAGE}&offset=${offset}`);
      if (mine !== latest) return;
      render(data);
    } catch (err) {
      if (mine !== latest) return;
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: refresh });
    }
  }

  function render(data) {
    clear(root).append(h('section', { class: 'purchasing suppliers' }, [
      header(),
      editing ? editor() : null,
      controls(),
      data.suppliers.length === 0 ? emptyState() : table(data),
      pager(data),
    ]));
  }

  function header() {
    return h('header', { class: 'admin-head' }, [
      h('button', { class: 'report-back', text: '← Orders', onclick: () => onBack() }),
      h('h1', { text: 'Suppliers' }),
      h('button', {
        class: 'primary', text: 'New supplier',
        onclick: () => { editing = { termsDays: 0 }; refresh(); },
      }),
    ]);
  }

  function controls() {
    return h('div', { class: 'catalogue-controls' }, [
      h('input', {
        type: 'search', class: 'catalogue-search', value: query,
        placeholder: 'Name, code or contact', 'aria-label': 'Search suppliers',
        oninput: (event) => {
          query = event.target.value;
          offset = 0;
          clearTimeout(searchTimer);
          searchTimer = setTimeout(refresh, 200);
        },
      }),
      h('label', { class: 'check' }, [
        h('input', {
          type: 'checkbox', checked: includeInactive,
          onchange: (event) => { includeInactive = event.target.checked; offset = 0; refresh(); },
        }),
        h('span', { text: 'Include deactivated' }),
      ]),
    ]);
  }

  function emptyState() {
    return h('div', { class: 'state state-empty' }, [
      h('p', {
        class: 'state-title',
        text: query ? 'No suppliers match that.' : 'No suppliers yet. Add the first one.',
      }),
      h('button', {
        class: 'primary', text: 'New supplier',
        onclick: () => { editing = { termsDays: 0 }; refresh(); },
      }),
    ]);
  }

  function table(data) {
    return h('div', { class: 'table-scroll' }, [
      h('table', { class: 'catalogue-list' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: 'Supplier' }),
          h('th', { text: 'Code' }),
          h('th', { text: 'Contact' }),
          h('th', { text: 'Terms' }),
          h('th', { text: '' }),
        ])]),
        h('tbody', {}, data.suppliers.map((supplier) => h('tr', {
          class: supplier.is_active ? null : 'is-inactive',
        }, [
          h('td', {}, [
            h('strong', { text: supplier.name }),
            supplier.is_active ? null : h('span', { class: 'tag', text: 'deactivated' }),
          ]),
          h('td', { text: supplier.code || '—' }),
          h('td', { text: [supplier.contact_person, supplier.contact_no].filter(Boolean).join(' · ') || '—' }),
          h('td', { text: supplier.terms_label }),
          h('td', {}, [
            h('button', {
              class: 'row-action', text: 'Edit',
              onclick: () => { editing = toForm(supplier); refresh(); },
            }),
            supplier.is_active
              ? h('button', {
                class: 'row-action', text: 'Deactivate',
                onclick: () => deactivate(supplier),
              })
              : h('button', {
                class: 'row-action', text: 'Reactivate',
                onclick: () => reactivate(supplier),
              }),
          ]),
        ]))),
      ]),
    ]);
  }

  const toForm = (supplier) => ({
    id: supplier.id,
    name: supplier.name,
    code: supplier.code || '',
    contactPerson: supplier.contact_person || '',
    contactNo: supplier.contact_no || '',
    email: supplier.email || '',
    address: supplier.address || '',
    termsDays: supplier.terms_days,
    notes: supplier.notes || '',
  });

  function editor() {
    const field = (label, key, attrs = {}) => h('div', { class: 'editor-field' }, [
      h('label', { text: label }),
      h('input', {
        type: 'text', value: editing[key] ?? '', ...attrs,
        oninput: (event) => { editing[key] = event.target.value; },
      }),
    ]);

    return h('form', {
      class: 'editor-form supplier-editor',
      onsubmit: (event) => { event.preventDefault(); save(); },
    }, [
      h('h2', { text: editing.id ? `Edit ${editing.name}` : 'New supplier' }),
      // VR-401 — required and unique, said before the refusal rather than after it.
      field('Name', 'name', { required: true, placeholder: 'As it appears on their invoice' }),
      h('div', { class: 'editor-row' }, [
        field('Code', 'code', { placeholder: 'Optional short code' }),
        h('div', { class: 'editor-field' }, [
          h('label', { text: 'Terms (days)' }),
          h('input', {
            type: 'number', min: '0', max: '365', value: String(editing.termsDays ?? 0),
            oninput: (event) => { editing.termsDays = event.target.value; },
          }),
          h('small', { class: 'muted', text: '0 is cash on delivery.' }),
        ]),
      ]),
      h('div', { class: 'editor-row' }, [
        field('Contact person', 'contactPerson'),
        field('Contact number', 'contactNo', { placeholder: '09xx xxx xxxx' }),
      ]),
      field('Address', 'address'),
      field('Notes', 'notes'),
      h('div', { class: 'editor-actions' }, [
        h('button', { type: 'submit', class: 'primary', text: 'Save' }),
        h('button', { type: 'button', text: 'Cancel', onclick: () => { editing = null; refresh(); } }),
      ]),
    ]);
  }

  async function save() {
    const body = {
      name: editing.name,
      code: editing.code || null,
      contactPerson: editing.contactPerson || null,
      contactNo: editing.contactNo || null,
      email: editing.email || null,
      address: editing.address || null,
      termsDays: Number.parseInt(editing.termsDays, 10) || 0,
      notes: editing.notes || null,
    };
    try {
      if (editing.id) await api.put(`/suppliers/${editing.id}`, body);
      else await api.post('/suppliers', body);
      ui.toast('Supplier saved', { kind: 'success' });
      editing = null;
      await refresh();
    } catch (err) {
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    }
  }

  async function deactivate(supplier) {
    try {
      await api.post(`/suppliers/${supplier.id}/deactivate`, {});
      ui.toast(`${supplier.name} deactivated`, { kind: 'success' });
      await refresh();
    } catch (err) {
      // VR-401 refuses this while an order is outstanding, and says how many.
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    }
  }

  async function reactivate(supplier) {
    try {
      await api.post(`/suppliers/${supplier.id}/reactivate`, {});
      ui.toast(`${supplier.name} reactivated`, { kind: 'success' });
      await refresh();
    } catch (err) {
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    }
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
