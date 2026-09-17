// SCR-301 — the critical screen.
//
// The layout is 04_UX_SPEC.md §3's: search and cart on the left, customer and totals
// on the right, function keys along the foot. At 1366×768 both the cart and the totals
// rail are visible without scrolling, which is the acceptance criterion and the reason
// the cart scrolls inside its own container rather than the page doing it.
//
// **There is no offline indicator.** Offline is the normal condition of this product
// and a permanent warning trains people to ignore warnings (SCR-301's own states).

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money, quantity, packAndBase } from '../shell/format.js';
import { productPicture } from '../shell/pictures.js';
import { createCart } from './cart.js';
import { quantityForAmount } from './by-amount.js';
import { createScanner } from '../shell/scanner.js';
import { cameraButton } from '../shell/camera-scan.js';
import { KEYMAP, HELP_ORDER, actionFor, isMapped } from '../shell/keymap.js';

// TASK-056: the actions with no button of their own, in the order a sale uses them.
const TOUCH_ACTIONS = Object.freeze(['F3', 'F4', 'F5', 'F8', 'Delete', 'F6', 'F7']);
// TASK-066: the same keys, in a café's words (POS-109).
const CAFE_LABELS = Object.freeze({ F6: 'Send', F7: 'Orders', F12: 'Send & new' });

