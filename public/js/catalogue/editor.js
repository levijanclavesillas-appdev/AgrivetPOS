// SCR-202 — the product editor.
//
// Five tabs, fixed by 04_UX_SPEC.md §3: Identity, Units, Pricing, Stock, Barcodes.
//
// Two things here are easy to get wrong and expensive afterwards.
//
// **The base unit is immutable once a movement exists** (UOM-003). Changing it would
// silently reinterpret every movement in the product's history — 500 becomes 500 of
// something else. So the field is locked, and the lock *says why and names the
// correction path*, because a disabled input with no explanation is a support call.
//
// **Cost is absent, not disabled, for anyone but OWNER** (TX-412). The server already
// omits it from the payload, so this screen cannot render it even by mistake; the tab
// is built from what arrived rather than from a role check, which is the version that
// stays right when the matrix changes.
//
// A store setting itself up has no categories and no units, so both are creatable from
// inside this editor. Sending someone to another screen to make a category is how a
// cutover stalls at the first product.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money, quantity, manila } from '../shell/format.js';

const TABS = ['Identity', 'Units', 'Pricing', 'Stock', 'Barcodes'];
const TAX_CLASSES = ['VATABLE', 'VAT_EXEMPT', 'ZERO_RATED'];
const PRICE_LEVELS = ['RETAIL', 'WHOLESALE', 'DEALER'];

