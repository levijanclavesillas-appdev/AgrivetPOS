// SCR-206 — the batches of one product (TASK-043).
//
// What is on the shelf, batch by batch, with the date printed on each box and what
// that date means today. The screen `TASK-029` shipped an API and an alert for and no
// way to reach: a store was told three batches had expired and may not be sold, and
// the only way to act on it was an HTTP client.
//
// **There is no quantity field anywhere on this screen, and that is the design.**
// INV-201 makes a batch's quantity the ledger's own sum — the same sum INV-101 derives
// per product, grouped one column finer — so a box that set it would be a box that
// makes the two figures disagree. Stock moves by a movement, here as everywhere else.
//
// **The one write is the write-off** (INV-205), and it is the only exit expired stock
// has: the store's policy permits no override, so nothing on this screen, and no route
// behind it, can release an expired batch for sale. The EXPIRY movement INV-103
// declared says *why* the stock went, which is what lets the owner total what expiry
// cost them; an adjustment would have moved the same quantity and said nothing.
//
// Expiry status is not a column anywhere — INV-203 derives it from the date and the
// store's own `near_expiry_days` at read time, so a batch turns NEAR_EXPIRY at midnight
// in Manila with nothing having run.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';

const STATUS_LABEL = {
  EXPIRED: 'Expired',
  NEAR_EXPIRY: 'Near expiry',
  NORMAL: 'Good',
};

