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
import { createCart } from './cart.js';
import { createScanner } from '../shell/scanner.js';
import { KEYMAP, HELP_ORDER, actionFor, isMapped } from '../shell/keymap.js';

export function createPos({ root, session, onPay }) {
  const cart = createCart();
  const catalogue = new Map();
  let priced = null;
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
  const panelHost = h('div', { class: 'pos-panel' });
  const results = h('div', { class: 'search-results', hidden: true });

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

    cart.lines.forEach((line) => {
      const pricedLine = priced?.lines?.find((l) => l.product_id === line.productId);
      const selected = line.key === selectedKey;

      linesHost.append(h('div', {
        class: `cart-line${selected ? ' is-selected' : ''}${line.unavailable ? ' is-unavailable' : ''}`,
        role: 'listitem',
        tabindex: '0',
        'aria-current': selected ? 'true' : null,
        onclick: () => { selectedKey = line.key; renderLines(); },
      }, [
        h('div', { class: 'cart-line-name', text: line.name }),
        h('div', { class: 'cart-line-detail' }, [
          // POS-102: both the entered pack and the base unit; the ledger stores base.
          h('span', {
            class: 'qty',
            text: packAndBase({
              qtyMilli: line.qtyMilli,
              baseUnit: line.baseUnit,
              packUnit: line.packUnitCode,
              packFactorMilli: line.packFactorMilli,
            }),
          }),
          h('span', { class: 'sep', text: '×' }),
          h('span', {
            class: 'unit-price',
            text: pricedLine ? `${money(pricedLine.unit_price_centavos)}/${line.baseUnit}` : '—',
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
    if (!applied) return null;

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
    if (!product || product.on_hand_milli === undefined || product.on_hand_milli === null) return null;

    const takenBefore = cart.lines
      .slice(0, cart.lines.findIndex((l) => l.key === line.key) + 1)
      .filter((l) => l.productId === line.productId)
      .reduce((sum, l) => sum + l.qtyMilli, 0);
    return product.on_hand_milli - takenBefore;
  }

  function renderRail() {
    const customer = cart.customer;
    clear(railHost).append(
      h('div', { class: 'rail-block' }, [
        h('h2', { text: 'Customer' }),
        h('p', { class: 'rail-customer', text: customer ? customer.name : 'Walk-in' }),
        h('button', { class: 'rail-action', text: 'Change  F2', onclick: () => chooseCustomer() }),
        h('p', { class: 'rail-level', text: `Price: ${customer?.price_level || 'RETAIL'}` }),
      ]),
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
        priced?.tax_summary ? row('VAT', money(priced.tax_amount_centavos)) : null,
        h('hr'),
        row('TOTAL', priced ? money(priced.total_centavos) : money(0), 'total'),
      ]),
      h('div', { class: 'rail-block' }, [
        h('button', {
          class: 'primary pay', text: 'PAY  F9',
          disabled: cart.isEmpty || !priced || priced.requires_authorisation,
          onclick: () => pay(),
        }),
        h('button', { class: 'rail-action', text: 'Park & new  F12', onclick: () => park({ andNew: true }) }),
      ]),
      // PR-105 and PR-203 surfaced where they happen (§6), not at Complete.
      priced?.requires_authorisation ? authorisations() : null
    );
  }

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
        h('button', { text: 'Authorise', onclick: () => authorise(auth) }),
      ])),
    ]);
  }

  function render() {
    renderLines();
    renderRail();
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
        await addProduct(result.product);
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

  async function addProduct(product) {
    catalogue.set(product.id, await withStock(product));
    cart.add({ product });
    selectedKey = `${product.id}:base`;
    await reprice();
  }

  /** POS-104 needs on-hand, which the product payload does not carry. */
  async function withStock(product) {
    try {
      const { on_hand: onHand } = await api.get(`/inventory/${product.id}`);
      return { ...product, on_hand_milli: onHand.qty_on_hand_milli };
    } catch {
      return product;
    }
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
          h('span', { class: 'result-name', text: product.name }),
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

  function prompt({ title, label, value = '', onSubmit }) {
    modalOpen = true;
    const input = h('input', { type: 'text', value, autocomplete: 'off', inputmode: 'decimal' });
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

  const actions = {
    search: () => search.focus(),
    customer: () => chooseCustomer(),

    quantity: () => {
      const line = selected();
      if (!line) return;
      prompt({
        title: `Quantity — ${line.name}`,
        label: `In ${line.baseUnit}${line.packUnitCode ? ` or ${line.packUnitCode}` : ''}`,
        value: String(line.qtyMilli / 1000),
        onSubmit: async (raw) => {
          const qty = Math.round(Number.parseFloat(raw) * 1000);
          if (!Number.isFinite(qty) || qty <= 0) return ui.toast('Enter a quantity greater than zero.', { kind: 'error' });
          cart.setQuantity(line.key, qty);
          await reprice();
        },
      });
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

    park: () => park({ andNew: false }),
    parkAndNew: () => park({ andNew: true }),
    retrieve: () => retrieve(),
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
        h('button', { text: 'Walk-in', onclick: async () => { cart.customer = null; close(); await reprice(); } }),
        h('button', { text: 'Cancel', onclick: close }),
      ]),
    ]));
    queueMicrotask(() => input.focus());
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
        const approver = await api.post('/auth/login', { username, password });
        modalOpen = false;
        clear(panelHost);
        onPay({ cart, priced, approver: approver.user, approverToken: approver.token });
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
    for (const line of saved.lines || []) {
      if (catalogue.has(line.productId)) continue;
      try {
        const { product } = await api.get(`/products/${line.productId}`);
        catalogue.set(product.id, await withStock(product));
      } catch { /* left unavailable and flagged by the cart model */ }
    }
    cart.restore(saved, catalogue);
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

  function helpBar() {
    return h('div', { class: 'pos-help' }, HELP_ORDER.map((key) => h('span', { class: 'help-key' }, [
      h('kbd', { text: key }),
      h('span', { text: KEYMAP[key].label }),
    ])));
  }

  async function mount() {
    clear(root).append(
      h('div', { class: 'pos' }, [
        h('div', { class: 'pos-main' }, [
          h('div', { class: 'pos-searchbar' }, [search, results]),
          attachBar,
          linesHost,
          panelHost,
          helpBar(),
        ]),
        railHost,
      ])
    );

    search.addEventListener('input', () => {
      if (search.value.trim().length >= 2) lookup(search.value.trim());
      else results.hidden = true;
    });
    document.addEventListener('keydown', onKeyDown);

    render();

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
