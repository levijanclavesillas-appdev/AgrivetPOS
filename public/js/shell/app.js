// The shell: sign-in, the rail, the lock screen, and which screen is showing.
//
// 04_UX_SPEC.md §2 fixes the landing screen per role and says unreachable rail items
// are **hidden** — and that the route is refused server-side regardless (SEC-6). The
// hiding is a courtesy; the refusal is the control, and the renderer never assumes
// otherwise.

import * as api from './api.js';
import * as ui from './ui.js';
import { h, clear } from './ui.js';
import { createPos } from '../pos/view.js';
import { createPayment } from '../payment/view.js';
import { createReceipt } from '../receipt/view.js';

/** §2's role → landing screen. */
const LANDING = { CASHIER: 'pos', INVENTORY: 'products', MANAGER: 'dashboard', OWNER: 'dashboard' };

/** The rail, with the TX-* each item needs. Hidden without it; refused regardless. */
const RAIL = [
  { id: 'pos', label: 'POS', tx: 'TX-401', screen: 'SCR-301' },
  { id: 'customers', label: 'Customers', tx: 'TX-413', screen: 'SCR-401' },
  { id: 'products', label: 'Products', tx: 'TX-422', screen: 'SCR-201' },
  { id: 'shift', label: 'Shift', tx: 'TX-418', screen: 'SCR-501' },
  { id: 'reports', label: 'Reports', tx: 'TX-421', screen: 'SCR-601' },
  { id: 'admin', label: 'Admin', tx: 'TX-423', screen: 'SCR-701' },
];

/**
 * §10's matrix, as much of it as the rail needs.
 *
 * A copy of the server's grants, and knowingly so: it decides what to *show*. Every
 * route re-checks server-side (SEC-6), so a stale copy here hides a button that would
 * have been refused anyway — never the reverse.
 */
const GRANTS = {
  'TX-401': ['OWNER', 'MANAGER', 'CASHIER'],
  'TX-413': ['OWNER', 'MANAGER', 'CASHIER', 'INVENTORY'],
  'TX-418': ['OWNER', 'MANAGER', 'CASHIER'],
  'TX-421': ['OWNER', 'MANAGER', 'CASHIER'],
  'TX-422': ['OWNER', 'MANAGER', 'CASHIER', 'INVENTORY'],
  'TX-423': ['OWNER'],
};

const may = (role, tx) => (GRANTS[tx] || []).includes(role);

