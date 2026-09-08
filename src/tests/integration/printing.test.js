'use strict';

// FR_3.7 / TAX-006, TAX-007, POS-206, POS-208, POS-507, INT-1, INT-2.
//
// The case with legal weight is the template guard: **no template may contain
// "Official Receipt", "Sales Invoice", "OR No.", a permit number or an ATP range**, and
// the acceptance criterion says asserted by test rather than by review. That one is
// written to read every template this product can produce, at both paper widths, in
// every tax mode — because a helpful phrase added later would not be reviewed again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const server = require('../../server');
const db = require('../../config/database');
const authService = require('../../services/authService');
const productService = require('../../services/productService');
const customerService = require('../../services/customerService');
const inventoryService = require('../../services/inventoryService');
const creditService = require('../../services/creditService');
const collectionService = require('../../services/collectionService');
const shiftService = require('../../services/shiftService');
const saleService = require('../../services/saleService');
const storeProfileService = require('../../services/storeProfileService');
const settingsService = require('../../services/settingsService');
const printService = require('../../services/printService');
const documentService = require('../../services/documentService');
const drawerService = require('../../services/drawerService');
const auditService = require('../../services/auditService');
const escpos = require('../../services/escpos');
const temp = require('../helpers/tempdb');

const PORT = 47882;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'correct-horse-battery';

let instance;
let ref;
const tokens = {};
const sessions = {};
let shift;

