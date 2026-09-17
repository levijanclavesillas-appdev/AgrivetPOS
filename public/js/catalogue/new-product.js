// A product made where it is needed — on the buying screens (TX-410).
//
// A delivery arrives with something the catalogue has never seen: a new brand of feed, a line
// the store has not sold before. Until now that meant leaving the delivery, going to Products,
// making the product, and coming back to start the line again. This is the same three fields
// the catalogue asks for, in a dialog over the screen that needs them, and it makes the
// category or the unit too where the store has none yet.
//
// Everything it writes goes through the ordinary endpoints, so every rule that governs a
// product made on SCR-202 governs one made here: VR-201's SKU, VR-203's price, UOM-004's
// fractions, and TX-410 for all of it.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';

const NEW = '__new__';

/** A SKU from a name — "Well-milled rice" → "WELL-MILLED-RICE", trimmed to 40 (VR-201). */
export function skuFrom(name) {
  return String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Ask for a new product. Resolves with it, or with null where the dialog was closed.
 * `name` prefills the name, so a buyer who typed a product that does not exist keeps what
 * they typed.
 */
export function askNewProduct({ name = '' } = {}) {
  return new Promise((resolve) => {
    let categories = [];
    let units = [];
    let busy = false;

    const nameField = h('input', { type: 'text', value: name, maxlength: '120', required: true, autocomplete: 'off' });
    const skuField = h('input', { type: 'text', value: skuFrom(name), maxlength: '40', required: true, autocomplete: 'off' });
    let skuTouched = Boolean(name);
    const price = h('input', { type: 'text', inputmode: 'decimal', required: true, autocomplete: 'off', placeholder: '0.00' });

    const categorySelect = h('select', { required: true });
    const categoryName = h('input', { type: 'text', maxlength: '80', placeholder: 'New category name', hidden: true });
    const unitSelect = h('select', { required: true });
    const unitCode = h('input', { type: 'text', maxlength: '12', placeholder: 'Code — KG, SACK, PC', hidden: true });
    const unitName = h('input', { type: 'text', maxlength: '60', placeholder: 'Name — Kilogram', hidden: true });
    const unitFraction = h('label', { class: 'ask-check', hidden: true }, [
      h('input', { type: 'checkbox' }),
      h('span', { text: 'Can be sold in parts — 1.5 of them' }),
    ]);
    const problem = h('p', { class: 'opening-status error', role: 'alert', hidden: true });

    const overlay = h('div', { class: 'ask-overlay' });
    const close = (value) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key !== 'Escape' || busy) return;
      event.preventDefault();
      event.stopPropagation();
      close(null);
    };

    const option = (value, text) => h('option', { value, text });
    function fillOptions() {
      clear(categorySelect).append(
        option('', 'Choose a category…'),
        ...categories.map((c) => option(c.id, c.name)),
        option(NEW, '+ New category…'),
      );
      clear(unitSelect).append(
        option('', 'Choose a unit…'),
        ...units.map((u) => option(u.id, `${u.name} (${u.code})`)),
        option(NEW, '+ New unit…'),
      );
    }

    categorySelect.addEventListener('change', () => { categoryName.hidden = categorySelect.value !== NEW; });
    unitSelect.addEventListener('change', () => {
      const making = unitSelect.value === NEW;
      unitCode.hidden = making;
      unitName.hidden = making;
      unitFraction.hidden = making;
      for (const el of [unitCode, unitName, unitFraction]) el.hidden = !making;
    });
    nameField.addEventListener('input', () => {
      if (!skuTouched) skuField.value = skuFrom(nameField.value);
    });
    skuField.addEventListener('input', () => { skuTouched = true; });

    async function submit(event) {
      event.preventDefault();
      if (busy) return;
      problem.hidden = true;
      const pesos = Number.parseFloat(price.value);
      if (!Number.isFinite(pesos) || pesos < 0) return fail('Give the price it sells for. Type 0 if it is not sold.');
      if (!categorySelect.value) return fail('Choose a category, or make one.');
      if (!unitSelect.value) return fail('Choose the unit it is counted in, or make one.');

      busy = true;
      try {
        const categoryId = categorySelect.value === NEW
          ? (await api.post('/categories', { name: categoryName.value.trim() })).category.id
          : categorySelect.value;
        const baseUnitId = unitSelect.value === NEW
          ? (await api.post('/units', {
            code: unitCode.value.trim().toUpperCase(),
            name: unitName.value.trim() || unitCode.value.trim().toUpperCase(),
            allowsFraction: unitFraction.querySelector('input').checked,
          })).unit.id
          : unitSelect.value;

        const { product } = await api.post('/products', {
          sku: skuField.value.trim(),
          name: nameField.value.trim(),
          categoryId,
          baseUnitId,
          retailPriceCentavos: Math.round(pesos * 100),
        });
        ui.toast(`${product.name} added to the catalogue.`, { kind: 'success' });
        close(product);
      } catch (err) {
        fail(err.isRefusal && err.ruleId ? `${err.message} (${err.ruleId})` : err.message);
      } finally {
        busy = false;
      }
      return undefined;
    }

    function fail(message) {
      problem.textContent = message;
      problem.hidden = false;
      return undefined;
    }

    overlay.append(h('form', { class: 'ask new-product', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'New product', onsubmit: submit }, [
      h('h2', { text: 'New product' }),
      h('p', { class: 'ask-message', text: 'It is added to the catalogue as it is made, and can be edited under Products.' }),
      h('label', { text: 'Name' }, [nameField]),
      h('label', { text: 'SKU — the store\'s own code' }, [skuField]),
      h('label', { text: 'Category' }, [categorySelect]),
      categoryName,
      h('label', { text: 'Counted and sold in' }, [unitSelect]),
      unitCode,
      unitName,
      unitFraction,
      h('label', { text: 'Sells for (₱)' }, [price]),
      problem,
      h('div', { class: 'ask-actions' }, [
        h('button', { type: 'submit', class: 'primary', text: 'Add product' }),
        h('button', { type: 'button', text: 'Cancel', onclick: () => close(null) }),
      ]),
    ]));

    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);

    Promise.all([
      api.get('/categories').then((data) => data.categories || []).catch(() => []),
      api.get('/units').then((data) => data.units || []).catch(() => []),
    ]).then(([foundCategories, foundUnits]) => {
      categories = foundCategories.filter((c) => c.is_active !== 0);
      units = foundUnits.filter((u) => u.is_active !== 0);
      fillOptions();
      queueMicrotask(() => nameField.focus());
    });
  });
}