export function createApp({ root }) {
  let session = null;
  let current = null;
  const main = h('main', { class: 'screen' });
  const railHost = h('nav', { class: 'rail', 'aria-label': 'Sections' });

  // ── Sign in (SCR-101) ─────────────────────────────────────────────────────

  function signIn({ prefillUsername = null, note = null } = {}) {
    const username = h('input', { type: 'text', autocomplete: 'username', value: prefillUsername || '', required: true });
    const password = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const problem = h('p', { class: 'error', role: 'alert', hidden: true });

    clear(root).append(h('div', { class: 'signin' }, [
      h('h1', { text: 'Chachi Agrivet POS' }),
      note ? h('p', { class: 'signin-note', text: note }) : null,
      h('form', {
        onsubmit: async (event) => {
          event.preventDefault();
          problem.hidden = true;
          try {
            const result = await api.post('/auth/login', {
              username: username.value.trim(), password: password.value,
            });
            api.setToken(result.token);
            session = result.user;
            start();
          } catch (err) {
            // SEC-3: the same sentence for a wrong username and a wrong password, and
            // the remaining minutes when the account is locked.
            problem.textContent = err.message;
            problem.hidden = false;
            password.value = '';
            password.focus();
          }
        },
      }, [
        h('label', { text: 'Username' }, [username]),
        h('label', { text: 'Password' }, [password]),
        problem,
        h('button', { type: 'submit', class: 'primary', text: 'Sign in' }),
      ]),
    ]));
    queueMicrotask(() => (prefillUsername ? password : username).focus());
  }

  /**
   * SCR-102 — the PIN keypad, rendered **over** a preserved cart.
   *
   * POS-105: the cart is on the server, so the lock screen does not need to hold it —
   * but "Different user" must not silently discard it either, which is why that path
   * says what it is doing rather than just returning to sign-in.
   */
  function lock({ username }) {
    const pin = h('input', {
      type: 'password', inputmode: 'numeric', pattern: '\\d{6}', maxlength: '6',
      class: 'pin-input', autocomplete: 'off', 'aria-label': 'Six-digit PIN',
    });
    const problem = h('p', { class: 'error', role: 'alert', hidden: true });

    const overlay = h('div', { class: 'lock-overlay' }, [
      h('div', { class: 'lock' }, [
        h('h1', { text: 'Screen locked' }),
        h('p', { text: `${username} — enter your PIN to continue.` }),
        h('p', { class: 'lock-note', text: 'Your cart is kept.' }),
        h('form', {
          onsubmit: async (event) => {
            event.preventDefault();
            try {
              const result = await api.post('/auth/pin-unlock', { username, pin: pin.value });
              api.setToken(result.token);
              session = result.user;
              overlay.remove();
            } catch (err) {
              problem.textContent = err.message;
              problem.hidden = false;
              pin.value = '';
              pin.focus();
            }
          },
        }, [h('label', { text: 'PIN' }, [pin]), problem, h('button', { type: 'submit', class: 'primary', text: 'Unlock' })]),
        h('button', {
          class: 'lock-different',
          text: 'Different user',
          onclick: () => {
            // Not a silent discard: the cart stays on the server against this user and
            // this shift, and they are told so.
            overlay.remove();
            signIn({ note: 'The previous cashier’s cart is kept on their shift.' });
          },
        }),
      ]),
    ]);

    document.body.append(overlay);
    queueMicrotask(() => pin.focus());
  }

  // ── Screens ───────────────────────────────────────────────────────────────

  async function show(id) {
    if (current?.unmount) current.unmount();
    clear(main);
    renderRail(id);

    if (id === 'pos') return showPos();

    // The rest of the rail is TASK-016's and the admin screens'. Saying so beats a
    // dead button, and 04_UX_SPEC.md §5's empty state is exactly this shape.
    ui.empty(main, { title: `${RAIL.find((item) => item.id === id)?.label} is not built yet.` });
    return null;
  }

  async function showPos() {
    // POS-501 / FR_5.1: the POS refuses with an "open your shift" prompt rather than
    // failing at payment.
    let shift = null;
    try {
      shift = await api.get('/shifts/current');
    } catch (err) {
      ui.error(main, { message: err.message, retry: () => show('pos') });
      return null;
    }

    if (!shift.open) {
      ui.empty(main, {
        title: 'Open your shift before selling. Count the drawer and enter the opening float.',
        action: 'Open shift',
        onAction: () => openShift(),
      });
      return null;
    }

    current = createPos({
      root: main,
      session,
      onPay: ({ cart, priced, approver }) => showPayment({ cart, priced, approver }),
    });
    current.mount();
    return current;
  }

  function openShift() {
    const float = h('input', { type: 'text', inputmode: 'decimal', required: true, 'aria-label': 'Opening float in pesos' });
    const confirmed = h('input', { type: 'checkbox', required: true });

    clear(main).append(h('form', {
      class: 'open-shift',
      onsubmit: async (event) => {
        event.preventDefault();
        try {
          // POS-503: counted and confirmed. The server refuses without the tick.
          await api.post('/shifts/open', {
            openingFloatCentavos: Math.round(Number.parseFloat(float.value) * 100),
            confirmed: confirmed.checked,
          });
          show('pos');
        } catch (err) {
          ui.toast(err.message, { kind: 'error' });
        }
      },
    }, [
      h('h1', { text: 'Open shift' }),
      h('label', { text: 'Opening float (₱)' }, [float]),
      h('label', { class: 'check' }, [confirmed, h('span', { text: 'I have counted this and it is correct' })]),
      h('button', { type: 'submit', class: 'primary', text: 'Open shift' }),
    ]));
    queueMicrotask(() => float.focus());
  }

  function showPayment({ cart, priced, approver }) {
    if (current?.unmount) current.unmount();
    current = createPayment({
      root: main,
      cart,
      priced,
      approver,
      onCancel: () => showPos(),
      onComplete: (sale) => showReceipt(sale),
    });
    current.mount();
  }

  function showReceipt(sale) {
    if (current?.unmount) current.unmount();
    current = createReceipt({
      root: main,
      sale,
      printed: sale.printed ?? null,
      onNewSale: () => showPos(),
    });
    current.mount();
  }

  function renderRail(activeId) {
    clear(railHost).append(
      h('div', { class: 'rail-brand', text: 'Chachi Agrivet' }),
      ...RAIL
        // §2: items the role cannot reach are hidden, not disabled.
        .filter((item) => may(session.role, item.tx))
        .map((item) => h('button', {
          class: `rail-item${item.id === activeId ? ' is-active' : ''}`,
          'aria-current': item.id === activeId ? 'page' : null,
          onclick: () => show(item.id),
        }, [h('span', { class: 'rail-label', text: item.label })])),
      h('div', { class: 'rail-spacer' }),
      h('button', {
        class: 'rail-item rail-user',
        text: session.username,
        onclick: () => (session.has_pin ? lock({ username: session.username }) : signIn()),
      })
    );
  }

  function start() {
    clear(root).append(h('div', { class: 'shell' }, [railHost, main]));
    show(LANDING[session.role] || 'pos');
  }

  // SEC-7: an expired session locks the screen over whatever was open. The cart is on
  // the server, so nothing is lost by it (POS-105).
  api.onError((err) => {
    if (err.status === 401 && session) lock({ username: session.username });
  });

  return {
    async mount() {
      const status = await api.get('/setup').catch(() => null);
      if (status?.required) { window.location.href = '/'; return; }
      signIn();
    },
    get session() { return session; },
  };
}
