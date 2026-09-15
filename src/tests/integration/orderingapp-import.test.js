'use strict';

// TASK-064 — a café's OrderingApp history, into Chachi POS through the ordinary import.
//
// tools/orderingapp/to-archive.js turns one OrderingApp store into an import archive on
// top of the new store's own export. Here a small store with every kind of order goes
// through the real validation and import (OPS-102, OPS-103), and the daily report then
// says what OrderingApp said: the same takings, the same cancellations, the change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zip = require('../../config/zip');
const authService = require('../../services/authService');
const settingsService = require('../../services/settingsService');
const exportService = require('../../services/exportService');
const importService = require('../../services/importService');
const reportService = require('../../services/reportService');
const saleRepository = require('../../repositories/saleRepository');
const dataRepository = require('../../repositories/dataRepository');
const temp = require('../helpers/tempdb');
const { convert } = require('../../../tools/orderingapp/to-archive');

const PASSWORD = 'correct-horse-battery';
let owner;
let backups;

const STORE = { id: 's1', name: 'Kape sa Kanto', slug: 'kape-sa-kanto' };
const order = (id, at, fields) => ({
  id, store_id: STORE.id, customer_id: null, placed_by: 'u-staff', status: 'completed', order_type: 'dine-in',
  subtotal: '0', discount: '0.00', promo_code_id: null, service_fee_rate: '0.000', service_fee: '0.00', total: '0',
  currency: 'PHP', created_at: at, table_label: null, customer_name: null,
  pay_method: 'cash', pay_status: 'paid', pay_provider: null, pay_ref: null, paid_at: null, ...fields,
});
const line = (orderId, id, item, name, price, quantity, notes = null) => ({
  id, order_id: orderId, menu_item_id: item, name_snapshot: name, price_snapshot: price,
  quantity, line_total: (Number(price) * quantity).toFixed(2), notes,
});

const SOURCE = {
  store: STORE,
  categories: [
    { id: 'c-rice', store_id: 's1', slug: 'rice', name: 'Rice Bowls', sort_order: 1 },
    { id: 'c-coffee', store_id: 's1', slug: 'coffee', name: 'Coffee', sort_order: 2 },
  ],
  items: [
    { id: 'm-bibimbap', category_id: 'c-rice', slug: 'bibimbap', name: 'Bibimbap', price: '115.00', description: null, available: true },
    { id: 'm-latte', category_id: 'c-coffee', slug: 'iced-latte', name: 'Iced Latte', price: '89.00', description: 'Tall', available: true },
    { id: 'm-old', category_id: 'c-coffee', slug: 'old-brew', name: 'Old Brew', price: '75.00', description: null, available: false },
  ],
  members: [
    { role: 'owner', id: 'u-owner', email: 'kape.owner@example.com', name: 'Kape Owner' },
    { role: 'staff', id: 'u-staff', email: 'jo@example.com', name: 'Jo' },
  ],
  placers: [
    { id: 'u-staff', email: 'jo@example.com', name: 'Jo' },
    { id: 'u-gone', email: 'former.staff@example.com', name: 'Former Staff' },
  ],
  customers: [{ id: 'k-1', store_id: 's1', name: 'Table 4 Ana', phone: '', address: null }],
  promos: [{ id: 'p-1', code: 'OPENING', label: 'Opening week' }],
  orders: [
    // Paid in cash, ₱500 handed over for ₱230: ₱270 change.
    order('KK-1001', '2026-08-01T03:00:00Z', { subtotal: '230.00', total: '230.00', pay_provider: '500' }),
    // Taken, never marked paid, with a 5% fee and a promo.
    order('KK-1002', '2026-08-01T04:00:00Z', {
      status: 'received', subtotal: '89.00', service_fee_rate: '0.050', service_fee: '4.45',
      discount: '10.00', promo_code_id: 'p-1', total: '83.45', pay_status: 'cash_on_delivery', table_label: 'T2',
    }),
    order('KK-1003', '2026-08-01T05:00:00Z', { status: 'cancelled', subtotal: '89.00', total: '89.00', pay_status: 'cash_on_delivery' }),
    order('KK-1004', '2026-08-01T06:00:00Z', { status: 'pending_payment', subtotal: '115.00', total: '115.00', pay_method: 'paymongo', pay_status: 'pending' }),
    // The next day, by someone no longer on the staff, in GCash, for a named customer.
    order('KK-1005', '2026-08-02T02:30:00Z', {
      placed_by: 'u-gone', customer_id: 'k-1', subtotal: '204.00', total: '204.00',
      pay_method: 'gcash', pay_status: 'paid', pay_ref: '1029384756', order_type: 'take-out',
    }),
  ],
  lines: [
    line('KK-1001', 1, 'm-bibimbap', 'Bibimbap', '115.00', 2),
    line('KK-1002', 2, 'm-latte', 'Iced Latte', '89.00', 1, 'less ice'),
    line('KK-1003', 3, 'm-latte', 'Iced Latte', '89.00', 1),
    line('KK-1004', 4, 'm-bibimbap', 'Bibimbap', '115.00', 1),
    line('KK-1005', 5, 'm-bibimbap', 'Bibimbap', '115.00', 1),
    line('KK-1005', 6, 'm-latte', 'Iced Latte', '89.00', 1),
  ],
};

