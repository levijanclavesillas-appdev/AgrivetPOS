// SCR-806 — Restock: what to buy, asked for and approved (TASK-072).
//
// Until now the store could see *what is low* and could not keep a list of *what to buy*.
// `SCR-201`'s low-stock filter and the dashboard tile both produce a list on a screen that
// dies when the screen closes, so a buyer read it, wrote on paper, and keyed the same
// products into `SCR-802` again — once per supplier, from memory of which supplier sells
// which.
//
// **The column that makes this worth opening is "Coming".** INV-109 compares the shelf with
// the minimum and knows nothing about the forty sacks on a PENDING order, so a buyer reading
// the low-stock list twice in a week orders them twice. PO-109 nets it off, and the row shows
// the sum rather than handing over a figure from nowhere.
//
// Three views, one module, because they are one job: the requests that exist, the list being
// built, and one request being decided. Every figure and every may-I is the server's — the
// screen draws what it is told (SEC-6's reasoning applied to state).

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { createProductPicker } from '../shell/picker.js';
import { money, quantity, manila } from '../shell/format.js';

const MILLI = 1000;
const PAGE = 25;

const qty = (milli) => (milli === null || milli === undefined ? '—' : quantity(milli));

export function createRestock({ root, onBack, onOpenOrder = null }) {
  let view = 'requests';       // 'requests' | 'build' | 'detail'
  let data = null;             // GET /restock-requests
  let offset = 0;
  let suggestions = null;      // GET /restock/suggestions
  let draft = [];              // the list being built, in the buyer's own order
  let suppliers = [];
  let detail = null;           // GET /restock-requests/:id
  let note = '';
  let saving = false;

  // ── Loading ───────────────────────────────────────────────────────────────

  async function loadRequests() {
    try {
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      data = await api.get(`/restock-requests?${params}`);
      view = 'requests';
      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: loadRequests });
    }
  }

  async function loadSuggestions() {
    try {
      ui.loading(root, { rows: 6 });
      const [list, supplierList] = await Promise.all([
        api.get('/restock/suggestions'),
        api.get('/suppliers?limit=200'),
      ]);
      suggestions = list;
      suppliers = supplierList.suppliers;
      // Everything the shelf says needs buying starts on the list, at the quantity the
      // arithmetic worked out. A product already on somebody's open request starts off
      // it — it has been asked for, and asking twice is the fault this module fixes.
      draft = suggestions.products
        .filter((p) => !p.on_open_request)
        .map(fromSuggestion);
      view = 'build';
      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: loadSuggestions });
    }
  }

  async function open(id) {
    try {
      detail = (await api.get(`/restock-requests/${id}`)).request;
      view = 'detail';
      render();
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
  }

  const fromSuggestion = (p) => ({
    productId: p.product_id,
    label: `${p.sku} — ${p.name}`,
    name: p.name,
    sku: p.sku,
    baseUnit: p.base_unit_code,
    onHandMilli: p.qty_on_hand_milli,
    onOrderMilli: p.on_order_milli,
    minStockMilli: p.min_stock_milli,
    suggestedQtyMilli: p.suggested_qty_milli,
    targetMilli: p.target_milli,
    // A product with no minimum has no suggestion, so the box starts empty and the row
    // asks rather than inventing a number the buyer would have to notice and correct.
    qty: p.suggested_qty_milli === null ? '' : String(p.suggested_qty_milli / MILLI),
    supplierId: p.last_supplier_id || '',
    cost: p.last_cost_centavos === null || p.last_cost_centavos === undefined
      ? '' : String(p.last_cost_centavos / 100),
    source: p.source,
    onOpenRequest: p.on_open_request,
  });

  // ── The list being built ──────────────────────────────────────────────────

  /**
   * The field that puts a product on the list by hand.
   *
   * A fresh picker each render, because the row it adds redraws the table underneath it —
   * and the field empties itself after a pick so the next product can be typed straight
   * in, which is how somebody works through a supplier's letter.
   */
  function adder() {
    const picker = createProductPicker({
      placeholder: 'Add a product by name, SKU or barcode',
      ariaLabel: 'Add a product to the list',
      // INV-105, as the other buying screens read it: a product withdrawn from sale can
      // still be bought, and a store restocking one is not making a mistake.
      includeInactive: true,
      onPick: (product) => { picker.input.value = ''; addByHand(product); },
    });
    return picker;
  }

  async function addByHand(product) {
    if (draft.some((l) => l.productId === product.id)) {
      ui.toast(`${product.name} is already on this list.`);
      return;
    }
    try {
      // The picker's own search carries the shelf but not what is on order, and "coming"
      // is the figure this screen exists for — so the row is read again properly.
      const ctx = await api.post('/restock/context', { productIds: [product.id] });
      const row = ctx.products[0];
      draft = [...draft, row ? fromSuggestion(row) : {
        productId: product.id, label: `${product.sku} — ${product.name}`, name: product.name,
        sku: product.sku, baseUnit: product.base_unit?.code || '', qty: '', supplierId: '',
        cost: '', source: 'ADDED',
      }];
      render();
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
  }

  function payload() {
    return {
      note: note.trim() || null,
      lines: draft
        .filter((l) => Number(l.qty) > 0)
        .map((l) => ({
          productId: l.productId,
          qtyMilli: Math.round(Number(l.qty) * MILLI),
          supplierId: l.supplierId || null,
          unitCostCentavos: l.cost === '' ? null : Math.round(Number(l.cost) * 100),
          suggestedQtyMilli: l.suggestedQtyMilli ?? null,
          onHandMilli: l.onHandMilli ?? null,
          onOrderMilli: l.onOrderMilli ?? null,
          minStockMilli: l.minStockMilli ?? null,
          source: l.source,
        })),
    };
  }

  async function save() {
    const body = payload();
    if (body.lines.length === 0) {
      ui.toast('Nothing to ask for — put a quantity against at least one product.', { kind: 'error' });
      return;
    }
    saving = true; render();
    try {
      const { request } = await api.post('/restock-requests', body);
      // Straight on to asking: a saved draft nobody submits is the paper list again.
      const submitted = (await api.post(`/restock-requests/${request.id}/submit`, {})).request;
      detail = submitted;
      view = 'detail';
      ui.toast(submitted.status === 'APPROVED'
        ? `${submitted.rr_no} raised and approved — ${submitted.line_count} product(s).`
        : `${submitted.rr_no} sent for approval — ${submitted.line_count} product(s).`);
      render();
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    } finally {
      saving = false;
    }
  }

  // ── Deciding, and converting ──────────────────────────────────────────────

  async function decide(approve) {
    const struck = new Set(detail.items.filter((i) => i.is_approved === false).map((i) => i.id));
    let reason = null;
    if (!approve) {
      // ui.ask, not window.prompt — Electron throws on prompt, so a button built on one
      // does nothing at all in the packaged app (the fault order.js:386 records).
      const answers = await ui.ask({
        title: 'Reject this request',
        message: 'The reason goes on the audit trail beside the refusal (AUD-601), and the '
          + 'person who raised it sees it.',
        fields: [{ name: 'reason', label: 'Why is this refused?', maxLength: 200 }],
        submitLabel: 'Reject',
      });
      if (!answers || !answers.reason || !answers.reason.trim()) return;
      reason = answers.reason;
    }
    try {
      const body = { approve, reason };
      if (approve && struck.size) {
        body.itemDecisions = Object.fromEntries([...struck].map((id) => [id, false]));
      }
      detail = (await api.post(`/restock-requests/${detail.id}/decide`, body)).request;
      ui.toast(approve ? 'Approved.' : 'Rejected.');
      render();
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
  }

  async function convert() {
    try {
      const result = await api.post(`/restock-requests/${detail.id}/orders`, {});
      detail = result.request;
      const names = result.purchase_orders.map((o) => `${o.po_no} (${o.supplier_name})`).join(', ');
      ui.toast(`${result.purchase_orders.length} draft order(s): ${names}`);
      if (result.lines_without_supplier.length) {
        ui.toast(`Still without a supplier: ${result.lines_without_supplier.join(', ')}`, { kind: 'error' });
      }
      render();
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  function render() {
    if (view === 'build') return renderBuild();
    if (view === 'detail') return renderDetail();
    return renderRequests();
  }

  const head = (backLabel, backTo, title, actions = []) => h('header', { class: 'admin-head' }, [
    h('button', { class: 'row-action', icon: 'arrow-left', text: backLabel, onclick: backTo }),
    h('h1', { text: title }),
    ...actions,
  ]);

  function renderRequests() {
    if (!data) return ui.loading(root, { rows: 5 });
    const rows = data.requests;
    clear(root).append(h('section', { class: 'catalogue' }, [
      head('Buying', () => onBack(), 'Restock', [
        h('button', {
          class: 'primary', icon: 'clipboard-list', text: 'What to buy',
          onclick: loadSuggestions,
        }),
      ]),
      h('p', { class: 'muted', text: 'What the shelf says needs buying, asked for and approved. '
        + 'A request moves no stock and orders nothing on its own (PO-107) — approving it raises '
        + 'one draft order per supplier, which you still check and send.' }),
      rows.length === 0
        ? h('p', { class: 'muted', text: 'No restocking request yet. “What to buy” builds one from the shelf.' })
        : h('div', { class: 'table-scroll' }, [h('table', { class: 'catalogue-list' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: 'Request' }),
            h('th', { text: 'Raised' }),
            h('th', { text: 'By' }),
            h('th', { class: 'qty', text: 'Products' }),
            h('th', { text: 'Status' }),
          ])]),
          h('tbody', {}, rows.map((row) => h('tr', {
            tabindex: '0',
            onclick: () => open(row.id),
            onkeydown: (event) => { if (event.key === 'Enter') open(row.id); },
          }, [
            h('td', { class: 'sku' }, [
              row.rr_no,
              row.self_approved ? h('span', { class: 'tag', text: 'self-approved' }) : null,
            ]),
            h('td', { text: manila(row.requested_at) }),
            h('td', { text: row.requested_by_username || '—' }),
            h('td', { class: 'qty', text: String(row.line_count) }),
            h('td', { text: row.status_label }),
          ]))),
        ])]),
      pager(),
    ]));
  }

  function pager() {
    if (!data || data.total <= PAGE) return null;
    const from = data.offset + 1;
    const to = Math.min(data.offset + PAGE, data.total);
    return h('div', { class: 'pager' }, [
      h('button', {
        class: 'row-action', text: 'Newer', disabled: offset === 0,
        onclick: () => { offset = Math.max(0, offset - PAGE); loadRequests(); },
      }),
      h('span', { class: 'muted', text: `${from}–${to} of ${data.total}` }),
      h('button', {
        class: 'row-action', text: 'Older', disabled: to >= data.total,
        onclick: () => { offset += PAGE; loadRequests(); },
      }),
    ]);
  }

  function renderBuild() {
    const cover = suggestions.cover_multiplier;
    const asked = draft.filter((l) => Number(l.qty) > 0).length;

    clear(root).append(h('section', { class: 'catalogue' }, [
      head('Restock', () => loadRequests(), 'What to buy', [
        h('button', {
          class: 'primary', icon: 'check', disabled: saving || asked === 0,
          text: saving ? 'Saving…' : `Ask for ${asked} product${asked === 1 ? '' : 's'}`,
          onclick: save,
        }),
      ]),
      h('p', { class: 'muted', text: `Suggested: top up to ${cover}× the minimum, less what is on the `
        + 'shelf and less what is already on an order. Every figure can be typed over, and a row you '
        + 'do not want is removed.' }),
      h('div', { class: 'catalogue-controls' }, [
        adder().el,
        h('input', {
          type: 'text', class: 'catalogue-search', value: note, maxlength: '500',
          placeholder: 'A note for this request (optional)', 'aria-label': 'Note',
          oninput: (event) => { note = event.target.value; },
        }),
      ]),
      draft.length === 0
        ? h('p', { class: 'muted', text: 'Nothing is below its minimum and nothing is empty. '
          + 'Add a product above to ask for it anyway.' })
        : h('div', { class: 'table-scroll' }, [h('table', { class: 'catalogue-list' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: 'Product' }),
            h('th', { class: 'qty', text: 'On hand' }),
            h('th', { class: 'qty', text: 'Minimum' }),
            h('th', { class: 'qty', text: 'Coming' }),
            h('th', { class: 'qty', text: 'Ask for' }),
            h('th', { text: 'Supplier' }),
            h('th', { class: 'money', text: 'Unit cost' }),
            h('th', {}),
          ])]),
          h('tbody', {}, draft.map(buildRow)),
        ])]),
    ]));
  }

  function buildRow(line, index) {
    return h('tr', { class: line.source === 'OUT_OF_STOCK' ? 'is-low' : null }, [
      h('td', {}, [
        h('span', { class: 'sku', text: line.sku }), ' ', line.name,
        line.source === 'OUT_OF_STOCK' ? h('span', { class: 'tag', text: 'empty, no minimum set' }) : null,
        line.source === 'ADDED' ? h('span', { class: 'tag', text: 'added' }) : null,
      ]),
      h('td', { class: 'qty', text: `${qty(line.onHandMilli)} ${line.baseUnit || ''}`.trim() }),
      h('td', { class: 'qty', text: line.minStockMilli ? qty(line.minStockMilli) : '—' }),
      // The figure the whole screen is for: what is already on its way.
      h('td', { class: 'qty', text: line.onOrderMilli ? qty(line.onOrderMilli) : '—' }),
      h('td', { class: 'qty' }, [
        h('input', {
          type: 'number', min: '0', step: '0.001', class: 'line-qty', value: line.qty,
          'aria-label': `Quantity for ${line.name}`,
          oninput: (event) => { draft[index].qty = event.target.value; },
          onchange: () => render(),
        }),
        // Where the suggestion came from, so a buyer can disagree with the sum rather
        // than with a number.
        line.targetMilli
          ? h('small', { class: 'muted', text: `${qty(line.targetMilli)} wanted − ${qty(line.onHandMilli)} here`
            + `${line.onOrderMilli ? ` − ${qty(line.onOrderMilli)} coming` : ''}` })
          : h('small', { class: 'muted', text: 'no minimum set — say how many' }),
      ]),
      h('td', {}, [
        h('select', {
          'aria-label': `Supplier for ${line.name}`,
          onchange: (event) => { draft[index].supplierId = event.target.value; },
        }, [
          h('option', { value: '', text: '— none —', selected: !line.supplierId }),
          ...suppliers.map((s) => h('option', {
            value: s.id, text: s.name, selected: s.id === line.supplierId,
          })),
        ]),
      ]),
      h('td', { class: 'money' }, [
        h('input', {
          type: 'number', min: '0', step: '0.01', class: 'line-cost', value: line.cost,
          'aria-label': `Unit cost for ${line.name}`,
          oninput: (event) => { draft[index].cost = event.target.value; },
        }),
      ]),
      h('td', {}, [
        h('button', {
          class: 'row-action', icon: 'x', 'aria-label': `Take ${line.name} off the list`,
          onclick: () => { draft = draft.filter((_, i) => i !== index); render(); },
        }),
      ]),
    ]);
  }

  function renderDetail() {
    const r = detail;
    clear(root).append(h('section', { class: 'catalogue' }, [
      head('Restock', () => loadRequests(), r.rr_no, [
        r.can_decide ? h('button', { class: 'primary', icon: 'check', text: 'Approve', onclick: () => decide(true) }) : null,
        r.can_decide ? h('button', { class: 'row-action', icon: 'x', text: 'Reject…', onclick: () => decide(false) }) : null,
        r.can_convert ? h('button', { class: 'primary', icon: 'truck', text: 'Create orders', onclick: convert }) : null,
      ].filter(Boolean)),
      h('dl', { class: 'meta-fields' }, [
        field('Raised', `${manila(r.requested_at)} by ${r.requested_by_username || '—'}`),
        field('Status', r.status_label),
        r.decided_at ? field('Decided', `${manila(r.decided_at)} by ${r.decided_by_username || '—'}`) : null,
        r.decision_reason ? field('Reason', r.decision_reason) : null,
        r.note ? field('Note', r.note) : null,
      ].filter(Boolean)),
      r.self_approved
        ? h('p', { class: 'muted', text: 'Approved by the person who raised it: this store has one active '
          + 'user, so there was nobody else to ask. It is recorded that way rather than shown as a '
          + 'second person having agreed.' })
        : null,
      r.no_supplier_count
        ? h('p', { class: 'muted', text: `${r.no_supplier_count} product(s) name no supplier and cannot `
          + 'become an order until one is named. The rest can.' })
        : null,
      h('div', { class: 'table-scroll' }, [h('table', { class: 'catalogue-list' }, [
        h('thead', {}, [h('tr', {}, [
          r.can_decide ? h('th', { text: 'Buy' }) : null,
          h('th', { text: 'Product' }),
          h('th', { class: 'qty', text: 'Asked for' }),
          h('th', { class: 'qty', text: 'Was on hand' }),
          h('th', { class: 'qty', text: 'Was coming' }),
          h('th', { text: 'Supplier' }),
          h('th', { class: 'money', text: 'Unit cost' }),
          h('th', { text: 'Order' }),
        ].filter(Boolean))]),
        h('tbody', {}, r.items.map((line) => h('tr', {}, [
          // Per-line approval: an owner strikes two things off a list of eleven.
          r.can_decide ? h('td', {}, [h('input', {
            type: 'checkbox',
            checked: line.is_approved !== false,
            'aria-label': `Buy ${line.product_name}`,
            onchange: (event) => { line.is_approved = event.target.checked; },
          })]) : null,
          h('td', {}, [h('span', { class: 'sku', text: line.sku }), ' ', line.product_name]),
          h('td', { class: 'qty', text: `${qty(line.qty_milli)} ${line.base_unit_code}` }),
          // What the shelf looked like when it was asked for, not now: a request read in
          // three months is a question about a shelf that has moved since.
          h('td', { class: 'qty', text: qty(line.on_hand_milli) }),
          h('td', { class: 'qty', text: line.on_order_milli ? qty(line.on_order_milli) : '—' }),
          h('td', { text: line.supplier_name || '—' }),
          h('td', { class: 'money', text: line.unit_cost_centavos === null ? '—' : money(line.unit_cost_centavos) }),
          h('td', {}, [
            line.po_no && onOpenOrder
              ? h('button', { class: 'row-action', text: line.po_no, onclick: () => onOpenOrder(line.po_id) })
              : h('span', { class: 'muted', text: line.po_no || '—' }),
          ]),
        ].filter(Boolean)))),
      ])]),
      h('p', { class: 'muted', text: 'A restocking request orders nothing by itself (PO-107). '
        + 'Approving it raises one draft order per supplier; each is still yours to check and send.' }),
    ]));
  }

  const field = (label, value) => h('div', { class: 'meta-field' }, [
    h('dt', { text: label }), h('dd', { text: value }),
  ]);

  return { mount: loadRequests, unmount() {} };
}