export function createPos({ root, session, onPay }) {
  const cart = createCart();
  const catalogue = new Map();
  let priced = null;
  let policy = null;             // GET /sales/pricing-policy — TAX-004's switch and rate
  let selectedKey = null;
  let modalOpen = false;
  let saveTimer = null;

  const search = h('input', {
    type: 'search', class: 'pos-search', id: 'pos-search',
    placeholder: 'Scan or search', autocomplete: 'off', 'aria-label': 'Scan or search',
  });
  const attachBar = h('div', { class: 'attach-bar', hidden: true });
  const linesHost = h('div', { class: 'cart-lines', role: 'list', tabindex: '0', 'aria-label': 'Cart' });
  const railHost = h('aside', { class: 'pos-rail' });
  // The customer and how the sale is being made: above the search field, across the screen,
  // where a landscape counter has room for them and the cart does not have to give any up.
  const topHost = h('div', { class: 'pos-top' });
  const panelHost = h('div', { class: 'pos-panel' });
  const results = h('div', { class: 'search-results', hidden: true });
  // Its own host, because the bar's contents depend on the policy the server has not
  // sent yet when the screen is first drawn.
  const helpHost = h('div', { class: 'pos-help-host' });
  // POS-113 (TASK-070): the store's own buttons, for goods with no barcode.
  const quickHost = h('div', { class: 'quick-keys-host' });
  let quickKeys = [];
  let quickShown = true;

  // The scanner only detects scans. What a person types is already in the search
  // field, and the input listener below searches on it.
  const scanner = createScanner({ onScan: (code) => scan(code) });

  // ── Rendering ─────────────────────────────────────────────────────────────

  function renderLines() {
    clear(linesHost);

    if (cart.isEmpty) {
      // SCR-301's empty state, verbatim, with the search focused.
      ui.empty(linesHost, { title: 'Scan an item to begin' });
      search.focus();
      return;
    }

    cart.lines.forEach((line, index) => {
      // By position, not by product: since POS-111 two lines may be the same product with
      // different notes, and the price-check answers line for line in the order sent.
      const pricedLine = priced?.lines?.[index]?.product_id === line.productId ? priced.lines[index] : null;
      const selected = line.key === selectedKey;

      linesHost.append(h('div', {
        class: `cart-line${selected ? ' is-selected' : ''}${line.unavailable ? ' is-unavailable' : ''}`,
        role: 'listitem',
        tabindex: '0',
        'aria-current': selected ? 'true' : null,
        onclick: () => { selectedKey = line.key; renderLines(); },
      }, [
        h('div', { class: 'cart-line-name', text: line.name }),
        // POS-111: what the kitchen is told about this line.
        line.note ? h('div', { class: 'cart-line-note', text: line.note }) : null,
        h('div', { class: 'cart-line-detail' }, [
          // POS-102: both the entered pack and the base unit; the ledger stores base.
          h('span', {
            class: 'qty',
            text: packAndBase({
              // The base equivalent, derived: the line holds what was entered, and
              // packAndBase's job is to show both halves of POS-102.
              qtyMilli: cart.baseMilliOf(line),
              baseUnit: line.baseUnit,
              packUnit: line.packUnitCode,
              packFactorMilli: line.packFactorMilli,
            }),
          }),
          h('span', { class: 'sep', text: '×' }),
          h('span', {
            class: 'unit-price',
            // PR-108: a line priced per pack says so — ₱180.00/BOX, not per sachet.
            text: pricedLine
              ? `${money(pricedLine.unit_price_centavos)}/${pricedLine.priced_per_pack ? line.packUnitCode : line.baseUnit}`
              : '—',
          }),
          // PR-101: the resolved level is named, so "why is this ₱58" is answerable.
          // Since TASK-024 the top two levels can win, and neither reads as an English
          // answer in its raw form — "QUANTITY_BREAK" is a column value, not a reason
          // a cashier can give a customer standing at the counter.
          pricedLine
            ? h('span', {
              class: `price-level${pricedLine.price_fell_through ? ' fell-through' : ''}`,
              text: priceLevelLabel(pricedLine),
              title: priceLevelTitle(pricedLine),
            })
            : null,
          h('span', { class: 'line-total', text: pricedLine ? money(pricedLine.amount_centavos) : '—' }),
        ]),
        // PR-206: the discount that actually applied, and — where one beat the other —
        // which and why. A cashier who typed 5% and sees 5% taken off has no way to
        // know whether their figure was used or an automatic one of the same size was,
        // and the difference is whose decision the sale records.
        discountLine(pricedLine, line),
        // POS-104: remaining stock after this line.
        h('div', {
          class: 'cart-line-stock',
          text: stockAfter(line) === null ? '' : `stock after: ${quantity(stockAfter(line), line.baseUnit)}`,
        }),
        line.unavailable
          ? h('div', { class: 'cart-line-warning', text: 'This product is no longer available. Remove the line.' })
          : null,
      ]));
    });
  }

  /**
   * PR-101's resolved level, in words a cashier can repeat to a customer.
   *
   * The label is the screen's — this is presentation, not policy — but every fact in
   * it is the server's: which level won, which band, and what was agreed. A screen
   * that worked out *why* a price was what it is would be a second resolver.
   */
  function priceLevelLabel(pricedLine) {
    if (pricedLine.price_level === 'CUSTOMER_SPECIFIC') return 'AGREED';
    if (pricedLine.price_level === 'QUANTITY_BREAK') {
      const band = pricedLine.quantity_band;
      return band ? `${quantity(band.min_qty_milli)}+` : 'BULK';
    }
    return pricedLine.price_level;
  }

  function priceLevelTitle(pricedLine) {
    if (pricedLine.price_level === 'CUSTOMER_SPECIFIC') {
      return pricedLine.customer_price_note
        ? `Agreed with this customer — ${pricedLine.customer_price_note} (PR-103)`
        : 'A price agreed with this customer, which beats any quantity break (PR-103)';
    }
    if (pricedLine.price_level === 'QUANTITY_BREAK') {
      return 'A quantity break, applied to the whole line (PR-104)';
    }
    return pricedLine.price_fell_through
      ? 'No price at the customer’s level, so retail applies (PR-102)'
      : null;
  }

  /**
   * What came off this line, and whose decision it was.
   *
   * The applied figure is the server's — PR-206 chose between the automatic discount
   * and the typed one, and the screen must not re-derive that choice or it would show
   * one figure while the till charged another.
   */
  function discountLine(pricedLine, line) {
    const applied = pricedLine ? pricedLine.line_discount_centavos : line.discountCentavos;
    const statutory = pricedLine && pricedLine.under_statutory ? pricedLine.statutory_choice : null;
    if (!applied && !statutory) return null;

    // TAX-004 / TAX-005 on the line it happened to. Shown per line rather than only in
    // the rail because the entitlement reaches some products and not others, and
    // "which of these did the 20% come off" is the question the customer asks.
    if (statutory) {
      return h('div', { class: 'cart-line-discount statutory' }, [
        h('span', {
          text: pricedLine.statutory_discount_centavos > 0
            ? `SC/PWD ${money(-pricedLine.statutory_discount_centavos)}`
            : `Store discount ${money(-applied)}`,
        }),
        pricedLine.vat_exemption_centavos > 0
          // TAX-002: not a discount, and never labelled as one. The line stopped being
          // VATable, which is a different thing from money the store gave away.
          ? h('small', { class: 'discount-why', text: `VAT-exempt, less ${money(pricedLine.vat_exemption_centavos)} VAT` })
          : null,
        // TAX-005's sentence, the server's own: the customer receives the larger of the
        // two, and a cashier who sees only one figure would otherwise think the till
        // had dropped the other.
        statutory.suppressed ? h('small', { class: 'discount-why', text: statutory.why }) : null,
      ]);
    }

    const choice = pricedLine && pricedLine.discount_choice;
    return h('div', { class: 'cart-line-discount' }, [
      h('span', { text: `Discount ${money(-applied)}` }),
      // Requirement 3's second half: say why the other one did not apply. The sentence
      // is the server's; a screen that wrote its own would be a second place PR-206
      // lives.
      choice && choice.suppressed
        ? h('small', { class: 'discount-why', text: choice.why })
        : null,
    ]);
  }

  function stockAfter(line) {
    const product = catalogue.get(line.productId);
    // INV-114: made to order has no shelf to count down.
    if (line.isStocked === false || (product && product.is_stocked === false)) return null;
    if (!product || product.on_hand_milli === undefined || product.on_hand_milli === null) return null;

    // In base units: what comes off the shelf is kilos, whatever the line was keyed in.
    const takenBefore = cart.lines
      .slice(0, cart.lines.findIndex((l) => l.key === line.key) + 1)
      .filter((l) => l.productId === line.productId)
      .reduce((sum, l) => sum + cart.baseMilliOf(l), 0);
    return product.on_hand_milli - takenBefore;
  }

  // ── TASK-066: a café's counter ─────────────────────────────────────────────

  /** POS-109: whether this store takes orders before they are paid. The server's answer. */
  const ordersOn = () => Boolean(policy?.orders?.enabled);
  let openOrders = [];           // GET /open-orders, for the count on the Orders button

  const tableInput = h('input', {
    type: 'text', class: 'order-table', placeholder: 'Table or name', autocomplete: 'off',
    'aria-label': 'Table or name', maxlength: '30',
    oninput: (event) => { cart.tableLabel = event.target.value; saveSoon(); renderOrderState(); },
  });
  const orderStateHost = h('div', { class: 'order-state-host' });

  /**
   * The order this cart is: how it is served, where, and — for an order already sent —
   * whether the kitchen has everything on the screen.
   */
  function orderBlock() {
    const open = cart.openOrder;
    if (document.activeElement !== tableInput) tableInput.value = cart.tableLabel;
    renderOrderState();
    return h('div', { class: 'rail-block rail-order' }, [
      h('h2', { text: open ? `Order ${open.order_no}` : 'New order' }),
      h('div', { class: 'order-types', role: 'group', 'aria-label': 'How it is served' },
        policy.orders.order_types.map((type) => h('button', {
          type: 'button',
          class: `order-type${cart.orderType === type.code ? ' is-on' : ''}`,
          'aria-pressed': String(cart.orderType === type.code),
          text: type.label,
          onclick: async () => { cart.orderType = type.code; await reprice(); },
        }))),
      tableInput,
      orderStateHost,
    ]);
  }

  function renderOrderState() {
    const open = cart.openOrder;
    if (!open) { clear(orderStateHost); return; }
    const changed = cart.changedSinceLoaded();
    clear(orderStateHost).append(
      h('p', { class: `order-state${changed ? ' is-changed' : ''}`, text: changed ? 'Changes not sent to the kitchen yet.' : 'The kitchen has this order.' }),
      changed
        ? h('button', { class: 'rail-action', text: 'Discard changes', onclick: () => discardChanges() })
        : h('button', { class: 'rail-action', text: 'Put the order back', onclick: () => leaveOrder() }),
    );
  }

  /** The bar over the counter: who is buying, and how this sale is being rung up. */
  function renderTop() {
    const customer = cart.customer;
    clear(topHost).append(...[
      h('div', { class: 'top-block top-customer' }, [
        h('h2', { text: 'Customer' }),
        h('div', { class: 'top-row' }, [
          h('p', { class: 'rail-customer', text: customer ? customer.name : 'Walk-in' }),
          h('button', { class: 'top-action', icon: 'users', text: 'Change  F2', onclick: () => chooseCustomer() }),
        ]),
      ]),
      // PR-107: retail or wholesale, for a walk-in; an account customer's own level is shown.
      wholesaleOn() || !ordersOn()
        ? h('div', { class: 'top-block top-level' }, [
          h('h2', { text: 'Price' }),
          wholesaleOn() && !customer
            ? priceSwitch()
            : h('p', { class: 'rail-level', text: customer?.price_level || 'RETAIL' }),
        ])
        : null,
      // POS-109: dine-in, take-out or delivery, and the table — a café's kind of sale.
      ordersOn() ? h('div', { class: 'top-block top-order' }, [orderBlock()]) : null,
    ].filter(Boolean));
  }

  function renderRail() {
    const customer = cart.customer;
    // `.filter(Boolean)`, and it is not decoration: `Element.append()` is the DOM's own
    // and coerces `null` to the **string** "null", where `h()`'s children are filtered.
    // The last block below is conditional, so on every sale that needed no
    // authorisation — which is nearly all of them — the word `null` was printed under
    // the Pay button, on the one screen this product is for. The payment screen already
    // filters for the same reason; this call site did not.
    clear(railHost).append(...[
      h('div', { class: 'rail-block rail-totals' }, [
        row('Subtotal', priced ? money(priced.subtotal_centavos) : money(0)),
        row('Discount', priced ? money(-(priced.line_discount_centavos + priced.transaction_discount_centavos)) : money(0)),
        // PR-106: the band this basket earned, named. "Why is there ₱300 off" is a
        // question the customer asks and the cashier has to be able to answer — and
        // the label is the owner's own, from the registry, so no copy lives here.
        priced?.transaction_tier?.applies
          ? h('p', { class: 'rail-tier', text: priced.transaction_tier.band.label })
          : null,
        // PR-206 at the transaction level: the tier beat what somebody typed, or lost
        // to it. Said, because a cashier who entered ₱100 and sees ₱300 off would
        // otherwise think the till had added them together.
        priced?.transaction_discount_choice?.suppressed
          ? h('p', { class: 'rail-tier-why', text: priced.transaction_discount_choice.why })
          : null,
        // TAX-004: its own row, never folded into the discount above — the store
        // deducts one and gave the other away, and the cashier is asked about both.
        priced?.statutory
          ? row(`SC/PWD ${percent(policy?.statutory?.discount_bp)}`, money(-priced.statutory_discount_centavos), 'statutory')
          : null,
        priced?.statutory
          ? h('p', { class: 'rail-statutory', text: `${priced.statutory.id_type_label} · ${priced.statutory.name} · ${priced.statutory.id_no}` })
          : null,
        priced?.tax_summary ? row('VAT', money(priced.tax_amount_centavos)) : null,
        // POS-112: on a dine-in bill, after every discount — its own row, and the rate on it.
        priced?.service_charge_centavos > 0
          ? row(`Service charge ${percent(priced.service_charge_bp)}`, money(priced.service_charge_centavos), 'service-charge')
          : null,
        h('hr'),
        row('TOTAL', priced ? money(priced.total_centavos) : money(0), 'total'),
      ]),
      h('div', { class: 'rail-block rail-pay' }, [
        h('button', {
          class: 'primary pay', text: 'PAY  F9',
          disabled: cart.isEmpty || !priced || priced.requires_authorisation,
          onclick: () => pay(),
        }),
        ordersOn()
          ? h('button', {
            class: 'rail-action send-order', icon: 'send',
            text: cart.openOrder ? 'Send changes  F6' : 'Send to kitchen  F6',
            disabled: cart.isEmpty || (Boolean(cart.openOrder) && !cart.changedSinceLoaded()),
            onclick: () => sendOrder(),
          })
          : h('button', { class: 'rail-action', icon: 'circle-pause', text: 'Park & new  F12', onclick: () => park({ andNew: true }) }),
        ordersOn()
          ? h('button', {
            class: 'rail-action open-orders', icon: 'clipboard-list',
            text: `Orders${openOrders.length ? ` (${openOrders.length})` : ''}  F7`,
            onclick: () => showOrders(),
          })
          : null,
      ]),
      // PR-105 and PR-203 surfaced where they happen (§6), not at Complete.
      priced?.requires_authorisation ? authorisations() : null,
    ].filter(Boolean));
  }

  // ── TASK-070: a sari-sari store's counter ─────────────────────────────────

  /** PR-107: whether a walk-in's cart may be switched to wholesale. The server's answer. */
  const wholesaleOn = () => Boolean(policy?.retail?.wholesale_switch?.enabled);
  const quickOn = () => Boolean(policy?.retail?.quick_keys?.enabled);

  /** PR-107: Retail | Wholesale, for a walk-in. A chosen customer's level is their own. */
  function priceSwitch() {
    return h('div', { class: 'order-types price-switch', role: 'group', 'aria-label': 'Price level' },
      [['RETAIL', 'Retail'], ['WHOLESALE', 'Wholesale']].map(([code, label]) => h('button', {
        type: 'button',
        class: `order-type${cart.priceLevel === code ? ' is-on' : ''}`,
        'aria-pressed': String(cart.priceLevel === code),
        text: label,
        onclick: async () => { cart.priceLevel = code; await reprice(); },
      })));
  }

  /** POS-113: the grid, where the store has keys. Pressing one is scanning that product. */
  function renderQuickKeys() {
    clear(quickHost);
    if (!quickOn() || quickKeys.length === 0) return;
    quickHost.append(
      h('button', {
        type: 'button', class: 'quick-keys-toggle', 'aria-expanded': String(quickShown),
        text: quickShown ? 'Hide quick keys' : `Quick keys (${quickKeys.length})`,
        onclick: () => { quickShown = !quickShown; renderQuickKeys(); },
      }),
      quickShown
        ? h('div', { class: 'quick-keys', role: 'group', 'aria-label': 'Quick keys' }, quickKeys.map((key) => h('button', {
          type: 'button', class: 'quick-key', disabled: !key.usable,
          title: key.usable ? key.product_name : `${key.product_name} can no longer be sold`,
          onclick: () => pressQuickKey(key),
        }, [
          h('span', { class: 'quick-key-label', text: key.label }),
          key.pack_unit_code ? h('small', { class: 'quick-key-pack', text: key.pack_unit_code }) : null,
        ])))
        : null,
    );
  }

  async function pressQuickKey(key) {
    try {
      const { product } = await api.get(`/products/${key.product_id}`);
      await addProduct(product, { packUnitId: key.pack_unit_id || null });
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
  }

  async function refreshQuickKeys() {
    if (!quickOn()) return;
    try {
      ({ keys: quickKeys } = await api.get('/quick-keys'));
    } catch { quickKeys = []; }
    renderQuickKeys();
  }

  /**
   * "₱20 of rice" (TASK-070): the quantity the amount buys at this line's price, rounded
   * down to the unit's selling step. Only for a loose line of a unit sold in parts.
   */
  function sellByAmount() {
    const line = selected();
    if (!line) return;
    const index = cart.lines.findIndex((l) => l.key === line.key);
    const pricedLine = priced?.lines?.[index];
    if (!line.baseUnitAllowsFraction || line.packUnitId || !pricedLine || pricedLine.priced_per_pack) {
      ui.toast(`${line.name} is not sold by amount. Enter a quantity instead.`, { kind: 'error' });
      return;
    }
    const step = catalogue.get(line.productId)?.base_unit?.step_milli ?? null;
    prompt({
      title: `By amount — ${line.name}`,
      label: `Pesos of ${line.baseUnit} at ${money(pricedLine.unit_price_centavos)}/${line.baseUnit}`,
      onSubmit: async (raw) => {
        const pesos = Number.parseFloat(raw);
        const qty = Number.isFinite(pesos)
          ? quantityForAmount({ amountCentavos: Math.round(pesos * 100), unitPriceCentavos: pricedLine.unit_price_centavos, stepMilli: step })
          : null;
        if (!qty) return ui.toast('That amount buys less than the smallest quantity sold.', { kind: 'error' });
        cart.setQuantity(line.key, qty);
        await reprice();
        ui.toast(`${quantity(qty, line.baseUnit)} of ${line.name}.`);
        return undefined;
      },
    });
  }

  /** A rate the server sent, in words. The figure is never this screen's (OPS-005). */
  const percent = (bp) => (Number.isFinite(bp) ? `${bp / 100}%` : '');

  const row = (label, value, cls = '') => h('div', { class: `rail-row ${cls}` }, [
    h('span', { text: label }),
    h('span', { class: 'money', text: value }),
  ]);

  function authorisations() {
    return h('div', { class: 'rail-block rail-authorisations' }, [
      h('h2', { text: 'Authorisation needed' }),
      ...priced.authorisations.map((auth) => h('div', { class: 'authorisation-needed' }, [
        h('p', { text: auth.message }),
        h('p', { class: 'refusal-rule', text: `${auth.rule_id} · ${auth.requires_role}` }),
        h('button', { icon: 'shield-check', text: 'Authorise', onclick: () => authorise(auth) }),
      ])),
    ]);
  }

  function render() {
    renderLines();
    renderTop();
    renderRail();
    clear(helpHost).append(helpBar());
  }

  // ── Pricing (§4.1 step 2 — the client computes nothing that is banked) ─────

  async function reprice() {
    if (cart.isEmpty) { priced = null; render(); return; }
    try {
      priced = await api.post('/sales/price-check', cart.toRequest());
    } catch (err) {
      priced = null;
      ui.toast(err.message, { kind: 'error' });
    }
    render();
    saveSoon();
  }

  /** POS-105: the cart is saved after every change, so a power cut loses nothing. */
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api.put('/carts/active', cart.toRequest()).catch(() => {});
    }, 400);
  }

  // ── Scanning (INT-3, FR_3.1) ──────────────────────────────────────────────

  async function scan(code) {
    search.value = '';
    attachBar.hidden = true;
    try {
      const result = await api.get(`/products/barcode/${encodeURIComponent(code)}`);
      if (result.found) {
        // TASK-055: the code on a box adds a box — the pack it is printed on.
        await addProduct(result.product, { packUnitId: result.pack ? result.pack.unit.id : null });
        return;
      }
      // FR_3.1 / TC-INT-30: never a silent no-op and never a swallowed 404.
      offerAttach(result.barcode);
    } catch (err) {
      // A weight-embedded barcode (VR-205) lands here, and says so.
      ui.toast(err.message, { kind: 'error' });
    }
  }

  function offerAttach(barcode) {
    clear(attachBar).append(
      h('span', { text: `${barcode} is not in the catalogue.` }),
      h('button', {
        class: 'primary',
        text: `Attach ${barcode} to a product`,
        onclick: () => { search.value = ''; search.focus(); attachBar.hidden = true; ui.toast('Find the product, then attach the code from its editor.'); },
      }),
      h('button', { text: 'Dismiss', onclick: () => { attachBar.hidden = true; } })
    );
    attachBar.hidden = false;
  }

  async function addProduct(product, { packUnitId = null } = {}) {
    const known = await withStock(product);
    catalogue.set(product.id, known);
    cart.add({ product: known, packUnitId });
    selectedKey = `${product.id}:${packUnitId || 'base'}`;
    await reprice();
  }

  /**
   * What a cart line needs that a search result does not carry.
   *
   * Two things: `POS-104`'s on-hand, and — since the unit picker — the product's packs.
   * The search payload has neither, and it is right not to: fifty rows in the catalogue
   * list would be fifty pack queries for a screen that shows none of them. A line being
   * *added* is one product and one moment, so it is the place to ask.
   *
   * Both in parallel, and both optional. A product that arrived by scan already carries
   * its packs — `/products/barcode/:code` answers with the detail — and a failed fetch
   * leaves the line sellable in its base unit rather than refusing to add it at all.
   */
  async function withStock(product) {
    const [detail, stock] = await Promise.all([
      product.packs ? Promise.resolve({ product }) : api.get(`/products/${product.id}`).catch(() => null),
      api.get(`/inventory/${product.id}`).catch(() => null),
    ]);

    return {
      ...product,
      packs: product.packs ?? detail?.product?.packs ?? [],
      on_hand_milli: stock ? stock.on_hand.qty_on_hand_milli : undefined,
    };
  }

  async function lookup(term) {
    if (!term || term.length < 2) { results.hidden = true; return; }
    try {
      const { products } = await api.get(`/products?q=${encodeURIComponent(term)}&limit=8`);
      clear(results);
      if (products.length === 0) {
        results.append(h('p', { class: 'no-results', text: `Nothing matches “${term}”.` }));
      }
      for (const product of products) {
        results.append(h('button', {
          class: 'search-result',
          onclick: async () => { results.hidden = true; search.value = ''; await addProduct(product); },
        }, [
          // TASK-052: the box, which is how a customer points at what they mean.
          productPicture(product, { className: 'product-picture result-picture' }),
          // The generic under the brand name: "parac" finds six boxes, and the
          // generic is how the cashier tells the customer which of them is which.
          h('span', { class: 'result-name' }, [
            product.name,
            product.generic_name ? h('small', { class: 'result-generic', text: product.generic_name }) : null,
          ]),
          h('span', { class: 'result-sku', text: product.sku }),
          h('span', { class: 'result-price', text: money(product.retail_price_centavos) }),
        ]));
      }
      results.hidden = false;
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
  }

  // ── Actions the keyboard map dispatches to ────────────────────────────────

  function selected() {
    return cart.lines.find((line) => line.key === selectedKey) ?? cart.lines.at(-1) ?? null;
  }

  function prompt({ title, label, value = '', onSubmit, inputmode = 'decimal', maxlength = null }) {
    modalOpen = true;
    const input = h('input', { type: 'text', value, autocomplete: 'off', inputmode, maxlength });
    const close = () => { modalOpen = false; clear(panelHost); search.focus(); };

    clear(panelHost).append(h('form', {
      class: 'pos-prompt',
      onsubmit: (event) => { event.preventDefault(); onSubmit(input.value.trim()); close(); },
    }, [
      h('h2', { text: title }),
      h('label', { text: label }, [input]),
      h('div', { class: 'prompt-actions' }, [
        h('button', { type: 'submit', class: 'primary', text: 'Apply' }),
        // §7: Escape cancels the field, never the cart.
        h('button', { type: 'button', text: 'Cancel', onclick: close }),
      ]),
    ]));
    queueMicrotask(() => input.select());
  }

  /**
   * `TAX-004` — the senior citizen and PWD claim (`F8`).
   *
   * Three fields, because the law wants three things: which ID, its number, and the
   * name on it. Nothing here decides anything — whether the store grants the discount,
   * what the rate is, which of the products it reaches and whether it beats a discount
   * already on the line are all the server's answers, and the panel's job is to collect
   * the record and let `reprice()` find out.
   *
   * The refusal when the store does not grant it is shown here rather than at the sale,
   * because a cashier who has already asked a customer for their ID and typed it in has
   * done something they cannot undo in front of them.
   */
  function claimStatutory() {
    if (!policy?.statutory?.enabled) {
      return ui.toast(
        'This store does not grant the senior citizen and PWD discount. The owner turns '
        + 'it on in Settings.',
        { kind: 'error' }
      );
    }

    modalOpen = true;
    const claim = cart.statutory;
    const types = policy.statutory.id_types;
    const idType = h('select', { 'aria-label': 'ID type' }, types.map((type) => h('option', {
      value: type.id, text: `${type.label} (${type.statute})`, selected: claim?.idType === type.id,
    })));
    const idNo = h('input', { type: 'text', value: claim?.idNo || '', autocomplete: 'off', 'aria-label': 'ID number' });
    const name = h('input', { type: 'text', value: claim?.name || '', autocomplete: 'off', 'aria-label': 'Name on the ID' });
    const close = () => { modalOpen = false; clear(panelHost); search.focus(); };

    clear(panelHost).append(h('form', {
      class: 'pos-prompt statutory-prompt',
      onsubmit: async (event) => {
        event.preventDefault();
        if (!idNo.value.trim() || !name.value.trim()) {
          return ui.toast('The ID number and the name on it are both required (TAX-004).', { kind: 'error' });
        }
        cart.statutory = { idType: idType.value, idNo: idNo.value.trim(), name: name.value.trim() };
        close();
        await reprice();
        // The claim is refused by the server where no line is eligible, and `reprice`
        // has already said so. Dropping it here keeps the screen and the cart agreed.
        if (!priced) cart.statutory = null;
      },
    }, [
      h('h2', { text: `${policy.statutory.rate_label} senior citizen / PWD discount` }),
      // The server's own sentence about how it interacts with the rest — TAX-005 and
      // the VAT exemption. No copy of either lives here.
      h('p', { class: 'muted', text: policy.statutory.note }),
      h('label', { text: 'ID type' }, [idType]),
      h('label', { text: 'ID number' }, [idNo]),
      h('label', { text: 'Name on the ID' }, [name]),
      h('div', { class: 'prompt-actions' }, [
        h('button', { type: 'submit', class: 'primary', text: 'Apply' }),
        claim
          ? h('button', {
            type: 'button', text: 'Remove',
            onclick: async () => { cart.statutory = null; close(); await reprice(); },
          })
          : null,
        h('button', { type: 'button', text: 'Cancel', onclick: close }),
      ]),
    ]));
    queueMicrotask(() => idNo.focus());
  }

  /**
   * `POS-102` — the quantity **and the unit it is in** (`F3`).
   *
   * The unit was missing from this screen until now, and its absence was not neutral:
   * the field was labelled "In KG or SACK" and the number was always taken as KG. A
   * cashier keying 2 for two sacks sold two kilos, at a fiftieth of the money. The
   * server has taken a pack unit per line since `TASK-011`, the cart has kept pack
   * lines apart since `TASK-015`, and the receipt has printed both halves all along —
   * the counter simply had no way to say which.
   *
   * The conversion is shown as it is typed, because "2 SACK = 100 KG" is the sentence
   * that catches a mis-keyed unit while the customer is still standing there, and
   * `UOM-004`'s refusal is stated **before** the submit rather than after it: a unit
   * that cannot be halved says so under the field, not in a toast once the sale is
   * refused.
   */
  function quantityPrompt(line) {
    const product = catalogue.get(line.productId);
    const packs = product?.packs ?? [];
    const units = [
      { id: null, code: line.baseUnit, allowsFraction: line.baseUnitAllowsFraction, factorMilli: 1000 },
      ...packs.map((pack) => ({
        id: pack.unit.id,
        code: pack.unit.code,
        allowsFraction: pack.unit.allows_fraction ?? false,
        factorMilli: pack.factor_milli,
      })),
    ];

    modalOpen = true;
    const close = () => { modalOpen = false; clear(panelHost); search.focus(); };

    const qty = h('input', { type: 'text', inputmode: 'decimal', value: String(line.qtyMilli / 1000), autocomplete: 'off' });
    const unit = h('select', {}, units.map((u) => h('option', {
      value: u.id || '', text: u.code, selected: (u.id || null) === (line.packUnitId || null),
    })));
    const note = h('p', { class: 'prompt-note' });
    const rule = h('p', { class: 'prompt-rule', hidden: true });

    const chosen = () => units.find((u) => (u.id || '') === unit.value) || units[0];

    /** The sentence under the field: what this comes to, and what the unit refuses. */
    function explain() {
      const picked = chosen();
      const typed = Number.parseFloat(qty.value);
      const milli = Number.isFinite(typed) ? Math.round(typed * 1000) : null;

      note.textContent = milli === null || milli <= 0 || picked.factorMilli === 1000
        ? ''
        : `${quantity(milli, picked.code)} = ${quantity(Math.round((milli * picked.factorMilli) / 1000), line.baseUnit)}`;

      // UOM-004, said before it is needed rather than after it is broken.
      const indivisible = !picked.allowsFraction;
      rule.hidden = !indivisible;
      if (indivisible) {
        rule.textContent = `${picked.code} cannot be sold in parts — a whole number of them.`;
      }
    }

    clear(panelHost).append(h('form', {
      class: 'pos-prompt',
      onsubmit: async (event) => {
        event.preventDefault();
        const picked = chosen();
        const typed = Math.round(Number.parseFloat(qty.value) * 1000);
        if (!Number.isFinite(typed) || typed <= 0) {
          return ui.toast('Enter a quantity greater than zero.', { kind: 'error' });
        }
        // Refused here as well as at the server, because the counter should not have to
        // send a sale to find out (UOM-004).
        if (!picked.allowsFraction && typed % 1000 !== 0) {
          return ui.toast(`${picked.code} cannot be sold in parts. Enter a whole number of `
            + `${picked.code}, or sell by ${line.baseUnit}.`, { kind: 'error' });
        }

        const moved = cart.setUnit(line.key, picked.id, product);
        cart.setQuantity(moved ? moved.key : line.key, typed);
        selectedKey = moved ? moved.key : line.key;
        close();
        await reprice();
        return undefined;
      },
    }, [
      h('h2', { text: `Quantity — ${line.name}` }),
      h('label', { text: 'Quantity' }, [qty]),
      // Only where there is a choice to make. A product sold by the kilo alone gets the
      // field it always had, with no control that has one option in it.
      units.length > 1 ? h('label', { text: 'Unit' }, [unit]) : null,
      note,
      rule,
      h('div', { class: 'prompt-actions' }, [
        h('button', { type: 'submit', class: 'primary', text: 'Apply' }),
        h('button', { type: 'button', text: 'Cancel', onclick: close }),
      ]),
    ]));

    qty.addEventListener('input', explain);
    unit.addEventListener('change', explain);
    explain();
    queueMicrotask(() => qty.select());
  }

  const actions = {
    search: () => search.focus(),
    customer: () => chooseCustomer(),
    statutory: () => claimStatutory(),

    quantity: () => {
      const line = selected();
      if (!line) return;
      quantityPrompt(line);
    },

    lineDiscount: () => {
      const line = selected();
      if (!line) return;
      prompt({
        title: `Discount — ${line.name}`,
        label: 'Amount in pesos',
        value: String(line.discountCentavos / 100),
        onSubmit: async (raw) => {
          const pesos = Number.parseFloat(raw);
          if (!Number.isFinite(pesos) || pesos < 0) return ui.toast('Enter a discount of zero or more.', { kind: 'error' });
          cart.setLineDiscount(line.key, Math.round(pesos * 100));
          await reprice();
        },
      });
    },

    txnDiscount: () => prompt({
      title: 'Transaction discount',
      label: 'Amount in pesos',
      value: String(cart.transactionDiscountCentavos / 100),
      onSubmit: async (raw) => {
        const pesos = Number.parseFloat(raw);
        if (!Number.isFinite(pesos) || pesos < 0) return ui.toast('Enter a discount of zero or more.', { kind: 'error' });
        cart.transactionDiscountCentavos = Math.round(pesos * 100);
        await reprice();
      },
    }),

    removeLine: async () => {
      const line = selected();
      if (!line) return;
      cart.remove(line.key);
      selectedKey = null;
      await reprice();
    },

    // TASK-066: in a café the park keys send the order to the kitchen, and retrieve lists
    // the open orders — the same place on the keyboard for the same idea: set it down.
    park: () => (ordersOn() ? sendOrder() : park({ andNew: false })),
    parkAndNew: () => (ordersOn() ? sendOrder() : park({ andNew: true })),
    retrieve: () => (ordersOn() ? showOrders() : retrieve()),
    note: () => {
      const line = selected();
      if (!line) return;
      prompt({
        title: `Note — ${line.name}`,
        label: 'For the kitchen',
        value: line.note || '',
        inputmode: 'text',
        maxlength: String(policy?.orders?.note_max || 60),
        onSubmit: async (text) => {
          const moved = cart.setNote(line.key, text);
          selectedKey = moved ? moved.key : null;
          await reprice();
        },
      });
    },
    pay: () => pay(),
    exactCash: () => pay({ exactCash: true }),
    cancelField: () => { results.hidden = true; attachBar.hidden = true; if (modalOpen) { modalOpen = false; clear(panelHost); } search.focus(); },
  };

  /**
   * `SCR-302` — park and resume (`POS-106`).
   *
   * Not a screen of its own: it is the POS screen with the cart set down, which is why
   * it lives here rather than in a file of its own. Labelled because the spec names it,
   * and an implemented screen nobody can find in the source reads as a missing one.
   */
  async function park({ andNew }) {
    if (cart.isEmpty) return ui.toast('There is nothing to park.', { kind: 'error' });
    try {
      await api.put('/carts/active', cart.toRequest());
      const { cart: parked } = await api.post('/carts/park', {});
      cart.clear();
      priced = null;
      render();
      ui.toast(`Parked: ${parked.label}`);
      if (andNew) search.focus();
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
  }

  async function retrieve() {
    try {
      const { carts } = await api.get('/carts/parked');
      if (carts.length === 0) return ui.toast('No parked carts.', { kind: 'error' });

      modalOpen = true;
      clear(panelHost).append(h('div', { class: 'pos-prompt' }, [
        h('h2', { text: 'Parked carts' }),
        ...carts.map((parked) => h('button', {
          class: 'parked-cart',
          onclick: async () => {
            modalOpen = false;
            clear(panelHost);
            const { cart: resumed, displaced } = await api.post(`/carts/${parked.id}/resume`, {});
            await restore(resumed);
            if (displaced) ui.toast(`Your cart was parked as “${displaced.label}”.`);
          },
        }, [
          h('span', { text: parked.label }),
          h('span', { class: 'parked-count', text: `${parked.line_count} lines` }),
        ])),
        h('button', { text: 'Cancel', onclick: () => { modalOpen = false; clear(panelHost); search.focus(); } }),
      ]));
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
  }

  // ── POS-109 — the orders ──────────────────────────────────────────────────

  async function refreshOrders() {
    if (!ordersOn()) return;
    try {
      ({ orders: openOrders } = await api.get('/open-orders'));
    } catch { openOrders = []; }
    renderRail();
  }

  /** What the printer said about a kitchen ticket, where it is worth saying. */
  function ticketNote(printed) {
    if (!printed || printed.delivered || printed.pending || printed.transport === 'BROWSER') return;
    if (printed.transport === 'NONE') return;
    ui.toast(`The kitchen ticket did not print (${printed.error}). Tell the kitchen, or print it again from Orders.`, { kind: 'error' });
  }

  /**
   * F6 in a café: this order to the kitchen — all of it the first time, what changed
   * after that — and the counter cleared for the next table.
   */
  async function sendOrder() {
    if (cart.isEmpty) return ui.toast('There is nothing to send.', { kind: 'error' });
    if (!cart.orderType) return ui.toast('Choose dine-in, take-out or delivery first.', { kind: 'error' });
    try {
      const body = cart.toRequest();
      const result = cart.openOrder
        ? await api.put(`/open-orders/${cart.openOrder.id}`, body)
        : await api.post('/open-orders', body);
      await api.del('/carts/active').catch(() => {});
      const where = result.order.table_label ? ` — ${result.order.table_label}` : '';
      cart.clear();
      priced = null;
      render();
      ui.toast(result.changes > 0
        ? `Order ${result.order.order_no}${where} sent to the kitchen.`
        : `Order ${result.order.order_no}${where}: nothing new for the kitchen.`, { kind: 'success' });
      ticketNote(result.printed);
      await refreshOrders();
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
    return undefined;
  }

  /** Products the order names, fetched into the catalogue the cart reads names from. */
  async function fetchProducts(lines) {
    for (const line of lines || []) {
      if (catalogue.has(line.productId)) continue;
      try {
        const { product } = await api.get(`/products/${line.productId}`);
        catalogue.set(product.id, await withStock(product));
      } catch { /* left unavailable and flagged by the cart model */ }
    }
  }

  async function loadOrder(order) {
    await fetchProducts(order.lines);
    cart.loadOrder(order, catalogue);
    selectedKey = null;
    await reprice();
  }

  async function discardChanges() {
    if (!cart.openOrder) return;
    try {
      const { order } = await api.get(`/open-orders/${cart.openOrder.id}`);
      await loadOrder(order);
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
  }

  /** The order stays open for later; the counter is cleared for the next one. */
  async function leaveOrder() {
    await api.del('/carts/active').catch(() => {});
    cart.clear();
    priced = null;
    render();
  }

  /** F7 in a café: every open order, oldest first, to take up, reprint or call off. */
  async function showOrders() {
    await refreshOrders();
    modalOpen = true;
    const close = () => { modalOpen = false; clear(panelHost); search.focus(); };
    const age = (at) => {
      const minutes = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60000));
      return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
    };

    const busy = !cart.isEmpty && cart.changedSinceLoaded();
    clear(panelHost).append(h('div', { class: 'pos-prompt open-orders-panel' }, [
      h('h2', { text: 'Open orders' }),
      openOrders.length === 0 ? h('p', { class: 'muted', text: 'No orders are open. Send one to the kitchen with F6.' }) : null,
      busy ? h('p', { class: 'muted', text: 'Send or pay the order on the counter before you take up another.' }) : null,
      ...openOrders.map((order) => h('div', { class: `open-order${cart.openOrder?.id === order.id ? ' is-current' : ''}` }, [
        h('button', {
          class: 'open-order-load',
          disabled: busy,
          onclick: async () => { close(); await loadOrder(order); },
        }, [
          h('strong', { text: `Order ${order.order_no}` }),
          h('span', { text: [order.order_type_label, order.table_label].filter(Boolean).join(' · ') }),
          h('span', { class: 'muted', text: `${order.line_count} line${order.line_count === 1 ? '' : 's'} · ${age(order.opened_at)}` }),
          h('span', { class: 'money', text: order.total_centavos === null ? '—' : money(order.total_centavos) }),
        ]),
        h('button', {
          class: 'rail-action', icon: 'printer', text: 'Ticket',
          disabled: policy?.orders?.kitchen_printer === 'NONE',
          onclick: async () => {
            try { const result = await api.post(`/open-orders/${order.id}/ticket`, {}); ticketNote(result.printed); ui.toast(`Order ${order.order_no}'s ticket printed again.`); } catch (err) { ui.toast(err.message, { kind: 'error' }); }
          },
        }),
        h('button', {
          class: 'rail-action', icon: 'x', text: 'Cancel…',
          onclick: () => cancelOrder(order),
        }),
      ])),
      h('div', { class: 'prompt-actions' }, [h('button', { text: 'Close', onclick: close })]),
    ]));
  }

  /** Called off before it is paid: a reason, and the kitchen told to stop (POS-109). */
  function cancelOrder(order) {
    prompt({
      title: `Cancel order ${order.order_no}${order.table_label ? ` — ${order.table_label}` : ''}`,
      label: 'Why? (the kitchen is told to stop)',
      inputmode: 'text',
      onSubmit: async (reason) => {
        try {
          const result = await api.post(`/open-orders/${order.id}/cancel`, { reason });
          if (cart.openOrder?.id === order.id) { cart.clear(); priced = null; render(); }
          ui.toast(`Order ${order.order_no} cancelled.`);
          ticketNote(result.printed);
          await refreshOrders();
        } catch (err) {
          ui.toast(err.message, { kind: 'error' });
        }
      },
    });
  }

  async function chooseCustomer() {
    modalOpen = true;
    const input = h('input', { type: 'search', placeholder: 'Name, code or number', autocomplete: 'off' });
    const hits = h('div', { class: 'customer-results' });
    const close = () => { modalOpen = false; clear(panelHost); search.focus(); };

    input.addEventListener('input', async () => {
      if (input.value.trim().length < 2) return;
      const { customers } = await api.get(`/customers?q=${encodeURIComponent(input.value.trim())}&limit=8`);
      clear(hits);
      for (const customer of customers) {
        hits.append(h('button', {
          class: 'customer-result',
          onclick: async () => {
            cart.customer = customer;
            close();
            await reprice();
            // §6: an over-limit customer is flagged when selected, not after payment.
            if (customer.credit && customer.credit.available_centavos <= 0) {
              ui.toast(`${customer.name} is at their credit limit.`, { kind: 'error' });
            }
          },
        }, [
          h('span', { text: customer.name }),
          h('span', { class: 'result-level', text: customer.price_level }),
          customer.credit
            ? h('span', { class: 'result-credit', text: `available ${money(customer.credit.available_centavos)}` })
            : null,
        ]));
      }
    });

    clear(panelHost).append(h('div', { class: 'pos-prompt' }, [
      h('h2', { text: 'Customer' }),
      h('label', { text: 'Search' }, [input]),
      hits,
      h('div', { class: 'prompt-actions' }, [
        // TASK-070: "Isulat, Aling Nena" — a customer added here by name, at the store's
        // counter credit limit. Only for a cashier who may add customers (TX-413).
        policy?.retail?.counter_customer?.may_add
          ? h('button', { icon: 'user-plus', text: 'New customer', onclick: () => newCustomer(input.value.trim(), close) })
          : null,
        h('button', { text: 'Walk-in', onclick: async () => { cart.customer = null; close(); await reprice(); } }),
        h('button', { text: 'Cancel', onclick: close }),
      ]),
    ]));
    queueMicrotask(() => input.focus());
  }

  /** TASK-070: a customer added at the counter by name. */
  function newCustomer(typed, closePicker) {
    const limit = policy?.retail?.counter_customer?.credit_limit_centavos || 0;
    closePicker();
    prompt({
      title: 'New customer',
      label: limit > 0 ? `Name — they may buy on credit up to ${money(limit)}` : 'Name',
      value: typed,
      inputmode: 'text',
      maxlength: '120',
      onSubmit: async (name) => {
        if (name.length < 2) return ui.toast('Enter the customer\'s name.', { kind: 'error' });
        try {
          const { customer } = await api.post('/customers/quick', { name });
          cart.customer = customer;
          ui.toast(`${customer.name} added.`);
          await reprice();
        } catch (err) {
          ui.toast(err.message, { kind: 'error' });
        }
        return undefined;
      },
    });
  }

  function authorise(auth) {
    modalOpen = true;
    clear(panelHost).append(ui.authorisationPanel({
      message: auth.message,
      ruleId: auth.rule_id,
      requiresRole: auth.requires_role,
      onCancel: () => { modalOpen = false; clear(panelHost); search.focus(); },
      onApprove: async ({ username, password }) => {
        // AUD-603: the approver authenticates as themselves, so the two actors the
        // server records are two people rather than one person typing a name.
        const approver = await api.approve(username, password, (priced.authorisations || []).map((a) => a.rule_id));
        modalOpen = false;
        clear(panelHost);
        onPay({ cart, priced, approver });
      },
    }));
  }

  function pay(options = {}) {
    if (cart.isEmpty) return ui.toast('The cart is empty.', { kind: 'error' });
    if (!priced) return ui.toast('Prices are still loading.', { kind: 'error' });
    if (priced.requires_authorisation) return authorise(priced.authorisations[0]);
    onPay({ cart, priced, ...options });
  }

  async function restore(saved) {
    if (!saved) return;
    await fetchProducts(saved.lines);
    cart.restore(saved, catalogue);
    // TASK-066: a draft that was an open order is that order again, so the counter can
    // still say what the kitchen has not been sent. An order paid or cancelled since
    // leaves the lines as a new order.
    if (saved.open_order_id && ordersOn()) {
      try {
        const { order } = await api.get(`/open-orders/${saved.open_order_id}`);
        if (order.status === 'OPEN') cart.attachOrder(order);
      } catch { /* gone: the lines stay, as a new order */ }
    }
    await reprice();
  }

  // ── Keyboard (§7) ─────────────────────────────────────────────────────────

  function onKeyDown(event) {
    if (isMapped(event.key)) {
      // Only the mapped keys are claimed, so browser and field behaviour elsewhere is
      // untouched.
      event.preventDefault();
      const action = actions[actionFor(event.key)];
      if (action) action();
      return;
    }

    // INT-3: the wedge types wherever focus is, provided no modal is open.
    if (document.activeElement !== search && !modalOpen && event.key.length === 1) {
      search.focus();
    }
    scanner.key({ key: event.key, modalOpen });
  }

  // ── Mount ─────────────────────────────────────────────────────────────────

  /**
   * The counter's actions as buttons (TASK-056), with the F-key beside each.
   *
   * This bar used to be key hints only, and a touch screen hid it — so on the tablet a
   * cashier could not change a quantity, give a discount or the senior/PWD 20%, remove a
   * line or bring back a parked sale at all: the only way to each was a key the tablet
   * does not have. Now each is a button a finger can press, and the key beside it (a
   * `.key-hint`, which a touch screen hides) is for whoever has a keyboard. Search,
   * Customer, Pay and Park & new have their own buttons already, so they stay hints.
   *
   * TAX-004 ships off in an agrivet, and a bar that offers a key the store cannot use is
   * a bar cashiers stop reading: SC/PWD shows where the store grants it.
   */
  function helpBar() {
    const empty = cart.isEmpty;
    const needsCart = new Set(['F3', 'F4', 'F5', 'F8', 'Delete', 'F6']);
    // TASK-066: a café's words for the same keys — F6 sends the order, F7 lists them.
    const labelOf = (key) => (ordersOn() && CAFE_LABELS[key]) || KEYMAP[key].label;
    const buttons = TOUCH_ACTIONS.filter((key) => key !== 'F8' || policy?.statutory?.enabled)
      .map((key) => h('button', {
        type: 'button', class: 'pos-action', 'aria-keyshortcuts': key,
        disabled: needsCart.has(key) && empty,
        onclick: () => { const run = actions[KEYMAP[key].action]; if (run) run(); },
      }, [
        h('span', { text: labelOf(key) }),
        h('kbd', { class: 'key-hint', text: key === 'Delete' ? 'Del' : key }),
      ]));
    // POS-111: a note for the kitchen, where there is a kitchen. A button only — every
    // function key is spoken for, and F11 is the screen's own.
    if (ordersOn()) {
      buttons.splice(buttons.length - 2, 0, h('button', {
        type: 'button', class: 'pos-action', disabled: empty, onclick: () => actions.note(),
      }, [h('span', { text: 'Note' })]));
    }
    // TASK-070: "₱20 of rice", where a line is sold in parts. A button only, like Note.
    if (cart.lines.some((l) => l.baseUnitAllowsFraction && !l.packUnitId)) {
      buttons.splice(1, 0, h('button', {
        type: 'button', class: 'pos-action', onclick: () => sellByAmount(),
      }, [h('span', { text: 'By amount' })]));
    }
    const hints = HELP_ORDER.filter((key) => !TOUCH_ACTIONS.includes(key))
      .map((key) => h('span', { class: 'help-key' }, [h('kbd', { text: key }), h('span', { text: labelOf(key) })]));
    return h('div', { class: 'pos-help' }, [
      h('div', { class: 'pos-actions', role: 'toolbar', 'aria-label': 'Counter actions' }, buttons),
      h('div', { class: 'pos-hints key-hint' }, hints),
    ]);
  }

  async function mount() {
    clear(root).append(
      h('div', { class: 'pos' }, [
        topHost,
        h('div', { class: 'pos-main' }, [
          h('div', { class: 'pos-searchbar' }, [
            search,
            // TASK-069: the phone's camera as a scanner. It stays open for the next item,
            // and each code goes where a wedge scan goes.
            cameraButton({
              continuous: true,
              title: 'Scan items',
              onCode: async (code) => {
                const before = cart.count;
                await scan(code);
                const line = selected();
                return cart.count >= before && line ? `${line.name} added. Scan the next one, or press Done.` : null;
              },
              onOpen: () => { modalOpen = true; },
              onClose: () => { modalOpen = false; search.focus(); },
            }),
            results,
          ]),
          quickHost,
          attachBar,
          linesHost,
          panelHost,
          helpHost,
        ]),
        railHost,
      ])
    );

    search.addEventListener('input', () => {
      if (search.value.trim().length >= 2) lookup(search.value.trim());
      else results.hidden = true;
    });
    document.addEventListener('keydown', onKeyDown);

    // OPS-005 at the counter: the ceilings, the bands and TAX-004's switch and rate all
    // come from the server. A screen holding its own copy of any of them is a screen
    // that is wrong the day the owner changes one.
    try {
      policy = await api.get('/sales/pricing-policy');
    } catch { /* the sale re-checks every one of them regardless */ }
    // TASK-066: a café's counter starts on the first way it serves — dine-in.
    if (ordersOn() && !cart.orderType) cart.orderType = policy.orders.order_types[0].code;

    render();
    refreshOrders();
    refreshQuickKeys();

    // POS-105: come back to the cart that was open.
    try {
      const { cart: saved } = await api.get('/carts/active');
      if (saved) {
        await restore(saved);
        ui.toast(`Your cart was restored — ${saved.line_count} line${saved.line_count === 1 ? '' : 's'}.`);
      }
    } catch { /* no shift open yet; the shell handles that */ }
  }

  function unmount() {
    document.removeEventListener('keydown', onKeyDown);
  }

  return { mount, unmount, cart, reprice, restore, get priced() { return priced; } };
}
