// The product picker — one field, one list, one place (`FR_2.1`, `NFR_1.3`).
//
// The POS has always had this: type two letters and the matches appear as a list you
// click. The buying screens had a `<datalist>` instead, and the difference is not
// cosmetic. A datalist is a hint, not a choice — the line resolved only when the typed
// text matched a product's label **exactly**, or when the search happened to return
// one row. So a buyer typing "feed" against a shop with four feeds saw four
// suggestions, picked none of them by keyboard, and had a line bound to nothing; the
// refusal came at save, one screen too late, which is the failure the resolved-label
// line under the field was added to soften rather than to fix.
//
// This is that list, extracted so both screens use the same one. It exists in the shell
// rather than in either screen because the third caller — a stock count, an adjustment
// — is a matter of time, and three implementations of "find a product" is three
// behaviours of the search a store will describe as one.
//
// **The picker never guesses.** There is no "one result means they meant it": a line is
// bound because somebody chose a row, and a field left half-typed binds nothing. That
// is the opposite of the datalist's behaviour and it is deliberate — a buyer who typed
// "feed" and got the wrong feed silently ordered the wrong feed.

import * as api from './api.js';
import { h, clear } from './ui.js';

/**
 * @param {object} options
 * @param {string}   options.value        what the field starts with, for an existing line
 * @param {function} options.onPick       called with the chosen product
 * @param {function} [options.onClear]    called when the field is emptied or edited away
 * @param {string}   [options.placeholder]
 * @param {string}   [options.ariaLabel]
 * @param {boolean}  [options.includeInactive] INV-105: a withdrawn product cannot be
 *   sold, but it can still be received and counted, so the buying screens ask for it.
 */
export function createProductPicker({
  value = '', onPick, onClear = null, placeholder = 'Name, SKU or barcode',
  ariaLabel = 'Find a product', includeInactive = false,
}) {
  let timer = null;
  let latest = 0;
  let matches = [];
  let cursor = -1;

  const results = h('div', { class: 'picker-results', role: 'listbox', hidden: true });
  const input = h('input', {
    type: 'search', class: 'line-product picker-input', value,
    placeholder, 'aria-label': ariaLabel, autocomplete: 'off',
    role: 'combobox', 'aria-expanded': 'false', 'aria-autocomplete': 'list',
  });

  function close() {
    results.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    cursor = -1;
  }

  /**
   * Search, debounced, with a sequence guard.
   *
   * Both are the catalogue list's, for its reasons: a keystroke should not spend most
   * of `NFR_1.3`'s budget waiting to be sent, and four searches fired by "feed" do not
   * come back in order — without the guard the list settles on whichever was slowest,
   * which reads as the search ignoring the last letter.
   */
  function search() {
    const term = input.value.trim();
    if (term.length < 2) { matches = []; clear(results); close(); return; }

    const mine = ++latest;
    api.get(`/products?q=${encodeURIComponent(term)}&limit=8&includeInactive=${includeInactive}`)
      .then((data) => {
        if (mine !== latest) return;
        matches = data.products || [];
        render();
      })
      .catch(() => {
        // A failed lookup leaves the field as typed and the list closed. The screen's
        // own save refuses an unbound line with a sentence; a picker that emptied the
        // field would take the buyer's typing away as well as their answer.
        if (mine === latest) close();
      });
  }

  function render() {
    clear(results);
    if (matches.length === 0) {
      results.append(h('p', { class: 'no-results', text: `Nothing matches “${input.value.trim()}”.` }));
    }

    matches.forEach((product, index) => {
      results.append(h('button', {
        type: 'button',
        class: `picker-result${index === cursor ? ' is-cursor' : ''}`,
        role: 'option',
        'aria-selected': index === cursor ? 'true' : 'false',
        // mousedown, not click: the field's blur fires first and would hide the list
        // out from under the pointer.
        onmousedown: (event) => { event.preventDefault(); pick(product); },
      }, [
        h('span', { class: 'picker-sku', text: product.sku }),
        h('span', { class: 'picker-name', text: product.name }),
        // What a buyer checks before ordering more: the unit it is bought in and what
        // is on the shelf now. Both are already on the search payload.
        h('span', { class: 'picker-unit', text: product.base_unit.code }),
        h('span', { class: 'picker-stock', text: product.qty_on_hand_display || '' }),
        product.is_active ? null : h('span', { class: 'tag', text: 'inactive' }),
      ]));
    });

    results.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function pick(product) {
    input.value = `${product.sku} — ${product.name}`;
    close();
    onPick(product);
  }

  input.addEventListener('input', () => {
    // Editing after a choice unbinds the line: the field and what it resolved to must
    // not be allowed to say different things.
    if (onClear) onClear();
    clearTimeout(timer);
    timer = setTimeout(search, 120);
  });

  input.addEventListener('keydown', (event) => {
    if (results.hidden || matches.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      cursor = event.key === 'ArrowDown'
        ? Math.min(cursor + 1, matches.length - 1)
        : Math.max(cursor - 1, 0);
      render();
    } else if (event.key === 'Enter' && cursor >= 0) {
      // Enter picks the highlighted row rather than submitting the form around it —
      // a buyer keying a ten-line order never leaves the keyboard.
      event.preventDefault();
      pick(matches[cursor]);
    } else if (event.key === 'Escape') {
      close();
    }
  });

  input.addEventListener('blur', () => { setTimeout(close, 120); });

  return {
    input,
    el: h('div', { class: 'picker' }, [input, results]),
    focus: () => input.focus(),
    get value() { return input.value; },
  };
}
