'use strict';

// FR_3.7 / INT-1, INT-2 — the templates, the transport and the reprint.
//
// Three documents: the sale receipt, the collection acknowledgement (CR-206) and the
// shift closing summary. Every one of them is an **internal transaction record**
// (TAX-006), and this file is where that boundary is either honoured or quietly broken
// by a helpful template — 01_PRODUCT_BRIEF.md §5 puts BIR receipting permanently out of
// scope, so nothing rendered here may look like an Official Receipt.
//
// Printing is best-effort and outside every business transaction (INT-1). A jammed
// printer raises a toast and queues the document for reprint; it never rolls back a
// committed sale, and nothing in this file throws for a hardware fault.

const fs = require('fs');
const net = require('net');
const clock = require('../config/clock');
const money = require('./money');
const escpos = require('./escpos');
const documentService = require('./documentService');
const settingsService = require('./settingsService');

/** Documents that failed to print, waiting for POS-208's reprint. */
const queue = [];
const MAX_QUEUED = 100;

function width() {
  return escpos.assertWidth(settingsService.get('receipt_width_columns'));
}

// ── Templates ───────────────────────────────────────────────────────────────

/**
 * The block every document opens with.
 *
 * TAX-006's required sentence is added by `close()` at the foot of each template
 * rather than here, so a template cannot be written that omits it — the composer adds
 * it, and documentService refuses to print anything without it.
 */
function header(profile, title, columns) {
  const lines = [
    escpos.centre(profile.store_name, columns),
    ...(profile.address ? escpos.wrap(profile.address, columns).map((l) => escpos.centre(l, columns)) : []),
    ...(profile.contact_no ? [escpos.centre(profile.contact_no, columns)] : []),
    ...(profile.tin ? [escpos.centre(`TIN ${profile.tin}`, columns)] : []),
    '',
    escpos.centre(title, columns),
  ];
  return lines;
}

/**
 * The foot every document closes with, carrying TAX-006's sentence verbatim.
 *
 * Not optional, not configurable, and not omitted in any tax mode — the rule says so
 * in its own last sentence.
 */
function footer(columns, { reprint = false } = {}) {
  return [
    '',
    ...(reprint ? [escpos.centre('*** REPRINT ***', columns), ''] : []),
    escpos.centre(documentService.REQUIRED_NOTICE, columns),
  ];
}

/**
 * The sale receipt (SCR-304).
 *
 * TAX-007: in `VAT` mode it adds the VATable / exempt / zero-rated / VAT-amount block,
 * because the store needs those figures for its own bookkeeping. In `NONE` and
 * `NON_VAT` there is nothing to add — TAX-002 computes no tax at all, and a block of
 * zeroes would imply the store is registered.
 */
function renderSaleReceipt({ sale, items, tenders, profile, reprint = false, columns = width() }) {
  escpos.assertWidth(columns);
  const lines = [
    ...header(profile, 'TRANSACTION RECORD', columns),
    escpos.centre(sale.sale_no, columns),
    escpos.centre(clock.toManila(sale.occurred_at), columns),
    escpos.divider(columns),
  ];

  for (const item of items) {
    lines.push(...escpos.itemLines({
      name: item.name,
      qtyDisplay: item.qty_display,
      unitPrice: money.toDisplay(item.unit_price_centavos, { symbol: false }),
      lineTotal: money.toDisplay(item.line_total_centavos, { symbol: false }),
    }, columns));

    if (item.discount_centavos > 0) {
      lines.push(escpos.leftRight('  Discount', `-${money.toDisplay(item.discount_centavos, { symbol: false })}`, columns));
    }
  }

  lines.push(escpos.divider(columns));
  lines.push(escpos.leftRight('Subtotal', money.toDisplay(sale.subtotal_centavos, { symbol: false }), columns));

  if (sale.line_discount_centavos > 0) {
    lines.push(escpos.leftRight('Line discounts', `-${money.toDisplay(sale.line_discount_centavos, { symbol: false })}`, columns));
  }
  if (sale.txn_discount_centavos > 0) {
    lines.push(escpos.leftRight('Discount', `-${money.toDisplay(sale.txn_discount_centavos, { symbol: false })}`, columns));
  }

  lines.push(escpos.leftRight('TOTAL', money.toDisplay(sale.total_centavos, { symbol: false }), columns));
  lines.push('');

  for (const tender of tenders) {
    // POS-206: a non-cash tender prints RECORDED beside the amount. It means "the
    // cashier saw it" — no payment API confirms these, and a receipt that said
    // "verified" would be claiming something nobody checked.
    const label = tender.method === 'CASH' ? tender.method : `${tender.method} ${tender.status}`;
    lines.push(escpos.leftRight(label, money.toDisplay(tender.amount_centavos, { symbol: false }), columns));
    if (tender.reference_no) lines.push(`  Ref ${escpos.truncate(tender.reference_no, columns - 6)}`);
  }

  if (sale.change_centavos > 0) {
    lines.push(escpos.leftRight('CHANGE', money.toDisplay(sale.change_centavos, { symbol: false }), columns));
  }

  // TAX-007, in VAT mode only.
  if (sale.tax_mode === 'VAT') {
    lines.push('', escpos.divider(columns));
    lines.push(escpos.centre('VAT SUMMARY (12%)', columns));
    lines.push(escpos.leftRight('VATable', money.toDisplay(sale.vatable_centavos, { symbol: false }), columns));
    lines.push(escpos.leftRight('VAT-exempt', money.toDisplay(sale.vat_exempt_centavos, { symbol: false }), columns));
    lines.push(escpos.leftRight('Zero-rated', money.toDisplay(sale.zero_rated_centavos, { symbol: false }), columns));
    lines.push(escpos.leftRight('VAT', money.toDisplay(sale.vat_centavos, { symbol: false }), columns));
  }

  lines.push(...footer(columns, { reprint }));

  return {
    kind: 'SALE_RECEIPT',
    document_no: sale.sale_no,
    sale_id: sale.id,
    reprint,
    columns,
    text: lines.join('\n'),
  };
}

