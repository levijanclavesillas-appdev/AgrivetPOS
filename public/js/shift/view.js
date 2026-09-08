// SCR-501, SCR-502, SCR-503 — the shift.
//
// One view with three states, because they are one thing a cashier does across a day:
// open the drawer, move cash through it, count it and close. Three files would be
// three places for the expected figure to be assembled differently, and the whole
// point of POS-509 is that there is one figure and it is derived.
//
// **The screen never makes the drawer balance.** POS-510 forbids a silent forced
// balance, and the temptation is strongest exactly here — a cashier ₱200 short at
// seven in the evening wants the number to go away. So the counted fields start empty
// and are never pre-filled from the expected figure: a pre-filled count is a count
// nobody made, and it would turn the one control that catches theft into a formality.
//
// The variance shown while typing is for the reader. Every term is recomputed by the
// server at the close (§4.1's principle applied to the till), so a client that
// disagreed would be corrected rather than believed.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money, manila } from '../shell/format.js';

/** POS-510: what the closer actually counts. CREDIT is not among them, and says why. */
const COUNTED = ['CASH', 'GCASH', 'QRPH'];

const pesos = (input) => {
  const value = Number.parseFloat(String(input).trim());
  return Number.isFinite(value) ? Math.round(value * 100) : null;
};

/**
 * `shiftId` opens somebody else's drawer (TX-419).
 *
 * There is no endpoint listing other people's open shifts, and this screen does not
 * invent one: the way a manager reaches another till is the POS-508 alert on the
 * dashboard, which carries the shift id of a drawer that has been open too long. That
 * is also the only situation in which closing somebody else's shift is a normal thing
 * to do rather than an oddity.
 */
