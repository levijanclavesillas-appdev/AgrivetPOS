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
import { createReceiptList } from '../receipt/list.js';
import { createDashboard } from '../reports/dashboard.js';
import { createReport } from '../reports/report.js';
import { createBackup } from '../admin/backup.js';
import { createHealth } from '../admin/health.js';
import { createUsers } from '../admin/users.js';
import { createSettings } from '../admin/settings.js';
import { createAudit } from '../admin/audit.js';
import { createData } from '../admin/data.js';
import { createProductList } from '../catalogue/list.js';
import { createProductEditor } from '../catalogue/editor.js';
import { createAdjustment } from '../catalogue/adjustment.js';
import { createBatchList } from '../catalogue/batches.js';
import { createRecall } from '../catalogue/recall.js';
import { createStockCount } from '../catalogue/count.js';
import { createCustomerList } from '../customers/list.js';
import { createCustomerProfile } from '../customers/profile.js';
import { createStatement } from '../customers/statement.js';
import { createAgeing } from '../reports/ageing.js';
import { createReconciliation } from '../reports/reconciliation.js';
import { createAnalysis } from '../reports/analysis.js';
import { createMovements } from '../reports/movements.js';
import { createCollection } from '../customers/collection.js';
import { createShift } from '../shift/view.js';
import { createShiftSummary } from '../shift/summary.js';
import { createPurchaseOrders } from '../purchasing/orders.js';
import { createPurchaseOrder } from '../purchasing/order.js';
import { createGoodsReceipt } from '../purchasing/receive.js';
import { createReturn } from '../returns/view.js';
import { createSuppliers } from '../purchasing/suppliers.js';

/** §2's role → landing screen. */
// §2's role → landing screen. MANAGER and OWNER land on SCR-601, which lives under
// the rail's Reports section — so the id is the rail's, or the rail would highlight
// nothing on the screen the user is looking at.
const LANDING = { CASHIER: 'pos', INVENTORY: 'products', MANAGER: 'reports', OWNER: 'reports' };

