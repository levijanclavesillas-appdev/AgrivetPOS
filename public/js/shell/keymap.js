// 04_UX_SPEC.md §7 — the POS keyboard map, in full.
//
// The acceptance criterion is that the whole sale is completable without a mouse, so
// the map is data rather than a switch buried in a handler: the help bar renders from
// it, the handler dispatches from it, and a key that is in one and not the other
// cannot happen.

export const KEYMAP = Object.freeze({
  F1: { action: 'search', label: 'Search' },
  F2: { action: 'customer', label: 'Customer' },
  F3: { action: 'quantity', label: 'Qty' },
  F4: { action: 'lineDiscount', label: 'Discount' },
  F5: { action: 'txnDiscount', label: 'Txn discount' },
  F6: { action: 'park', label: 'Park' },
  F7: { action: 'retrieve', label: 'Retrieve' },
  // TAX-004. In the map always, in the help bar only where the store grants it — a key
  // advertised to every store and refused in most of them is a key cashiers learn to
  // ignore, and this one has to work the day somebody presents an ID.
  F8: { action: 'statutory', label: 'SC/PWD' },
  F9: { action: 'pay', label: 'Pay' },
  F10: { action: 'exactCash', label: 'Exact cash' },
  F12: { action: 'parkAndNew', label: 'Park & new' },
  Delete: { action: 'removeLine', label: 'Remove line' },
  // §7: Escape cancels the current field and **never** the cart. A cashier reaching
  // for it to clear a mis-keyed quantity must not lose the customer's basket.
  Escape: { action: 'cancelField', label: 'Cancel field' },
});

/** The bar along the foot of SCR-301, in the spec's own order. */
export const HELP_ORDER = Object.freeze(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F12']);

export function actionFor(key) {
  return KEYMAP[key]?.action ?? null;
}

/** True for the keys the POS claims, so the handler can preventDefault only on those. */
export function isMapped(key) {
  return Object.prototype.hasOwnProperty.call(KEYMAP, key);
}
