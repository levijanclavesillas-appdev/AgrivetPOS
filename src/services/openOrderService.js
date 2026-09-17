'use strict';

// POS-109, POS-110 — orders taken before they are paid, and the kitchen's ticket (TASK-066).
//
// A café takes the order at the table, the kitchen makes it, and the customer pays when
// they leave. Until they pay it is not a sale: no number from POS-108, no money, no stock
// moved. It is this — an order with a number the counter calls, a table, the lines the
// customer asked for, and a record of what the kitchen has been told.
//
// **The kitchen is told what changed, not the whole order again.** Each send compares
// the order with `sent` and prints only the difference: two more coffees, one rice bowl
// the customer no longer wants. A cook handed the whole order a second time makes it
// twice. The first ticket is the whole order; paying for an order prints whatever was
// added at the counter and never sent; cancelling one tells the kitchen to stop.
//
// **Prices are not held.** Like a parked cart, an order's lines are products and
// quantities, priced when it is shown and again when it is paid (§4.1 step 2).
//
// **It belongs to this counter, and outlives the shift.** Open orders are never synced
// (config/syncTables.js): the order is where the table's cashier took it. A shift closes
// with orders still open — the table is still eating when the drawer is counted — and
// whoever is on the counter next is paid for them; the close says how many carried over.

const db = require('../config/database');
const ids = require('../config/ids');
const clock = require('../config/clock');
const errors = require('./errors');
const auditService = require('./auditService');
const settingsService = require('./settingsService');
const storeProfileService = require('./storeProfileService');
const documentService = require('./documentService');
const printService = require('./printService');
const cartService = require('./cartService');
const shiftService = require('./shiftService');
const pricingService = require('./pricingService');
const openOrderRepository = require('../repositories/openOrderRepository');
const productRepository = require('../repositories/productRepository');
const referenceRepository = require('../repositories/referenceRepository');
const customerRepository = require('../repositories/customerRepository');
const userRepository = require('../repositories/userRepository');
const saleRepository = require('../repositories/saleRepository');

const ORDER_TYPES = Object.freeze(['DINE_IN', 'TAKE_OUT', 'DELIVERY']);
const TABLE_MAX = 30;
const VOID_REASON_MIN = 3;

const textOrNull = (value, max = 200) => {
  const trimmed = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
  return trimmed || null;
};

// ── The rules at the door ───────────────────────────────────────────────────

function enabled() {
  return settingsService.get('open_orders_enabled');
}

function assertEnabled() {
  if (enabled()) return;
  throw errors.conflict(
    'This store does not take orders before they are paid. The owner turns it on in Settings '
    + '(take orders before they are paid).',
    { ruleId: 'POS-109' }
  );
}

/** POS-109: dine-in, take-out or delivery. Refused rather than guessed. */
function orderTypeOf(value, { required = true } = {}) {
  const type = typeof value === 'string' ? value.trim().toUpperCase().replace(/[\s-]+/g, '_') : '';
  if (ORDER_TYPES.includes(type)) return type;
  if (!type && !required) return null;
  throw errors.badRequest('Say how the order is served: dine-in, take-out or delivery.', { ruleId: 'POS-109' });
}

const tableOf = (value) => textOrNull(value, TABLE_MAX);

/**
 * POS-112: the service charge a bill of this kind carries, in basis points. Dine-in only —
 * a customer who takes the food away was not served at a table.
 */
function serviceChargeBpFor(orderType) {
  return orderType === 'DINE_IN' ? settingsService.get('service_charge_bp') : 0;
}

// ── What the kitchen has been told ──────────────────────────────────────────

const keyOf = (line) => `${line.productId}|${line.packUnitId || ''}|${line.note || ''}`;

/** Lines folded by product, unit and note — the units a kitchen ticket speaks in. */
function entriesOf(lines) {
  const entries = new Map();
  for (const line of lines || []) {
    const key = keyOf(line);
    const entry = entries.get(key) || {
      key, productId: line.productId, packUnitId: line.packUnitId || null, note: line.note || null, qtyMilli: 0,
    };
    entry.qtyMilli += line.qtyMilli;
    entries.set(key, entry);
  }
  return [...entries.values()];
}

/**
 * From what was sent to what is wanted now, as ticket lines with the product's name.
 * An empty list means the kitchen already knows everything.
 */
