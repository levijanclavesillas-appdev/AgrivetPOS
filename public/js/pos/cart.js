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

  /**
   * Add a product, or increase the line already holding it.
   *
   * Scanning the same item twice means two of it, not two lines — 04_UX_SPEC.md's
   * SCR-301 shows a cart a person reads across a counter, and a column of identical
   * one-unit lines is not that. Lines differing by pack are kept apart, because a sack
   * and a loose kilo are different things to pick.
   */
  function add({ product, qtyMilli = 1000, packUnitId = null }) {
    const existing = lines.find(
      (line) => line.productId === product.id && line.packUnitId === packUnitId
    );

    if (existing) {
      existing.qtyMilli += qtyMilli;
      return existing;
    }

    const line = {
      key: `${product.id}:${packUnitId || 'base'}`,
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
    };
    lines.push(line);
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
  }

  /** The request body for price-check and for the sale — one shape, two callers. */
  function toRequest() {
    return {
      customerId: customer?.id ?? null,
      transactionDiscountCentavos,
      // TAX-004: sent to price-check and to the sale, which are the two callers that
      // may act on it. `PUT /carts/active` reads neither it nor anything like it.
      statutory,
      lines: lines.map((line) => ({
        productId: line.productId,
        qtyMilli: line.qtyMilli,
        packUnitId: line.packUnitId,
        discountCentavos: line.discountCentavos,
      })),
    };
  }

  /** Restore a cart the server was holding (POS-105), keeping the display fields. */
  function restore(saved, catalogue = new Map()) {
    clear();
    customer = saved.customer ?? null;
    transactionDiscountCentavos = saved.transaction_discount_centavos || 0;

    for (const line of saved.lines || []) {
      const product = catalogue.get(line.productId);
      if (product) {
        const added = add({ product, qtyMilli: line.qtyMilli, packUnitId: line.packUnitId });
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
          unavailable: true,
        });
      }
    }
  }

  return {
    add,
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
  };
}
