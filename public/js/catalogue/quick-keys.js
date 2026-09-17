// POS-113 — arranging the counter's quick keys (TASK-070).
//
// The store's own buttons for goods with no barcode: loose rice, ice, eggs, a cigarette by
// the stick. Reached from Products, because arranging them is editing the catalogue
// (TX-410). The set is saved whole, as the server keeps it: order is part of it.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';

export function createQuickKeys({ root, onBack }) {
  let keys = [];               // [{ productId, packUnitId, label, name, packCode }]
  let enabled = false;
  let max = 24;
  let dirty = false;
  const results = h('div', { class: 'search-results quick-key-results', hidden: true });
  const search = h('input', {
    type: 'search', placeholder: 'Find a product to add', autocomplete: 'off', 'aria-label': 'Find a product to add',
  });

  async function load() {
    ui.loading(root, { rows: 4 });
    try {
      const data = await api.get('/quick-keys');
      enabled = data.enabled;
      max = data.max;
      keys = data.keys.map((k) => ({
        productId: k.product_id, packUnitId: k.pack_unit_id, label: k.label === k.product_name ? '' : k.label,
        name: k.product_name, packCode: k.pack_unit_code, usable: k.usable,
      }));
      dirty = false;
      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  function render() {
    clear(root).append(h('section', { class: 'quick-keys-admin' }, [
      h('header', { class: 'admin-head' }, [
        h('button', { class: 'row-action', icon: 'arrow-left', text: 'Products', onclick: () => onBack() }),
        h('h1', { text: 'Quick keys' }),
      ]),
      h('p', { class: 'muted', text: 'Buttons at the counter for goods with no barcode. Pressing one adds one, '
        + `the same as scanning it. Up to ${max}, in the order shown.` }),
      enabled ? null : h('p', { class: 'opening-status error', text: 'Quick keys are off in Settings, so the counter does not show them yet.' }),
      h('div', { class: 'pos-searchbar' }, [search, results]),
      keys.length === 0
        ? h('div', {}, [
          h('p', { class: 'muted', text: 'No quick keys yet.' }),
          h('button', { class: 'row-action', text: 'Suggest from products with no barcode', onclick: suggest }),
        ])
        : h('div', { class: 'table-scroll' }, [h('table', { class: 'catalogue-list' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: '#' }), h('th', { text: 'Product' }), h('th', { text: 'Pack' }),
            h('th', { text: 'Button says' }), h('th', { text: '' }),
          ])]),
          h('tbody', {}, keys.map((key, index) => h('tr', {}, [
            h('td', { text: String(index + 1) }),
            h('td', { text: key.usable === false ? `${key.name} (cannot be sold)` : key.name }),
            h('td', { text: key.packCode || '—' }),
            h('td', {}, [h('input', {
              type: 'text', maxlength: '24', value: key.label, placeholder: key.name, 'aria-label': `Label for ${key.name}`,
              oninput: (event) => { key.label = event.target.value; dirty = true; renderSave(); },
            })]),
            h('td', {}, [
              h('button', { class: 'row-action', text: 'Up', disabled: index === 0, onclick: () => move(index, -1) }),
              h('button', { class: 'row-action', text: 'Down', disabled: index === keys.length - 1, onclick: () => move(index, 1) }),
              h('button', { class: 'row-action', text: 'Remove', onclick: () => { keys.splice(index, 1); dirty = true; render(); } }),
            ]),
          ]))),
        ])]),
      saveHost,
    ]));
    renderSave();
  }

  const saveHost = h('div', { class: 'editor-actions' });
  function renderSave() {
    // Filtered: Element.append() prints a null child as the word "null".
    clear(saveHost).append(...[
      h('button', { class: 'primary', icon: 'save', text: 'Save quick keys', disabled: !dirty, onclick: save }),
      dirty ? h('button', { text: 'Undo changes', onclick: load }) : null,
    ].filter(Boolean));
  }

  function move(index, by) {
    const [key] = keys.splice(index, 1);
    keys.splice(index + by, 0, key);
    dirty = true;
    render();
  }

  async function add(product) {
    results.hidden = true;
    search.value = '';
    if (keys.length >= max) { ui.toast(`There are at most ${max} quick keys.`, { kind: 'error' }); return; }
    let packs = [];
    try { packs = (await api.get(`/products/${product.id}`)).product.packs || []; } catch { /* sold loose */ }
    let packUnitId = null;
    let packCode = null;
    if (packs.length > 0) {
      const answer = await ui.ask({
        title: `Add ${product.name}`,
        message: `Leave blank to add one ${product.base_unit?.code || 'unit'}, or type a pack: ${packs.map((p) => p.unit.code).join(', ')}.`,
        fields: [{ name: 'pack', label: 'Pack', required: false }],
        submitLabel: 'Add',
      });
      if (!answer) return;
      const typed = String(answer.pack || '').trim().toUpperCase();
      if (typed) {
        const pack = packs.find((p) => p.unit.code === typed);
        if (!pack) { ui.toast(`${product.name} has no ${typed} pack.`, { kind: 'error' }); return; }
        packUnitId = pack.unit.id;
        packCode = pack.unit.code;
      }
    }
    if (keys.some((k) => k.productId === product.id && (k.packUnitId || null) === packUnitId)) {
      ui.toast(`${product.name}${packCode ? ` (${packCode})` : ''} is already a quick key.`, { kind: 'error' });
      return;
    }
    keys.push({ productId: product.id, packUnitId, label: '', name: product.name, packCode, usable: true });
    dirty = true;
    render();
  }

  async function lookup(term) {
    if (term.length < 2) { results.hidden = true; return; }
    try {
      const { products } = await api.get(`/products?q=${encodeURIComponent(term)}&limit=8`);
      clear(results).append(...(products.length
        ? products.map((p) => h('button', { class: 'search-result', onclick: () => add(p) }, [
          h('span', { class: 'result-name', text: p.name }),
          h('span', { class: 'result-sku', text: p.sku }),
        ]))
        : [h('p', { class: 'no-results', text: `Nothing matches “${term}”.` })]));
      results.hidden = false;
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
  }

  async function save() {
    try {
      await api.put('/quick-keys', {
        keys: keys.map((k) => ({ productId: k.productId, packUnitId: k.packUnitId, label: k.label || null })),
      });
      ui.toast('Quick keys saved', { kind: 'success' });
      await load();
    } catch (err) {
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    }
  }

  async function suggest() {
    try {
      await api.post('/quick-keys/suggest', {});
      await load();
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
  }

  search.addEventListener('input', () => lookup(search.value.trim()));

  return { mount: load, unmount() {} };
}