function changesBetween(sent, now) {
  const before = new Map(entriesOf(sent).map((e) => [e.key, e]));
  const after = new Map(entriesOf(now).map((e) => [e.key, e]));
  const keys = [...new Set([...after.keys(), ...before.keys()])];
  return keys
    .map((key) => {
      const entry = after.get(key) || before.get(key);
      const deltaMilli = (after.get(key)?.qtyMilli || 0) - (before.get(key)?.qtyMilli || 0);
      return { ...entry, deltaMilli };
    })
    .filter((entry) => entry.deltaMilli !== 0)
    .map(named);
}

/** A ticket line needs the name a cook knows it by and the unit it is counted in. */
function named(entry) {
  const product = productRepository.findById(entry.productId);
  const pack = entry.packUnitId ? referenceRepository.findById('units', entry.packUnitId) : null;
  return {
    ...entry,
    name: product ? product.name : 'Unknown item',
    unitCode: product ? product.base_unit_code : null,
    packCode: pack && product && pack.id !== product.base_unit_id ? pack.code : null,
  };
}

/** The lines of a paid sale, in the shape an order's lines take. */
function linesOfSale(saleId) {
  return saleRepository.itemsFor(saleId).map((item) => {
    const factor = item.sold_pack_factor_milli || 1000;
    return {
      productId: item.product_id,
      packUnitId: factor === 1000 ? null : item.sold_unit_id,
      qtyMilli: factor === 1000 ? item.qty_milli : Math.round((item.qty_milli * 1000) / factor),
      note: item.note || null,
    };
  });
}

/**
 * POS-110: print a ticket, where the store has a kitchen printer. Outside every
 * transaction (INT-1): a jammed kitchen printer does not un-take an order, and the
 * ticket is queued for reprint like any document that did not print.
 */
function printTicket({ order, lines, kind, actor, reprint = false }) {
  if (settingsService.get('kitchen_printer') === 'NONE') return { document: null, printed: null };
  const document = printService.renderKitchenTicket({
    order, lines, kind, sentBy: actor ? actor.username : null, at: clock.nowUtc(), reprint,
  });
  return { document, printed: documentService.print(document) };
}

// ── Sending ─────────────────────────────────────────────────────────────────

/**
 * Take an order, or send the changes to one already taken (POS-109, POS-110).
 *
 * The lines are validated the way a sale's are — every product sellable and priced — so
 * an order that reaches the kitchen is one the till can take payment for. Discounts ride
 * along and are authorised at payment, where the amount is final.
 */
function send({ id = null, lines = [], orderType, tableLabel = null, customerId = null, transactionDiscountCentavos = 0 }, actor) {
  assertEnabled();
  const shift = shiftService.requireOpenShift(actor, { action: 'take an order' });
  const normalised = cartService.normaliseLines(lines);
  if (normalised.length === 0) {
    throw errors.badRequest('An order needs at least one line.', { ruleId: 'POS-101' });
  }
  const type = orderTypeOf(orderType);
  const table = tableOf(tableLabel);
  const customer = customerId ? customerRepository.findById(customerId) : null;
  if (customerId && !customer) throw errors.notFound('No such customer');
  const discount = Number.isInteger(transactionDiscountCentavos) ? transactionDiscountCentavos : 0;

  // Refuses a withdrawn or unpriced product now, in front of the customer, not at payment.
  priceOf({ lines: normalised, customer, transactionDiscountCentavos: discount, orderType: type });

  const at = clock.nowUtc();
  const payload = JSON.stringify({ lines: normalised, transactionDiscountCentavos: discount });

  const result = db.transaction(() => {
    const existing = id ? openOrderRepository.findById(id) : null;
    if (id && !existing) throw errors.notFound('No such order');
    if (existing) assertOpen(existing);

    const sent = existing ? JSON.parse(existing.sent) : [];
    const changes = changesBetween(sent, normalised);
    const fields = {
      order_type: type,
      table_label: table,
      customer_id: customer ? customer.id : null,
      payload,
      sent: JSON.stringify(normalised),
      line_count: normalised.length,
      ticket_count: (existing ? existing.ticket_count : 0) + (changes.length > 0 ? 1 : 0),
      updated_at: at,
    };

    const row = existing
      ? openOrderRepository.update(existing.id, fields)
      : openOrderRepository.insert({
        id: ids.uuidv7(),
        order_no: openOrderRepository.nextNumber(clock.manilaDate(at)),
        business_date: clock.manilaDate(at),
        status: 'OPEN',
        opened_by: actor.id,
        opened_shift_id: shift.id,
        opened_at: at,
        ...fields,
      });
    return { row, changes, isNew: !existing };
  }, { immediate: true });

  const ticket = result.changes.length > 0
    ? printTicket({ order: result.row, lines: result.changes, kind: result.isNew ? 'NEW' : 'CHANGES', actor })
    : { document: null, printed: null };

  return {
    order: present(result.row),
    changes: result.changes.length,
    ticket: ticket.document ? { text: ticket.document.text } : null,
    printed: ticket.printed,
  };
}

