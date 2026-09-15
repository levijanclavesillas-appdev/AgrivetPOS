'use strict';

// One store's menu, customers, staff and order history out of OrderingApp (the café app
// at back-end.store), as a Chachi POS import archive — TASK-064.
//
//   node tools/orderingapp/to-archive.js --base <export.zip> --store <name or slug>
//        --psql "docker exec mmcafe-db-1 psql -U <user> -d <db>" [--no-customers] [--out <file>]
//
// 1. Set the new store up in Chachi POS and export it (Admin → Export / import). Its
//    export is the base: it carries the schema the archive must match, and the owner.
// 2. Run this. It only reads from OrderingApp's database (SELECTs through --psql).
// 3. Import the file it writes in the same store. The import validates it whole and
//    backs up first (OPS-102, OPS-103), and every imported user needs a password (SEC-1).
//
// How the rows land, and what does not move, is TASK-064's migration table. In short:
// menu items become products in a Serving unit, each order a sale under its own number
// (MM-1234), a cancelled order a voided sale, the service fee a "Service charge" line,
// and each cashier's day a closed shift. An order never paid (pending_payment) is left out.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zip = require('../../src/config/zip');
const exportService = require('../../src/services/exportService');

const METHOD = Object.freeze({ cash: 'CASH', gcash: 'GCASH', qrph: 'QRPH', paymongo: 'OTHER', bank: 'OTHER' });

const cents = (value) => Math.round(Number(value || 0) * 100);
const iso = (at) => new Date(at).toISOString();
const manilaDay = (at) => new Date(new Date(at).getTime() + 8 * 3600e3).toISOString().slice(0, 10);
const isAmount = (text) => /^[0-9]+(\.[0-9]+)?$/.test(String(text || ''));