/** CR-206's acknowledgement, at the configured width. */
function renderAcknowledgement({
  profile, documentNo, customer, amountCentavos, method, referenceNo,
  balanceAfterCentavos, allocations = [], receivedBy, at, columns = width(), reprint = false,
}) {
  escpos.assertWidth(columns);
  const owed = balanceAfterCentavos > 0;

  const lines = [
    ...header(profile, 'COLLECTION ACKNOWLEDGEMENT', columns),
    escpos.centre(documentNo, columns),
    escpos.centre(clock.toManila(at), columns),
    escpos.divider(columns),
    ...escpos.wrap(`Customer: ${customer.name}${customer.code ? ` (${customer.code})` : ''}`, columns),
    escpos.leftRight('Amount', money.toDisplay(amountCentavos, { symbol: false }), columns),
    escpos.leftRight('Method', method + (referenceNo ? '' : ''), columns),
    ...(referenceNo ? [`  Ref ${escpos.truncate(referenceNo, columns - 6)}`] : []),
  ];

  if (allocations.length > 0) {
    lines.push('', 'Applied to:');
    for (const allocation of allocations) {
      lines.push(escpos.leftRight(
        `  ${allocation.sale_document_no}`,
        money.toDisplay(allocation.amount_centavos, { symbol: false }),
        columns
      ));
      lines.push(`    ${allocation.settled_in_full ? 'settled' : 'part payment'}`);
    }
  }

  lines.push(
    '',
    escpos.divider(columns),
    escpos.leftRight(
      owed ? 'Balance now' : 'Store credit',
      money.toDisplay(Math.abs(balanceAfterCentavos), { symbol: false }),
      columns
    ),
    escpos.leftRight('Received by', escpos.truncate(receivedBy, 16), columns),
    ...footer(columns, { reprint })
  );

  return {
    kind: 'COLLECTION_ACKNOWLEDGEMENT',
    document_no: documentNo,
    reprint,
    columns,
    text: lines.join('\n'),
  };
}

/** The shift closing summary the store files with the drawer count. */
function renderClosingSummary({
  profile, shift, expected, lines: methodLines, variance, beyondTolerance, tolerance,
  reason, closedBy, at, columns = width(), reprint = false,
}) {
  escpos.assertWidth(columns);
  const amount = (centavos) => money.toDisplay(centavos, { symbol: false });

  const out = [
    ...header(profile, 'SHIFT CLOSING SUMMARY', columns),
    escpos.centre(clock.toManila(at), columns),
    escpos.divider(columns),
    escpos.leftRight('Opened', clock.toManila(shift.opened_at), columns),
    escpos.leftRight('Closed by', escpos.truncate(closedBy, 16), columns),
    '',
    escpos.leftRight('Opening float', amount(expected.opening_float_centavos), columns),
    escpos.leftRight('Cash sales', amount(expected.cash_sales_centavos), columns),
    escpos.leftRight('Cash collections', amount(expected.cash_collections_centavos), columns),
    escpos.leftRight('Cash in', amount(expected.cash_in_centavos), columns),
    escpos.leftRight('Cash out', `-${amount(expected.cash_out_centavos)}`, columns),
    escpos.leftRight('Change given', `-${amount(expected.change_given_centavos)}`, columns),
    escpos.divider(columns),
  ];

  for (const line of methodLines) {
    out.push(line.method);
    out.push(escpos.leftRight('  expected', amount(line.expected_centavos), columns));
    // A method that cannot be counted says so rather than showing a counted figure
    // nobody produced (POS-510, and credit's exclusion from it).
    out.push(line.reconcilable === false
      ? escpos.leftRight('  not counted', 'credit given', columns)
      : escpos.leftRight('  counted', amount(line.actual_centavos), columns));
    if (line.reconcilable !== false && line.variance_centavos !== 0) {
      out.push(escpos.leftRight(
        '  variance',
        `${amount(Math.abs(line.variance_centavos))} ${line.variance_centavos < 0 ? 'short' : 'over'}`,
        columns
      ));
    }
  }

  out.push(
    escpos.divider(columns),
    escpos.leftRight(
      'CASH VARIANCE',
      variance === 0 ? 'balanced' : `${amount(Math.abs(variance))} ${variance < 0 ? 'short' : 'over'}`,
      columns
    )
  );

  if (beyondTolerance) out.push(...escpos.wrap(`Beyond the ${amount(tolerance)} tolerance.`, columns));
  if (reason) out.push('', 'Reason:', ...escpos.wrap(reason, columns));

  out.push(...footer(columns, { reprint }));

  return {
    kind: 'SHIFT_CLOSING',
    document_no: null,
    shift_id: shift.id,
    reprint,
    columns,
    text: out.join('\n'),
  };
}