function assertOpen(order) {
  if (order.status === 'OPEN') return;
  throw errors.conflict(
    order.status === 'PAID'
      ? `Order ${order.order_no} has already been paid.`
      : `Order ${order.order_no} was cancelled (${order.void_reason}).`,
    { ruleId: 'POS-109' }
  );
}

/**
 * Call an order off before it is paid. A reason, audited, and a ticket telling the
 * kitchen to stop — the food may be half made, and the cook needs to know now.
 */
function cancel(id, { reason } = {}, actor) {
  assertEnabled();
  const why = textOrNull(reason);
  if (!why || why.length < VOID_REASON_MIN) {
    throw errors.badRequest('Say why the order is cancelled — the customer left, it was entered twice.', { ruleId: 'POS-109' });
  }
  const at = clock.nowUtc();

  const row = db.transaction(() => {
    const order = openOrderRepository.findById(id);
    if (!order) throw errors.notFound('No such order');
    assertOpen(order);
    const updated = openOrderRepository.update(id, {
      status: 'VOIDED', void_reason: why, closed_at: at, closed_by: actor.id, updated_at: at,
    });
    auditService.write({
      actor,
      action: 'OPEN_ORDER_VOIDED',
      entityType: 'open_orders',
      entityId: id,
      before: { status: 'OPEN', order_no: order.order_no, table_label: order.table_label, lines: JSON.parse(order.payload).lines },
      after: { status: 'VOIDED' },
      reason: why,
      shiftId: actor.shiftId || null,
    });
    return updated;
  }, { immediate: true });

  const sent = JSON.parse(row.sent);
  const ticket = sent.length > 0
    ? printTicket({ order: row, lines: changesBetween(sent, []), kind: 'CANCELLED', actor })
    : { document: null, printed: null };
  return { order: present(row), printed: ticket.printed };
}

/** The whole order again, marked REPRINT — the ticket fell behind the grill. */
function reprintTicket(id, actor) {
  const order = openOrderRepository.findById(id);
  if (!order) throw errors.notFound('No such order');
  if (settingsService.get('kitchen_printer') === 'NONE') {
    throw errors.conflict('This store has no kitchen printer set. Choose one in Settings.', { ruleId: 'POS-110' });
  }
  const lines = changesBetween([], JSON.parse(order.sent));
  const ticket = printTicket({ order, lines, kind: 'NEW', actor, reprint: true });
  return { order: present(order), printed: ticket.printed };
}

// ── Payment (called by saleService, inside the sale's transaction) ──────────

/** POS-109: the order a sale is paying for, still open. */
function forPayment(id) {
  assertEnabled();
  const order = openOrderRepository.findById(id);
  if (!order) throw errors.notFound('No such order');
  assertOpen(order);
  return order;
}

/**
 * The sale is written: the order is paid, or — a café's sale rung up without an order,
 * a take-out paid at once — it gets a number of its own, so the kitchen and the
 * customer both have one to call.
 */
function recordPayment({ order = null, saleId, orderType, tableLabel, customerId = null, actor, shiftId, at }) {
  if (order) {
    return openOrderRepository.update(order.id, {
      status: 'PAID', sale_id: saleId, closed_at: at, closed_by: actor.id, updated_at: at,
      order_type: orderType, table_label: tableLabel,
    });
  }
  if (!enabled()) return null;
  return openOrderRepository.insert({
    id: ids.uuidv7(),
    order_no: openOrderRepository.nextNumber(clock.manilaDate(at)),
    business_date: clock.manilaDate(at),
    status: 'PAID',
    order_type: orderType || 'TAKE_OUT',
    table_label: tableLabel,
    customer_id: customerId,
    payload: JSON.stringify({ lines: [], transactionDiscountCentavos: 0 }),
    sent: '[]',
    line_count: 0,
    ticket_count: 0,
    opened_by: actor.id,
    opened_shift_id: shiftId,
    opened_at: at,
    updated_at: at,
    sale_id: saleId,
    closed_at: at,
    closed_by: actor.id,
  });
}

