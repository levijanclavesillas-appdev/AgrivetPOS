// SCR-203 — inventory adjustment.
//
// Product, current on-hand, the counted figure, the variance the screen computes for
// the reader, a reason from the configured list (INV-108), and notes.
//
// The variance is shown but **not sent**. The server takes the quantity and derives
// everything else; a client that posted its own variance would be a client that could
// post a different one from the figures on screen. What the arithmetic here is for is
// the person doing the counting — "you counted 12 fewer than the system thinks" is the
// sentence that catches a miscount before it becomes a movement.
//
// Above the configured value the inline authorisation panel appears and the submit
// button stays disabled until an owner has authenticated in it (INV-108, AUD-603). It
// is the same panel the POS screen uses, from ui.js — a second one would drift, and
// the day they disagreed the counter and the stockroom would each be sure they were
// right.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { quantity } from '../shell/format.js';

export function createAdjustment({ root, productId, onClose }) {
  let product = null;
  let onHand = null;
  let reasons = [];
  let approver = null;
  let counted = '';
  let reason = '';
  let notes = '';
  let refusal = null;

  async function load() {
    ui.loading(root, { rows: 4 });
    try {
      const [detail, stock, meta] = await Promise.all([
        api.get(`/products/${productId}`),
        api.get(`/inventory/${productId}`),
        api.get('/inventory/meta/adjustment-reasons'),
      ]);
      product = detail.product;
      // GET /inventory/:id wraps its payload; reading it flat gave a NaN variance and
      // an empty on-hand line, which the browser smoke caught and no unit test would.
      onHand = stock.on_hand;
      reasons = meta.reasons || [];
      counted = quantity(onHand.qty_on_hand_milli);
      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  const countedMilli = () => {
    const value = Number.parseFloat(counted);
    return Number.isFinite(value) ? Math.round(value * 1000) : null;
  };

  /** What the movement will be: the difference, signed. */
  const varianceMilli = () => {
    const target = countedMilli();
    return target === null ? null : target - onHand.qty_on_hand_milli;
  };

  function render() {
    const variance = varianceMilli();
    const unit = product.base_unit.code;

    clear(root).append(h('section', { class: 'catalogue adjustment' }, [
      h('header', { class: 'admin-head' }, [
        h('button', { class: 'report-back', text: '← Products', onclick: () => onClose() }),
        h('h1', { text: 'Adjust stock' }),
      ]),

      h('dl', { class: 'admin-meta' }, [
        metaField('Product', `${product.sku} — ${product.name}`),
        metaField('On hand now', onHand.qty_on_hand_display),
        metaField('Base unit', `${product.base_unit.name} (${unit})`),
      ]),

      h('form', {
        class: 'editor-form',
        onsubmit: (event) => { event.preventDefault(); submit(); },
      }, [
        h('div', { class: 'editor-field' }, [
          h('label', { text: `Counted quantity (${unit})` }),
          h('input', {
            type: 'text', inputmode: 'decimal', value: counted, autofocus: true,
            'aria-label': `Counted quantity in ${unit}`,
            oninput: (event) => { counted = event.target.value; renderVariance(); },
          }),
          h('small', { class: 'muted', text: 'What is actually on the shelf. The system works out '
            + 'the difference.' }),
        ]),

        h('div', { class: 'variance-block', id: 'variance' }, [varianceLine(variance, unit)]),

        h('div', { class: 'editor-field' }, [
          // INV-108: from the list, never free text alone. A select rather than a text
          // box, because an adjustment justified by whatever somebody typed is the
          // audit hole the rule closes.
          h('label', { text: 'Reason' }),
          h('select', {
            required: true,
            onchange: (event) => { reason = event.target.value; },
          }, [
            h('option', { value: '', text: 'Choose a reason…' }),
            ...reasons.map((r) => h('option', { value: r, text: r, selected: r === reason })),
          ]),
          h('small', { class: 'muted', text: 'The list is set by the owner in Settings (INV-108).' }),
        ]),

        h('div', { class: 'editor-field' }, [
          h('label', { text: 'Notes' }),
          h('input', {
            type: 'text', value: notes, placeholder: 'Optional — anything the reason does not say',
            oninput: (event) => { notes = event.target.value; },
          }),
        ]),

        h('div', { id: 'authorisation' }, [refusal ? authorisation() : null]),

        h('div', { class: 'editor-actions' }, [
          h('button', {
            type: 'submit', class: 'primary', text: 'Post adjustment',
            // INV-108: nothing is posted above the threshold until an owner has
            // authenticated in the panel.
            disabled: Boolean(refusal) && !approver,
          }),
          h('button', { type: 'button', text: 'Cancel', onclick: () => onClose() }),
        ]),
      ]),
    ]));
  }

  /** Re-rendered on every keystroke, without rebuilding the form under the cursor. */
  function renderVariance() {
    const host = root.querySelector('#variance');
    if (host) clear(host).append(varianceLine(varianceMilli(), product.base_unit.code));
  }

  function varianceLine(variance, unit) {
    if (variance === null) return h('p', { class: 'muted', text: 'Enter what you counted.' });
    if (variance === 0) {
      return h('p', { class: 'variance zero', text: 'The count matches. Nothing to post.' });
    }

    // The peso value of the variance is deliberately not shown: it is measured at
    // average cost, which is owner-only (TX-412), and the server is the only side that
    // knows whether this crosses the authorisation threshold.
    return h('p', { class: `variance ${variance < 0 ? 'down' : 'up'}` }, [
      h('strong', { text: `${variance > 0 ? '+' : ''}${quantity(variance)} ${unit}` }),
      h('span', { text: variance < 0
        ? ' — there is less on the shelf than the system thinks.'
        : ' — there is more on the shelf than the system thinks.' }),
    ]);
  }

  /**
   * AUD-603 — the approver authenticates as themselves.
   *
   * Signing in here does not replace the session: `/auth/login` is unauthenticated and
   * issues no session header, so the person doing the counting stays signed in and the
   * row records two distinct actors rather than one asserted twice.
   */
  function authorisation() {
    return ui.authorisationPanel({
      message: refusal.message,
      ruleId: refusal.ruleId,
      requiresRole: refusal.requiresRole,
      onApprove: async ({ username, password }) => {
        const result = await api.post('/auth/login', { username, password });
        approver = result.user;
        ui.toast(`${approver.username} authorised this`, { kind: 'success' });
        render();
      },
      onCancel: () => { refusal = null; approver = null; render(); },
    });
  }

  async function submit() {
    const variance = varianceMilli();
    if (variance === null || variance === 0) {
      ui.toast('Enter a counted quantity that differs from what is on hand.', { kind: 'error' });
      return;
    }
    if (!reason) {
      ui.toast('Choose a reason.', { kind: 'error' });
      return;
    }

    try {
      await api.post('/inventory/adjustments', {
        productId,
        // The signed movement, not the counted figure: the server posts what it is
        // given and derives the new on-hand from the ledger (INV-101).
        qtyMilli: variance,
        reason,
        notes: notes.trim() || null,
        approver: approver ? { id: approver.id, username: approver.username, role: approver.role } : null,
      });
      ui.toast('Adjustment posted', { kind: 'success' });
      onClose(productId);
    } catch (err) {
      if (err.isRefusal && err.ruleId === 'INV-108' && err.requiresRole) {
        // Above the threshold. The panel appears here rather than being guessed at
        // beforehand, because the threshold is measured at average cost and only the
        // server knows both figures.
        refusal = err;
        render();
        queueMicrotask(() => root.querySelector('.authorisation input')?.focus());
        return;
      }
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    }
  }

  const metaField = (label, value) => h('div', { class: 'meta-field' }, [
    h('dt', { text: label }), h('dd', { text: value }),
  ]);

  return { mount: load, unmount() {} };
}