/** The rows one store holds in OrderingApp, through `psql`. Reads only. */
function readSource(psql, store) {
  const [command, ...args] = psql.trim().split(/\s+/);
  const rows = (sql) => JSON.parse(execFileSync(command, [...args, '-At', '-c',
    `select coalesce(json_agg(t), '[]') from (${sql}) t`], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8'));
  const quoted = `'${String(store).replace(/'/g, "''")}'`;
  const found = rows(`select id, name, slug from store where name = ${quoted} or slug = ${quoted}`);
  if (found.length !== 1) throw new Error(`OrderingApp has ${found.length} stores named ${store}`);
  const id = `'${found[0].id}'`;
  return {
    store: found[0],
    categories: rows(`select * from category where store_id = ${id} order by sort_order, name`),
    items: rows(`select * from menu_item where store_id = ${id} order by name`),
    members: rows(`select m.role, u.id, u.email, u.name from store_member m join users u on u.id = m.user_id where m.store_id = ${id}`),
    placers: rows(`select distinct u.id, u.email, u.name from orders o join users u on u.id = o.placed_by where o.store_id = ${id}`),
    customers: rows(`select * from customer where store_id = ${id}`),
    orders: rows(`select o.*, p.method as pay_method, p.status as pay_status, p.provider as pay_provider,
                         p.session_id as pay_ref, p.paid_at
                    from orders o left join payment p on p.order_id = o.id
                   where o.store_id = ${id} order by o.created_at, o.id`),
    lines: rows(`select i.* from order_item i join orders o on o.id = i.order_id where o.store_id = ${id} order by i.order_id, i.id`),
    promos: rows(`select id, code, label from promo_code where store_id = ${id}`),
  };
}

/**
 * The base archive with OrderingApp's rows added, re-sealed.
 *
 * `base` is an export of a store with no products and no sales: the archive is imported
 * whole into the store it came from, whose own rows are then skipped as collisions.
 */
function convert({ base, source, customers: withCustomers = true, now = new Date().toISOString(), uuid = crypto.randomUUID }) {
  const entries = zip.unzipMany(base);
  const byName = new Map(entries.map((e) => [e.name, e.content]));
  const manifest = JSON.parse(byName.get(exportService.MANIFEST).toString('utf8'));
  const rows = Object.fromEntries(manifest.entities.map((t) => [t, JSON.parse(byName.get(`${t}.json`).toString('utf8'))]));
  if (rows.products.length || rows.sales.length) {
    throw new Error('Export a newly set-up store: this one already has products or sales.');
  }
  const owner = rows.users.find((u) => u.role === 'OWNER' && u.is_active);
  const summary = {
    store: source.store.name, orders: source.orders.length, skipped_orders: [], line_notes_dropped: 0,
    table_labels_dropped: 0, order_types: {}, users_without_password: 0,
    completed_centavos: 0, voided_centavos: 0, service_charge_centavos: 0,
  };

  // ── Users: the store's members, and anybody else who placed one of its orders ──
  const userOf = new Map();
  const taken = new Set(rows.users.map((u) => u.username.toLowerCase()));
  const people = new Map();
  for (const m of source.members) people.set(m.id, { ...m, member: true });
  for (const p of source.placers) if (!people.has(p.id)) people.set(p.id, { ...p, role: null, member: false });
  for (const person of people.values()) {
    let name = String(person.email || '').split('@')[0].replace(/[^A-Za-z0-9._-]/g, '').slice(0, 28);
    if (name.length < 3) name = `${name || 'user'}-staff`;   // VR-501: three characters at least
    let username = name;
    for (let n = 2; taken.has(username.toLowerCase()); n += 1) username = `${name}${n}`;
    taken.add(username.toLowerCase());
    const id = uuid();
    userOf.set(person.id, id);
    rows.users.push({
      id, username, full_name: person.name || username,
      role: person.role === 'owner' ? 'OWNER' : 'CASHIER',
      failed_attempts: 0, locked_until_at: null, is_active: person.member ? 1 : 0,
      created_at: now, created_by: owner.id,
    });
    summary.users_without_password += 1;
  }

  // ── The menu ──
  const unitId = uuid();
  rows.units.push({ id: unitId, code: 'SRV', name: 'Serving', allows_fraction: 0, is_active: 1, created_at: now });
  const categoryNames = new Set(rows.categories.map((c) => c.name.toLowerCase()));
  const category = (id, wanted, maxDiscountBp = null) => {
    let name = wanted;
    for (let n = 2; categoryNames.has(name.toLowerCase()); n += 1) name = `${wanted} (${n})`;
    categoryNames.add(name.toLowerCase());
    rows.categories.push({ id, name, max_discount_bp: maxDiscountBp, is_active: 1, created_at: now });
  };
  const skus = new Set();
  const product = ({ id, sku, name, categoryId, description = null, active = true, priceCentavos }) => {
    let unique = sku;
    for (let n = 2; skus.has(unique.toLowerCase()); n += 1) unique = `${sku}-${n}`;
    skus.add(unique.toLowerCase());
    rows.products.push({
      id, sku: unique, name, category_id: categoryId, brand_id: null, base_unit_id: unitId, description,
      tax_class: 'VATABLE', statutory_discount_eligible: 1, avg_cost_centavos: 0, avg_cost_as_of: null,
      min_stock_milli: 0, is_batch_tracked: 0, is_active: active ? 1 : 0,
      created_at: now, created_by: owner.id, updated_at: null, updated_by: null, generic_name: null,
    });
    rows.product_prices.push({
      id: uuid(), product_id: id, price_level: 'RETAIL', price_centavos: priceCentavos,
      // Before the first order, so every imported sale is under a price that existed.
      effective_from: source.orders.length ? iso(new Date(source.orders[0].created_at).getTime() - 86400e3) : now,
      created_at: now, created_by: owner.id,
    });
    rows.inventory.push({ product_id: id, qty_on_hand_milli: 0, updated_at: now });
  };
  for (const c of source.categories) category(c.id, c.name);
  for (const m of source.items) {
    product({
      id: m.id, sku: String(m.slug || m.id).toUpperCase().slice(0, 40), name: m.name, categoryId: m.category_id,
      description: m.description || null, active: m.available, priceCentavos: cents(m.price),
    });
  }
  // Chachi POS has no service charge (TASK-064): OrderingApp's fee becomes a line.
  const feeProduct = uuid();
  if (source.orders.some((o) => Number(o.service_fee) > 0)) {
    const feeCategory = uuid();
    category(feeCategory, 'Service charge', 0);
    product({ id: feeProduct, sku: 'SERVICE-CHARGE', name: 'Service charge', categoryId: feeCategory, priceCentavos: 0 });
  }

  // ── Customers: in OrderingApp, a name written on an order ──
  const customerIds = new Set();
  if (withCustomers) {
    for (const c of source.customers) {
      customerIds.add(c.id);
      rows.customers.push({
        id: c.id, code: null, name: c.name || 'Customer', contact_no: c.phone || null, address: c.address || null,
        customer_type: 'RETAIL', price_level: 'RETAIL', is_credit_eligible: 0, is_active: 1,
        notes: 'From OrderingApp', created_at: now, created_by: owner.id, updated_at: null, updated_by: null,
      });
    }
  }

  // ── Shifts: one closed shift per cashier per day (Manila) ──
  const shifts = new Map();
  const shiftFor = (at, userId) => {
    const key = `${manilaDay(at)}|${userId}`;
    if (!shifts.has(key)) {
      const shift = { id: uuid(), user_id: userId, opened_at: iso(at), opening_float_centavos: 0, closed_at: iso(at), status: 'CLOSED' };
      shifts.set(key, shift);
      rows.cashier_shifts.push(shift);
    }
    const shift = shifts.get(key);
    shift.closed_at = iso(at);
    return shift.id;
  };

  // ── Orders, as sales ──
  const linesOf = new Map();
  for (const l of source.lines) {
    if (!linesOf.has(l.order_id)) linesOf.set(l.order_id, []);
    linesOf.get(l.order_id).push(l);
  }
  const promoOf = new Map(source.promos.map((p) => [p.id, p]));

  for (const o of source.orders) {
    summary.order_types[o.order_type] = (summary.order_types[o.order_type] || 0) + 1;
    if (o.status === 'pending_payment') {
      summary.skipped_orders.push({ order: o.id, reason: 'never paid' });
      continue;
    }
    if (o.table_label) summary.table_labels_dropped += 1;
    const voided = o.status === 'cancelled';
    const createdBy = userOf.get(o.placed_by) || owner.id;
    const saleId = uuid();
    const at = iso(o.created_at);
    const fee = cents(o.service_fee);
    const discount = cents(o.discount);
    const itemLines = linesOf.get(o.id) || [];
    const subtotal = itemLines.reduce((sum, l) => sum + cents(l.line_total), 0) + fee;
    const total = cents(o.total);
    if (subtotal - discount !== total) {
      throw new Error(`Order ${o.id} does not add up: lines and fee ${subtotal}, discount ${discount}, total ${total} (centavos).`);
    }
    const method = METHOD[o.pay_method] || 'OTHER';
    // Cash is recorded as handed over, with the change taken off (MON-007). OrderingApp
    // keeps the amount handed over in payment.provider.
    const tendered = method === 'CASH' && isAmount(o.pay_provider) && cents(o.pay_provider) > total ? cents(o.pay_provider) : total;

    rows.sales.push({
      id: saleId, sale_no: o.id, customer_id: customerIds.has(o.customer_id) ? o.customer_id : null,
      shift_id: shiftFor(o.created_at, createdBy),
      status: voided ? 'VOIDED' : 'COMPLETED', price_level: 'RETAIL', tax_mode: 'NONE',
      subtotal_centavos: subtotal, line_discount_centavos: 0, txn_discount_centavos: discount,
      statutory_discount_centavos: 0, vatable_centavos: 0, vat_exempt_centavos: 0, zero_rated_centavos: 0,
      vat_centavos: 0, total_centavos: total, change_centavos: tendered - total, approved_by: null,
      voided_at: voided ? at : null, voided_by: voided ? createdBy : null,
      void_reason: voided ? 'Cancelled in OrderingApp' : null,
      occurred_at: at, created_by: createdBy,
    });
    let lineNo = 0;
    const line = (productId, name, qty, unitCentavos, lineCentavos) => rows.sale_items.push({
      id: uuid(), sale_id: saleId, line_no: ++lineNo, product_id: productId, product_name_snapshot: name,
      qty_milli: qty * 1000, sold_unit_id: unitId, sold_pack_factor_milli: 1000,
      unit_price_centavos: unitCentavos, price_level_applied: 'RETAIL', unit_cost_centavos: 0, discount_centavos: 0,
      tax_class_snapshot: 'VATABLE', tax_centavos: 0, line_total_centavos: lineCentavos,
      batch_id: null, returned_qty_milli: 0,
    });
    for (const l of itemLines) {
      if (l.notes) summary.line_notes_dropped += 1;
      line(l.menu_item_id, l.name_snapshot, l.quantity, cents(l.price_snapshot), cents(l.line_total));
    }
    if (fee > 0) {
      line(feeProduct, `Service charge (${Math.round(Number(o.service_fee_rate) * 1000) / 10}%)`, 1, fee, fee);
      if (!voided) summary.service_charge_centavos += fee;
    }
    if (discount > 0) {
      const promo = promoOf.get(o.promo_code_id);
      rows.sale_discounts.push({
        id: uuid(), sale_id: saleId, sale_item_id: null, discount_type: 'MANUAL_TXN',
        original_centavos: subtotal, discount_centavos: discount, discount_bp: Math.round((discount / subtotal) * 10000),
        reason: promo ? `Promo ${promo.code}${promo.label ? ` (${promo.label})` : ''}` : 'Discount in OrderingApp',
        applied_by: createdBy, approved_by: null,
        statutory_id_type: null, statutory_id_no: null, statutory_name: null, created_at: at,
      });
    }
    if (total > 0) {
      rows.sale_tenders.push({
        id: uuid(), sale_id: saleId, method, amount_centavos: tendered,
        reference_no: method === 'CASH' ? null : (o.pay_ref || null), status: 'RECORDED',
        created_at: o.paid_at ? iso(o.paid_at) : at,
      });
    }
    if (voided) summary.voided_centavos += total; else summary.completed_centavos += total;
  }

  // ── Sealed as an export is (OPS-101) ──
  const files = manifest.entities.map((t) => ({ name: `${t}.json`, content: Buffer.from(`${JSON.stringify(rows[t], null, 2)}\n`, 'utf8') }));
  manifest.row_counts = Object.fromEntries(manifest.entities.map((t) => [t, rows[t].length]));
  manifest.total_rows = Object.values(manifest.row_counts).reduce((sum, n) => sum + n, 0);
  manifest.checksum = exportService.checksumOf(files);
  manifest.notes = [...(manifest.notes || []), `${source.store.name} from OrderingApp (tools/orderingapp/to-archive.js, TASK-064).`];
  const archive = zip.zipMany([{ name: exportService.MANIFEST, content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') }, ...files]);

  summary.sales = rows.sales.length;
  summary.shifts = shifts.size;
  summary.products = source.items.length;
  summary.customers = withCustomers ? source.customers.length : 0;
  return { archive, summary };
}

module.exports = { readSource, convert, METHOD };

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
  const base = flag('--base'); const store = flag('--store'); const psql = flag('--psql');
  if (!base || !store || !psql) {
    process.stderr.write('usage: to-archive.js --base <export.zip> --store <name or slug> --psql "<psql command>" [--no-customers] [--out <file>]\n');
    process.exit(2);
  }
  const { archive, summary } = convert({
    base: fs.readFileSync(base), source: readSource(psql, store), customers: !args.includes('--no-customers'),
  });
  const out = flag('--out') || path.join(path.dirname(base), `orderingapp-${summary.store.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}.zip`);
  fs.writeFileSync(out, archive, { mode: 0o600 });
  process.stdout.write(`${out}\n${JSON.stringify(summary, null, 2)}\n`);
}
