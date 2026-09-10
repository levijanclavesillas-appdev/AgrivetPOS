// SCR-802 — one purchase order: raising it, editing it, sending it, cancelling it.
//
// **Nothing on this screen moves stock.** PO-103 is the rule, and the screen states it
// where a reader would otherwise expect a "receive" shortcut to appear, because a
// buyer who thinks raising an order has stocked the shelf is a buyer who will not
// notice the delivery never came.
//
// PO-104's two halves are the other thing this screen has to make legible. A DRAFT is
// edited in place — nobody outside the store has seen it. A sent order is **amended**
// into a new revision, and the save button says so before it is pressed: the supplier
// is holding a printed copy of something, and "rev 2" is the word that tells both
// sides which one they are looking at.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money, quantity, manila } from '../shell/format.js';

export function createPurchaseOrder({ root, poId, onBack, onReceive }) {
  let order = null;
  let suppliers = [];
  let supplierId = '';
  let expectedAt = '';
  let referenceNo = '';
  let notes = '';
  let lines = [];
  let saving = false;

  const isNew = () => !poId;

  async function load() {
    ui.loading(root, { rows: 6 });
    try {
      suppliers = (await api.get('/suppliers?limit=200')).suppliers || [];

      if (isNew()) {
        lines = [blankLine()];
        render();
        return;
      }

      order = (await api.get(`/purchase-orders/${poId}`)).purchase_order;
      supplierId = order.supplier.id;
      expectedAt = order.expected_at || '';
      referenceNo = order.reference_no || '';
      notes = order.notes || '';
      lines = order.lines.map((line) => ({
        productId: line.product_id,
        label: `${line.sku} — ${line.product_name}`,
        unitCode: line.base_unit_code,
        qty: (line.qty_milli / 1000).toString(),
        cost: (line.unit_cost_centavos / 100).toFixed(2),
      }));
      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  const blankLine = () => ({ productId: '', label: '', unitCode: '', qty: '', cost: '' });

  const editable = () => isNew() || order.can_edit || order.can_amend;
  const amending = () => Boolean(order && order.can_amend);

  const lineTotal = (line) => {
    const qty = Number.parseFloat(line.qty);
    const cost = Number.parseFloat(line.cost);
    if (!Number.isFinite(qty) || !Number.isFinite(cost)) return null;
    return Math.round(Math.round(qty * 1000) * Math.round(cost * 100) / 1000);
  };

  const total = () => lines.reduce((sum, line) => sum + (lineTotal(line) || 0), 0);

  function render() {
    clear(root).append(h('section', { class: 'purchasing purchase-order' }, [
      header(),
      order ? meta() : null,
      // PO-103, said on the screen rather than only in the schema.
      h('p', { class: 'muted rule-note', text:
        'A purchase order moves no stock. Nothing here changes what is on the shelf — '
        + 'only a delivery does that (PO-103).' }),
      editable() ? form() : readOnlyLines(),
      order ? receipts() : null,
    ]));
  }

  function header() {
    return h('header', { class: 'admin-head' }, [
      h('button', { class: 'report-back', text: '← Orders', onclick: () => onBack() }),
      h('h1', { text: isNew() ? 'New purchase order' : order.reference_label }),
      order
        ? h('span', { class: `status status-${order.status.toLowerCase()}`, text: order.status_label })
        : null,
      order && order.can_submit
        ? h('button', { class: 'primary', text: 'Send to supplier', onclick: submit })
        : null,
      order && order.can_receive
        ? h('button', { class: 'primary', text: 'Receive delivery', onclick: () => onReceive(order.id) })
        : null,
      order && order.can_cancel
        ? h('button', { class: 'row-action danger', text: 'Cancel order', onclick: cancel })
        : null,
    ]);
  }

  function meta() {
    return h('dl', { class: 'admin-meta' }, [
      metaField('Supplier', order.supplier.name),
      metaField('Terms', order.supplier.terms_days === 0 ? 'Cash on delivery' : `${order.supplier.terms_days} days`),
      metaField('Sent', order.ordered_at ? manila(order.ordered_at) : 'Not yet sent'),
      metaField('Expected', order.expected_at || '—'),
      metaField('Revision', String(order.revision)),
      metaField('Total', money(order.total_centavos)),
      order.cancel_reason ? metaField('Cancelled because', order.cancel_reason) : null,
    ]);
  }

  function form() {
    return h('form', {
      class: 'editor-form',
      onsubmit: (event) => { event.preventDefault(); save(); },
    }, [
      h('div', { class: 'editor-field' }, [
        h('label', { text: 'Supplier' }),
        h('select', {
          required: true,
          // PO-101: the supplier is fixed once the order exists. Changing it would
          // make the number the mill was given belong to a different account.
          disabled: Boolean(order),
          onchange: (event) => { supplierId = event.target.value; },
        }, [
          h('option', { value: '', text: 'Choose a supplier…' }),
          ...suppliers.map((s) => h('option', {
            value: s.id, text: s.name, selected: s.id === supplierId,
          })),
        ]),
      ]),

      h('div', { class: 'editor-row' }, [
        h('div', { class: 'editor-field' }, [
          h('label', { text: 'Expected' }),
          h('input', {
            type: 'date', value: expectedAt,
            oninput: (event) => { expectedAt = event.target.value; },
          }),
        ]),
        h('div', { class: 'editor-field' }, [
          h('label', { text: "Supplier's reference" }),
          h('input', {
            type: 'text', value: referenceNo, placeholder: 'Their own order number',
            oninput: (event) => { referenceNo = event.target.value; },
          }),
        ]),
      ]),

      h('h2', { text: 'Lines' }),
      h('div', { class: 'table-scroll' }, [
        h('table', { class: 'catalogue-list' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: 'Product' }),
            h('th', { class: 'qty', text: 'Quantity' }),
            h('th', { class: 'money', text: 'Unit cost' }),
            h('th', { class: 'money', text: 'Line total' }),
            h('th', { text: '' }),
          ])]),
          h('tbody', { id: 'po-lines' }, lines.map((line, index) => lineRow(line, index))),
        ]),
      ]),
      h('div', { class: 'editor-actions' }, [
        h('button', { type: 'button', text: 'Add a line', onclick: () => { lines.push(blankLine()); render(); } }),
        h('strong', { class: 'po-total', text: `Total ${money(total())}` }),
      ]),

      h('div', { class: 'editor-field' }, [
        h('label', { text: 'Notes' }),
        h('input', {
          type: 'text', value: notes, placeholder: 'The store’s own note — the supplier never sees it',
          oninput: (event) => { notes = event.target.value; },
        }),
      ]),

      // PO-104, before the button rather than after it.
      amending()
        ? h('p', { class: 'rule-note warn', text:
          `${order.po_no} has already been sent. Saving raises revision ${order.revision + 1} `
          + 'rather than overwriting it, so the supplier can be told which version they are '
          + 'holding (PO-104).' })
        : null,

      h('div', { class: 'editor-actions' }, [
        h('button', {
          type: 'submit', class: 'primary', disabled: saving,
          text: amending() ? `Save as revision ${order.revision + 1}` : 'Save',
        }),
        h('button', { type: 'button', text: 'Cancel', onclick: () => onBack() }),
      ]),
    ]);
  }

  function lineRow(line, index) {
    return h('tr', {}, [
      h('td', {}, [
        h('input', {
          type: 'search', class: 'line-product', value: line.label,
          placeholder: 'Name, SKU or barcode', 'aria-label': `Product on line ${index + 1}`,
          list: `po-products-${index}`,
          oninput: (event) => findProduct(index, event.target),
        }),
        h('datalist', { id: `po-products-${index}` }, (line.matches || []).map((p) => h('option', {
          value: `${p.sku} — ${p.name}`,
        }))),
        // What the typed text resolved to. Without it the field says "Hog Grower" and
        // the buyer has no way to tell whether the line is bound to a product at all —
        // which they find out when the save is refused, one screen too late.
        h('small', { class: 'resolved', text: line.productId ? line.label : '' }),
      ]),
      h('td', { class: 'qty' }, [
        h('input', {
          type: 'text', inputmode: 'decimal', value: line.qty, class: 'qty',
          'aria-label': `Quantity on line ${index + 1}`,
          oninput: (event) => { line.qty = event.target.value; refreshTotals(); },
        }),
        h('span', { class: 'unit', text: line.unitCode || '' }),
      ]),
      h('td', { class: 'money' }, [
        h('input', {
          type: 'text', inputmode: 'decimal', value: line.cost, class: 'money',
          'aria-label': `Unit cost on line ${index + 1}`,
          oninput: (event) => { line.cost = event.target.value; refreshTotals(); },
        }),
      ]),
      h('td', { class: 'money line-total', text: money(lineTotal(line)) }),
      h('td', {}, [
        h('button', {
          type: 'button', class: 'row-action', text: 'Remove', 'aria-label': `Remove line ${index + 1}`,
          onclick: () => { lines.splice(index, 1); if (lines.length === 0) lines.push(blankLine()); render(); },
        }),
      ]),
    ]);
  }

  /** Resolve what was typed to a product, without rebuilding the row under the cursor. */
  async function findProduct(index, input) {
    const line = lines[index];
    line.label = input.value;
    const term = input.value.trim();
    if (term.length < 2) return;

    try {
      const data = await api.get(`/products?q=${encodeURIComponent(term)}&limit=8`);
      line.matches = data.products;
      const exact = data.products.find((p) => `${p.sku} — ${p.name}` === term)
        || (data.products.length === 1 ? data.products[0] : null);
      if (exact) {
        line.productId = exact.id;
        line.unitCode = exact.base_unit.code;
        line.label = `${exact.sku} — ${exact.name}`;
      } else {
        line.productId = '';
      }
      const list = root.querySelector(`#po-products-${index}`);
      if (list) {
        clear(list).append(...data.products.map((p) => h('option', { value: `${p.sku} — ${p.name}` })));
      }
      refreshTotals();
    } catch {
      // A failed lookup leaves the row as typed; the save below refuses an unresolved
      // line with a sentence rather than the search failing silently under the cursor.
    }
  }

  function refreshTotals() {
    const rows = root.querySelectorAll('#po-lines tr');
    lines.forEach((line, index) => {
      const cell = rows[index]?.querySelector('.line-total');
      if (cell) cell.textContent = money(lineTotal(line));
      const unit = rows[index]?.querySelector('.unit');
      if (unit) unit.textContent = line.unitCode || '';
      const resolved = rows[index]?.querySelector('.resolved');
      if (resolved) resolved.textContent = line.productId ? line.label : '';
    });
    const totalCell = root.querySelector('.po-total');
    if (totalCell) totalCell.textContent = `Total ${money(total())}`;
  }

  function readOnlyLines() {
    return h('div', { class: 'table-scroll' }, [
      h('table', { class: 'catalogue-list' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: 'Product' }),
          h('th', { class: 'qty', text: 'Ordered' }),
          h('th', { class: 'qty', text: 'Received' }),
          h('th', { class: 'qty', text: 'Outstanding' }),
          h('th', { class: 'money', text: 'Unit cost' }),
          h('th', { class: 'money', text: 'Line total' }),
        ])]),
        h('tbody', {}, order.lines.map((line) => h('tr', {
          class: line.is_complete ? 'is-complete' : null,
        }, [
          h('td', { text: `${line.sku} — ${line.product_name}` }),
          h('td', { class: 'qty', text: line.qty_display }),
          h('td', { class: 'qty', text: line.received_display }),
          h('td', { class: 'qty', text: line.outstanding_display }),
          h('td', { class: 'money', text: money(line.unit_cost_centavos) }),
          h('td', { class: 'money', text: money(line.line_total_centavos) }),
        ]))),
      ]),
    ]);
  }

  function receipts() {
    if (!order.receipts || order.receipts.length === 0) return null;
    return h('div', { class: 'po-receipts' }, [
      h('h2', { text: 'Deliveries against this order' }),
      h('ul', { class: 'plain-list' }, order.receipts.map((gr) => h('li', {}, [
        h('strong', { text: gr.gr_no }),
        h('span', { text: ` ${manila(gr.received_at)} — ${money(gr.total_centavos)}` }),
        gr.has_over_receipt ? h('span', { class: 'tag warn', text: 'over-receipt' }) : null,
        gr.has_cost_variance ? h('span', { class: 'tag warn', text: 'cost variance' }) : null,
      ]))),
    ]);
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  function payload() {
    return {
      supplierId,
      expectedAt: expectedAt || null,
      referenceNo: referenceNo.trim() || null,
      notes: notes.trim() || null,
      lines: lines.map((line) => ({
        productId: line.productId,
        qtyMilli: Math.round(Number.parseFloat(line.qty) * 1000),
        unitCostCentavos: Math.round(Number.parseFloat(line.cost) * 100),
      })),
    };
  }

  function usable() {
    if (!supplierId) { ui.toast('Choose a supplier.', { kind: 'error' }); return false; }
    const bad = lines.findIndex((line) => !line.productId
      || !Number.isFinite(Number.parseFloat(line.qty)) || Number.parseFloat(line.qty) <= 0
      || !Number.isFinite(Number.parseFloat(line.cost)));
    if (bad !== -1) {
      ui.toast(`Line ${bad + 1} needs a product, a quantity and a unit cost.`, { kind: 'error' });
      return false;
    }
    return true;
  }

  async function save() {
    if (saving || !usable()) return;
    saving = true;
    try {
      const result = isNew()
        ? await api.post('/purchase-orders', payload())
        : await api.put(`/purchase-orders/${poId}`, payload());
      const saved = result.purchase_order;
      ui.toast(
        saved.revision > 1 ? `Saved as ${saved.reference_label}` : `${saved.po_no} saved`,
        { kind: 'success' }
      );
      poId = saved.id;
      await load();
    } catch (err) {
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    } finally {
      saving = false;
    }
  }

  async function submit() {
    try {
      await api.post(`/purchase-orders/${poId}/submit`, {});
      ui.toast('Sent to the supplier', { kind: 'success' });
      await load();
    } catch (err) {
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    }
  }

  /** PO-102 wants a reason, and PO-105 refuses this outright once anything arrived. */
  async function cancel() {
    // ui.ask, not window.prompt — Electron throws on prompt, so this button did
    // nothing at all in the packaged app and an order could not be cancelled.
    const answers = await ui.ask({
      title: 'Cancel this order',
      message: 'The reason goes on the audit trail beside the cancellation (PO-102).',
      fields: [{ name: 'reason', label: 'Why is this order being cancelled?', maxLength: 200 }],
      submitLabel: 'Cancel order',
    });
    if (!answers || !answers.reason) return;
    try {
      await api.post(`/purchase-orders/${poId}/cancel`, { reason: answers.reason });
      ui.toast('Order cancelled', { kind: 'success' });
      await load();
    } catch (err) {
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    }
  }

  const metaField = (label, value) => h('div', { class: 'meta-field' }, [
    h('dt', { text: label }), h('dd', { text: value }),
  ]);

  return { mount: load, unmount() {} };
}