const call = (path_, { token = null, method = 'GET', body = null } = {}) => fetch(`${BASE}${path_}`, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

let seq = 0;
function stocked({ retail = 6250, taxClass = 'VATABLE' } = {}) {
  seq += 1;
  const product = productService.create({
    sku: `PRN-${String(seq).padStart(3, '0')}`,
    name: `Print Test Feed ${seq}`,
    categoryId: ref.category.id,
    baseUnitId: ref.kg.id,
    taxClass,
    retailPriceCentavos: retail,
  }, sessions.OWNER);
  inventoryService.postStandalone({
    productId: product.id, type: 'RECEIPT', qtyMilli: 1000000, unitCostCentavos: 4000, actor: sessions.OWNER,
  });
  return product;
}

test.before(async () => {
  temp.openEmpty('printing');
  instance = await server.start({ listenPort: PORT });
  temp.seedStore({ taxMode: 'VAT', withOwner: false });
  ref = temp.seedCatalog();

  for (const role of ['OWNER', 'MANAGER', 'CASHIER', 'INVENTORY']) {
    const username = role.toLowerCase();
    temp.seedUser({ username, role, password: PASSWORD });
    const signedIn = authService.login({ username, password: PASSWORD });
    tokens[role] = signedIn.token;
    sessions[role] = authService.verifyToken(signedIn.token);
  }
  shift = shiftService.open({
    actor: sessions.CASHIER, openingFloatCentavos: 200000, confirmed: true,
  }).shift;

  const backups = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-print-')), 'backups');
  db.transaction(() => settingsService.set('backup_folder', backups, sessions.OWNER));
});

test.after(async () => {
  await server.stop(instance);
  temp.cleanup();
});

/** Every document this product can produce, at both widths, in every tax mode. */
function everyTemplate() {
  const profile = storeProfileService.profile();
  const documents = [];

  for (const columns of [32, 48]) {
    for (const taxMode of ['NONE', 'NON_VAT', 'VAT']) {
      documents.push(printService.renderSaleReceipt({
        columns,
        profile,
        sale: {
          id: 'x', sale_no: 'SALE-20260908-000001', occurred_at: '2026-09-08T02:00:00.000Z',
          tax_mode: taxMode, subtotal_centavos: 112000, line_discount_centavos: 500,
          txn_discount_centavos: 250, total_centavos: 111250, change_centavos: 8750,
          vatable_centavos: 90000, vat_exempt_centavos: 10000, zero_rated_centavos: 0,
          vat_centavos: 11250,
        },
        items: [{
          name: 'Hog Grower Pellets', qty_display: '1.255 KG', unit_price_centavos: 6250,
          line_total_centavos: 7844, discount_centavos: 500,
        }],
        tenders: [
          { method: 'CASH', amount_centavos: 60000, status: 'RECORDED', reference_no: null },
          { method: 'GCASH', amount_centavos: 60000, status: 'RECORDED', reference_no: 'GC-1' },
        ],
      }));

      documents.push(printService.renderSaleReceipt({
        columns, profile, reprint: true,
        sale: {
          id: 'x', sale_no: 'SALE-20260908-000002', occurred_at: '2026-09-08T02:00:00.000Z',
          tax_mode: taxMode, subtotal_centavos: 10000, line_discount_centavos: 0,
          txn_discount_centavos: 0, total_centavos: 10000, change_centavos: 0,
          vatable_centavos: 8929, vat_exempt_centavos: 0, zero_rated_centavos: 0, vat_centavos: 1071,
        },
        items: [{ name: 'Feed', qty_display: '1 KG', unit_price_centavos: 10000, line_total_centavos: 10000, discount_centavos: 0 }],
        tenders: [{ method: 'CASH', amount_centavos: 10000, status: 'RECORDED', reference_no: null }],
      }));
    }

    documents.push(printService.renderAcknowledgement({
      columns, profile,
      documentNo: 'COLL-20260908-000001',
      customer: { name: 'Dela Cruz Piggery', code: 'DLC-01' },
      amountCentavos: 150000, method: 'GCASH', referenceNo: 'GC-4004',
      balanceAfterCentavos: 150000,
      allocations: [{ sale_document_no: 'SALE-20260908-000001', amount_centavos: 150000, settled_in_full: true }],
      receivedBy: 'cashier', at: '2026-09-08T02:00:00.000Z',
    }));

    documents.push(printService.renderAcknowledgement({
      columns, profile,
      documentNo: 'COLL-20260908-000002',
      customer: { name: 'Walk In', code: null },
      amountCentavos: 50000, method: 'CASH', referenceNo: null,
      balanceAfterCentavos: -50000, allocations: [],
      receivedBy: 'owner', at: '2026-09-08T02:00:00.000Z',
    }));

    documents.push(printService.renderClosingSummary({
      columns, profile,
      shift: { id: 's', opened_at: '2026-09-08T00:00:00.000Z' },
      expected: {
        opening_float_centavos: 200000, cash_sales_centavos: 100000,
        cash_collections_centavos: 40000, cash_in_centavos: 10000,
        cash_out_centavos: 15000, change_given_centavos: 50000,
      },
      lines: [
        { method: 'CASH', expected_centavos: 285000, actual_centavos: 265000, variance_centavos: -20000, reconcilable: true },
        { method: 'GCASH', expected_centavos: 30000, actual_centavos: 30000, variance_centavos: 0, reconcilable: true },
        { method: 'CREDIT', expected_centavos: 100000, actual_centavos: 100000, variance_centavos: 0, reconcilable: false },
      ],
      variance: -20000, beyondTolerance: true, tolerance: 10000,
      reason: 'Two hundred pesos missing after the afternoon rush',
      closedBy: 'nena', at: '2026-09-08T10:00:00.000Z',
    }));
  }

  return documents;
}

// ── TAX-006 — the rule with legal weight ────────────────────────────────────

test('every template carries "This is not an official receipt"', () => {
  const documents = everyTemplate();
  // 2 widths x (3 tax modes x [receipt, reprint] + 2 acknowledgements + 1 closing).
  assert.equal(documents.length, 18, 'every template this product can produce');

  for (const document of documents) {
    assert.match(
      document.text,
      /This is not an official receipt/,
      `${document.kind} at ${document.columns} columns is missing TAX-006's sentence`
    );
  }
});

test('no template contains any phrase TAX-006 forbids', () => {
  // 01_PRODUCT_BRIEF.md §5 puts BIR receipting permanently out of scope. A document
  // that looks like an Official Receipt without an Authority to Print behind it is one
  // the store can be penalised for issuing — so this reads every template rather than
  // trusting review, which is what the acceptance criterion asks for.
  const forbidden = [
    { label: 'Official Receipt', pattern: /official\s+receipt/i },
    { label: 'Sales Invoice', pattern: /sales\s+invoice/i },
    { label: 'OR No.', pattern: /\bor\s*(?:no\.?|#|number)\b/i },
    { label: 'a permit number', pattern: /permit\s*(?:no\.?|number|#)/i },
    { label: 'an ATP range', pattern: /\batp\b/i },
  ];

  for (const document of everyTemplate()) {
    // The required sentence contains the words "official receipt", so it is removed
    // before the forbidden phrases are looked for — otherwise the sentence TAX-006
    // demands would trip the rule TAX-006 makes.
    const body = document.text.replace(/This is not an official receipt/ig, '');
    for (const { label, pattern } of forbidden) {
      assert.equal(
        pattern.test(body), false,
        `${document.kind} at ${document.columns} columns contains "${label}"`
      );
    }
  }
});

test('TAX-006 holds in every tax mode, and is not a setting', () => {
  // "This rule holds in every tax mode and is not configurable" — its own last
  // sentence. There is no key that could switch it off.
  assert.equal(
    Object.keys(settingsService.REGISTRY).some((key) => /receipt_notice|official|tax_006/i.test(key)),
    false
  );

  for (const taxMode of ['NONE', 'NON_VAT', 'VAT']) {
    storeProfileService.setTaxMode(taxMode, sessions.OWNER);
    const product = stocked({ retail: 10000 });
    const sale = saleService.complete({
      lines: [{ productId: product.id, qtyMilli: 1000 }],
      tenders: [{ method: 'CASH', amountCentavos: 10000 }],
    }, sessions.CASHIER);

    const { document } = saleService.printReceipt(sale.sale.id);
    assert.match(document.text, /This is not an official receipt/, taxMode);
  }
  storeProfileService.setTaxMode('VAT', sessions.OWNER);
});

test('a document without the notice is refused before it reaches the printer', () => {
  // The guard is in documentService, on every document, rather than in a template —
  // a template gets edited, and the next person editing one should not be able to drop
  // the sentence.
  assert.throws(
    () => documentService.print({ kind: 'SALE_RECEIPT', text: 'Chachi Agrivet Supply\nTOTAL 100.00' }),
    /must carry the words/
  );
  assert.throws(
    () => documentService.print({
      kind: 'SALE_RECEIPT',
      text: 'Store\nOFFICIAL RECEIPT No. 1\nThis is not an official receipt',
    }),
    /must not carry/
  );
});

// ── TC-UT-17 / TAX-007 — the VAT block by mode ──────────────────────────────

test('TC-UT-17: VAT mode prints the tax summary block; NONE and NON_VAT do not', () => {
  const profile = storeProfileService.profile();
  const sale = {
    id: 'x', sale_no: 'SALE-1', occurred_at: '2026-09-08T02:00:00.000Z',
    subtotal_centavos: 112000, line_discount_centavos: 0, txn_discount_centavos: 0,
    total_centavos: 112000, change_centavos: 0,
    vatable_centavos: 100000, vat_exempt_centavos: 0, zero_rated_centavos: 0, vat_centavos: 12000,
  };
  const items = [{ name: 'Feed', qty_display: '1 KG', unit_price_centavos: 112000, line_total_centavos: 112000, discount_centavos: 0 }];
  const tenders = [{ method: 'CASH', amount_centavos: 112000, status: 'RECORDED', reference_no: null }];

  const vat = printService.renderSaleReceipt({ profile, sale: { ...sale, tax_mode: 'VAT' }, items, tenders });
  assert.match(vat.text, /VAT SUMMARY \(12%\)/, 'TAX-007');
  assert.match(vat.text, /VATable\s+1,000\.00/);
  assert.match(vat.text, /VAT\s+120\.00/);

  for (const taxMode of ['NONE', 'NON_VAT']) {
    const other = printService.renderSaleReceipt({ profile, sale: { ...sale, tax_mode: taxMode }, items, tenders });
    // A block of zeroes would imply the store is registered when it is not.
    assert.equal(/VAT SUMMARY/.test(other.text), false, taxMode);
    assert.equal(/VATable/.test(other.text), false, taxMode);
  }
});

// ── POS-206 — RECORDED, never VERIFIED ──────────────────────────────────────

test('POS-206: a non-cash tender prints RECORDED beside the amount', () => {
  const product = stocked({ retail: 10000 });
  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [
      { method: 'CASH', amountCentavos: 4000 },
      { method: 'GCASH', amountCentavos: 6000, referenceNo: 'GC-REC-1' },
    ],
  }, sessions.CASHIER);

  const { document } = saleService.printReceipt(sale.sale.id);

  assert.match(document.text, /GCASH RECORDED/, 'it means "the cashier saw it"');
  assert.match(document.text, /Ref GC-REC-1/);
  // Cash needs no such word — nobody doubts a note in the drawer. The boundary matters:
  // "GCASH RECORDED" contains "CASH RECORDED" as a substring.
  assert.equal(/\bCASH RECORDED/.test(document.text), false);

  // The word VERIFIED must never appear: no payment API confirms these, and a receipt
  // saying so would be claiming something nobody checked.
  for (const document_ of everyTemplate()) {
    assert.equal(/verified|confirmed/i.test(document_.text), false, document_.kind);
  }
});

// ── TC-INT-39 / POS-208 — the reprint ───────────────────────────────────────

test('TC-INT-39: a reprint is stamped REPRINT and audited', () => {
  const product = stocked({ retail: 10000 });
  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 10000 }],
  }, sessions.CASHIER);

  const first = saleService.printReceipt(sale.sale.id);
  assert.equal(/REPRINT/.test(first.document.text), false, 'the original is not stamped');

  const again = saleService.reprint(sale.sale.id, sessions.MANAGER);

  // An unmarked reprint is a shrinkage tool: a cashier can hand a customer a receipt
  // for a sale they pocketed the cash from and produce another for the drawer.
  assert.match(again.document.text, /\*\*\* REPRINT \*\*\*/);
  assert.equal(again.document.reprint, true);

  const [row] = auditService.browse({ action: 'RECEIPT_REPRINTED', entityId: sale.sale.id }).rows;
  assert.ok(row, 'POS-208 puts it on the trail');
  assert.equal(row.actor.username, 'manager');
  assert.equal(row.after.sale_no, sale.sale.sale_no);
  assert.match(row.reason, new RegExp(sale.sale.sale_no));
});