export function createBatchList({ root, productId, session, onClose, onRecall = null }) {
  let product = null;
  let batches = [];
  let includeEmpty = false;

  // TX-407, from §10's matrix rather than from the payload: unlike TX-412's cost, the
  // batch list is the same list for everybody and only the *action* is restricted. The
  // route re-checks (SEC-6), so a stale copy here hides a button that would have been
  // refused anyway — never the reverse.
  const mayWriteOff = ['OWNER', 'MANAGER', 'INVENTORY'].includes(session.role);

  async function load() {
    ui.loading(root, { rows: 4 });
    try {
      const [detail, list] = await Promise.all([
        api.get(`/products/${productId}`),
        api.get(`/products/${productId}/batches?includeEmpty=${includeEmpty}`),
      ]);
      product = detail.product;
      batches = list.batches || [];
      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  async function refresh() {
    try {
      batches = (await api.get(`/products/${productId}/batches?includeEmpty=${includeEmpty}`)).batches || [];
      render();
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
  }

  function render() {
    clear(root).append(h('section', { class: 'catalogue batches' }, [
      h('header', { class: 'admin-head' }, [
        h('button', { class: 'report-back', text: '← Products', onclick: () => onClose() }),
        h('h1', { text: 'Batches' }),
      ]),

      h('dl', { class: 'admin-meta' }, [
        metaField('Product', `${product.sku} — ${product.name}`),
        metaField('On hand', product.qty_on_hand_display),
        // INV-201 said on the screen: these two figures are one figure, read two ways,
        // and somebody comparing them should be told that rather than left to wonder.
        metaField('In batches', held()),
      ]),

      h('p', { class: 'muted', text: 'A batch is stock as it arrived — a delivery, with the '
        + 'supplier’s own batch number and the date printed on the box. Quantities come from the '
        + 'stock ledger and cannot be typed here; a batch changes by a movement (INV-201).' }),

      h('label', { class: 'check' }, [
        h('input', {
          type: 'checkbox', checked: includeEmpty,
          onchange: (event) => { includeEmpty = event.target.checked; refresh(); },
        }),
        // Not "show all": an exhausted batch is the batch a recall notice still names,
        // and the reason to look at one is a reason worth stating.
        h('span', { text: 'Include batches that are used up — a recall still names them' }),
      ]),

      batches.length === 0 ? emptyState() : table(),
    ]));
  }

  const held = () => {
    const total = batches.reduce((sum, b) => sum + b.qty_milli, 0);
    const unit = batches.length > 0 ? batches[0].base_unit_code : product.base_unit.code;
    return includeEmpty || batches.length > 0
      ? `${(total / 1000).toLocaleString('en-PH', { maximumFractionDigits: 3 })} ${unit}`
      : '—';
  };

  function emptyState() {
    const host = h('div');
    ui.empty(host, {
      title: includeEmpty
        ? 'This product has no batches. Stock arrives as one on a delivery (INV-202).'
        : 'No batches with stock. Tick the box above to see ones that are used up.',
    });
    return host;
  }

  function table() {
    return h('table', { class: 'catalogue-list batch-list' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', { text: 'Batch' }), h('th', { text: 'Supplier' }), h('th', { text: 'Expires' }),
        h('th', { text: 'Status' }), h('th', { text: 'Held' }), h('th', { text: '' }),
      ])]),
      h('tbody', {}, batches.map((batch) => h('tr', {
        // The same visual language SCR-201's low-stock row already speaks: amber for
        // something to deal with, and the refusal's colour for stock that may not be
        // sold at all.
        class: batch.expiry_status === 'EXPIRED' ? 'is-expired'
          : (batch.expiry_status === 'NEAR_EXPIRY' ? 'is-low' : ''),
      }, [
        h('td', { class: 'sku', text: batch.batch_no }),
        h('td', { text: batch.supplier_name }),
        h('td', {}, [
          h('span', { text: batch.expiry_date }),
          // INV-203's arithmetic, in the words a shopkeeper uses. "In 12 days" is a
          // decision; "2026-09-22" is a date somebody has to work out.
          h('small', { class: 'muted', text: daysPhrase(batch.days_to_expiry) }),
        ]),
        h('td', {}, [h('span', {
          class: `tag${batch.expiry_status === 'NORMAL' ? '' : ' warn'}`,
          text: STATUS_LABEL[batch.expiry_status] || batch.expiry_status,
        })]),
        h('td', { class: 'qty', text: batch.qty_display }),
        h('td', {}, [
          // INV-206 in one step from the batch, which is where somebody holding a
          // manufacturer's notice arrives. A recall is offered for every batch, sold
          // out or not — an exhausted batch is exactly the one whose stock is all in
          // customers' sheds.
          onRecall
            ? h('button', {
              class: 'row-action', text: 'Recall',
              onclick: () => onRecall(batch.id),
            })
            : null,
          writeOff(batch),
        ]),
      ]))),
    ]);
  }

  /** INV-205's one exit, offered only where there is something to write off. */
  function writeOff(batch) {
    if (batch.expiry_status !== 'EXPIRED' || batch.qty_milli <= 0) return null;
    if (!mayWriteOff) return null;

    return h('button', {
      class: 'row-action', text: 'Write off',
      onclick: async () => {
        // ui.ask, not window.prompt: Electron does not implement prompt and throws on
        // the call. The reason is optional here because the batch and its date are
        // already the reason — INV-205 does not ask for one, and a required field
        // nobody has an answer for is how "expired" ends up on every row.
        const answers = await ui.ask({
          title: `Write off batch ${batch.batch_no}`,
          message: `${batch.qty_display} expired on ${batch.expiry_date}. Writing it off records `
            + 'an EXPIRY movement against this batch, so the store can total what expiry cost it. '
            + 'The stock is not deleted and the batch stays on the record (INV-102).',
          fields: [{
            name: 'reason', label: 'Note (optional)', required: false, maxLength: 200,
            hint: 'Where it went, if that matters — “swept the vaccine fridge”.',
          }],
          submitLabel: 'Write it off',
        });
        if (!answers) return;

        try {
          await api.post(`/batches/${batch.id}/expire`, { reason: answers.reason || null });
          ui.toast(`${batch.batch_no} written off — ${batch.qty_display} gone from stock`,
            { kind: 'success' });
          await refresh();
        } catch (err) {
          ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
        }
      },
    });
  }

  const daysPhrase = (days) => {
    if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`;
    if (days === 0) return 'today';
    return `in ${days} day${days === 1 ? '' : 's'}`;
  };

  const metaField = (label, value) => h('div', { class: 'meta-field' }, [
    h('dt', { text: label }), h('dd', { text: value }),
  ]);

  return {
    mount: load,
    unmount() {},
  };
}