// No `session` parameter, deliberately: what this screen shows is decided by what the
// server put in the payload, not by a role check here. TX-412 omits cost entirely for
// anyone who may not see it, so the editor cannot render it by mistake — and there is no
// role variable in scope for a future change to start branching on.
export function createProductEditor({ root, productId, onClose }) {
  let product = null;
  let reference = { categories: [], brands: [], units: [] };
  let tab = 'Identity';
  const isNew = !productId;

  async function load() {
    ui.loading(root, { rows: 5 });
    try {
      const [categories, brands, units] = await Promise.all([
        api.get('/categories'), api.get('/brands'), api.get('/units'),
      ]);
      reference = {
        categories: categories.categories || [],
        brands: brands.brands || [],
        units: units.units || [],
      };
      product = isNew ? blank() : (await api.get(`/products/${productId}`)).product;
      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  const blank = () => ({
    id: null, sku: '', name: '', description: '',
    category: { id: null }, brand: null, base_unit: { id: null },
    tax_class: 'VATABLE', min_stock_milli: 0, is_active: true,
    qty_on_hand_milli: 0, has_moved: false, base_unit_locked: false,
    barcodes: [], packs: [], prices: { RETAIL: null, WHOLESALE: null, DEALER: null },
  });

  function render() {
    clear(root).append(h('section', { class: 'catalogue editor' }, [
      h('header', { class: 'admin-head' }, [
        // Wrapped, deliberately: `onclick: onClose` would hand the handler a
        // MouseEvent, and onClose reads its first argument as a newly created product
        // id — so the back button reopened the editor instead of returning to the list.
        h('button', { class: 'report-back', text: '← Products', onclick: () => onClose() }),
        h('h1', { text: isNew ? 'New product' : product.name }),
        product && !product.is_active
          ? h('span', { class: 'tag', text: 'inactive' })
          : null,
      ]),
      h('nav', { class: 'admin-tabs', 'aria-label': 'Product sections' },
        // A product that does not exist yet has no stock, no packs and no barcodes to
        // show. Offering the tabs would be offering empty screens that cannot be
        // filled until it is saved.
        (isNew ? ['Identity'] : TABS).map((name) => h('button', {
          class: `admin-tab${name === tab ? ' is-active' : ''}`,
          'aria-current': name === tab ? 'page' : null,
          text: name,
          onclick: () => { tab = name; render(); },
        }))),
      h('div', { class: 'editor-panel' }, [panel()]),
    ]));
  }

  const panel = () => ({
    Identity: identityTab,
    Units: unitsTab,
    Pricing: pricingTab,
    Stock: stockTab,
    Barcodes: barcodesTab,
  }[tab]());

  // ── Identity ──────────────────────────────────────────────────────────────

  function identityTab() {
    const sku = field('SKU', h('input', { type: 'text', value: product.sku, required: true }));
    const name = field('Name', h('input', { type: 'text', value: product.name, required: true }));
    const category = referenceSelect('categories', 'Category', product.category.id, true);
    const brand = referenceSelect('brands', 'Brand', product.brand ? product.brand.id : null, false);
    const unit = baseUnitField();
    const taxClass = field('Tax class', h('select', {},
      TAX_CLASSES.map((c) => h('option', {
        value: c, text: c.replace(/_/g, ' ').toLowerCase(), selected: c === product.tax_class,
      }))));

    // A product is created with a retail price, because the API requires one (VR-203)
    // and PR-102 makes a product without one unsellable anyway. Asking here rather
    // than sending someone to the Pricing tab afterwards is the difference between
    // one form and two — and the Pricing tab does not exist until it is saved.
    const retail = isNew
      ? field('Retail price (₱)', h('input', {
        type: 'text', inputmode: 'decimal', required: true, placeholder: '0.00',
      }))
      : null;

    return h('form', {
      class: 'editor-form',
      onsubmit: async (event) => {
        event.preventDefault();
        const changes = {
          sku: sku.input.value.trim(),
          name: name.input.value.trim(),
          categoryId: category.input.value || null,
          brandId: brand.input.value || null,
          baseUnitId: unit.input ? unit.input.value : product.base_unit.id,
          taxClass: taxClass.input.value,
        };
        if (retail) {
          const pesos = Number.parseFloat(retail.input.value);
          if (!Number.isFinite(pesos) || pesos < 0) {
            ui.toast('Enter a retail price. It can be changed later.', { kind: 'error' });
            return;
          }
          changes.retailPriceCentavos = Math.round(pesos * 100);
        }
        await save(changes);
      },
    }, [
      sku.el, name.el, category.el, brand.el, unit.el, taxClass.el,
      retail ? retail.el : null,
      h('div', { class: 'editor-actions' }, [
        h('button', { type: 'submit', class: 'primary', text: isNew ? 'Create product' : 'Save' }),
        isNew || !product.is_active ? null : h('button', {
          type: 'button', class: 'row-action', text: 'Deactivate',
          onclick: deactivate,
        }),
      ]),
    ]);
  }

  /** UOM-003, and the sentence that makes the lock make sense. */
  function baseUnitField() {
    if (product.base_unit_locked) {
      return {
        input: null,
        el: h('div', { class: 'editor-field locked' }, [
          h('label', { text: 'Base unit' }),
          h('p', { class: 'locked-value', text: unitName(product.base_unit.id) }),
          h('p', { class: 'locked-why', text: 'This cannot be changed: stock has moved for this '
            + 'product, and every one of those movements is recorded in this unit. Changing it '
            + 'would silently reinterpret them. To correct it, create a new product with the '
            + 'right unit and move the stock across with an adjustment.' }),
          h('p', { class: 'refusal-rule', text: 'UOM-003' }),
        ]),
      };
    }
    return referenceSelect('units', 'Base unit', product.base_unit.id, true);
  }

  const unitName = (id) => {
    const unit = reference.units.find((u) => u.id === id);
    return unit ? `${unit.name} (${unit.code})` : '—';
  };

  /**
   * A select over a reference list, with "add one" built in.
   *
   * Requirement 3: a store with an empty catalogue has no categories and no units, and
   * making them elsewhere is how the first product never gets entered.
   */
  function referenceSelect(kind, label, selected, required) {
    const list = reference[kind];
    const input = h('select', { required }, [
      h('option', { value: '', text: required ? `Choose a ${label.toLowerCase()}…` : 'None' }),
      ...list.map((row) => h('option', {
        value: row.id, text: row.code ? `${row.name} (${row.code})` : row.name,
        selected: row.id === selected,
      })),
    ]);

    const add = h('button', {
      type: 'button', class: 'row-action', text: `New ${label.toLowerCase()}`,
      onclick: async () => {
        const name = window.prompt(`Name of the new ${label.toLowerCase()}`);
        if (!name) return;
        const body = { name: name.trim() };
        if (kind === 'units') {
          const code = window.prompt('Short code, as it appears on a receipt (KG, SACK, PC)');
          if (!code) return;
          body.code = code.trim().toUpperCase();
          body.allowsFraction = window.confirm(
            `Can ${body.code} be sold in fractions — 1.5 of them?\n\n`
            + 'OK for yes (kilos, litres). Cancel for no (sacks, pieces).'
          );
        }
        try {
          const created = await api.post(`/${kind}`, body);
          const made = created.unit || created.category || created.brand;
          reference[kind] = [...list, made];
          render();
        } catch (err) {
          ui.toast(err.message, { kind: 'error' });
        }
      },
    });

    return {
      input,
      el: h('div', { class: 'editor-field' }, [
        h('label', { text: label }), h('div', { class: 'field-row' }, [input, add]),
      ]),
    };
  }

  // ── Units — the pack table (UOM-002) ──────────────────────────────────────

  function unitsTab() {
    const unitId = h('select', {}, [
      h('option', { value: '', text: 'Choose a unit…' }),
      ...reference.units
        .filter((u) => u.id !== product.base_unit.id
          && !product.packs.some((pack) => pack.unit.id === u.id))
        .map((u) => h('option', { value: u.id, text: `${u.name} (${u.code})` })),
    ]);
    const factor = h('input', {
      type: 'text', inputmode: 'decimal', placeholder: 'How many base units',
      'aria-label': 'Conversion factor',
    });

    return h('div', {}, [
      h('p', { class: 'muted', text: `Everything is stored in ${unitName(product.base_unit.id)}. `
        + 'A pack is a way of selling several of them at once.' }),

      product.packs.length === 0
        ? h('p', { class: 'muted', text: 'No packs. The product is sold in its base unit only.' })
        : h('table', { class: 'catalogue-list' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: 'Pack' }), h('th', { text: 'Is' }), h('th', { text: '' }),
          ])]),
          h('tbody', {}, product.packs.map((pack) => h('tr', {}, [
            h('td', { text: pack.unit.code }),
            // UOM-002 stated in words. A factor of 5000 where 50000 was meant is
            // invisible as a number and obvious as a sentence.
            h('td', { text: `1 ${pack.unit.code} = ${quantity(pack.factor_milli)} `
              + `${product.base_unit.code}` }),
            h('td', {}, [h('button', {
              class: 'row-action', text: 'Remove',
              onclick: () => removePack(pack.id),
            })]),
          ]))),
        ]),

      h('form', {
        class: 'editor-form inline',
        onsubmit: async (event) => {
          event.preventDefault();
          const factorMilli = Math.round(Number.parseFloat(factor.value) * 1000);
          if (!unitId.value || !Number.isFinite(factorMilli) || factorMilli <= 0) {
            ui.toast('Choose a unit and how many base units it holds.', { kind: 'error' });
            return;
          }
          try {
            const result = await api.post(`/products/${product.id}/packs`, {
              unitId: unitId.value, factorMilli,
            });
            product.packs = result.packs;
            render();
          } catch (err) {
            ui.toast(err.message, { kind: 'error' });
          }
        },
      }, [
        h('div', { class: 'field-row' }, [
          unitId, factor,
          h('button', { type: 'submit', class: 'row-action', text: 'Add pack' }),
        ]),
      ]),
    ]);
  }

  async function removePack(packId) {
    try {
      product.packs = (await api.del(`/products/${product.id}/packs/${packId}`)).packs;
      render();
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
  }

  // ── Pricing (PR-101, TX-411, TX-412) ──────────────────────────────────────

  function pricingTab() {
    const inputs = {};
    for (const level of PRICE_LEVELS) {
      inputs[level] = h('input', {
        type: 'text', inputmode: 'decimal',
        value: product.prices[level] === null ? '' : (product.prices[level] / 100).toFixed(2),
        'aria-label': `${level} price in pesos`,
      });
    }

    return h('div', {}, [
      // TX-412: the server omits cost entirely for anyone else, so this block is built
      // from what arrived rather than from a role check here.
      'avg_cost_centavos' in product
        ? h('div', { class: 'cost-block' }, [
          h('h2', { text: 'Average cost' }),
          h('p', { class: 'profit-figure', text: money(product.avg_cost_centavos) }),
          h('p', { class: 'muted', text: product.avg_cost_as_of
            ? `As of ${manila(product.avg_cost_as_of)}. Maintained by receipts (MON-004).`
            : 'No stock has been received yet, so there is no cost.' }),
        ])
        : null,

      h('form', {
        class: 'editor-form',
        onsubmit: async (event) => {
          event.preventDefault();
          // PUT /products/:id/prices takes the level names themselves — RETAIL,
          // WHOLESALE, DEALER — and refuses anything else with PR-101. A level left
          // blank is left alone rather than set to zero.
          const levels = {};
          for (const level of PRICE_LEVELS) {
            const value = inputs[level].value.trim();
            if (value === '') continue;
            levels[level] = Math.round(Number.parseFloat(value) * 100);
          }
          if (Object.keys(levels).length === 0) {
            ui.toast('Nothing to save.', { kind: 'error' });
            return;
          }
          try {
            product = (await api.put(`/products/${product.id}/prices`, levels)).product;
            ui.toast('Prices saved', { kind: 'success' });
            render();
          } catch (err) {
            // PR-105, TX-411 and the below-cost refusals all land here, and each one
            // names its rule.
            if (err.isRefusal) ui.toast(`${err.message} (${err.ruleId})`, { kind: 'error' });
            else ui.toast(err.message, { kind: 'error' });
          }
        },
      }, [
        ...PRICE_LEVELS.map((level) => h('div', { class: 'editor-field' }, [
          h('label', { text: `${level[0]}${level.slice(1).toLowerCase()} price (₱)` }),
          inputs[level],
          product.prices.effective && product.prices.effective[level]
            ? h('small', { class: 'muted', text: `since ${manila(product.prices.effective[level])}` })
            : null,
        ])),
        h('p', { class: 'muted', text: 'A product with no retail price cannot be sold (PR-102).' }),
        h('div', { class: 'editor-actions' }, [
          h('button', { type: 'submit', class: 'primary', text: 'Save prices' }),
        ]),
      ]),
    ]);
  }

  // ── Stock (INV-101, INV-109, UOM-005) ─────────────────────────────────────

  function stockTab() {
    const minimum = h('input', {
      type: 'text', inputmode: 'decimal',
      value: quantity(product.min_stock_milli),
      'aria-label': `Minimum stock in ${product.base_unit.code}`,
    });

    return h('div', {}, [
      h('dl', { class: 'admin-meta' }, [
        metaField('On hand', product.qty_on_hand_display
          || quantity(product.qty_on_hand_milli, product.base_unit.code)),
        metaField('Base unit', unitName(product.base_unit.id)),
      ]),
      // INV-101: derived from the ledger and never editable. The way to change it is a
      // movement, which is what the adjustment screen is for.
      h('p', { class: 'muted', text: 'On hand comes from the stock ledger and cannot be typed. '
        + 'Use an adjustment to correct it — that way there is a reason and a record.' }),

      h('form', {
        class: 'editor-form',
        onsubmit: async (event) => {
          event.preventDefault();
          await save({ minStockMilli: Math.round(Number.parseFloat(minimum.value || '0') * 1000) });
        },
      }, [
        h('div', { class: 'editor-field' }, [
          // UOM-005: thresholds are in the base unit, and the label says which.
          h('label', { text: `Minimum stock (${product.base_unit.code})` }),
          minimum,
          h('small', { class: 'muted', text: 'At or below this, the product appears in Low stock '
            + 'and in the alert centre (INV-109). Zero turns the alert off.' }),
        ]),
        h('div', { class: 'editor-actions' }, [
          h('button', { type: 'submit', class: 'primary', text: 'Save' }),
        ]),
      ]),
    ]);
  }

  const metaField = (label, value) => h('div', { class: 'meta-field' }, [
    h('dt', { text: label }), h('dd', { text: value }),
  ]);

  // ── Barcodes (VR-205) ─────────────────────────────────────────────────────

  function barcodesTab() {
    const code = h('input', {
      type: 'text', class: 'barcode-input', autocomplete: 'off',
      placeholder: 'Scan it, or type it', 'aria-label': 'Barcode',
    });

    return h('div', {}, [
      product.barcodes.length === 0
        ? h('p', { class: 'muted', text: 'No barcodes. Scan the item into the box below.' })
        : h('table', { class: 'catalogue-list' }, [
          h('tbody', {}, product.barcodes.map((barcode) => h('tr', {}, [
            h('td', { class: 'sku', text: barcode.barcode }),
            h('td', {}, [h('button', {
              class: 'row-action', text: 'Remove',
              onclick: async () => {
                try {
                  product.barcodes = (await api.del(
                    `/products/${product.id}/barcodes/${barcode.id}`
                  )).barcodes;
                  render();
                } catch (err) { ui.toast(err.message, { kind: 'error' }); }
              },
            })]),
          ]))),
        ]),

      h('form', {
        class: 'editor-form inline',
        onsubmit: async (event) => {
          event.preventDefault();
          if (!code.value.trim()) return;
          try {
            product.barcodes = (await api.post(`/products/${product.id}/barcodes`, {
              barcode: code.value.trim(),
            })).barcodes;
            code.value = '';
            render();
            queueMicrotask(() => root.querySelector('.barcode-input')?.focus());
          } catch (err) {
            // VR-205: the code already belongs to another product. Worth reading, not
            // a toast that vanishes.
            ui.toast(err.message, { kind: 'error' });
          }
        },
      }, [
        h('div', { class: 'field-row' }, [
          code, h('button', { type: 'submit', class: 'row-action', text: 'Add' }),
        ]),
      ]),
      h('p', { class: 'muted', text: 'A barcode belongs to one product only (VR-205). '
        + 'A product may have several — a sack and a repack often carry different codes.' }),
    ]);
  }

  // ── Saving ────────────────────────────────────────────────────────────────

  async function save(changes) {
    try {
      if (isNew) {
        const created = await api.post('/products', changes);
        ui.toast(`${created.product.name} created`, { kind: 'success' });
        onClose(created.product.id);
        return;
      }
      product = (await api.put(`/products/${product.id}`, changes)).product;
      ui.toast('Saved', { kind: 'success' });
      render();
    } catch (err) {
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    }
  }

  async function deactivate() {
    // INV-105: deactivating withdraws it from sale; it is never deleted, because
    // history references it.
    if (!window.confirm(`Withdraw ${product.name} from sale?\n\n`
      + 'It stays in the system and on every past sale. It simply cannot be sold again '
      + 'until it is reactivated.')) return;
    try {
      product = (await api.post(`/products/${product.id}/deactivate`, {})).product;
      render();
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
  }

  const field = (label, input) => ({
    input,
    el: h('div', { class: 'editor-field' }, [h('label', { text: label }), input]),
  });

  function onKey(event) {
    if ((event.ctrlKey || event.metaKey) && event.key === 's') {
      event.preventDefault();
      root.querySelector('form')?.requestSubmit();
    }
  }

  return {
    mount() {
      document.addEventListener('keydown', onKey);
      load();
    },
    unmount() { document.removeEventListener('keydown', onKey); },
  };
}