test('TC-INT-39: a reprint requires TX-430', async () => {
  const product = stocked({ retail: 10000 });
  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 10000 }],
  }, sessions.CASHIER);

  const refused = await call(`/sales/${sale.sale.id}/reprint`, { token: tokens.INVENTORY, method: 'POST' });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.rule_id, 'TX-430');

  // §10 grants TX-430 to owner, manager and cashier — the counter reprints a receipt
  // the customer dropped.
  const ok = await call(`/sales/${sale.sale.id}/reprint`, { token: tokens.CASHIER, method: 'POST' });
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).document.text, /REPRINT/);
});

test('a reprint is audited even when the printer refuses it', () => {
  const product = stocked({ retail: 10000 });
  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 10000 }],
  }, sessions.CASHIER);

  documentService.setDriver(() => { throw new Error('printer offline'); });
  try {
    const result = saleService.reprint(sale.sale.id, sessions.OWNER);
    // A reprint that will not print is still a reprint that was requested, and POS-208
    // is about the request.
    assert.equal(result.printed.delivered, false);
    assert.equal(auditService.browse({ action: 'RECEIPT_REPRINTED', entityId: sale.sale.id }).total, 1);
  } finally {
    documentService.setDriver(null);
    printService.install();
  }
});

// ── TC-INT-36 / POS-507, INT-2 — the drawer ─────────────────────────────────

