// SCR-304 — the receipt.
//
// A preview of the internal transaction record, print and reprint. TAX-006's sentence
// is on it in every tax mode and TAX-007's block only in VAT mode, but neither is
// decided here: the server renders the document (TASK-014) and this shows what it
// rendered. A second template in the renderer is how the paper and the screen end up
// saying different things.
//
// **The void lives here (TASK-021, FT-308)**, because this is the screen a cashier is
// looking at in the moment POS-401 exists for: the customer is still standing there
// and the mis-scan has just printed. Every condition on it is the server's answer,
// fetched from `GET /sales/:id/voidable` — whether the shift is still open (POS-402)
// and whether this cashier already carries the authority (POS-403). A screen that
// decided either for itself would offer the button after a close and explain the
// refusal afterwards, by which time the cashier has already told the customer it can
// be undone.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money } from '../shell/format.js';

export function createReceipt({ root, sale, printed, onNewSale }) {
  const paper = h('pre', { class: 'receipt-paper', 'aria-label': 'Receipt preview' });

  let voidable = null;       // GET /sales/:id/voidable
  let voiding = false;       // the reason panel is open
  let reason = '';
  let approver = null;
  let refusal = null;
  let voided = null;

  async function load() {
    ui.loading(paper.parentElement ?? root, { rows: 6 });
    try {
      const { document: doc } = await api.get(`/sales/${sale.sale.id}/receipt`);
      paper.textContent = doc.text;
    } catch (err) {
      ui.error(root, { message: err.message, retry: load });
    }
  }

  async function reprint() {
    try {
      const result = await api.post(`/sales/${sale.sale.id}/reprint`, {});
      paper.textContent = result.document.text;
      // POS-208: stamped and audited. The toast says so, because a reprint the cashier
      // did not realise was a reprint is the thing the rule exists to prevent.
      ui.toast(result.printed.delivered
        ? 'Reprinted and marked REPRINT.'
        : `Marked REPRINT. ${result.printed.error}`, { kind: result.printed.delivered ? 'success' : 'error' });
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
  }

  /**
   * POS-402 and POS-403, asked before the button is drawn.
   *
   * Failing quietly is deliberate: a receipt that will not render because the void
   * endpoint is unreachable is a worse outcome than a receipt with no void button, and
   * the sale is already committed either way.
   */
  async function loadVoidable() {
    try {
      voidable = await api.get(`/sales/${sale.sale.id}/voidable`);
    } catch {
      voidable = null;
    }
    renderActions();
  }

  function actionsBlock() {
    if (voided) {
      return h('div', { class: 'receipt-voided' }, [
        h('p', { class: 'close-verdict beyond', role: 'alert',
          text: `${voided.sale.sale_no} is voided.` }),
        // POS-404, said on the screen rather than left to be noticed: the number is
        // not reissued, and the cashier should not go looking for it to come back.
        h('p', { class: 'muted', text: 'It stays in the ledger and keeps its receipt '
          + 'number — the sequence has no gap (POS-404). It is out of the day\u2019s net sales.' }),
        h('p', { class: 'muted', text: voided.reversal.drawer.cash_out_centavos > 0
          ? `Hand back ${money(voided.reversal.drawer.cash_out_centavos)}. The drawer is open.`
          : 'Nothing was paid in cash, so there is nothing to hand back.' }),
        h('div', { class: 'receipt-actions' }, [
          h('button', { class: 'primary', text: 'New sale  Enter', onclick: onNewSale }),
        ]),
      ]);
    }

    if (voiding) return voidPanel();

    return h('div', { class: 'receipt-actions' }, [
      h('button', { class: 'primary', text: 'New sale  Enter', onclick: onNewSale }),
      h('button', { text: 'Reprint', onclick: reprint }),
      voidButton(),
    ]);
  }

  /**
   * Offered, or explained — never absent without a reason.
   *
   * POS-402's refusal is the one worth showing rather than hiding: "that shift has been
   * closed, so the correction is a return" is an answer the cashier can act on, and a
   * missing button is not.
   */
  function voidButton() {
    if (!voidable) return null;
    if (voidable.can_void) {
      return h('button', {
        class: 'danger', text: 'Void this sale',
        onclick: () => { voiding = true; renderActions(); },
      });
    }
    return h('p', { class: 'muted void-refusal',
      text: `${voidable.refusal.message} (${voidable.refusal.rule_id})` });
  }

  /**
   * The reason, and — for a cashier — the manager beside them.
   *
   * POS-401 requires the reason and POS-403 requires the authority, so both are asked
   * for in one place rather than as two consecutive refusals. `self_authorised` comes
   * from the server, so a manager sees one field and a cashier sees the panel.
   */
  function voidPanel() {
    const reasonField = h('input', {
      type: 'text', value: reason, class: 'void-reason',
      placeholder: 'What went wrong — a mis-scan, the wrong customer',
      'aria-label': 'Reason for voiding this sale',
      // Re-render the whole panel on every keystroke and the cursor jumps to the end
      // of the field, so only the one thing that changes is touched. The submit's
      // `disabled` is computed once when the panel is built, and without this it
      // stays as it was built — dead, however much the cashier types.
      oninput: (event) => { reason = event.target.value; refreshVoidSubmit(); },
    });

    return h('div', { class: 'void-panel' }, [
      h('h2', { text: `Void ${sale.sale.sale_no}?` }),
      // The two facts a cashier needs before pressing it, both of them POS-404's.
      h('p', { class: 'rule-note warn', role: 'alert', text:
        'A void says the sale never happened. It keeps its receipt number and stays on '
        + 'the trail; it comes out of the day\u2019s takings (POS-404).' }),
      h('label', { text: 'Reason' }, [reasonField]),
      !voidable.self_authorised
        ? h('p', { class: 'muted', text: 'A cashier may never void a sale unaided. A '
          + 'manager or owner signs in below (POS-403).' })
        : null,
      !voidable.self_authorised && !approver ? authorisation() : null,
      approver ? h('p', { class: 'muted', text: `Authorised by ${approver.username}.` }) : null,
      h('div', { class: 'editor-actions' }, [
        h('button', {
          class: 'danger', text: 'Void the sale',
          disabled: !voidReady(),
          onclick: submitVoid,
        }),
        h('button', {
          text: 'Keep the sale',
          onclick: () => { voiding = false; approver = null; refusal = null; renderActions(); },
        }),
      ]),
    ]);
  }

  /**
   * AUD-603 — the approver authenticates as themselves.
   *
   * `/auth/login` issues no session header, so the cashier stays signed in and the
   * trail records two distinct actors rather than one asserted twice.
   */
  function authorisation() {
    return ui.authorisationPanel({
      message: refusal
        ? refusal.message
        : 'A manager or owner must authorise this void.',
      ruleId: 'POS-403',
      requiresRole: voidable.requires_role || 'MANAGER or OWNER',
      onApprove: async ({ username, password }) => {
        const auth = await api.post('/auth/login', { username, password });
        approver = auth.user;
        ui.toast(`${approver.username} authorised this void`, { kind: 'success' });
        renderActions();
      },
      onCancel: () => { voiding = false; approver = null; refusal = null; renderActions(); },
    });
  }

  async function submitVoid() {
    try {
      voided = await api.post(`/sales/${sale.sale.id}/void`, {
        reason: reason.trim(),
        approver: approver ? { username: approver.username } : null,
      });
      voiding = false;
      renderActions();
      ui.toast(`${voided.sale.sale_no} voided.`, { kind: 'success' });
    } catch (err) {
      // POS-402's closed shift and POS-403's missing authority each come back naming
      // their rule. The second opens the panel; the first is final, and says so.
      if (err.isRefusal && err.ruleId === 'POS-403') {
        refusal = err;
        approver = null;
        renderActions();
        queueMicrotask(() => root.querySelector('.authorisation input')?.focus());
        return;
      }
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
      if (err.isRefusal) { voiding = false; loadVoidable(); }
    }
  }

  /** Whether the void may be submitted yet — POS-401's reason and POS-403's authority. */
  const voidReady = () => reason.trim().length >= 4
    && Boolean(voidable) && (voidable.self_authorised || Boolean(approver));

  function refreshVoidSubmit() {
    const button = root.querySelector('.void-panel .editor-actions button');
    if (button) button.disabled = !voidReady();
  }

  function renderActions() {
    const host = root.querySelector('#receipt-actions');
    if (host) clear(host).append(actionsBlock());
  }

  function mount() {
    clear(root).append(h('div', { class: 'receipt' }, [
      h('h1', { text: sale.sale.sale_no }),
      h('div', { class: 'receipt-figures' }, [
        h('div', { class: 'summary-line total' }, [
          h('span', { text: 'Total' }), h('span', { class: 'money', text: money(sale.sale.total_centavos) }),
        ]),
        sale.sale.change_centavos > 0
          ? h('div', { class: 'summary-line change' }, [
            h('span', { text: 'Change' }), h('span', { class: 'money', text: money(sale.sale.change_centavos) }),
          ])
          : null,
      ]),
      h('div', { class: 'receipt-sheet' }, [paper]),
      h('div', { id: 'receipt-actions' }, [actionsBlock()]),
    ]));

    // INT-1: printing already happened, asynchronously, and did not gate the sale. A
    // failure is a toast and a queued document, never an unwound sale.
    if (printed && !printed.delivered) {
      ui.toast(`The receipt did not print (${printed.error}). It is queued — press Reprint when the printer is ready.`, { kind: 'error' });
    }

    load();
    loadVoidable();
  }

  function onKeyDown(event) {
    // Enter starts the next sale — but not while the void panel is open, where it
    // would submit a destructive action the cashier was still typing a reason into.
    if (event.key === 'Enter' && !voiding) { event.preventDefault(); onNewSale(); }
  }
  document.addEventListener('keydown', onKeyDown);

  return { mount, unmount: () => document.removeEventListener('keydown', onKeyDown) };
}
