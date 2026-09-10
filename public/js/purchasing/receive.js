// SCR-803 — the delivery. FT-503 against an order, FT-504 without one.
//
// The screen's whole job is to make PO-202 visible while somebody is counting sacks
// off a van: **arrived, less damaged, is what becomes stock.** It computes the sound
// quantity on every keystroke and labels it as the figure that will be posted, because
// a shopkeeper is entitled to see that arithmetic at the tailgate rather than discover
// it in the ledger a week later.
//
// The unit cost field asks for what was **actually charged**, not what was ordered
// (PO-203). It is pre-filled from the order as a convenience and is the one field on
// this screen most worth changing — the average cost it sets is what every gross-profit
// report will read for ever.
//
// PO-204 and PO-205 arrive as a refusal from the server carrying the rule and the
// amount, and open §4's inline authorisation panel. They are not pre-judged here: the
// tolerance is a setting and the ordered cost is the server's figure, so a screen that
// decided for itself would be a screen that disagreed with the refusal it then got.

import * as api from '../shell/api.js';
import { createProductPicker } from '../shell/picker.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money, quantity } from '../shell/format.js';

export function createGoodsReceipt({ root, poId = null, onBack, onPosted }) {
  let order = null;
  let suppliers = [];
  let supplierId = '';
  let supplierDrNo = '';
  let invoiceNo = '';
  let notes = '';
  let lines = [];
  let refusal = null;
  let approver = null;
  let approvalReason = '';
  let posting = false;

  const direct = () => !poId;

  async function load() {
    ui.loading(root, { rows: 6 });
    try {
      if (direct()) {
        suppliers = (await api.get('/suppliers?limit=200')).suppliers || [];
        lines = [blankLine()];
      } else {
        order = (await api.get(`/purchase-orders/${poId}`)).purchase_order;
        supplierId = order.supplier.id;
        lines = order.lines
          // A line already fully received is left off rather than shown at zero: the
          // van is delivering what is outstanding, and a row of zeroes is a row
          // somebody has to read past on every delivery.
          .filter((line) => !line.is_complete)
          .map((line) => ({
            poItemId: line.id,
            productId: line.product_id,
            label: `${line.sku} — ${line.product_name}`,
            unitCode: line.base_unit_code,
            orderedMilli: line.qty_milli,
            outstandingMilli: line.outstanding_qty_milli,
            // Pre-filled with what is outstanding and what was agreed. Both are the
            // usual answer and both are meant to be corrected when they are wrong.
            received: (line.outstanding_qty_milli / 1000).toString(),
            damaged: '',
            cost: (line.unit_cost_centavos / 100).toFixed(2),
            orderedCostCentavos: line.unit_cost_centavos,
            damageNote: '',
          }));
      }
      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  const blankLine = () => ({
    poItemId: null, productId: '', label: '', unitCode: '',
    orderedMilli: 0, outstandingMilli: 0,
    received: '', damaged: '', cost: '', orderedCostCentavos: null, damageNote: '',
  });

  const milli = (value) => {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? Math.round(n * 1000) : null;
  };

  /** PO-202 — arrived, less damaged. The figure that becomes stock. */
  const soundMilli = (line) => {
    const received = milli(line.received);
    if (received === null) return null;
    const damaged = line.damaged.trim() === '' ? 0 : milli(line.damaged);
    if (damaged === null || damaged < 0 || damaged > received) return null;
    return received - damaged;
  };

  const lineTotal = (line) => {
    const sound = soundMilli(line);
    const cost = Number.parseFloat(line.cost);
    if (sound === null || !Number.isFinite(cost)) return null;
    return Math.round(sound * Math.round(cost * 100) / 1000);
  };

  const total = () => lines.reduce((sum, line) => sum + (lineTotal(line) || 0), 0);

  function render() {
    clear(root).append(h('section', { class: 'purchasing goods-receipt' }, [
      header(),
      direct() ? supplierPicker() : orderMeta(),
      h('form', {
        class: 'editor-form',
        onsubmit: (event) => { event.preventDefault(); post(); },
      }, [
        h('div', { class: 'editor-row' }, [
          h('div', { class: 'editor-field' }, [
            h('label', { text: 'Delivery receipt no.' }),
            h('input', {
              type: 'text', value: supplierDrNo, placeholder: 'The number on their DR',
              oninput: (event) => { supplierDrNo = event.target.value; },
            }),
          ]),
          h('div', { class: 'editor-field' }, [
            h('label', { text: 'Invoice no.' }),
            h('input', {
              type: 'text', value: invoiceNo,
              oninput: (event) => { invoiceNo = event.target.value; },
            }),
          ]),
        ]),

        h('div', { class: 'table-scroll' }, [
          h('table', { class: 'catalogue-list receive-table' }, [
            h('thead', {}, [h('tr', {}, [
              h('th', { text: 'Product' }),
              direct() ? null : h('th', { class: 'qty', text: 'Outstanding' }),
              h('th', { class: 'qty', text: 'Arrived' }),
              h('th', { class: 'qty', text: 'Damaged' }),
              h('th', { class: 'qty', text: 'Into stock' }),
              h('th', { class: 'money', text: 'Unit cost' }),
              h('th', { class: 'money', text: 'Value' }),
              h('th', { text: '' }),
            ])]),
            h('tbody', { id: 'gr-lines' }, lines.map((line, index) => lineRow(line, index))),
          ]),
        ]),

        // PO-202, said once and plainly, under the column that computes it.
        h('p', { class: 'muted rule-note', text:
          'Only the sound quantity — what arrived, less what arrived damaged — becomes stock. '
          + 'The damaged quantity is recorded against the supplier and posts nothing (PO-202).' }),

        h('div', { class: 'editor-actions' }, [
          direct()
            ? h('button', { type: 'button', text: 'Add a line', onclick: () => { lines.push(blankLine()); render(); } })
            : null,
          h('strong', { class: 'gr-total', text: `Into stock: ${money(total())}` }),
        ]),

        h('div', { class: 'editor-field' }, [
          h('label', { text: 'Notes' }),
          h('input', {
            type: 'text', value: notes,
            oninput: (event) => { notes = event.target.value; },
          }),
        ]),

        h('div', { id: 'authorisation' }, [refusal ? authorisation() : null]),

        h('div', { class: 'editor-actions' }, [
          h('button', {
            type: 'submit', class: 'primary', text: 'Post delivery',
            // PO-204 / PO-205: nothing posts until a manager or owner has
            // authenticated in the panel the refusal opened.
            disabled: posting || (Boolean(refusal) && !approver),
          }),
          h('button', { type: 'button', text: 'Cancel', onclick: () => onBack() }),
        ]),
      ]),
    ]));
  }

  function header() {
    return h('header', { class: 'admin-head' }, [
      h('button', { class: 'report-back', text: '← Back', onclick: () => onBack() }),
      h('h1', { text: direct() ? 'Receive a delivery' : `Receive against ${order.reference_label}` }),
    ]);
  }

  function orderMeta() {
    return h('dl', { class: 'admin-meta' }, [
      metaField('Supplier', order.supplier.name),
      metaField('Order', order.reference_label),
      metaField('Expected', order.expected_at || '—'),
      metaField('Status', order.status_label),
    ]);
  }

  /** PO-207: a delivery with no order still needs a supplier. */
  function supplierPicker() {
    return h('div', { class: 'editor-field' }, [
      h('label', { text: 'Supplier' }),
      h('select', {
        required: true,
        onchange: (event) => { supplierId = event.target.value; },
      }, [
        h('option', { value: '', text: 'Choose a supplier…' }),
        ...suppliers.map((s) => h('option', { value: s.id, text: s.name, selected: s.id === supplierId })),
      ]),
      h('small', { class: 'muted', text:
        'A delivery is always from somebody. Every cost figure this records is read for ever '
        + '(PO-207).' }),
    ]);
  }

  function lineRow(line, index) {
    const sound = soundMilli(line);
    return h('tr', {}, [
      h('td', {}, direct()
        ? [
          // SCR-802's picker, the same one, for the same reason: a delivery keyed
          // against a line bound to nothing is a delivery refused at post, after the
          // clerk has keyed every quantity on the van's docket.
          productPicker(line, index).el,
          // The same confirmation SCR-802 shows: the buyer needs to see that the line
          // is bound to a product before they post a delivery against it.
          h('small', { class: 'resolved', text: line.productId ? line.label : '' }),
        ]
        : [h('span', { text: line.label })]),

      direct() ? null : h('td', { class: 'qty', text: quantity(line.outstandingMilli, line.unitCode) }),

      h('td', { class: 'qty' }, [
        h('input', {
          type: 'text', inputmode: 'decimal', class: 'qty', value: line.received,
          'aria-label': `Quantity that arrived on line ${index + 1}`,
          oninput: (event) => { line.received = event.target.value; refreshLine(index); },
        }),
        h('span', { class: 'unit', text: line.unitCode || '' }),
      ]),

      h('td', { class: 'qty' }, [
        h('input', {
          type: 'text', inputmode: 'decimal', class: 'qty', value: line.damaged,
          placeholder: '0', 'aria-label': `Quantity damaged on line ${index + 1}`,
          oninput: (event) => { line.damaged = event.target.value; refreshLine(index); },
        }),
      ]),

      h('td', { class: 'qty sound', text: sound === null ? '—' : quantity(sound, line.unitCode) }),

      h('td', { class: 'money' }, [
        h('input', {
          type: 'text', inputmode: 'decimal', class: 'money', value: line.cost,
          'aria-label': `Unit cost actually charged on line ${index + 1}`,
          oninput: (event) => { line.cost = event.target.value; refreshLine(index); },
        }),
        // PO-203: the ordered figure beside the actual one, so a change is visible
        // while it is being typed rather than only when the server refuses it.
        line.orderedCostCentavos !== null
          ? h('small', { class: 'muted', text: `ordered ${money(line.orderedCostCentavos)}` })
          : null,
      ]),

      h('td', { class: 'money line-total', text: money(lineTotal(line)) }),

      h('td', {}, [
        h('input', {
          type: 'text', class: 'damage-note', value: line.damageNote,
          placeholder: 'What was wrong with them', 'aria-label': `Damage note on line ${index + 1}`,
          oninput: (event) => { line.damageNote = event.target.value; },
        }),
      ]),
    ]);
  }

  /** Recompute the derived cells without rebuilding the row under the cursor. */
  function refreshLine(index) {
    const row = root.querySelectorAll('#gr-lines tr')[index];
    if (!row) return;
    const line = lines[index];
    const sound = soundMilli(line);
    const soundCell = row.querySelector('.sound');
    if (soundCell) {
      soundCell.textContent = sound === null ? '—' : quantity(sound, line.unitCode);
      soundCell.classList.toggle('warn', sound !== null && sound < (milli(line.received) || 0));
    }
    const totalCell = row.querySelector('.line-total');
    if (totalCell) totalCell.textContent = money(lineTotal(line));
    const resolved = row.querySelector('.resolved');
    if (resolved) resolved.textContent = line.productId ? line.label : '';
    const totals = root.querySelector('.gr-total');
    if (totals) totals.textContent = `Into stock: ${money(total())}`;
  }

  /** One line's picker (SCR-802's, shared). Bound on a choice, never on a guess. */
  function productPicker(line, index) {
    return createProductPicker({
      value: line.label,
      ariaLabel: `Product on line ${index + 1}`,
      // INV-105: a withdrawn product still arrives on the last delivery of it.
      includeInactive: true,
      onPick: (product) => {
        line.productId = product.id;
        line.unitCode = product.base_unit.code;
        line.label = `${product.sku} — ${product.name}`;
        refreshLine(index);
      },
      onClear: () => {
        if (!line.productId) return;
        line.productId = '';
        line.label = '';
        line.unitCode = '';
        refreshLine(index);
      },
    });
  }

  /**
   * AUD-603 — the approver authenticates as themselves.
   *
   * `/auth/login` is unauthenticated and issues no session header, so the person doing
   * the receiving stays signed in and the row records two distinct actors rather than
   * one asserted twice. The server resolves the username against the users table; the
   * role this screen holds is only used to say who it has.
   */
  function authorisation() {
    return ui.authorisationPanel({
      message: refusal.message,
      ruleId: refusal.ruleId,
      requiresRole: refusal.requiresRole,
      onApprove: async ({ username, password }) => {
        const result = await api.post('/auth/login', { username, password });
        approver = result.user;
        approvalReason = refusal.message;
        ui.toast(`${approver.username} authorised this delivery`, { kind: 'success' });
        render();
      },
      onCancel: () => { refusal = null; approver = null; render(); },
    });
  }

  function usable() {
    if (!supplierId && direct()) { ui.toast('Choose a supplier.', { kind: 'error' }); return false; }
    if (lines.length === 0) { ui.toast('There is nothing left to receive on this order.', { kind: 'error' }); return false; }

    const bad = lines.findIndex((line) => !line.productId
      || !(milli(line.received) > 0)
      || soundMilli(line) === null
      || !Number.isFinite(Number.parseFloat(line.cost)));
    if (bad !== -1) {
      ui.toast(
        `Line ${bad + 1} needs a product, a quantity that arrived, and the unit cost charged. `
        + 'The damaged quantity cannot exceed what arrived.',
        { kind: 'error' }
      );
      return false;
    }
    return true;
  }

  async function post() {
    if (posting || !usable()) return;
    posting = true;
    try {
      const result = await api.post('/goods-receipts', {
        poId: poId || null,
        supplierId: direct() ? supplierId : null,
        supplierDrNo: supplierDrNo.trim() || null,
        invoiceNo: invoiceNo.trim() || null,
        notes: notes.trim() || null,
        approver: approver ? { username: approver.username } : null,
        approvalReason: approvalReason || null,
        lines: lines.map((line) => ({
          poItemId: line.poItemId,
          productId: line.productId,
          receivedQtyMilli: milli(line.received),
          damagedQtyMilli: line.damaged.trim() === '' ? 0 : milli(line.damaged),
          unitCostCentavos: Math.round(Number.parseFloat(line.cost) * 100),
          damageNote: line.damageNote.trim() || null,
        })),
      });
      const gr = result.goods_receipt;
      ui.toast(`${gr.gr_no} posted — ${money(gr.total_centavos)} into stock`, { kind: 'success' });
      onPosted(gr);
    } catch (err) {
      // PO-204 and PO-205 come back as a refusal naming the rule and the role. The
      // panel opens here rather than being guessed at beforehand: the tolerance is a
      // setting and the ordered cost is the server's figure.
      if (err.isRefusal && (err.ruleId === 'PO-204' || err.ruleId === 'PO-205') && err.requiresRole) {
        refusal = err;
        render();
        queueMicrotask(() => root.querySelector('.authorisation input')?.focus());
        return;
      }
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    } finally {
      posting = false;
    }
  }

  const metaField = (label, value) => h('div', { class: 'meta-field' }, [
    h('dt', { text: label }), h('dd', { text: value }),
  ]);

  return { mount: load, unmount() {} };
}