test('TC-INT-36: the drawer pulses on cash sale, cash collection and till movement', () => {
  const product = stocked({ retail: 10000 });
  const customer = customerService.create({
    name: `Drawer Farm ${seq}`, customerType: 'FARM',
    isCreditEligible: true, creditLimitCentavos: 1000000, termsDays: 15,
  }, sessions.OWNER);
  creditService.postStandalone({
    accountId: creditService.accountFor(customer.id).id, type: 'CREDIT_SALE',
    amountCentavos: 50000, actor: sessions.CASHIER, documentNo: `S-D${seq}`,
  });

  const pulses = [];
  drawerService.setDriver((record) => pulses.push(record));

  try {
    // 1. A cash tender.
    saleService.complete({
      lines: [{ productId: product.id, qtyMilli: 1000 }],
      tenders: [{ method: 'CASH', amountCentavos: 10000 }],
    }, sessions.CASHIER);
    assert.equal(pulses.at(-1).reason, 'CASH_TENDER');

    // 2. A cash collection (CR-205).
    collectionService.record({
      customerId: customer.id, amountCentavos: 10000, method: 'CASH',
    }, sessions.CASHIER);
    assert.equal(pulses.at(-1).reason, 'CASH_COLLECTION');

    // 3. Any till movement.
    shiftService.moveTillCash({
      shiftId: shift.id, direction: 'IN', amountCentavos: 5000, reason: 'Petty cash', actor: sessions.CASHIER,
    });
    assert.equal(pulses.at(-1).reason, 'TILL_MOVEMENT');

    assert.equal(pulses.length, 3);

    // And not on a pure credit sale, or a GCash collection: no cash, no drawer.
    const before = pulses.length;
    saleService.complete({
      lines: [{ productId: product.id, qtyMilli: 1000 }],
      customerId: customer.id,
      tenders: [{ method: 'CREDIT', amountCentavos: 10000 }],
    }, sessions.CASHIER);
    collectionService.record({
      customerId: customer.id, amountCentavos: 5000, method: 'GCASH', referenceNo: `GC-D${seq}`,
    }, sessions.CASHIER);
    assert.equal(pulses.length, before);
  } finally {
    drawerService.setDriver(null);
    printService.install();
  }
});

