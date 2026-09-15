// The cart model — POS-101 to POS-104.
//
// Pure, and deliberately so: this holds lines and quantities and nothing else. **It
// computes no total that is banked.** Every figure the screen shows comes from
// POST /sales/price-check, which is the same computation the sale runs
// (05_TECH_SPEC.md §4.1 step 2), so what the cashier sees and what the till charges
// cannot drift. A total computed here would be a second answer.

export function createCart() {
  let lines = [];
  let customer = null;
  let transactionDiscountCentavos = 0;
  // TAX-004's claim: the ID type, the ID number and the name on it.
  //
  // Held here and **never** parked. `POST /carts/active` takes lines, a customer and a
  // transaction discount, and this is deliberately not among them: a beneficiary's ID
  // number sitting in a parked cart for a week is personal data the store has no reason
  // to keep (RA 10173's minimisation), and a resumed cart asks for the ID again, which
  // is a second look at the card rather than a copy of it.
  let statutory = null;
  // TASK-066: a café's order — how it is served, the table or name, and the open order
  // this cart was loaded from (with what it held when loaded, to know what changed).
  let orderType = null;
  let tableLabel = '';
  let openOrder = null;          // { id, order_no, lines (as loaded) }

  /** A line's identity: product, unit, and — since a note makes a line its own — its note. */
  const keyOf = (productId, packUnitId, note) => `${productId}:${packUnitId || 'base'}${note ? `:${note}` : ''}`;

  /**
   * Add a product, or increase the line already holding it.
   *
   * Scanning the same item twice means two of it, not two lines — 04_UX_SPEC.md's
   * SCR-301 shows a cart a person reads across a counter, and a column of identical
   * one-unit lines is not that. Lines differing by pack are kept apart, because a sack
   * and a loose kilo are different things to pick.
   */
  function add({ product, qtyMilli = 1000, packUnitId = null, note = null }) {
    // A second scan adds to the line without a note: "one more" is one more of the plain
    // one, and the latte with less ice stays the latte with less ice (POS-111).
    const existing = lines.find(
      (line) => line.productId === product.id && line.packUnitId === packUnitId && (line.note || null) === (note || null)
    );

    if (existing) {
      existing.qtyMilli += qtyMilli;
      return existing;
    }

    const line = {
      key: keyOf(product.id, packUnitId, note),
      productId: product.id,
      sku: product.sku,
      name: product.name,
      baseUnit: product.base_unit?.code ?? null,
      baseUnitAllowsFraction: product.base_unit?.allows_fraction ?? true,
      packUnitId,
      packUnitCode: packUnitId
        ? product.packs?.find((pack) => pack.unit.id === packUnitId)?.unit.code ?? null
        : null,
      packFactorMilli: packUnitId
        ? product.packs?.find((pack) => pack.unit.id === packUnitId)?.factor_milli ?? null
        : null,
      qtyMilli,
      discountCentavos: 0,
      note: note || null,
      // INV-114: made to order — no "stock after" under it.
      isStocked: product.is_stocked !== false,
    };
    lines.push(line);
    return line;
  }

  /**
   * POS-111: a note for the kitchen. The line becomes its own — where another line of the
   * same product already carries this note, the two become one.
   */
  function setNote(key, note) {
    const line = lines.find((l) => l.key === key);
    if (!line) return null;
    const text = String(note || '').replace(/\s+/g, ' ').trim() || null;
    const merged = lines.find((l) => l.key !== key && l.productId === line.productId
      && l.packUnitId === line.packUnitId && (l.note || null) === text);
    if (merged) {
      merged.qtyMilli += line.qtyMilli;
      remove(key);
      return merged;
    }
    line.note = text;
    line.key = keyOf(line.productId, line.packUnitId, text);
    return line;
  }

  /**
   * `POS-102`: **`qtyMilli` is what the cashier entered, in the unit they entered it
   * in.** Two sacks is `qtyMilli: 2000` with the sack's `packUnitId`, not 100,000.
   *
   * That is the wire's convention — `POST /sales`, `/sales/price-check` and the parked
   * cart all take the entered quantity and the unit beside it, and `saleService`
   * multiplies by the pack factor to get base. It is also what the rule says: a line
   * quantity **is entered** in the base unit or in a defined pack, and the ledger
   * stores base.
   *
   * Everything on this screen that needs base — the second half of "2 SACK (100 KG)",
   * and `POS-104`'s stock-after — asks for it here rather than assuming. Before the
   * unit picker existed no line ever carried a pack, so the two readings of `qtyMilli`
   * had never disagreed; the first pack line would have shown 2 SACK as 0.04 SACK and
   * counted 2 KG against the shelf.
   */
  const baseMilliOf = (line) => (line.packFactorMilli
    ? Math.round((line.qtyMilli * line.packFactorMilli) / 1000)
    : line.qtyMilli);

  /**
   * Move a line to another of the product's units, keeping the quantity as typed.
   *
   * Changing the unit changes the line's identity — a sack and a loose kilo are
   * different things to pick — so where the cart already holds a line in the unit being
   * moved to, the two merge rather than becoming a second line the counter has to
   * notice. That is `add`'s own rule, applied to a line that already exists.
   */
  function setUnit(key, packUnitId, product) {
    const line = lines.find((l) => l.key === key);
    if (!line) return null;
    if ((line.packUnitId || null) === (packUnitId || null)) return line;

    const pack = packUnitId
      ? product?.packs?.find((p) => p.unit.id === packUnitId) ?? null
      : null;
    if (packUnitId && !pack) return line;

    const merged = lines.find(
      (l) => l.key !== key && l.productId === line.productId && l.packUnitId === (packUnitId || null)
        && (l.note || null) === (line.note || null)
    );
    if (merged) {
      merged.qtyMilli += line.qtyMilli;
      remove(key);
      return merged;
    }

    line.packUnitId = packUnitId || null;
    line.packUnitCode = pack ? pack.unit.code : null;
    line.packFactorMilli = pack ? pack.factor_milli : null;
    line.key = keyOf(line.productId, packUnitId, line.note);
    return line;
  }

  function setQuantity(key, qtyMilli) {
    const line = lines.find((l) => l.key === key);
    if (!line) return null;
    if (qtyMilli <= 0) return remove(key);
    line.qtyMilli = qtyMilli;
    return line;
  }

  function setLineDiscount(key, discountCentavos) {
    const line = lines.find((l) => l.key === key);
    if (!line) return null;
    line.discountCentavos = Math.max(0, discountCentavos);
    return line;
  }

  function remove(key) {
    lines = lines.filter((line) => line.key !== key);
    return null;
  }

  function clear() {
    lines = [];
    customer = null;
    transactionDiscountCentavos = 0;
    statutory = null;
    tableLabel = '';
    openOrder = null;
    // The order type is kept: a café serving dine-in serves the next table dine-in too.
  }

  /** The lines as the server holds an order's, to tell whether this cart has changed. */
  const wireLines = () => lines.map((line) => ({
    productId: line.productId,
    qtyMilli: line.qtyMilli,
    packUnitId: line.packUnitId || null,
    discountCentavos: line.discountCentavos || 0,
    note: line.note || null,
  }));

  /** True when the cart holds more or less than the order it was loaded from. */
  function changedSinceLoaded() {
    if (!openOrder) return lines.length > 0;
    const norm = (list) => JSON.stringify(list.map((l) => [l.productId, l.packUnitId || null, l.qtyMilli, l.discountCentavos || 0, l.note || null])
      .sort((a, b) => (a.join('|') < b.join('|') ? -1 : 1)));
    return norm(wireLines()) !== norm(openOrder.lines);
  }

  /** The request body for price-check and for the sale — one shape, two callers. */
  function toRequest() {
    return {
      customerId: customer?.id ?? null,
      transactionDiscountCentavos,
      // TAX-004: sent to price-check and to the sale, which are the two callers that
      // may act on it. `PUT /carts/active` reads neither it nor anything like it.
      statutory,
      lines: wireLines(),
      // TASK-066: the café's order. Null for a shop's sale, which sends none of them.
      orderType,
      tableLabel: tableLabel || null,
      openOrderId: openOrder ? openOrder.id : null,
    };
  }

  /** Restore a cart the server was holding (POS-105), keeping the display fields. */
  function restore(saved, catalogue = new Map()) {
    clear();
    customer = saved.customer ?? null;
    transactionDiscountCentavos = saved.transaction_discount_centavos || 0;
    if (saved.order_type) orderType = saved.order_type;
    tableLabel = saved.table_label || '';

    for (const line of saved.lines || []) {
      const product = catalogue.get(line.productId);
      if (product) {
        const added = add({ product, qtyMilli: line.qtyMilli, packUnitId: line.packUnitId, note: line.note || null });
        added.discountCentavos = line.discountCentavos || 0;
      } else {
        // The product could not be re-read — withdrawn, or the catalogue was not
        // fetched. The line is kept and flagged rather than dropped: silently losing a
        // line from a restored cart is the failure POS-105 is about.
        lines.push({
          key: `${line.productId}:${line.packUnitId || 'base'}`,
          productId: line.productId,
          sku: null,
          name: 'Unavailable product',
          baseUnit: null,
          baseUnitAllowsFraction: true,
          packUnitId: line.packUnitId,
          packUnitCode: null,
          packFactorMilli: null,
          qtyMilli: line.qtyMilli,
          discountCentavos: line.discountCentavos || 0,
          note: line.note || null,
          unavailable: true,
        });
      }
    }
  }

  /**
   * An open order into the counter (POS-109): its lines, table and type, remembered as
   * loaded so the screen can say whether anything is waiting to go to the kitchen.
   */
  function loadOrder(order, catalogue = new Map()) {
    restore({
      customer: order.customer, transaction_discount_centavos: order.transaction_discount_centavos,
      order_type: order.order_type, table_label: order.table_label, lines: order.lines,
    }, catalogue);
    openOrder = { id: order.id, order_no: order.order_no, lines: order.lines.map((l) => ({ ...l, packUnitId: l.packUnitId || null, note: l.note || null })) };
  }

  /** A restored draft that was an open order: the order, as the kitchen has it (POS-105). */
  function attachOrder(order) {
    openOrder = { id: order.id, order_no: order.order_no, lines: order.lines.map((l) => ({ ...l, packUnitId: l.packUnitId || null, note: l.note || null })) };
  }

  /** After a send, what the kitchen has is what the cart holds. */
  function markSent(order) {
    openOrder = { id: order.id, order_no: order.order_no, lines: wireLines() };
  }

  return {
    add,
    baseMilliOf,
    setUnit,
    setNote,
    loadOrder,
    attachOrder,
    markSent,
    changedSinceLoaded,
    setQuantity,
    setLineDiscount,
    remove,
    clear,
    restore,
    toRequest,
    get lines() { return lines.slice(); },
    get isEmpty() { return lines.length === 0; },
    get count() { return lines.length; },
    get customer() { return customer; },
    set customer(value) { customer = value; },
    get transactionDiscountCentavos() { return transactionDiscountCentavos; },
    set transactionDiscountCentavos(value) { transactionDiscountCentavos = Math.max(0, value || 0); },
    get statutory() { return statutory; },
    set statutory(value) { statutory = value || null; },
    get orderType() { return orderType; },
    set orderType(value) { orderType = value || null; },
    get tableLabel() { return tableLabel; },
    set tableLabel(value) { tableLabel = String(value || ''); },
    get openOrder() { return openOrder; },
  };
}
