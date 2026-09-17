// SCR-209 — changing many prices at once (TX-411, PR-101, PR-109, AUD-601).
//
// Putting every price up by 5% meant opening a hundred products, one at a time, on the
// screen that edits one. Here the store picks the products it means — everything a search or a
// category finds, or a list it builds by hand — says what to do to them, sees what each would
// become, and writes them in one go with one reason kept on every one of them.
//
// **Two ways to choose the products, because stores mean two different things.** "Every drink
// goes up 5%" is a search; "these eleven items the supplier wrote to us about" is a list nobody
// can express as a search, so it is added product by product, scanned or typed, and the screen
// keeps it until it is saved or emptied.
//
// **The screen proposes and the server disposes.** The arithmetic is `price-rules.js`, shown
// as a preview; `PUT /products/prices` re-checks every figure, writes them in one
// transaction, and audits each product as an ordinary price change.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money } from '../shell/format.js';
import { createProductPicker } from '../shell/picker.js';
import { RULES, ROUNDINGS, newPrice, marginBp } from './price-rules.js';

const PAGE = 200;

export function createPriceChange({ root, onBack }) {
  let found = [];              // what the search and the category found: { product, next }
  let picked = [];             // what the store added by hand, in the order it added them
  let mode = 'MATCH';          // MATCH — what the search finds · PICKED — the list built here
  let categories = [];
  let query = '';
  let categoryId = '';
  let level = 'RETAIL';
  let rule = 'PERCENT_UP';
  let value = '';
  let rounding = 'NONE';
  let reason = '';
  let saving = false;
  let timer = null;

  const lines = () => (mode === 'PICKED' ? picked : found);

  async function load() {
    ui.loading(root, { rows: 6 });
    try {
      const params = new URLSearchParams({ limit: String(PAGE), withPrices: 'true' });
      if (query.trim()) params.set('q', query.trim());
      if (categoryId) params.set('category', categoryId);
      const [result, reference] = await Promise.all([
        api.get(`/products?${params}`),
        categories.length ? Promise.resolve({ categories }) : api.get('/categories'),
      ]);
      categories = reference.categories || categories;
      found = result.products.map((product) => ({ product, next: null }));
      render(result.total);
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  const priceOf = (row) => (row.product.prices ? row.product.prices[level] : null);
  const costOf = (row) => (Number.isInteger(row.product.avg_cost_centavos) ? row.product.avg_cost_centavos : null);
  const changed = () => lines().filter((row) => row.next !== null && row.next !== priceOf(row));

  /**
   * One product added by hand (`FR_2.1`'s picker, so a code can be scanned into it).
   *
   * The picker's own search does not carry the other price levels — nothing else needs them —
   * so the product is read again the way the list reads them, and only then joins the list.
   */
  async function add(product) {
    if (picked.some((row) => row.product.id === product.id)) {
      mode = 'PICKED';
      render();
      ui.toast(`${product.name} is already on the list.`);
      return;
    }
    try {
      const params = new URLSearchParams({ q: product.sku, limit: '8', withPrices: 'true' });
      const result = await api.get(`/products?${params}`);
      const full = (result.products || []).find((p) => p.id === product.id) || product;
      picked = [...picked, { product: full, next: null }];
      mode = 'PICKED';
      render();
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
  }

  const picker = createProductPicker({
    placeholder: 'Add a product — name, SKU, or scan it',
    ariaLabel: 'Add a product to the list',
    // INV-105: a withdrawn product is not sold, and repricing one is pointless.
    onPick: (product) => { picker.input.value = ''; add(product); },
  });

  /** Fill in what each product would become. Nothing is written until Save. */
  function applyRule() {
    const typed = Number.parseFloat(value);
    if (!Number.isFinite(typed) || typed < 0) {
      ui.toast('Type the percentage or the amount first.', { kind: 'error' });
      return;
    }
    const needsAmount = (RULES.find((r) => r.id === rule) || {}).needs === 'amount';
    let missed = 0;
    for (const row of lines()) {
      const next = newPrice({
        rule,
        value: needsAmount ? Math.round(typed * 100) : typed,
        current: priceOf(row),
        costCentavos: costOf(row),
        rounding,
      });
      if (next === null) missed += 1;
      row.next = next;
    }
    if (missed > 0) {
      ui.toast(`${missed} product${missed === 1 ? '' : 's'} could not be worked out — no ${level.toLowerCase()} price, or no cost.`);
    }
    render();
  }

  async function save() {
    const list = changed();
    if (list.length === 0) return ui.toast('Nothing has changed.', { kind: 'error' });
    if (reason.trim().length < 3) return ui.toast('Say why the prices are changing.', { kind: 'error' });
    saving = true;
    render();
    try {
      const result = await api.put('/products/prices', {
        reason: reason.trim(),
        changes: list.map((row) => ({ productId: row.product.id, [level]: row.next })),
      });
      ui.toast(`${result.changed} price${result.changed === 1 ? '' : 's'} changed.`, { kind: 'success' });
      reason = '';
      // The server has written exactly these figures, so the list can say so without asking
      // again — which matters for a hand-built list, whose rows no search would bring back.
      for (const row of lines()) {
        if (row.next !== null && row.product.prices) row.product.prices[level] = row.next;
        row.next = null;
      }
      if (mode === 'MATCH') await load();
      else render();
    } catch (err) {
      ui.toast(err.isRefusal && err.ruleId ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    } finally {
      saving = false;
      render();
    }
    return undefined;
  }

  const search = h('input', {
    type: 'search', class: 'catalogue-search', value: query,
    placeholder: 'Name, generic, SKU or barcode', 'aria-label': 'Find products',
    oninput: (event) => {
      query = event.target.value;
      mode = 'MATCH';
      clearTimeout(timer);
      timer = setTimeout(load, 200);
    },
  });

  /** Which products: what a search finds, or the list built here. */
  function chooser() {
    const tab = (id, label, count) => h('button', {
      class: `row-action${mode === id ? ' is-on' : ''}`,
      'aria-pressed': mode === id ? 'true' : 'false',
      text: count === null ? label : `${label} (${count})`,
      onclick: () => { mode = id; render(); },
    });
    return h('div', { class: 'price-source' }, [
      h('div', { class: 'price-tabs' }, [
        tab('MATCH', 'What the search finds', null),
        tab('PICKED', 'The list I build', picked.length),
      ]),
      picker.el,
    ]);
  }

  function controls() {
    const ruleNeeds = (RULES.find((r) => r.id === rule) || {}).needs;
    return h('div', { class: 'price-rule' }, [
      h('label', { text: 'Which price' }, [
        h('select', {
          onchange: (event) => { level = event.target.value; for (const row of lines()) row.next = null; render(); },
        }, ['RETAIL', 'WHOLESALE', 'DEALER'].map((code) => h('option', {
          value: code, selected: level === code, text: `${code[0]}${code.slice(1).toLowerCase()}`,
        }))),
      ]),
      h('label', { text: 'Change' }, [
        h('select', {
          onchange: (event) => { rule = event.target.value; render(); },
        }, RULES.map((r) => h('option', { value: r.id, selected: rule === r.id, text: r.label }))),
      ]),
      h('label', { text: ruleNeeds === 'amount' ? 'Pesos' : 'Per cent' }, [
        h('input', {
          type: 'text', inputmode: 'decimal', value,
          'aria-label': ruleNeeds === 'amount' ? 'Amount in pesos' : 'Percentage',
          oninput: (event) => { value = event.target.value; },
        }),
      ]),
      h('label', { text: 'Round to' }, [
        h('select', {
          onchange: (event) => { rounding = event.target.value; },
        }, ROUNDINGS.map((r) => h('option', { value: r.id, selected: rounding === r.id, text: r.label }))),
      ]),
      h('button', { class: 'row-action', icon: 'refresh-cw', text: 'Work it out', onclick: applyRule }),
    ]);
  }

  function render(total = null) {
    const list = changed();
    const rows = lines();
    clear(root).append(h('section', { class: 'catalogue price-change' }, [
      h('header', { class: 'admin-head' }, [
        h('button', { class: 'row-action', icon: 'arrow-left', text: 'Products', onclick: () => onBack() }),
        h('h1', { text: 'Change prices' }),
      ]),
      h('p', { class: 'muted', text: 'Pick the products — everything a search finds, or a list you add to '
        + 'product by product — say what to do to their prices, and check the new column before saving. '
        + 'Every change is kept with its reason, and the old price stays in the history.' }),

      chooser(),

      mode === 'MATCH'
        ? h('div', { class: 'catalogue-controls' }, [
          search,
          h('select', {
            'aria-label': 'Category',
            onchange: (event) => { categoryId = event.target.value; load(); },
          }, [
            h('option', { value: '', text: 'All categories', selected: categoryId === '' }),
            ...categories.map((c) => h('option', { value: c.id, selected: categoryId === c.id, text: c.name })),
          ]),
        ])
        : null,

      controls(),

      rows.length === 0
        ? h('p', { class: 'muted', text: mode === 'PICKED'
          ? 'Nothing on the list yet. Add a product above — typed, or scanned.'
          : 'Nothing matches.' })
        : h('div', { class: 'table-scroll' }, [h('table', { class: 'catalogue-list' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: 'SKU' }),
            h('th', { text: 'Product' }),
            h('th', { class: 'money', text: 'Cost' }),
            h('th', { class: 'money', text: `${level[0]}${level.slice(1).toLowerCase()} now` }),
            h('th', { class: 'money', text: 'New price' }),
            h('th', { class: 'qty', text: 'Margin' }),
            mode === 'PICKED' ? h('th', { text: '' }) : null,
          ].filter(Boolean))]),
          h('tbody', {}, rows.map((row, index) => lineRow(row, index))),
        ])]),

      mode === 'MATCH' && total !== null && total > rows.length
        ? h('p', { class: 'muted', text: `Showing the first ${rows.length} of ${total}. Narrow it with the search or a category.` })
        : null,

      h('div', { class: 'price-save' }, [
        h('label', { text: 'Why' }, [
          h('input', {
            type: 'text', value: reason, maxlength: '200', placeholder: 'Supplier raised prices, September',
            'aria-label': 'Why the prices are changing',
            oninput: (event) => { reason = event.target.value; },
          }),
        ]),
        h('button', {
          class: 'primary', icon: 'save', disabled: saving || list.length === 0,
          text: saving ? 'Saving…' : `Save ${list.length} price${list.length === 1 ? '' : 's'}`,
          onclick: save,
        }),
        list.length > 0
          ? h('button', { text: 'Clear the new prices', onclick: () => { for (const row of lines()) row.next = null; render(); } })
          : null,
        mode === 'PICKED' && picked.length > 0
          ? h('button', { text: 'Empty the list', onclick: () => { picked = []; render(); } })
          : null,
      ].filter(Boolean)),
    ].filter(Boolean)));
  }

  function lineRow(row, index) {
    const current = priceOf(row);
    const cost = costOf(row);
    const next = row.next;
    const margin = next !== null && cost !== null ? marginBp(next, cost) : null;
    return h('tr', { class: next !== null && next !== current ? 'is-changed' : null }, [
      h('td', { class: 'sku', text: row.product.sku }),
      h('td', { text: row.product.name }),
      h('td', { class: 'money', text: cost === null ? '—' : money(cost) }),
      h('td', { class: 'money', text: current === null ? '—' : money(current) }),
      h('td', { class: 'money' }, [
        h('input', {
          type: 'text', inputmode: 'decimal', class: 'money new-price',
          value: next === null ? '' : (next / 100).toFixed(2),
          placeholder: current === null ? 'Set one' : '',
          'aria-label': `New ${level.toLowerCase()} price for ${row.product.name}`,
          oninput: (event) => {
            const typed = Number.parseFloat(event.target.value);
            lines()[index].next = Number.isFinite(typed) && typed >= 0 ? Math.round(typed * 100) : null;
            refreshRow(index);
          },
        }),
      ]),
      h('td', { class: 'qty', text: margin === null ? '—' : `${(margin / 100).toFixed(1)}%` }),
      mode === 'PICKED'
        ? h('td', { class: 'row-actions' }, [h('button', {
          class: 'row-action', icon: 'x', 'aria-label': `Take ${row.product.name} off the list`,
          onclick: () => { picked = picked.filter((entry) => entry !== row); render(); },
        })])
        : null,
    ].filter(Boolean));
  }

  /** The row's own figures, without rebuilding the table under the cashier's cursor. */
  function refreshRow(index) {
    const row = lines()[index];
    const tr = root.querySelectorAll('tbody tr')[index];
    if (!tr) return;
    const cost = costOf(row);
    const margin = row.next !== null && cost !== null ? marginBp(row.next, cost) : null;
    const marginCell = mode === 'PICKED' ? tr.cells[5] : tr.lastElementChild;
    marginCell.textContent = margin === null ? '—' : `${(margin / 100).toFixed(1)}%`;
    tr.classList.toggle('is-changed', row.next !== null && row.next !== priceOf(row));
    const save = root.querySelector('.price-save .primary');
    const list = changed();
    if (save) {
      save.disabled = saving || list.length === 0;
      save.lastChild.textContent = saving ? 'Saving…' : `Save ${list.length} price${list.length === 1 ? '' : 's'}`;
    }
  }

  return { mount: load, unmount() { clearTimeout(timer); } };
}