export function createShift({ root, session, shiftId = null, onClosed }) {
  let state = null;          // { open, shift, expected }
  let mine = true;
  let mode = 'drawer';       // drawer | till | close
  let counted = {};          // what the closer has typed, by method
  let varianceReason = '';
  let approver = null;
  let refusal = null;

  async function load() {
    ui.loading(root, { rows: 5 });
    try {
      if (shiftId) {
        const other = await api.get(`/shifts/${shiftId}`);
        mine = other.shift.user_id === session.id;
        state = { open: other.shift.status === 'OPEN', shift: other.shift, expected: other.expected };
      } else {
        state = await api.get('/shifts/current');
        mine = true;
      }
      mode = state.open ? mode : 'drawer';
      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  function render() {
    if (!state.open) return renderOpen();
    if (mode === 'till') return renderTill();
    if (mode === 'close') return renderClose();
    return renderDrawer();
  }

  // ── SCR-501, before there is a shift ──────────────────────────────────────

  function renderOpen() {
    const float = h('input', {
      type: 'text', inputmode: 'decimal', required: true, placeholder: '0.00',
      'aria-label': 'Opening float in pesos',
    });
    // POS-503: counted and confirmed. The server refuses without the tick, and the
    // screen does not pretend the tick is decoration.
    const confirmed = h('input', { type: 'checkbox' });

    clear(root).append(h('section', { class: 'shift' }, [
      h('header', { class: 'admin-head' }, [h('h1', { text: 'Open your shift' })]),
      h('p', { class: 'muted', text: 'Count the drawer before you start. Everything the till '
        + 'expects at the end of the day is measured from this figure.' }),

      h('form', {
        class: 'editor-form',
        onsubmit: async (event) => {
          event.preventDefault();
          const amount = pesos(float.value);
          if (amount === null || amount < 0) {
            ui.toast('Enter the counted float.', { kind: 'error' });
            return;
          }
          try {
            const result = await api.post('/shifts/open', {
              openingFloatCentavos: amount, confirmed: confirmed.checked,
            });
            // POS-502: a second attempt resumes rather than opening a second shift,
            // and the difference is worth saying out loud.
            ui.toast(result.resumed
              ? 'Your shift was already open — carrying on with it.'
              : 'Shift open.', { kind: 'success' });
            await load();
          } catch (err) {
            ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
          }
        },
      }, [
        h('div', { class: 'editor-field' }, [
          h('label', { text: 'Opening float (₱)' }), float,
        ]),
        h('label', { class: 'check' }, [
          confirmed, h('span', { text: 'I have counted this and it is correct' }),
        ]),
        h('div', { class: 'editor-actions' }, [
          h('button', { type: 'submit', class: 'primary', text: 'Open shift' }),
        ]),
      ]),
    ]));
    queueMicrotask(() => float.focus());
  }

  // ── SCR-501, the open drawer ──────────────────────────────────────────────

  function renderDrawer() {
    const e = state.expected;

    clear(root).append(h('section', { class: 'shift' }, [
      h('header', { class: 'admin-head' }, [
        h('h1', { text: 'Shift' }),
        mine
          ? h('button', { class: 'row-action', text: 'Cash in / out', onclick: () => { mode = 'till'; render(); } })
          : null,
        h('button', { class: 'primary', text: 'Close shift', onclick: () => { mode = 'close'; render(); } }),
      ]),
      notMine(),
      h('p', { class: 'muted', text: `Open since ${manila(state.shift.opened_at)}.` }),

      // POS-509's terms, one per row. A single "expected" figure is a number to be
      // believed; the terms are arithmetic somebody can check against the drawer.
      h('table', { class: 'shift-expected' }, [
        h('tbody', {}, [
          row('Opening float', e.opening_float_centavos),
          row('Cash sales', e.cash_sales_centavos),
          row('Collections in cash', e.cash_collections_centavos),
          row('Cash in', e.cash_in_centavos),
          row('Cash out', -e.cash_out_centavos),
          row('Refunds', -e.cash_refunds_centavos),
          row('Change given', -e.change_given_centavos),
          h('tr', { class: 'total-row' }, [
            h('th', { text: 'Expected in the drawer' }),
            h('td', { class: 'money', text: money(e.expected_cash_centavos) }),
          ]),
        ]),
      ]),

      h('h2', { text: 'Taken today, by method' }),
      h('table', { class: 'shift-methods' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: 'Method' }), h('th', { text: 'Sales' }),
          h('th', { text: 'Collections' }), h('th', { text: 'Total' }),
        ])]),
        h('tbody', {}, Object.values(e.by_method).map((m) => h('tr', {}, [
          h('td', { text: m.method }),
          h('td', { class: 'money', text: money(m.sales_centavos) }),
          h('td', { class: 'money', text: money(m.collections_centavos) }),
          h('td', { class: 'money', text: money(m.expected_centavos) }),
        ]))),
      ]),
    ]));
  }

  const row = (label, centavos) => h('tr', {}, [
    h('th', { text: label }), h('td', { class: 'money', text: money(centavos) }),
  ]);

  // ── SCR-502, till cash ────────────────────────────────────────────────────

  function renderTill() {
    const amount = h('input', { type: 'text', inputmode: 'decimal', 'aria-label': 'Amount in pesos' });
    const notes = h('input', { type: 'text', placeholder: 'Optional' });
    const reason = h('select', { required: true }, [h('option', { value: '', text: 'Loading…' })]);
    const direction = h('select', {}, [
      h('option', { value: 'OUT', text: 'Cash out — money leaving the drawer' }),
      h('option', { value: 'IN', text: 'Cash in — money added to the drawer' }),
    ]);

    api.get('/shifts/meta/till-reasons').then(({ reasons }) => {
      clear(reason).append(
        h('option', { value: '', text: 'Choose a reason…' }),
        ...reasons.map((r) => h('option', { value: r, text: r }))
      );
    }).catch(() => { /* the select stays empty and the submit is refused */ });

    clear(root).append(h('section', { class: 'shift' }, [
      h('header', { class: 'admin-head' }, [
        h('button', { class: 'report-back', text: '← Shift', onclick: () => { mode = 'drawer'; render(); } }),
        h('h1', { text: 'Cash in and out' }),
      ]),
      h('p', { class: 'muted', text: `The drawer expects ${money(state.expected.expected_cash_centavos)} `
        + 'right now. Every movement changes that figure and is recorded against your shift.' }),

      h('form', {
        class: 'editor-form',
        onsubmit: async (event) => {
          event.preventDefault();
          const centavos = pesos(amount.value);
          if (centavos === null || centavos <= 0) {
            ui.toast('Enter an amount.', { kind: 'error' });
            return;
          }
          if (!reason.value) {
            ui.toast('Choose a reason.', { kind: 'error' });
            return;
          }
          try {
            await api.post(`/shifts/${state.shift.id}/till`, {
              direction: direction.value,
              amountCentavos: centavos,
              reason: reason.value,
              notes: notes.value.trim() || null,
            });
            ui.toast('Recorded.', { kind: 'success' });
            mode = 'drawer';
            await load();
          } catch (err) {
            // POS-505: a withdrawal that would take the drawer below zero is refused
            // with the figure, which is the thing the cashier needs to act on.
            ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
          }
        },
      }, [
        h('div', { class: 'editor-field' }, [h('label', { text: 'Direction' }), direction]),
        h('div', { class: 'editor-field' }, [h('label', { text: 'Amount (₱)' }), amount]),
        h('div', { class: 'editor-field' }, [
          h('label', { text: 'Reason' }), reason,
          // POS-504: from the configured list. Free text alone is how a drawer is
          // emptied with nobody able to say what for.
          h('small', { class: 'muted', text: 'The list is set by the owner in Settings (POS-504).' }),
        ]),
        h('div', { class: 'editor-field' }, [h('label', { text: 'Notes' }), notes]),
        h('div', { class: 'editor-actions' }, [
          h('button', { type: 'submit', class: 'primary', text: 'Record' }),
          h('button', { type: 'button', text: 'Cancel', onclick: () => { mode = 'drawer'; render(); } }),
        ]),
      ]),
    ]));
    queueMicrotask(() => amount.focus());
  }

  // ── SCR-503, the close ────────────────────────────────────────────────────

  function renderClose() {
    const e = state.expected;

    clear(root).append(h('section', { class: 'shift closing' }, [
      h('header', { class: 'admin-head' }, [
        h('button', { class: 'report-back', text: '← Shift', onclick: () => { mode = 'drawer'; render(); } }),
        h('h1', { text: 'Close the shift' }),
      ]),
      notMine(),
      h('p', { class: 'muted', text: 'Count each one and type what you actually have. '
        + 'Nothing is filled in for you — a figure the system typed is not a count.' }),

      h('table', { class: 'shift-close' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: 'Method' }), h('th', { text: 'Expected' }),
          h('th', { text: 'Counted' }), h('th', { text: 'Variance' }),
        ])]),
        h('tbody', {}, Object.values(e.by_method).map((m) => closeRow(m, e))),
      ]),

      h('div', { class: 'editor-field' }, [
        h('label', { text: 'Reason for the variance' }),
        h('input', {
          type: 'text', value: varianceReason, class: 'variance-reason',
          placeholder: 'Required if anything is beyond tolerance',
          oninput: (event) => { varianceReason = event.target.value; },
        }),
        // POS-510, in the words the rule uses.
        h('small', { class: 'muted', text: 'A drawer is never silently forced to balance. '
          + 'If a figure is out beyond the store’s tolerance, say what happened.' }),
      ]),

      h('div', { id: 'close-authorisation' }, [refusal ? authorisation() : null]),

      h('div', { class: 'editor-actions' }, [
        h('button', {
          class: 'primary', text: 'Count and close',
          disabled: Boolean(refusal) && !approver,
          onclick: submitClose,
        }),
        h('button', { text: 'Cancel', onclick: () => { mode = 'drawer'; render(); } }),
      ]),
      h('p', { class: 'muted', text: 'Closing takes a backup of the day and checks it can be '
        + 'read back (OPS-001).' }),
      h('p', { class: 'refusal-rule', text: 'POS-510' }),
    ]));
  }

  function closeRow(method, expected) {
    const expectedCentavos = method.method === 'CASH'
      ? expected.expected_cash_centavos
      : method.expected_centavos;

    if (!COUNTED.includes(method.method)) {
      // CREDIT takes no money, so there is nothing to count against it. Reported with
      // the rest so the day reads as a whole, and carrying no variance by construction
      // — asking for a count here would ask for one nobody can make, and would count
      // the same peso twice: once as credit given today, once as cash collected later.
      return h('tr', { class: 'not-counted' }, [
        h('td', { text: method.method }),
        h('td', { class: 'money', text: money(expectedCentavos) }),
        h('td', { class: 'muted', colspan: '2',
          text: 'Nothing to count — a credit sale takes no money. It is collected later.' }),
      ]);
    }

    const typed = counted[method.method];
    const value = typed === undefined ? null : pesos(typed);
    const variance = value === null ? null : value - expectedCentavos;

    return h('tr', {}, [
      h('td', { text: method.method }),
      h('td', { class: 'money', text: money(expectedCentavos) }),
      h('td', {}, [h('input', {
        type: 'text', inputmode: 'decimal',
        // Never `value: expectedCentavos`. That single line would be the whole of the
        // control this screen exists to provide.
        value: typed === undefined ? '' : typed,
        placeholder: 'What you counted',
        'aria-label': `Counted ${method.method}`,
        oninput: (event) => { counted[method.method] = event.target.value; renderVariance(); },
      })]),
      h('td', {
        class: `money variance ${variance === null ? '' : (variance < 0 ? 'down' : (variance > 0 ? 'up' : 'zero'))}`,
        text: variance === null ? '—' : money(variance),
      }),
    ]);
  }

  /** Repaint the variance column without rebuilding the inputs under the cursor. */
  function renderVariance() {
    const e = state.expected;
    const rows = root.querySelectorAll('.shift-close tbody tr');
    Object.values(e.by_method).forEach((m, i) => {
      if (!COUNTED.includes(m.method)) return;
      const cell = rows[i] && rows[i].querySelector('.variance');
      if (!cell) return;

      const expectedCentavos = m.method === 'CASH' ? e.expected_cash_centavos : m.expected_centavos;
      const value = counted[m.method] === undefined ? null : pesos(counted[m.method]);
      const variance = value === null ? null : value - expectedCentavos;

      cell.textContent = variance === null ? '—' : money(variance);
      cell.className = `money variance ${variance === null ? '' : (variance < 0 ? 'down' : (variance > 0 ? 'up' : 'zero'))}`;
    });
  }

  /**
   * TX-419 — a manager closing somebody else's count is told whose it is.
   *
   * Because it is not their count. They are signing off a drawer they did not touch,
   * and the screen should say so rather than looking identical to closing your own.
   */
  function notMine() {
    if (mine) return null;
    return h('div', { class: 'alert alert-warning', role: 'alert' }, [
      h('span', { class: 'alert-message', text: `This is ${state.shift.username || 'another user'}’s `
        + 'shift, not yours. You are signing off a drawer you did not count — check it with them '
        + 'before you do.' }),
      h('span', { class: 'alert-rule', text: 'TX-419' }),
    ]);
  }

  function authorisation() {
    return ui.authorisationPanel({
      message: refusal.message,
      ruleId: refusal.ruleId,
      requiresRole: refusal.requiresRole,
      onApprove: async ({ username, password }) => {
        const result = await api.post('/auth/login', { username, password });
        approver = result.user;
        ui.toast(`${approver.username} authorised this close`, { kind: 'success' });
        render();
      },
      onCancel: () => { refusal = null; approver = null; render(); },
    });
  }

  async function submitClose() {
    const cash = pesos(counted.CASH);
    if (cash === null) {
      ui.toast('Count the cash first.', { kind: 'error' });
      return;
    }

    const actualByMethod = {};
    for (const method of COUNTED) {
      if (method === 'CASH') continue;
      actualByMethod[method] = counted[method] === undefined ? 0 : (pesos(counted[method]) ?? 0);
    }

    try {
      const result = await api.post(`/shifts/${state.shift.id}/close`, {
        actualCashCentavos: cash,
        actualByMethod,
        varianceReason: varianceReason.trim() || null,
        approver: approver
          ? { id: approver.id, username: approver.username, role: approver.role }
          : null,
      });
      onClosed(result);
    } catch (err) {
      if (err.isRefusal && err.requiresRole) {
        // POS-508: a long shift closing with a variance needs an owner.
        refusal = err;
        render();
        queueMicrotask(() => root.querySelector('.authorisation input')?.focus());
        return;
      }
      // POS-510's missing reason lands here, naming the row and the amount.
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
      queueMicrotask(() => root.querySelector('.variance-reason')?.focus());
    }
  }

  return {
    mount: load,
    unmount() {},
    reload: load,
  };
}