/**
 * After a sale commits (INT-1): the kitchen is told whatever it has not been — every line
 * of a sale rung up without an order, and what was added at the counter to one that was.
 */
function ticketForSale(saleId, actor) {
  const order = openOrderRepository.findBySale(saleId);
  if (!order) return null;
  const lines = linesOfSale(saleId);
  const changes = changesBetween(JSON.parse(order.sent), lines);
  if (changes.length === 0) return null;
  const firstTicket = order.ticket_count === 0;
  openOrderRepository.update(order.id, {
    sent: JSON.stringify(lines), ticket_count: order.ticket_count + 1, updated_at: clock.nowUtc(),
  });
  const ticket = printTicket({ order, lines: changes, kind: firstTicket ? 'NEW' : 'CHANGES', actor });
  return ticket.printed;
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** Priced now, like a parked cart: what paying for it would cost at this moment. */
function priceOf({ lines, customer, transactionDiscountCentavos, orderType }) {
  const { pricingLinesOf } = require('./saleService');
  return pricingService.priceCart({
    lines: pricingLinesOf(lines),
    customer,
    taxMode: storeProfileService.taxMode(),
    transactionDiscountCentavos,
    serviceChargeBp: serviceChargeBpFor(orderType),
  });
}

function present(row) {
  const payload = JSON.parse(row.payload);
  const sent = JSON.parse(row.sent);
  const customer = row.customer_id ? customerRepository.findById(row.customer_id) : null;
  let priced = null;
  if (payload.lines.length > 0) {
    try {
      priced = priceOf({
        lines: payload.lines, customer, transactionDiscountCentavos: payload.transactionDiscountCentavos || 0,
        orderType: row.order_type,
      });
    } catch {
      priced = null;   // a product withdrawn since: shown, so it can be fixed (POS-106's reasoning)
    }
  }
  const openedBy = userRepository.findById(row.opened_by);
  return {
    id: row.id,
    order_no: row.order_no,
    status: row.status,
    order_type: row.order_type,
    order_type_label: printService.ORDER_TYPE_LABELS[row.order_type],
    table_label: row.table_label,
    customer: customer ? { id: customer.id, name: customer.name, price_level: customer.price_level } : null,
    lines: payload.lines,
    transaction_discount_centavos: payload.transactionDiscountCentavos || 0,
    line_count: row.line_count,
    ticket_count: row.ticket_count,
    // What paying would add at the counter that the kitchen has not seen. Always false for
    // an order sent as it stands.
    unsent_changes: changesBetween(sent, payload.lines).length > 0,
    total_centavos: priced ? priced.total_centavos : null,
    priced,
    unpriceable: payload.lines.length > 0 && priced === null,
    opened_by: openedBy ? openedBy.username : null,
    opened_at: row.opened_at,
    opened_at_manila: clock.toManila(row.opened_at),
    updated_at: row.updated_at,
    sale_id: row.sale_id,
    closed_at: row.closed_at,
    void_reason: row.void_reason,
  };
}

function list() {
  return { orders: openOrderRepository.listOpen().map(present) };
}

function get(id) {
  const row = openOrderRepository.findById(id);
  if (!row) throw errors.notFound('No such order');
  return { order: present(row) };
}

/** For a receipt: the number the counter called for this sale, where it had one. */
function numberForSale(saleId) {
  const row = openOrderRepository.findBySale(saleId);
  return row ? row.order_no : null;
}

/** POS-109 at shift close: what is still open, carried to whoever is on next. */
function carriedOver() {
  const open = openOrderRepository.listOpen();
  return {
    count: open.length,
    orders: open.map((row) => ({ order_no: row.order_no, table_label: row.table_label, order_type: row.order_type })),
  };
}

module.exports = {
  ORDER_TYPES, TABLE_MAX,
  enabled, assertEnabled, orderTypeOf, tableOf, serviceChargeBpFor,
  entriesOf, changesBetween,
  send, cancel, reprintTicket, forPayment, recordPayment, ticketForSale,
  list, get, present, numberForSale, carriedOver,
};