test.before(() => {
  temp.openMigrated('orderingapp-import');
  temp.seedStore({ storeName: 'Kape sa Kanto', taxMode: 'NONE', withOwner: false, industry: 'AGRIVET' });
  temp.seedUser({ username: 'owner', role: 'OWNER', password: PASSWORD });
  owner = authService.verifyToken(authService.login({ username: 'owner', password: PASSWORD }).token);
  backups = fs.mkdtempSync(path.join(os.tmpdir(), 'agrivet-oa-backups-'));
  settingsService.set('backup_folder', backups, owner);
});

test.after(() => {
  temp.cleanup();
  fs.rmSync(backups, { recursive: true, force: true });
});

test('TASK-064: an OrderingApp store imports whole, and the daily report says what OrderingApp said', () => {
  const { archive, summary } = convert({ base: exportService.build().archive, source: SOURCE, now: '2026-09-15T00:00:00.000Z' });

  assert.equal(summary.completed_centavos, 23000 + 8345 + 20400);
  assert.equal(summary.voided_centavos, 8900);
  assert.deepEqual(summary.skipped_orders, [{ order: 'KK-1004', reason: 'never paid' }]);
  assert.equal(summary.line_notes_dropped, 1);
  assert.equal(summary.table_labels_dropped, 1);
  assert.equal(summary.shifts, 2, 'Jo on the 1st, and the former staff member on the 2nd');

  const checked = importService.validate(archive);
  assert.equal(checked.ok, true, JSON.stringify(checked.problems));
  assert.ok(checked.warnings.some((w) => w.rule_id === 'SEC-1'), 'the imported users are told they have no password');

  const done = importService.run(archive, { reason: 'TASK-064 test' }, owner);
  assert.equal(done.entities.sales.inserted, 4);
  assert.equal(done.entities.products.inserted, 4, 'three menu items and the service charge');
  assert.equal(done.entities.users.inserted, 3);

  const daily = reportService.daily({ from: '2026-08-01', to: '2026-08-02' }, owner);
  assert.equal(daily.totals.sale_count, 3);
  assert.equal(daily.totals.net_centavos, 51745);
  assert.equal(daily.totals.change_centavos, 27000);
  assert.equal(daily.header.voided_excluded_count, 1);
  assert.equal(daily.header.voided_excluded_centavos, 8900);

  // Each order keeps its number, so an old one is found the way the café knows it.
  const withFee = saleRepository.findByNo('KK-1002');
  assert.equal(withFee.total_centavos, 8345);
  assert.equal(withFee.txn_discount_centavos, 1000);
  const lines = dataRepository.rowsOf('sale_items').filter((l) => l.sale_id === withFee.id).sort((a, b) => a.line_no - b.line_no);
  assert.deepEqual(lines.map((l) => [l.product_name_snapshot, l.line_total_centavos]), [['Iced Latte', 8900], ['Service charge (5%)', 445]]);
  const discount = dataRepository.rowsOf('sale_discounts').find((d) => d.sale_id === withFee.id);
  assert.match(discount.reason, /OPENING/);

  const gcash = saleRepository.findByNo('KK-1005');
  const tender = dataRepository.rowsOf('sale_tenders').find((t) => t.sale_id === gcash.id);
  assert.deepEqual([tender.method, tender.reference_no], ['GCASH', '1029384756']);
  assert.equal(gcash.customer_id, 'k-1');
  assert.equal(saleRepository.findByNo('KK-1003').void_reason, 'Cancelled in OrderingApp');
  assert.equal(saleRepository.findByNo('KK-1004'), null);

  const users = dataRepository.rowsOf('users');
  assert.equal(users.find((u) => u.full_name === 'Former Staff').is_active, 0);
  assert.equal(users.find((u) => u.full_name === 'Jo').role, 'CASHIER');
  assert.equal(users.find((u) => u.full_name === 'Jo').username, 'jo-staff', 'a username is three characters at least');
  assert.equal(users.find((u) => u.full_name === 'Jo').password_hash, 'IMPORTED-NO-PASSWORD');
  assert.equal(dataRepository.rowsOf('products').find((p) => p.sku === 'OLD-BREW').is_active, 0);
});

test('TASK-064: the base must be a newly set-up store', () => {
  // The store above now has products and sales.
  assert.throws(() => convert({ base: exportService.build().archive, source: SOURCE }), /newly set-up store/);
  assert.ok(zip.unzipMany(exportService.build().archive).length > 1);
});
