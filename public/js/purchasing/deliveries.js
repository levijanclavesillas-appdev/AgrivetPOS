// SCR-804 — the deliveries this store has recorded (FT-503, FT-504).
//
// `POST /goods-receipts` has been the one way stock arrives since TASK-019, and until now
// nothing showed what had arrived: a delivery was posted and vanished, and "what came in last
// Tuesday, and what did we pay" had no answer on any screen. The server has always been able
// to answer it (`GET /goods-receipts`), which is what this reads.
//
// Every figure is the server's, and a delivery is never edited here: PO-206 makes a posted
// delivery immutable, and the screen says so rather than offering a button it would then have
// to explain away.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money, manila } from '../shell/format.js';

const PAGE = 25;

export function createDeliveries({ root, onBack, onOpenOrder = null }) {
  let data = null;             // GET /goods-receipts
  let detail = null;           // GET /goods-receipts/:id
  let query = '';
  let flaggedOnly = false;
  let offset = 0;
  let timer = null;

  async function load() {
    try {
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (query.trim()) params.set('q', query.trim());
      if (flaggedOnly) params.set('flaggedOnly', 'true');
      data = await api.get(`/goods-receipts?${params}`);
      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  async function open(id) {
    try {
      detail = (await api.get(`/goods-receipts/${id}`)).goods_receipt;
      render();
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
  }

  const search = h('input', {
    type: 'search', class: 'catalogue-search', value: query,
    placeholder: 'Delivery no., their DR, invoice or supplier', 'aria-label': 'Find a delivery',
    oninput: (event) => {
      query = event.target.value;
      offset = 0;
      clearTimeout(timer);
      timer = setTimeout(load, 200);
    },
  });

  function render() {
    if (detail) return renderDetail();
    if (!data) return ui.loading(root, { rows: 5 });

    const rows = data.goods_receipts;
    clear(root).append(h('section', { class: 'catalogue' }, [
      h('header', { class: 'admin-head' }, [
        h('button', { class: 'row-action', icon: 'arrow-left', text: 'Buying', onclick: () => onBack() }),
        h('h1', { text: 'Deliveries' }),
      ]),
      h('p', { class: 'muted', text: 'Everything that has arrived, newest first. A posted delivery is never '
        + 'edited (PO-206): a mistake is corrected with an adjustment, and the delivery stays as it was recorded.' }),
      h('div', { class: 'catalogue-controls' }, [
        search,
        h('label', { class: 'check' }, [
          h('input', {
            type: 'checkbox', checked: flaggedOnly,
            onchange: (event) => { flaggedOnly = event.target.checked; offset = 0; load(); },
          }),
          h('span', { text: 'Only those over the order or over its cost' }),
        ]),
      ]),
      rows.length === 0
        ? h('p', { class: 'muted', text: query || flaggedOnly ? 'Nothing matches.' : 'No delivery has been recorded yet.' })
        : h('div', { class: 'table-scroll' }, [h('table', { class: 'catalogue-list' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: 'Delivery' }),
            h('th', { text: 'Received' }),
            h('th', { text: 'Supplier' }),
            h('th', { text: 'Their DR' }),
            h('th', { text: 'Order' }),
            h('th', { class: 'qty', text: 'Lines' }),
            h('th', { class: 'money', text: 'Value' }),
          ])]),
          h('tbody', {}, rows.map((row) => h('tr', {
            tabindex: '0',
            onclick: () => open(row.id),
            onkeydown: (event) => { if (event.key === 'Enter') open(row.id); },
          }, [
            h('td', { class: 'sku' }, [
              row.gr_no,
              // PO-204 and PO-207: what a buyer looks for on a delivery they half remember.
              row.has_over_receipt ? h('span', { class: 'tag', text: 'over the order' }) : null,
              row.has_cost_variance ? h('span', { class: 'tag', text: 'cost changed' }) : null,
            ]),
            h('td', { text: manila(row.received_at) }),
            h('td', { text: row.supplier.name }),
            h('td', { text: row.supplier_dr_no || '—' }),
            h('td', { text: row.po_no || 'No order' }),
            h('td', { class: 'qty', text: String(row.line_count ?? '') }),
            h('td', { class: 'money', text: money(row.total_centavos) }),
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
        onclick: () => { offset = Math.max(0, offset - PAGE); load(); },
      }),
      h('span', { class: 'muted', text: `${from}–${to} of ${data.total}` }),
      h('button', {
        class: 'row-action', text: 'Older', disabled: to >= data.total,
        onclick: () => { offset += PAGE; load(); },
      }),
    ]);
  }

  function renderDetail() {
    const gr = detail;
    clear(root).append(h('section', { class: 'catalogue' }, [
      h('header', { class: 'admin-head' }, [
        h('button', { class: 'row-action', icon: 'arrow-left', text: 'Deliveries', onclick: () => { detail = null; render(); } }),
        h('h1', { text: gr.gr_no }),
      ]),
      h('dl', { class: 'meta-fields' }, [
        field('Received', `${manila(gr.received_at)} by ${gr.created_by || '—'}`),
        field('Supplier', gr.supplier.name),
        field('Their DR', gr.supplier_dr_no || '—'),
        field('Invoice', gr.invoice_no || '—'),
        field('Order', gr.po_no || 'No order — a counter purchase'),
        field('Value', money(gr.total_centavos)),
      ]),
      gr.po_id && onOpenOrder
        ? h('button', { class: 'row-action', icon: 'truck', text: `Open ${gr.po_no}`, onclick: () => onOpenOrder(gr.po_id) })
        : null,
      // PO-204 / PO-207: what was authorised, and by whom.
      gr.approved_by
        ? h('p', { class: 'muted', text: `Authorised by ${gr.approved_by}${gr.approval_reason ? ` — ${gr.approval_reason}` : ''}` })
        : null,
      gr.notes ? h('p', { class: 'muted', text: gr.notes }) : null,
      h('div', { class: 'table-scroll' }, [h('table', { class: 'catalogue-list' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: 'Product' }),
          h('th', { class: 'qty', text: 'Ordered' }),
          h('th', { class: 'qty', text: 'Arrived' }),
          h('th', { class: 'qty', text: 'Damaged' }),
          h('th', { class: 'qty', text: 'Into stock' }),
          h('th', { class: 'money', text: 'Unit cost' }),
          h('th', { class: 'money', text: 'Value' }),
        ])]),
        h('tbody', {}, (gr.lines || []).map((line) => h('tr', {}, [
          h('td', {}, [h('span', { class: 'sku', text: line.sku }), ' ', line.product_name]),
          h('td', { class: 'qty', text: line.po_item_id ? line.ordered_display : '—' }),
          h('td', { class: 'qty', text: line.received_display }),
          h('td', { class: 'qty', text: line.damaged_qty_milli ? line.damaged_display : '—' }),
          h('td', { class: 'qty', text: line.sound_display }),
          h('td', { class: 'money', text: money(line.unit_cost_centavos) }),
          h('td', { class: 'money', text: money(line.line_total_centavos ?? (line.unit_cost_centavos * (line.sound_qty_milli / 1000))) }),
        ]))),
      ])]),
      h('p', { class: 'muted', text: 'A delivery cannot be changed once it is posted (PO-206). '
        + 'Correct stock with an adjustment, and a cost with the product\'s cost.' }),
    ]));
  }

  const field = (label, value) => h('div', { class: 'meta-field' }, [
    h('dt', { text: label }), h('dd', { text: value }),
  ]);

  return { mount: load, unmount() { clearTimeout(timer); } };
}
