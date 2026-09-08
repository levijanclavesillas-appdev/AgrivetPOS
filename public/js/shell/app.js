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
import { createDashboard } from '../reports/dashboard.js';
import { createReport } from '../reports/report.js';
import { createBackup } from '../admin/backup.js';
import { createHealth } from '../admin/health.js';
import { createUsers } from '../admin/users.js';
import { createSettings } from '../admin/settings.js';
import { createProductList } from '../catalogue/list.js';
import { createProductEditor } from '../catalogue/editor.js';
import { createAdjustment } from '../catalogue/adjustment.js';
import { createShift } from '../shift/view.js';
import { createShiftSummary } from '../shift/summary.js';

/** §2's role → landing screen. */
// §2's role → landing screen. MANAGER and OWNER land on SCR-601, which lives under
// the rail's Reports section — so the id is the rail's, or the rail would highlight
// nothing on the screen the user is looking at.
const LANDING = { CASHIER: 'pos', INVENTORY: 'products', MANAGER: 'reports', OWNER: 'reports' };

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
  // 04_UX_SPEC.md §3: SCR-101 shows the store name and the version. Both are read
  // before anyone signs in — the store name from /setup and the version from /health,
  // which are the two endpoints that answer unauthenticated — because the version is
  // the first thing a support call needs and the last thing anyone can find.
  let installation = { store_name: null, app_version: null };
  const main = h('main', { class: 'screen' });
  const railHost = h('nav', { class: 'rail', 'aria-label': 'Sections' });

  // ── Sign in (SCR-101) ─────────────────────────────────────────────────────

  function signIn({ prefillUsername = null, note = null } = {}) {
    const username = h('input', { type: 'text', autocomplete: 'username', value: prefillUsername || '', required: true });
    const password = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const problem = h('p', { class: 'error', role: 'alert', hidden: true });

    clear(root).append(h('div', { class: 'signin' }, [
      h('h1', { text: installation.store_name || 'Chachi Agrivet POS' }),
      installation.store_name
        ? h('p', { class: 'signin-store', text: 'Chachi Agrivet POS' })
        : null,
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
      h('p', {
        class: 'signin-version',
        text: installation.app_version ? `Version ${installation.app_version}` : '',
      }),
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
    // Low stock is a filter of the products list, not a section of its own, so the
    // rail keeps Products highlighted rather than highlighting nothing.
    renderRail(id === 'low-stock' ? 'products' : id);

    if (id === 'pos') return showPos();
    if (id === 'reports') return showDashboard();
    if (id === 'admin') return showAdmin();
    if (id === 'products') return showProducts();
    if (id === 'low-stock') return showProducts({ mode: 'low-stock' });
    if (id === 'shift') return showShift();

    // The admin and catalog screens are their own tasks. Saying so beats a dead
    // button, and 04_UX_SPEC.md §5's empty state is exactly this shape.
    ui.empty(main, { title: `${RAIL.find((item) => item.id === id)?.label} is not built yet.` });
    return null;
  }

  /** SCR-601. MANAGER and OWNER land here (04_UX_SPEC.md §2). */
  function showDashboard() {
    current = createDashboard({
      root: main,
      session,
      // A tile opens either a report or a screen; the low-stock one opens SCR-204.
      onOpenReport: (target, isScreen) => (isScreen ? show(target) : showReport(target)),
    });
    current.mount();
    return current;
  }

  // ── SCR-201 – SCR-204 ─────────────────────────────────────────────────────

  /** The catalogue list, and the low-stock filter of it (TASK-036). */
  function showProducts({ mode = 'all' } = {}) {
    if (current?.unmount) current.unmount();
    clear(main);
    current = createProductList({
      root: main,
      mode,
      onOpen: (id) => showProductEditor(id),
      onAdjust: (id) => showAdjustment(id),
      onValuation: () => showReport('valuation'),
    });
    current.mount();
    return current;
  }

  function showProductEditor(productId) {
    if (current?.unmount) current.unmount();
    clear(main);
    current = createProductEditor({
      root: main,
      productId,
      // A newly created product reopens in the editor rather than dropping back to the
      // list: its packs, prices and barcodes are the next four things anybody does.
      onClose: (createdId) => (createdId ? showProductEditor(createdId) : showProducts()),
    });
    current.mount();
    return current;
  }

  /** SCR-501 – SCR-503. `shiftId` opens another user's drawer, from the POS-508 alert. */
  function showShift(shiftId = null) {
    if (current?.unmount) current.unmount();
    clear(main);
    renderRail('shift');
    current = createShift({
      root: main,
      session,
      shiftId,
      onClosed: (result) => showShiftSummary(result),
    });
    current.mount();
    return current;
  }

  function showShiftSummary(result) {
    if (current?.unmount) current.unmount();
    clear(main);
    current = createShiftSummary({
      root: main,
      result,
      // POS-511: a closed shift is immutable, so there is nowhere to go back to. The
      // cashier lands where the day starts again.
      onDone: () => show(LANDING[session.role] || 'pos'),
    });
    current.mount();
    return current;
  }

  function showAdjustment(productId) {
    if (current?.unmount) current.unmount();
    clear(main);
    current = createAdjustment({
      root: main,
      productId,
      onClose: () => showProducts(),
    });
    current.mount();
    return current;
  }

  /**
   * SCR-704 and SCR-705, under Admin.
   *
   * Users, settings and the audit trail are their own tasks; the two TASK-017 owns are
   * here, and the rest of the section says so rather than offering a dead button.
   */
  const ADMIN_PANELS = [
    { id: 'users', label: 'Users', screen: 'SCR-701', create: createUsers },
    { id: 'settings', label: 'Settings', screen: 'SCR-702', create: createSettings },
    { id: 'backup', label: 'Backups', screen: 'SCR-704', create: createBackup },
    { id: 'health', label: 'Health', screen: 'SCR-705', create: createHealth },
  ];
  // Users first: on the day a store is installed it is the first thing anybody needs,
  // and leaving it further in is how a store ends up trading on the owner login.
  let adminPanel = 'users';

  function showAdmin() {
    const host = h('div', { class: 'admin-screen' });
    const panelHost = h('div', { class: 'admin-panel' });

    const tabs = h('nav', { class: 'admin-tabs', 'aria-label': 'Admin sections' },
      ADMIN_PANELS.map((panel) => h('button', {
        class: `admin-tab${panel.id === adminPanel ? ' is-active' : ''}`,
        'aria-current': panel.id === adminPanel ? 'page' : null,
        text: panel.label,
        onclick: () => { adminPanel = panel.id; showAdmin(); },
      })));

    clear(main).append(host);
    host.append(tabs, panelHost);

    const chosen = ADMIN_PANELS.find((panel) => panel.id === adminPanel);
    if (current?.unmount) current.unmount();
    current = chosen.create({ root: panelHost, session });
    current.mount();
    return current;
  }

  /** SCR-602 – SCR-604, reached from the tile that carries their figure. */
  function showReport(report) {
    if (current?.unmount) current.unmount();
    clear(main);
    current = createReport({
      root: main,
      session,
      report,
      onBack: () => { clear(main); showDashboard(); },
    });
    current.mount();
    return current;
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
      // POS-501. The open form lives on SCR-501 and nowhere else: two forms that open
      // a shift are two places for the confirmation tick to drift apart.
      ui.empty(main, {
        title: 'Open your shift before selling. Count the drawer and enter the opening float.',
        action: 'Open shift',
        onAction: () => showShift(),
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

      // Neither call is allowed to stop the counter opening: a sign-in screen without
      // a version on it is a minor inconvenience, and one that never renders is a shop
      // that cannot trade.
      const health = await api.get('/health').catch(() => null);
      installation = {
        store_name: status?.store_name || null,
        app_version: health?.app_version || null,
      };
      signIn();
    },
    get session() { return session; },
  };
}