// ── INT-1 — best effort, never a rollback ───────────────────────────────────

test('INT-1: a printer that will not accept a document queues it and keeps the sale', () => {
  printService.clearQueue();
  const product = stocked({ retail: 10000 });

  // A LAN printer at an address nothing answers on: the shape of a printer that has
  // been unplugged from the network.
  const previous = {
    transport: settingsService.get('printer_transport'),
    host: settingsService.get('printer_host'),
  };
  db.transaction(() => {
    settingsService.set('printer_transport', 'USB', sessions.OWNER);
    settingsService.set('printer_device', '/nonexistent/printer/device', sessions.OWNER);
  });

  try {
    const sale = saleService.complete({
      lines: [{ productId: product.id, qtyMilli: 1000 }],
      tenders: [{ method: 'CASH', amountCentavos: 10000 }],
    }, sessions.CASHIER);

    const printed = saleService.printReceipt(sale.sale.id);
    assert.equal(printed.printed.delivered, false);
    assert.ok(printed.printed.error, 'and it says why');

    // POS-208: queued for reprint rather than lost.
    const queued = printService.queued();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].kind, 'SALE_RECEIPT');

    // The sale is committed and every ledger agrees. A jammed printer must never roll
    // one back — the customer has paid.
    assert.ok(saleService.get(sale.sale.id));
    assert.equal(inventoryService.reconcile().ok, true);
  } finally {
    db.transaction(() => {
      settingsService.set('printer_transport', previous.transport, sessions.OWNER);
      settingsService.set('printer_device', '', sessions.OWNER);
    });
    printService.clearQueue();
  }
});

test('INT-1: with no printer configured, printing says so rather than hanging', () => {
  assert.equal(settingsService.get('printer_transport'), 'NONE', 'the default');
  const outcome = printService.send(Buffer.from('x'));

  // A store that has not plugged one in yet gets an immediate honest answer, not a
  // five-second timeout at the counter on every sale.
  assert.equal(outcome.delivered, false);
  assert.match(outcome.error, /No receipt printer is configured/);
});

test('INT-1: LAN transport writes to a real socket, and a dead address is reported', async () => {
  const received = [];
  let sawData;
  const gotData = new Promise((resolve) => { sawData = resolve; });
  const listener = net.createServer((socket) => socket.on('data', (chunk) => {
    received.push(chunk);
    sawData();
  }));
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;

  try {
    const good = printService.sendOverTcp(escpos.encode('TOTAL 100.00'), '127.0.0.1', port);
    await good.settled;
    // `delivered` means the bytes were handed to the socket, which is the honest claim
    // for a fire-and-forget printer — a thermal head sends nothing back. So the
    // receiving side is awaited separately rather than assumed to have kept up.
    assert.equal(good.delivered, true);
    await gotData;
    assert.match(Buffer.concat(received).toString('latin1'), /TOTAL 100\.00/);

    // A closed port, which is what an unplugged LAN printer looks like.
    const bad = printService.sendOverTcp(Buffer.from('x'), '127.0.0.1', 1, { timeoutMs: 500 });
    await bad.settled;
    assert.equal(bad.delivered, false);
    assert.ok(bad.error, 'reported, not thrown');
  } finally {
    listener.close();
  }
});