// ── Transport (INT-1) ───────────────────────────────────────────────────────

/**
 * Send bytes to the printer.
 *
 * Three transports, chosen by a setting rather than detected: a store that has not
 * plugged one in yet is `NONE`, and saying so is better than a five-second timeout at
 * the counter on every sale.
 *
 * Never throws. INT-1 makes printing best-effort, and every caller of this has already
 * committed its transaction.
 */
function send(bytes) {
  const transport = settingsService.get('printer_transport');

  if (transport === 'NONE') {
    return { delivered: false, transport, error: 'No receipt printer is configured.' };
  }

  if (transport === 'USB') {
    // The node printer bridge writes to a device on Linux (/dev/usb/lp0) and to a
    // share on Windows. Both are a path this writes bytes to; TASK-018 configures
    // which, on the machine that has one.
    const device = settingsService.get('printer_device');
    if (!device) return { delivered: false, transport, error: 'No USB printer device is set.' };
    try {
      fs.writeFileSync(device, bytes);
      return { delivered: true, transport, device };
    } catch (err) {
      return { delivered: false, transport, device, error: `${err.code || err.message}` };
    }
  }

  // LAN: raw TCP 9100, the ESC/POS port. Fire-and-report — a socket that will not open
  // is a toast, and the sale is already banked.
  const host = settingsService.get('printer_host');
  const port = settingsService.get('printer_port');
  if (!host) return { delivered: false, transport, error: 'No LAN printer address is set.' };

  return sendOverTcp(bytes, host, port);
}

/**
 * Written as a synchronous-looking call that returns immediately with a promise
 * attached, because every caller is on a committed transaction and none of them may
 * wait: NFR_1.1 gives a sale two seconds, and a printer that has been unplugged takes
 * longer than that to say so.
 */
function sendOverTcp(bytes, host, port, { timeoutMs = 4000 } = {}) {
  const result = { delivered: false, transport: 'LAN', host, port, error: null, pending: true };

  result.settled = new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (error) => {
      if (!result.pending) return;
      result.pending = false;
      result.error = error;
      result.delivered = !error;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => socket.write(bytes, () => finish(null)));
    socket.on('timeout', () => finish(`the printer at ${host}:${port} did not answer`));
    socket.on('error', (err) => finish(err.code || err.message));
  });

  return result;
}

// ── The driver documentService and drawerService call ───────────────────────

/**
 * Install this as the printer and the drawer.
 *
 * documentService and drawerService were written with a driver seam precisely so this
 * task could fill it without editing a single caller: every place that already prints
 * a document or opens a drawer starts working the moment this runs.
 */
function install() {
  documentService.setDriver((record) => {
    const outcome = send(escpos.encode(record.text));
    if (!outcome.delivered && !outcome.pending) {
      // POS-208: queued for reprint rather than lost.
      enqueue(record, outcome.error);
      throw new Error(outcome.error || 'the printer did not accept the document');
    }
    record.transport = outcome.transport;
  });

  // INT-2: the pulse is an ESC/POS command on the same wire as the paper.
  const drawerService = require('./drawerService');
  drawerService.setDriver(() => {
    const outcome = send(escpos.drawerPulse());
    if (!outcome.delivered && !outcome.pending) {
      throw new Error(outcome.error || 'the drawer did not open');
    }
  });
}

function uninstall() {
  documentService.setDriver(null);
  require('./drawerService').setDriver(null);
}

function enqueue(record, error) {
  queue.push({ ...record, queued_at: clock.nowUtc(), error });
  if (queue.length > MAX_QUEUED) queue.shift();
}

/** What did not print, for SCR-304's reprint list and OPS-007's toast. */
function queued() {
  return queue.slice();
}

function clearQueue() {
  queue.length = 0;
}

module.exports = {
  width, header, footer,
  renderSaleReceipt, renderAcknowledgement, renderClosingSummary,
  send, sendOverTcp, install, uninstall, enqueue, queued, clearQueue,
};
