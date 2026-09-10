// SCR-201 — the product list, and SCR-204 — low stock.
//
// One view for both, because they are the same list under a different filter, and two
// files would be two places for the on-hand column to start disagreeing with itself.
//
// The list shows on-hand, which the product search returns directly (INV-101's
// materialised figure, joined in the repository). It is not computed here and it is
// not fetched per row: fifty products on a page would be fifty round trips, and a list
// that takes a second to paint is a list nobody uses during a cutover.
//
// Cost appears nowhere on this screen for anyone. TX-412 makes it owner-only, and a
// list is the wrong place for it even then — the price column is retail, which is what
// somebody scanning the list is checking.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money, quantity } from '../shell/format.js';

const PAGE = 50;

export function createProductList({ root, mode = 'all', onOpen, onAdjust, onBatches, onValuation, onCount }) {
  let query = '';
  let categoryId = '';
  let includeInactive = false;
  let offset = 0;
  let categories = [];
  let searchTimer = null;
  let latest = 0;

  const lowStockOnly = () => mode === 'low-stock';

  async function load() {
    ui.loading(root, { rows: 6 });
    try {
      categories = (await api.get('/categories')).categories || [];
      await refresh();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  /**
   * Fetch and render.
   *
   * Every request carries a sequence number and a late reply is dropped. Typing
   * "feed" fires four searches and they do not come back in order; without this the
   * list settles on whichever was slowest, which at a counter looks like the search
   * ignoring the last letter.
   */
  async function refresh() {
    const mine = ++latest;
    try {
      const data = lowStockOnly()
        ? await api.get(`/inventory/low-stock?limit=${PAGE}&offset=${offset}`)
        : await api.get(`/products?q=${encodeURIComponent(query)}`
          + `&category=${categoryId}&includeInactive=${includeInactive}`
          + `&limit=${PAGE}&offset=${offset}`);

      if (mine !== latest) return;
      render(lowStockOnly() ? asProducts(data) : data);
    } catch (err) {
      if (mine !== latest) return;
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: refresh });
    }
  }

  /** The low-stock endpoint returns its own shape; one renderer, one shape. */
  const asProducts = (data) => ({
    total: data.total,
    products: data.products.map((row) => ({
      id: row.product_id,
      sku: row.sku,
      name: row.name,
      category: { name: row.category_name },
      brand: row.brand_name ? { name: row.brand_name } : null,
      is_batch_tracked: Boolean(row.is_batch_tracked),
      base_unit: { code: row.base_unit_code },
      qty_on_hand_milli: row.qty_on_hand_milli,
      qty_on_hand_display: row.qty_on_hand_display,
      min_stock_milli: row.min_stock_milli,
      min_stock_display: row.min_stock_display,
      shortfall_milli: row.shortfall_milli,
      is_low_stock: true,
      is_out_of_stock: row.is_out_of_stock,
      is_active: true,
      retail_price_centavos: null,
    })),
  });

  function render(data) {
    clear(root).append(h('section', { class: 'catalogue' }, [
      header(),
      lowStockOnly() ? null : controls(),
      data.products.length === 0 ? emptyState() : table(data),
      pager(data),
    ]));
  }

  function header() {
    return h('header', { class: 'admin-head' }, [
      h('h1', { text: lowStockOnly() ? 'Low stock' : 'Products' }),
      // SCR-604 hangs off here rather than off the dashboard's low-stock tile: that
      // tile is a count of products and now opens this list, which left the valuation
      // report with nothing pointing at it.
      h('button', { class: 'row-action', text: 'Valuation', onclick: () => onValuation() }),
      // SCR-205. Beside the valuation because they answer the two halves of the same
      // question: what the system thinks is here, and what actually is.
      onCount ? h('button', { class: 'row-action', text: 'Stock count', onclick: () => onCount() }) : null,
      lowStockOnly()
        ? null
        : h('button', {
          class: 'primary', text: 'New product',
          onclick: () => onOpen(null),
        }),
    ]);
  }

  function controls() {
    const search = h('input', {
      type: 'search', class: 'catalogue-search', value: query,
      placeholder: 'Name, SKU, barcode or brand', 'aria-label': 'Search products',
      oninput: (event) => {
        query = event.target.value;
        offset = 0;
        // Debounced, but only just: NFR_1.3 gives the search 500 ms and a keystroke
        // should not spend most of that waiting to be sent.
        clearTimeout(searchTimer);
        searchTimer = setTimeout(refresh, 120);
      },
    });

    const category = h('select', {
      'aria-label': 'Category',
      onchange: (event) => { categoryId = event.target.value; offset = 0; refresh(); },
    }, [
      h('option', { value: '', text: 'All categories' }),
      ...categories.map((c) => h('option', {
        value: c.id, text: c.name, selected: c.id === categoryId,
      })),
    ]);

    const inactive = h('input', {
      type: 'checkbox', checked: includeInactive,
      onchange: (event) => { includeInactive = event.target.checked; offset = 0; refresh(); },
    });

    return h('div', { class: 'catalogue-controls' }, [
      search,
      category,
      h('label', { class: 'check' }, [inactive, h('span', { text: 'Show inactive' })]),
    ]);
  }

  function emptyState() {
    const host = h('div');
    if (lowStockOnly()) {
      ui.empty(host, { title: 'Nothing is at or below its reorder point.' });
    } else if (query || categoryId) {
      ui.empty(host, { title: `Nothing matches “${query || 'that filter'}”.` });
    } else {
      // The state a store is in on its first morning. The empty message is the one
      // instruction that matters at that moment.
      ui.empty(host, {
        title: 'No products yet. Add the first one to start stocking the shop.',
        action: 'New product',
        onAction: () => onOpen(null),
      });
    }
    return host;
  }

  function table(data) {
    return h('table', { class: 'catalogue-list' }, [
      h('thead', {}, [h('tr', {}, [
        // 04_UX_SPEC.md §3's columns, with brand beside the name it qualifies: a shelf
        // holds four makes of the same feed, and the name alone does not say which.
        h('th', { text: 'SKU' }), h('th', { text: 'Product' }), h('th', { text: 'Brand' }),
        h('th', { text: 'Category' }), h('th', { text: 'Base unit' }),
        h('th', { text: 'On hand' }),
        h('th', { text: lowStockOnly() ? 'Minimum' : 'Retail' }),
        h('th', { text: '' }),
      ])]),
      h('tbody', {}, data.products.map((p) => h('tr', {
        // The amber border and the muted row 04_UX_SPEC.md §3 asks for.
        class: [p.is_low_stock ? 'is-low' : '', p.is_active ? '' : 'is-inactive'].filter(Boolean).join(' '),
        tabindex: '0',
        onclick: () => onOpen(p.id),
        onkeydown: (event) => { if (event.key === 'Enter') onOpen(p.id); },
      }, [
        h('td', { class: 'sku', text: p.sku }),
        h('td', {}, [
          h('span', { text: p.name }),
          p.is_active ? null : h('span', { class: 'tag', text: 'inactive' }),
          p.retail_price_centavos === null && !lowStockOnly()
            // PR-102: a product with no price cannot be sold, and that is worth seeing
            // in the list rather than at the counter with a customer waiting.
            ? h('span', { class: 'tag warn', text: 'no price' })
            : null,
        ]),
        // An em dash, not an empty cell: a product with no brand and a product whose
        // brand failed to load look the same when the cell is blank (VR-209 makes the
        // brand optional and the category required, so only this one can be absent).
        h('td', { class: p.brand ? null : 'muted', text: p.brand ? p.brand.name : '—' }),
        h('td', { text: p.category.name }),
        // UOM-005: the code, because that is what every quantity in this product is
        // labelled with — including the one in the next column.
        h('td', { class: 'unit', text: p.base_unit.code }),
        h('td', { class: 'qty' }, [
          h('span', { text: p.qty_on_hand_display || quantity(p.qty_on_hand_milli, p.base_unit.code) }),
          p.is_low_stock && !lowStockOnly()
            ? h('span', { class: 'tag warn', text: 'low' })
            : null,
        ]),
        h('td', {
          class: lowStockOnly() ? 'qty' : 'money',
          text: lowStockOnly() ? p.min_stock_display : money(p.retail_price_centavos),
        }),
        h('td', {}, [
          h('button', {
            class: 'row-action', text: 'Adjust',
            onclick: (event) => { event.stopPropagation(); onAdjust(p.id); },
          }),
          // SCR-206, for the products that have batches at all. Absent rather than
          // present-and-refusing on the rest: INV-201 makes the question itself invalid
          // for a product whose stock is not held as batches.
          p.is_batch_tracked && onBatches
            ? h('button', {
              class: 'row-action', text: 'Batches',
              onclick: (event) => { event.stopPropagation(); onBatches(p.id); },
            })
            : null,
        ]),
      ]))),
    ]);
  }

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
    refresh,
  };
}