// ── The width setting ───────────────────────────────────────────────────────

test('the paper width is a setting, and only the two real ones are accepted', () => {
  assert.equal(printService.width(), 32, '58 mm by default');

  db.transaction(() => settingsService.set('receipt_width_columns', 48, sessions.OWNER));
  try {
    assert.equal(printService.width(), 48);
    const product = stocked({ retail: 10000 });
    const sale = saleService.complete({
      lines: [{ productId: product.id, qtyMilli: 1000 }],
      tenders: [{ method: 'CASH', amountCentavos: 10000 }],
    }, sessions.CASHIER);

    const { document } = saleService.printReceipt(sale.sale.id);
    assert.equal(document.columns, 48);
    assert.ok(document.text.split('\n').every((line) => line.length <= 48));
    assert.ok(document.text.split('\n').some((line) => line.length > 32), 'and it uses the width');
  } finally {
    db.transaction(() => settingsService.set('receipt_width_columns', 32, sessions.OWNER));
  }

  assert.throws(
    () => settingsService.coerce('receipt_width_columns', 40),
    (err) => err.ruleId === 'INT-1' && /must be one of 32, 48/.test(err.message)
  );
});

test('every rendered line fits the paper, at both widths', () => {
  // A line one character too long does not error on a thermal head — it wraps
  // mid-figure, and PHP 1,234.56 becomes two lines on the paper a customer keeps.
  for (const document of everyTemplate()) {
    for (const line of document.text.split('\n')) {
      assert.ok(
        line.length <= document.columns,
        `${document.kind} at ${document.columns}: "${line}" is ${line.length} characters`
      );
    }
  }
});

// ── Over HTTP ───────────────────────────────────────────────────────────────

test('GET /sales/:id/receipt previews at either width without printing', async () => {
  const product = stocked({ retail: 10000 });
  const sale = saleService.complete({
    lines: [{ productId: product.id, qtyMilli: 1000 }],
    tenders: [{ method: 'CASH', amountCentavos: 10000 }],
  }, sessions.CASHIER);

  const narrow = await (await call(`/sales/${sale.sale.id}/receipt`, { token: tokens.CASHIER })).json();
  assert.equal(narrow.document.columns, 32);

  const wide = await (await call(`/sales/${sale.sale.id}/receipt?columns=48`, { token: tokens.CASHIER })).json();
  assert.equal(wide.document.columns, 48);
  assert.equal(/REPRINT/.test(wide.document.text), false, 'a preview is not a reprint');

  // No audit row — looking at a receipt is not producing one (POS-208).
  assert.equal(auditService.browse({ action: 'RECEIPT_REPRINTED', entityId: sale.sale.id }).total, 0);
});

test('POST /print/test proves the printer, and is subject to TAX-006', async () => {
  const res = await call('/print/test', { token: tokens.OWNER, method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.match(body.document.text, /PRINTER TEST/);
  assert.match(body.document.text, /This is not an official receipt/, 'a test page is still paper');
  assert.match(body.document.text, /Requested by\s+owner/);

  // A cashier does not configure the printer.
  assert.equal((await call('/print/test', { token: tokens.CASHIER, method: 'POST' })).status, 403);
});

test('GET /print/queue lists what did not print', async () => {
  printService.clearQueue();
  printService.enqueue({ kind: 'SALE_RECEIPT', document_no: 'SALE-X', text: 'x' }, 'printer offline');

  const body = await (await call('/print/queue', { token: tokens.CASHIER })).json();
  assert.equal(body.queued.length, 1);
  assert.equal(body.queued[0].document_no, 'SALE-X');
  assert.equal(body.queued[0].error, 'printer offline');
  printService.clearQueue();
});