/** The rail, with the TX-* each item needs. Hidden without it; refused regardless. */
const RAIL = [
  { id: 'pos', label: 'POS', tx: 'TX-401', screen: 'SCR-301' },
  // TX-406 — "process a return". Its own rail item rather than a corner of the POS,
  // because a return is a different conversation from a sale and starts with a
  // receipt in somebody's hand, not a barcode.
  { id: 'returns', label: 'Returns', tx: 'TX-406', screen: 'SCR-305' },
  // TX-401 — the counter's own. SCR-304 appears when a sale completes and nowhere else,
  // and Enter on it starts the next customer, so a cashier who notices a mis-scan three
  // customers later held POS-402's right to void with no screen to exercise it from.
  { id: 'receipts', label: 'Receipts', tx: 'TX-401', screen: 'SCR-306' },
  { id: 'customers', label: 'Customers', tx: 'TX-413', screen: 'SCR-401' },
  { id: 'products', label: 'Products', tx: 'TX-422', screen: 'SCR-201' },
  { id: 'shift', label: 'Shift', tx: 'TX-418', screen: 'SCR-501' },
  // TX-409 is §10's "receive goods", and purchasing sits behind it whole: owner,
  // manager and the inventory clerk, and never a cashier.
  { id: 'buying', label: 'Buying', tx: 'TX-409', screen: 'SCR-801' },
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
  'TX-406': ['OWNER', 'MANAGER', 'CASHIER'],
  'TX-409': ['OWNER', 'MANAGER', 'INVENTORY'],
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

  // What the shell last learned about this user's shift (POS-501). Null until the POS
  // has been opened once — unknown is not the same as closed, and a lock screen that
  // assumed closed would send somebody with a live till to the password form.
  let shiftOpen = null;

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
    // POS-501, before the keypad rather than after a failed attempt: a PIN unlocks an
    // open shift, and offering one to somebody whose shift is closed is a dead end
    // dressed up as a lock screen — "Your cart is kept" said over a cart that does not
    // exist, and a way out labelled "Different user" for the same person.
    if (shiftOpen === false) {
      signIn({
        prefillUsername: username,
        note: 'A PIN unlocks an open shift. Sign in with your password to open one.',
      });
      return;
    }

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
              // POS-501: a PIN unlocks an **open shift**. Somebody whose shift is
              // closed — or who never opened one — can key a correct PIN all morning
              // and it will never work, because the refusal is not about the PIN.
              // Saying so and leaving them on a PIN keypad is a dead end: the only way
              // on was a button labelled "Different user", which is the wrong words for
              // the same person signing in with their password.
              if (err.ruleId === 'POS-501') {
                overlay.remove();
                signIn({ prefillUsername: username, note: err.message });
                return;
              }
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

  /**
   * A fresh host element per screen, instead of every view sharing `main`.
   *
   * A view fetches and then renders into its root. Switching screens while a fetch was
   * in flight left the **new** screen blank: the old view's reply landed after the
   * switch and cleared `main` from under whatever had replaced it. Each view's own
   * sequence guard cannot see that — it only knows about its own later requests — so
   * the fix belongs here. A late render now writes into a node that is no longer in
   * the document, and nobody sees it.
   */
  function host() {
    clear(main);
    const el = h('div', { class: 'screen-host' });
    main.append(el);
    return el;
  }

  async function show(id) {
    if (current?.unmount) current.unmount();
    clear(main);
    // Low stock is a filter of the products list, not a section of its own, so the
    // rail keeps Products highlighted rather than highlighting nothing.
    renderRail(id === 'low-stock' ? 'products'
      : (['ageing', 'reconciliation', 'analysis', 'movements'].includes(id) ? 'reports' : id));

    if (id === 'pos') return showPos();
    if (id === 'reports') return showDashboard();
    if (id === 'admin') return showAdmin();
    if (id === 'products') return showProducts();
    if (id === 'low-stock') return showProducts({ mode: 'low-stock' });
    // SCR-605 is a report, so the rail keeps Reports highlighted rather than nothing —
    // the same treatment low stock gets under Products.
    if (id === 'ageing') return showAgeing();
    if (id === 'reconciliation') return showReconciliation();
    // SCR-607 and SCR-608 are reports too, so the rail keeps Reports highlighted.
    if (id === 'analysis') return showAnalysis();
    if (id === 'movements') return showMovements();
    if (id === 'receipts') return showReceipts();
    if (id === 'shift') return showShift();
    if (id === 'customers') return showCustomers();
    if (id === 'buying') return showPurchaseOrders();
    if (id === 'returns') return showReturn();

    // The admin and catalog screens are their own tasks. Saying so beats a dead
    // button, and 04_UX_SPEC.md §5's empty state is exactly this shape.
    ui.empty(main, { title: `${RAIL.find((item) => item.id === id)?.label} is not built yet.` });
    return null;
  }

  /** SCR-601. MANAGER and OWNER land here (04_UX_SPEC.md §2). */
  function showDashboard() {
    current = createDashboard({
      root: host(),
      session,
      // A tile opens either a report or a screen; the low-stock one opens SCR-204.
      // A tile or an index entry opens either a screen the shell routes or one of
      // createReport's three. Both paths are one transition from here, which is what
      // 04_UX_SPEC.md §2's three-transition rule needs from the dashboard.
      onOpenReport: (target, isScreen) => (isScreen ? show(target) : showReport(target)),
      // OPS-007's expiry alerts open SCR-206 on the product they name, which is the
      // difference between being told about expired stock and being able to clear it.
      onOpenBatches: (productId) => { renderRail('products'); showBatches(productId); },
    });
    current.mount();
    return current;
  }

  // ── SCR-201 – SCR-204 ─────────────────────────────────────────────────────

  /** The catalogue list, and the low-stock filter of it (TASK-036). */
  function showProducts({ mode = 'all' } = {}) {
    if (current?.unmount) current.unmount();
    current = createProductList({
      root: host(),
      mode,
      onOpen: (id) => showProductEditor(id),
      onAdjust: (id) => showAdjustment(id),
      onBatches: (id) => showBatches(id),
      onValuation: () => showReport('valuation'),
      onCount: () => showStockCount(),
      // SCR-204 is a filter of this list, so it is reachable from it — and not only
      // from a dashboard the inventory clerk cannot open (04_UX_SPEC.md §2.1).
      onMode: (next) => show(next === 'low-stock' ? 'low-stock' : 'products'),
    });
    current.mount();
    return current;
  }

  function showProductEditor(productId) {
    if (current?.unmount) current.unmount();
    current = createProductEditor({
      root: host(),
      productId,
      // A newly created product reopens in the editor rather than dropping back to the
      // list: its packs, prices and barcodes are the next four things anybody does.
      onClose: (createdId) => (createdId ? showProductEditor(createdId) : showProducts()),
    });
    current.mount();
    return current;
  }

  // ── SCR-401 – SCR-403 ─────────────────────────────────────────────────────

  function showCustomers() {
    if (current?.unmount) current.unmount();
    renderRail('customers');
    current = createCustomerList({
      root: host(),
      onOpen: (id) => showCustomer(id),
      onCollect: (id) => showCollection(id),
    });
    current.mount();
    return current;
  }

  function showCustomer(customerId) {
    if (current?.unmount) current.unmount();
    current = createCustomerProfile({
      root: host(),
      customerId,
      session,
      onBack: () => showCustomers(),
      onCollect: (id) => showCollection(id),
      onStatement: (id) => showStatement(id),
    });
    current.mount();
    return current;
  }

  function showCollection(customerId) {
    if (current?.unmount) current.unmount();
    current = createCollection({
      root: host(),
      customerId,
      onBack: () => showCustomer(customerId),
      // Back to the profile, where the new balance and the settled invoices are.
      onDone: (id) => showCustomer(id),
    });
    current.mount();
    return current;
  }

  /** SCR-501 – SCR-503. `shiftId` opens another user's drawer, from the POS-508 alert. */
  function showShift(shiftId = null) {
    // Whatever the shell knew about the shift is about to be acted on from this screen,
    // so it stops knowing. A stale "closed" would send somebody who had just opened
    // their till to the password form instead of the keypad.
    shiftOpen = null;
    if (current?.unmount) current.unmount();
    renderRail('shift');
    current = createShift({
      root: host(),
      session,
      shiftId,
      onClosed: (result) => showShiftSummary(result),
    });
    current.mount();
    return current;
  }

  function showShiftSummary(result) {
    if (current?.unmount) current.unmount();
    current = createShiftSummary({
      root: host(),
      result,
      // POS-511: a closed shift is immutable, so there is nowhere to go back to. The
      // cashier lands where the day starts again.
      onDone: () => show(LANDING[session.role] || 'pos'),
    });
    current.mount();
    return current;
  }

  // ── SCR-801 – SCR-804 ─────────────────────────────────────────────────────

  /** SCR-801. The rail lands here; everything else in Buying is reached from it. */
  function showPurchaseOrders() {
    if (current?.unmount) current.unmount();
    renderRail('buying');
    current = createPurchaseOrders({
      root: host(),
      onOpen: (id) => showPurchaseOrder(id),
      onNew: () => showPurchaseOrder(null),
      onReceive: (id) => showGoodsReceipt(id),
      onSuppliers: () => showSuppliers(),
    });
    current.mount();
    return current;
  }

  /** SCR-802. `poId` null raises a new one. */
  function showPurchaseOrder(poId) {
    if (current?.unmount) current.unmount();
    renderRail('buying');
    current = createPurchaseOrder({
      root: host(),
      poId,
      onBack: () => showPurchaseOrders(),
      onReceive: (id) => showGoodsReceipt(id),
    });
    current.mount();
    return current;
  }

  /** SCR-803. `poId` null is FT-504's counter purchase (PO-207). */
  function showGoodsReceipt(poId) {
    if (current?.unmount) current.unmount();
    renderRail('buying');
    current = createGoodsReceipt({
      root: host(),
      poId,
      onBack: () => (poId ? showPurchaseOrder(poId) : showPurchaseOrders()),
      // PO-206: a posted delivery is immutable, so there is nothing to go back to.
      // Landing on the order shows the new status and what is still outstanding.
      onPosted: (gr) => (gr.po_id ? showPurchaseOrder(gr.po_id) : showPurchaseOrders()),
    });
    current.mount();
    return current;
  }

  /**
   * SCR-305. Opened from the rail with no sale, or from a receipt with one.
   *
   * `onDone` lands on the POS rather than back on the lookup: the customer has their
   * goods and their slip, and the next thing that happens at that counter is a sale.
   */
  function showReturn(forSaleId = null) {
    if (current?.unmount) current.unmount();
    renderRail('returns');
    current = createReturn({
      root: host(),
      saleId: forSaleId,
      onBack: () => show(LANDING[session.role] || 'pos'),
      onDone: () => show(LANDING[session.role] || 'pos'),
    });
    current.mount();
    return current;
  }

  /** SCR-804. */
  function showSuppliers() {
    if (current?.unmount) current.unmount();
    renderRail('buying');
    current = createSuppliers({
      root: host(),
      onBack: () => showPurchaseOrders(),
    });
    current.mount();
    return current;
  }

  /**
   * SCR-205 — the stocktake, reached from the products list.
   *
   * Under Products rather than a rail item of its own: a count is a thing done *to* the
   * catalogue, and TX-407's roles are the ones already on that section.
   */
  function showStockCount(id = null) {
    if (current?.unmount) current.unmount();
    renderRail('products');
    current = createStockCount({
      root: host(),
      session,
      countId: id,
      onBack: () => showProducts(),
    });
    current.mount();
    return current;
  }

  /**
   * SCR-206. Reached from the product list for a batch-tracked product, and in one step
   * from the near-expiry and expired-stock alerts — which is the path somebody actually
   * arrives by, because the alert is what told them there was anything to look at.
   */
  function showBatches(productId) {
    if (current?.unmount) current.unmount();
    current = createBatchList({
      root: host(),
      productId,
      session,
      onClose: () => showProducts(),
      onRecall: (batchId) => showRecall(batchId, productId),
    });
    current.mount();
    return current;
  }

  /** SCR-207. INV-206's list of people, one step from the batch it is about. */
  function showRecall(batchId, productId) {
    if (current?.unmount) current.unmount();
    current = createRecall({
      root: host(),
      batchId,
      onClose: () => showBatches(productId),
    });
    current.mount();
    return current;
  }

  function showAdjustment(productId) {
    if (current?.unmount) current.unmount();
    current = createAdjustment({
      root: host(),
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
    { id: 'audit', label: 'Audit', screen: 'SCR-703', create: createAudit },
    { id: 'backup', label: 'Backups', screen: 'SCR-704', create: createBackup },
    // SCR-706. Beside the backups because they answer the same question from two
    // sides: how a store's data survives this machine.
    { id: 'data', label: 'Export / import', screen: 'SCR-706', create: createData },
    { id: 'health', label: 'Health', screen: 'SCR-705', create: createHealth },
  ];
  // Users first: on the day a store is installed it is the first thing anybody needs,
  // and leaving it further in is how a store ends up trading on the owner login.
  let adminPanel = 'users';

  function showAdmin() {
    const screen = h('div', { class: 'admin-screen' });
    const panelHost = h('div', { class: 'admin-panel' });

    const tabs = h('nav', { class: 'admin-tabs', 'aria-label': 'Admin sections' },
      ADMIN_PANELS.map((panel) => h('button', {
        class: `admin-tab${panel.id === adminPanel ? ' is-active' : ''}`,
        'aria-current': panel.id === adminPanel ? 'page' : null,
        text: panel.label,
        onclick: () => { adminPanel = panel.id; showAdmin(); },
      })));

    clear(main).append(screen);
    screen.append(tabs, panelHost);

    const chosen = ADMIN_PANELS.find((panel) => panel.id === adminPanel);
    if (current?.unmount) current.unmount();
    current = chosen.create({ root: panelHost, session });
    current.mount();
    return current;
  }

  /** SCR-602 – SCR-604, reached from the tile that carries their figure. */
  /** SCR-404. CR-302's document, from the profile it is about. */
  function showStatement(customerId) {
    if (current?.unmount) current.unmount();
    current = createStatement({
      root: host(),
      customerId,
      onBack: () => showCustomer(customerId),
    });
    current.mount();
    return current;
  }

  /** SCR-605. FT-406's report, and the telephone list a store works from. */
  function showAgeing() {
    if (current?.unmount) current.unmount();
    current = createAgeing({
      root: host(),
      onBack: () => { renderRail('reports'); showDashboard(); },
      // A row is a customer, and the next thing an owner wants is their statement.
      onOpenCustomer: (customerId) => { renderRail('customers'); showCustomer(customerId); },
    });
    current.mount();
    return current;
  }

  /** SCR-606. RPT-105's comparison, which changes no figure anywhere. */
  function showReconciliation(range = null) {
    if (current?.unmount) current.unmount();
    current = createReconciliation({
      root: host(),
      range,
      onBack: () => { renderRail('reports'); showDashboard(); },
    });
    current.mount();
    return current;
  }

  /** SCR-607. FT-602's v1.2 half — the day's total, in the groupings a store acts on. */
  function showAnalysis(range = null, tab = 'by-category') {
    if (current?.unmount) current.unmount();
    current = createAnalysis({
      root: host(),
      range,
      tab,
      onBack: () => { renderRail('reports'); showDashboard(); },
    });
    current.mount();
    return current;
  }

  /** SCR-608. INV-102's ledger read as a report — TX-422, so a different readership. */
  function showMovements(range = null) {
    if (current?.unmount) current.unmount();
    current = createMovements({
      root: host(),
      range,
      onBack: () => { renderRail('reports'); showDashboard(); },
    });
    current.mount();
    return current;
  }

  function showReport(report) {
    if (current?.unmount) current.unmount();
    current = createReport({
      root: host(),
      session,
      report,
      onBack: () => { clear(main); showDashboard(); },
      // The range travels with it: somebody reconciling the week they are looking at
      // should not have to type the dates again.
      onReconcile: (range) => showReconciliation(range),
      // SCR-607 from the day's total, which is the screen somebody is on when they ask
      // *why* — and SCR-608 from the valuation, because the stock on the shelf and how
      // it got there are the same question from two sides.
      onAnalyse: (range) => { renderRail('reports'); showAnalysis(range); },
      onMovements: (range) => { renderRail('reports'); showMovements(range); },
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
      // Remembered for the lock screen: POS-501 makes a PIN unlock an open shift, so a
      // keypad offered to somebody whose shift is closed is a keypad that cannot work.
      // Stale after an idle period, which is why the refusal is still handled there.
      shiftOpen = Boolean(shift.open);
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
      root: host(),
      session,
      onPay: ({ cart, priced, approver }) => showPayment({ cart, priced, approver }),
    });
    current.mount();
    return current;
  }

  function showPayment({ cart, priced, approver }) {
    if (current?.unmount) current.unmount();
    current = createPayment({
      root: host(),
      cart,
      priced,
      approver,
      onCancel: () => showPos(),
      onComplete: (sale) => showReceipt(sale),
    });
    current.mount();
  }

  function showReceipt(sale, { from = null } = {}) {
    if (current?.unmount) current.unmount();
    current = createReceipt({
      root: host(),
      sale,
      printed: sale.printed ?? null,
      onNewSale: () => showPos(),
      // Only when it was opened from the list: reached from a completed sale, SCR-304
      // has one way on and it is the next customer.
      onBack: from === 'receipts' ? () => show('receipts') : null,
    });
    current.mount();
  }

  /** SCR-306. The shift's receipts, and the way back to one after the moment has passed. */
  function showReceipts() {
    if (current?.unmount) current.unmount();
    current = createReceiptList({
      root: host(),
      onOpenSale: async (saleId) => {
        try {
          // The same payload POST /sales answers with, so the receipt screen is the one
          // screen rather than a second rendering of the same document.
          const sale = await api.get(`/sales/${saleId}`);
          renderRail('receipts');
          showReceipt(sale, { from: 'receipts' });
        } catch (err) {
          ui.toast(err.message, { kind: 'error' });
        }
      },
      onBack: () => showPos(),
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
