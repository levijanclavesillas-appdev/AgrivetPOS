'use strict';

// The renderer's pure modules, and the two UI guards that a browser is not needed for.
//
// TASK-015's renderer is vanilla ES modules with no build step (05_TECH_SPEC.md §2), so
// its logic is deliberately kept in modules that touch no DOM at import time — the
// cart, the tender list, the scanner, the formatters and the keyboard map. Those are
// imported here and asserted directly. What genuinely needs a browser — layout,
// focus — is UAT's (§8, TC-UI-01 on the reference machine).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..', '..', '..');
const load = (relative) => import(pathToFileURL(path.join(root, 'public', relative)).href);

/**
 * Source with its comments removed.
 *
 * Every guard below greps for something that must not be in the *code*, and these
 * files explain in prose exactly why it must not be — "Never VERIFIED", "there is no
 * offline indicator". Grepping raw source makes the explanation trip the rule it
 * explains, which is the same trap TC-UT-99 documented and solved the same way.
 */
const codeOf = (relative) => fs.readFileSync(path.join(root, 'public', relative), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

/**
 * The declarations of one CSS rule, found by its exact selector.
 *
 * Comments are stripped first, or the comment above a rule ends up inside its selector
 * capture and no rule is ever found by name.
 */
/**
 * Source with its string concatenations joined up.
 *
 * The renderer's prose is written across several lines with `+`, so a sentence a guard
 * looks for is rarely contiguous in the file. Joining first means a guard checks what
 * the user reads rather than how the line happened to wrap.
 */
const proseOf = (relative) => fs.readFileSync(path.join(root, 'public', relative), 'utf8')
  .replace(/'\s*\n\s*\+\s*'/g, '')
  .replace(/"\s*\n\s*\+\s*"/g, '')
  .replace(/`\s*\n\s*\+\s*`/g, '');

/**
 * Comment prose with its line wrapping undone.
 *
 * The reasoning these guards check for is written in comments, and a comment wraps at
 * eighty columns wherever the sentence happens to be. Grepping the raw file for a
 * phrase finds it only when the wrap falls somewhere else, which makes the guard pass
 * or fail on formatting.
 */
const commentsOf = (relative) => fs.readFileSync(path.join(root, 'public', relative), 'utf8')
  .split('\n')
  .filter((line) => line.trim().startsWith('//') || line.trim().startsWith('*'))
  .map((line) => line.trim().replace(/^\/\/\s?|^\*\s?/, ''))
  .join(' ')
  .replace(/\s+/g, ' ');

/** Every file under public/, so a guard cannot be dodged by adding a new module. */
function walkFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, files);
    else files.push(full);
  }
  return files;
}

function cssRule(css, selector) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of stripped.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = match[1].split(',').map((s) => s.trim());
    if (selectors.includes(selector)) return match[2];
  }
  return null;
}

// ── 04_UX_SPEC.md §4 — money and quantity ───────────────────────────────────

test('money is always two decimals, grouped, and never a bare number', async () => {
  const { money, quantity, packAndBase, percent } = await load('js/shell/format.js');

  assert.equal(money(0), '₱0.00');
  assert.equal(money(7844), '₱78.44');
  assert.equal(money(112000), '₱1,120.00');
  assert.equal(money(100000000), '₱1,000,000.00');
  assert.equal(money(-5000), '-₱50.00');
  assert.equal(money(5), '₱0.05');
  assert.equal(money(null), '₱—', 'a missing figure is not zero');
  assert.equal(money(7844, { symbol: false }), '78.44');

  // MON-002: up to three decimals, trailing zeros trimmed, unit always attached.
  assert.equal(quantity(1255, 'KG'), '1.255 KG');
  assert.equal(quantity(50000, 'KG'), '50 KG');
  assert.equal(quantity(1500, 'KG'), '1.5 KG');
  assert.equal(quantity(-2000, 'KG'), '-2 KG');
  assert.equal(quantity(1000000, 'KG'), '1,000 KG');

  // POS-102 / UOM-002: both the pack entered and the base unit stored.
  assert.equal(
    packAndBase({ qtyMilli: 100000, baseUnit: 'KG', packUnit: 'SACK', packFactorMilli: 50000 }),
    '2 SACK (100 KG)'
  );
  assert.equal(packAndBase({ qtyMilli: 1255, baseUnit: 'KG' }), '1.255 KG', 'no pack, one figure');
  assert.equal(percent(200), '2%');
  assert.equal(percent(250), '2.50%');
});

// ── POS-101 to POS-104 — the cart model ─────────────────────────────────────

const feed = {
  id: 'p1', sku: 'FEED-001', name: 'Hog Grower Pellets',
  base_unit: { id: 'u-kg', code: 'KG', allows_fraction: true },
  packs: [{ unit: { id: 'u-sack', code: 'SACK' }, factor_milli: 50000 }],
};

test('scanning the same item twice makes two of it, not two lines', async () => {
  const { createCart } = await load('js/pos/cart.js');
  const cart = createCart();

  cart.add({ product: feed, qtyMilli: 1000 });
  cart.add({ product: feed, qtyMilli: 1000 });

  // A column of identical one-unit lines is not a cart a person reads across a counter.
  assert.equal(cart.count, 1);
  assert.equal(cart.lines[0].qtyMilli, 2000);
});

test('a sack line and a loose line of one product stay apart', async () => {
  const { createCart } = await load('js/pos/cart.js');
  const cart = createCart();

  cart.add({ product: feed, qtyMilli: 1255 });
  cart.add({ product: feed, qtyMilli: 2000, packUnitId: 'u-sack' });

  // They are different things to pick off a shelf, so they are different lines.
  assert.equal(cart.count, 2);
  assert.equal(cart.lines[1].packUnitCode, 'SACK');
  assert.equal(cart.lines[1].packFactorMilli, 50000);
});

test('the cart request is the shape POST /sales takes', async () => {
  const { createCart } = await load('js/pos/cart.js');
  const cart = createCart();
  cart.add({ product: feed, qtyMilli: 1255 });
  cart.setLineDiscount(cart.lines[0].key, 500);
  cart.customer = { id: 'c1', name: 'Farm', price_level: 'WHOLESALE' };
  cart.transactionDiscountCentavos = 250;

  // The cart is a draft of that request and nothing else, so resuming one and
  // completing it is a hand-off rather than a translation that could drop a field.
  assert.deepEqual(cart.toRequest(), {
    customerId: 'c1',
    transactionDiscountCentavos: 250,
    statutory: null,
    lines: [{ productId: 'p1', qtyMilli: 1255, packUnitId: null, discountCentavos: 500 }],
  });

  // TAX-004's claim travels in the same request — and out of the cart the moment it is
  // cleared, because a beneficiary's ID belongs to the sale it was presented for.
  cart.statutory = { idType: 'SENIOR_CITIZEN', idNo: '12-3456789', name: 'Lolo Ambrosio Cruz' };
  assert.deepEqual(cart.toRequest().statutory, { idType: 'SENIOR_CITIZEN', idNo: '12-3456789', name: 'Lolo Ambrosio Cruz' });
  cart.clear();
  assert.equal(cart.toRequest().statutory, null);
});

test('the cart computes no total — every figure comes from the server', async () => {
  const { createCart } = await load('js/pos/cart.js');
  const cart = createCart();
  cart.add({ product: feed, qtyMilli: 1000 });

  // §4.1 step 2: the client's figures are never banked, so the model does not produce
  // any. A total here would be a second answer to a question with one.
  for (const key of Object.keys(cart)) {
    assert.equal(/total|subtotal|tax|vat/i.test(key), false, `cart exposes ${key}`);
  }
  assert.equal(/unit_?price|price_centavos/i.test(codeOf('js/pos/cart.js')), false, 'the cart holds no price');
});

test('POS-105: a restored line whose product is gone is kept and flagged, not dropped', async () => {
  const { createCart } = await load('js/pos/cart.js');
  const cart = createCart();

  cart.restore({
    customer: null,
    transaction_discount_centavos: 0,
    lines: [{ productId: 'vanished', qtyMilli: 1000, packUnitId: null, discountCentavos: 0 }],
  }, new Map());

  // Silently losing a line from a restored cart is the failure POS-105 is about.
  assert.equal(cart.count, 1);
  assert.equal(cart.lines[0].unavailable, true);
});

// ── POS-201 to POS-207 — the tender model ───────────────────────────────────

test('POS-204: Complete is blocked until tendered ≥ due, and says why', async () => {
  const { createTenders } = await load('js/payment/tenders.js');
  const tenders = createTenders(100000);

  assert.match(tenders.blockedReason(), /Add a payment/);

  const cash = tenders.add('CASH', 60000);
  assert.match(tenders.blockedReason(), /does not cover the total/);
  assert.equal(tenders.remainingCentavos(), 40000);

  cash.amountCentavos = 100000;
  assert.equal(tenders.blockedReason(), null);
  assert.equal(tenders.isComplete, true);
});

test('TC-UT-33: a GCash tender with an empty reference cannot complete', async () => {
  const { createTenders } = await load('js/payment/tenders.js');
  const tenders = createTenders(100000);
  const row = tenders.add('GCASH', 100000);

  // POS-205: never defaulted and never generated — an auto-filled reference is a
  // receipt claiming a payment was traced when nobody traced it.
  assert.match(tenders.blockedReason(), /needs its reference number/);
  row.referenceNo = '   ';
  assert.match(tenders.blockedReason(), /needs its reference number/);

  row.referenceNo = 'GC-0001';
  assert.equal(tenders.blockedReason(), null);
  assert.equal(tenders.toRequest()[0].referenceNo, 'GC-0001');
});

test('POS-207: a duplicate reference blocks until it is explicitly accepted', async () => {
  const { createTenders } = await load('js/payment/tenders.js');
  const tenders = createTenders(100000);
  const row = tenders.add('GCASH', 100000, 'GC-0001');
  row.duplicate = true;

  assert.match(tenders.blockedReason(), /already used today/);
  row.duplicateAccepted = true;
  assert.equal(tenders.blockedReason(), null);
  assert.equal(tenders.anyDuplicateAccepted(), true);
});

test('POS-203 / MON-007: only cash over-tenders, and change is the cash excess', async () => {
  const { createTenders } = await load('js/payment/tenders.js');
  const split = createTenders(100000);
  split.add('CASH', 60000);
  split.add('GCASH', 40000, 'GC-1');
  assert.equal(split.changeCentavos(), 0);
  assert.equal(split.blockedReason(), null);

  const over = createTenders(100000);
  over.add('CASH', 150000);
  assert.equal(over.changeCentavos(), 50000);
  assert.equal(over.blockedReason(), null);

  const nonCashOver = createTenders(100000);
  nonCashOver.add('GCASH', 150000, 'GC-2');
  assert.match(nonCashOver.blockedReason(), /Only cash may be over-tendered/);
});

test('CR-108: store credit is offered up to the balance held, and refused past it', async () => {
  const { createTenders, METHODS, NEEDS_CUSTOMER } = await load('js/payment/tenders.js');

  // TASK-028: the method was in the schema's CHECK from TASK-011 and in no screen.
  assert.ok(METHODS.includes('STORE_CREDIT'));
  // CR-102 / CR-108: both of these belong to an account, so a walk-in is offered
  // neither — money the customer will owe, and money the store already owes them.
  assert.deepEqual([...NEEDS_CUSTOMER], ['CREDIT', 'STORE_CREDIT']);

  const tenders = createTenders(60000);
  // The balance arrives from GET /customers/:id/credit after the screen is drawn, so
  // the model takes it late rather than being rebuilt — rebuilding would throw away
  // whatever the cashier had already keyed.
  tenders.setStoreCreditHeld(40000);

  tenders.add('STORE_CREDIT', 50000);
  assert.match(tenders.blockedReason(), /Only ₱400\.00 of store credit is held/,
    'the figure, because "not enough" is unanswerable at a counter');

  tenders.rows[0].amountCentavos = 40000;
  // Checked before POS-204's shortfall: "this does not cover it yet" is the normal
  // state while counting, and a figure past the balance never becomes acceptable.
  assert.match(tenders.blockedReason(), /does not cover the total yet/);

  tenders.add('CASH', 20000);
  assert.equal(tenders.blockedReason(), null);
  assert.equal(tenders.storeCreditTendered(), 40000);
  // MON-007: change is the cash excess, and store credit is not cash — a balance
  // cannot be handed back as notes.
  assert.equal(tenders.changeCentavos(), 0);

  const none = createTenders(10000);
  none.add('STORE_CREDIT', 10000);
  assert.match(none.blockedReason(), /no store credit to spend/);
});

test('POS-206: every non-cash row is RECORDED and nothing says verified', async () => {
  const { createTenders } = await load('js/payment/tenders.js');
  const tenders = createTenders(1000);
  assert.equal(tenders.add('GCASH', 1000, 'GC-1').status, 'RECORDED');

  // The code, not the comment that explains why the word must not be in the code.
  assert.equal(/VERIFIED|CONFIRMED/.test(codeOf('js/payment/tenders.js')), false);
});

// ── INT-3 — the scanner ─────────────────────────────────────────────────────

test('a fast burst ending in Enter is a scan; human typing is not', async () => {
  const { createScanner } = await load('js/shell/scanner.js');
  const scans = [];
  const scanner = createScanner({ onScan: (c) => scans.push(c) });

  // A wedge scanner emits a whole code in tens of milliseconds. A person cannot.
  let at = 1000;
  for (const ch of '4800016641206') scanner.key({ key: ch, at: (at += 5) });
  assert.equal(scanner.key({ key: 'Enter', at: at + 5 }), 'scan');
  assert.deepEqual(scans, ['4800016641206']);

  // Human-speed keystrokes never accumulate into a scan: each pause longer than the
  // interval restarts the buffer, so Enter after typing is 'type' and no scan fires.
  // The buffer is only a scan detector — what the person typed is in the search field.
  at = 5000;
  for (const ch of 'hog feed') scanner.key({ key: ch, at: (at += 120) });
  assert.equal(scanner.key({ key: 'Enter', at: at + 120 }), 'type');
});

test('INT-3: a scan is ignored while a modal is open', async () => {
  const { createScanner } = await load('js/shell/scanner.js');
  const scans = [];
  const scanner = createScanner({ onScan: (c) => scans.push(c) });

  let at = 1000;
  for (const ch of '4800016641206') scanner.key({ key: ch, at: (at += 5), modalOpen: true });
  assert.equal(scanner.key({ key: 'Enter', at: at + 5, modalOpen: true }), null);
  assert.deepEqual(scans, [], 'a modal owns the keyboard (04_UX_SPEC.md §7)');
});

test('a too-short burst is not a scan', async () => {
  const { createScanner } = await load('js/shell/scanner.js');
  const scans = [];
  const scanner = createScanner({ onScan: (c) => scans.push(c) });

  let at = 1000;
  for (const ch of '12') scanner.key({ key: ch, at: (at += 5) });
  scanner.key({ key: 'Enter', at: at + 5 });
  assert.deepEqual(scans, [], 'somebody leaning on the keyboard is not a scan');
});

// ── 04_UX_SPEC.md §7 — the keyboard map ─────────────────────────────────────

test('the keyboard map is the spec’s, in full', async () => {
  const { KEYMAP, HELP_ORDER, actionFor } = await load('js/shell/keymap.js');

  // §7's table, key for key. The acceptance criterion is a sale completable without a
  // mouse, so a missing key is a mouse.
  assert.deepEqual(Object.keys(KEYMAP).sort(), [
    'Delete', 'Escape', 'F1', 'F10', 'F12', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9',
  ]);
  // TAX-004 (TASK-027). Mapped in every store and shown in the help bar only where the
  // owner has switched it on — a key advertised and then refused is a key cashiers
  // learn to skip, and this one has to work the day somebody presents an ID.
  assert.equal(actionFor('F8'), 'statutory');
  assert.equal(actionFor('F3'), 'quantity');
  assert.equal(actionFor('F9'), 'pay');
  assert.equal(actionFor('F10'), 'exactCash');
  assert.equal(actionFor('Delete'), 'removeLine');
  // §7: Escape cancels the current field and never the cart.
  assert.equal(actionFor('Escape'), 'cancelField');
  // Every helped key is mapped, and the bar renders from the map rather than a copy.
  for (const key of HELP_ORDER) assert.ok(KEYMAP[key], `${key} is in the help bar but not the map`);
});

test('the POS dispatches every action the map names', () => {
  const source = fs.readFileSync(path.join(root, 'public', 'js', 'pos', 'view.js'), 'utf8');
  const actions = [
    'search', 'customer', 'quantity', 'lineDiscount', 'txnDiscount', 'statutory',
    'park', 'retrieve', 'pay', 'exactCash', 'parkAndNew', 'removeLine', 'cancelField',
  ];
  for (const action of actions) {
    assert.match(source, new RegExp(`\\b${action}\\s*:`), `no handler for ${action}`);
  }
});

// ── TC-UI-01 — touch targets, as far as CSS can be read ─────────────────────

test('TC-UI-01: POS and payment controls declare a 44 px minimum', () => {
  // NFR_4.3. The real measurement is on the reference machine at 1366×768 (UAT §8);
  // what is checkable here is that every interactive rule on these screens carries the
  // minimum rather than relying on default button height.
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'pos.css'), 'utf8');

  assert.match(css, /--touch:\s*44px/, 'the token is the rule’s figure');

  for (const selector of [
    '.pos-search', '.rail-item', '.rail-action', '.pay',
    '.tender-amount', '.tender-reference', '.tender-remove', '.tender-add-button',
    '.search-result', '.pin-input',
  ]) {
    const block = cssRule(css, selector);
    assert.ok(block, `${selector} has no rule`);
    assert.match(
      block, /min-(height|width):\s*(var\(--touch\)|3(\.\d+)?rem|4[4-9]px|[5-9]\dpx)/,
      `${selector} does not declare a touch-sized minimum`
    );
  }
});

test('the POS keeps the cart and the rail visible without scrolling the page', () => {
  // 04_UX_SPEC.md §8: designed at 1366×768, and at that size both are visible. The
  // page never scrolls; the cart scrolls inside its own container.
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'pos.css'), 'utf8');
  const pos = cssRule(css, '.pos');

  assert.match(pos, /grid-template-columns/, 'cart and rail side by side');
  assert.match(pos, /height:\s*calc\(100vh/, 'the screen is the viewport, not taller');
  assert.match(cssRule(css, '.cart-lines'), /overflow-y:\s*auto/);
  assert.match(cssRule(css, '.screen'), /overflow:\s*hidden/);

  // §8: below 1024 px the rail collapses to icons rather than disappearing.
  assert.match(css, /@media \(max-width: 1023px\)/);
  assert.match(css.split('@media (max-width: 1023px)')[1], /\.rail-label[^}]*display:\s*none/);
});

test('there is no offline indicator anywhere in the renderer', () => {
  // SCR-301's own states: offline is the normal condition of this product, and a
  // permanent warning trains people to ignore warnings.
  for (const file of walkFiles(path.join(root, 'public', 'js')).filter((f) => f.endsWith('.js'))) {
    // The code, not the comments that explain why there is none.
    const source = codeOf(path.relative(path.join(root, 'public'), file));
    assert.equal(
      /navigator\.onLine|['"`][Oo]ffline['"`]/.test(source), false,
      `${path.relative(root, file)} carries an offline indicator`
    );
  }
});

test('05_TECH_SPEC.md §2: no build step, no framework, no bundler', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };

  for (const banned of ['react', 'vue', 'svelte', 'webpack', 'vite', 'rollup', 'esbuild', 'parcel', 'typescript']) {
    assert.equal(banned in dependencies, false, `${banned} is a build step`);
  }
  // The renderer is loaded as modules straight from public/.
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.match(html, /<script type="module" src="\/js\/boot\.js">/);
});

test('the shell declares a same-origin CSP, and nothing in it needs an exception', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const meta = html.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/);
  assert.ok(meta, 'index.html declares a Content-Security-Policy');

  const policy = meta[1];
  for (const directive of ["default-src 'self'", "script-src 'self'", "connect-src 'self'", "object-src 'none'"]) {
    assert.ok(policy.includes(directive), `the policy sets ${directive}`);
  }
  // A policy with an escape hatch in it is a policy that stops meaning anything.
  assert.equal(/unsafe-inline|unsafe-eval|\*/.test(policy), false, 'and grants no exception');

  // frame-ancestors is ignored in a <meta>, so claiming it would be theatre.
  assert.equal(policy.includes('frame-ancestors'), false);

  // The policy is only true if the renderer really is same-origin. Nothing loads from
  // a CDN, and no module reaches past 127.0.0.1 — which is SEC-8 restated on this side.
  for (const file of walkFiles(path.join(root, 'public'))) {
    if (!/\.(js|html|css)$/.test(file)) continue;
    const source = codeOf(path.relative(path.join(root, 'public'), file));
    assert.equal(
      /https?:\/\/(?!127\.0\.0\.1|localhost)/.test(source), false,
      `${path.relative(root, file)} reaches off the machine`
    );
  }
});

test('no inline script and no inline style survive in the shell', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  // Both are refused by the policy above, so either one is a blank screen on a store
  // PC and a green test suite here — the worst pairing there is.
  assert.equal(/<script(?![^>]*\bsrc=)/.test(html), false, 'no inline <script>');
  assert.equal(/<style[\s>]/.test(html), false, 'no inline <style>');
});

// ── SCR-601 – SCR-604 (TASK-016) ────────────────────────────────────────────

test('TC-INT-60: the dashboard view does no arithmetic of its own', () => {
  // Requirement 2 of TASK-016: every tile figure comes from the report behind it. The
  // way that goes wrong is a renderer that "just adds up" the methods to fill a tile,
  // and then disagrees with the report by one centavo of rounding for a week before
  // anyone notices. So the view is asserted to contain no money arithmetic at all.
  const source = codeOf('js/reports/dashboard.js');

  assert.equal(/centavos\s*[-+*/]/.test(source), false, 'no arithmetic on a centavo figure');
  assert.equal(/reduce\(/.test(source), false, 'no summing in the view');
  assert.equal(/\.value_centavos\s*[-+*/]/.test(source), false);
  // It renders `display`, which the server formatted from the same figure the report
  // used.
  assert.match(source, /data\.display|tile-value/);
});

test('OPS-007: the alert list gives the undismissible ones no dismiss control', () => {
  const source = codeOf('js/reports/dashboard.js');

  // Not a disabled button — no button. An absent control says "you cannot" more
  // clearly than a greyed one, and there is nothing to explain.
  assert.match(source, /a\.dismissible\s*\n?\s*\?/, 'the control is conditional on the flag');
  assert.equal(/disabled:\s*!a\.dismissible/.test(source), false, 'not merely disabled');

  // And dismissal never leaves the browser: "I have read this" is not a fact about the
  // store, so nothing is written to the server.
  assert.equal(/api\.(post|put|del)\(/.test(source), false, 'dismissal writes nothing');
});

test('POS-206: no report screen can say a payment was verified', () => {
  for (const file of walkFiles(path.join(root, 'public', 'js', 'reports'))) {
    const source = codeOf(path.relative(path.join(root, 'public'), file));
    assert.equal(
      /VERIFIED|CONFIRMED|SETTLED/.test(source), false,
      `${path.relative(root, file)} implies a payment was confirmed`
    );
  }
});

test('RPT-101: a report that does not reconcile says so in those words', () => {
  const source = proseOf('js/reports/report.js');

  // A red tick is not enough. The rule calls a failed reconciliation a defect, and the
  // screen has to say that, because the alternative reading — "rounding" — is exactly
  // the one a person reaches for when the numbers are close.
  assert.match(source, /does not reconcile/);
  assert.match(source, /defect, not a rounding artefact/);
  assert.match(source, /RPT-101/);

  // And the arithmetic is printed, not just checked (FR_6.2).
  assert.match(source, /r\.statement/);
  assert.match(source, /r\.tender_statement/);
});

test('every report screen renders RPT-106’s header', () => {
  const source = codeOf('js/reports/report.js');
  for (const field of ['from_date', 'tax_mode', 'includes_voided', 'generated_at_manila']) {
    assert.ok(source.includes(field), `the header shows ${field}`);
  }
  // headerBlock is called for all three reports, not only the daily one.
  assert.match(source, /headerBlock\(data\.header\)/);
});

test('TX-426: the export is fetched with the session, never followed as a link', () => {
  // SEC-7 keeps the token in memory only, so a plain <a href> the browser follows
  // arrives unauthenticated and the user gets a 401 page instead of a spreadsheet.
  const source = codeOf('js/reports/report.js');
  assert.match(source, /event\.preventDefault\(\);\s*exportCsv\(\)/);
  assert.match(source, /api\.download\(/);
  assert.match(codeOf('js/shell/api.js'), /export async function download/);
});

test('NFR_4.3: the dashboard and report controls are touchable', () => {
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'reports.css'), 'utf8');
  for (const selector of ['.dash-refresh', '.alert-dismiss', '.report-back, .report-export']) {
    const rule = cssRule(css, selector) ?? cssRule(css, selector.split(',')[0].trim());
    assert.ok(rule, `${selector} has a rule`);
    assert.match(rule, /min-height:\s*var\(--touch\)|min-height:\s*44px/, `${selector} is ≥ 44 px`);
  }
});

// ── SCR-704, SCR-705 (TASK-017) ─────────────────────────────────────────────

test('SEC-9: SCR-704 says who can read a backup, and promises no encryption', () => {
  const source = proseOf('js/admin/backup.js');

  assert.match(source, /shared_drive_warning/, 'the server’s wording, not a second copy');
  // 05_TECH_SPEC.md §7: the off-machine copy is a process control. The screen says so
  // rather than implying the application handles it.
  assert.match(source, /Nothing in this application does that for you/);
  assert.match(source, /USB stick/);

  const code = codeOf('js/admin/backup.js');
  assert.equal(/encrypt/i.test(code), false, 'it does not promise encryption it does not do');
  // NFR_3.1 and TASK-017 requirement 13: no cloud target anywhere in the renderer.
  // The pattern is anchored on word boundaries — an earlier version matched `sync`
  // inside `async function` and failed on the word "async", which is the same trap
  // TC-UT-99 and the offline guard both had to solve.
  assert.equal(
    /\b(cloud|dropbox|onedrive|gdrive)\b|drive\.google|amazonaws/i.test(code), false,
    'the renderer offers no off-machine target'
  );
});

test('OPS-004: the restore needs the filename typed, checked in the view too', () => {
  const source = codeOf('js/admin/backup.js');

  // The server refuses a wrong filename regardless (SEC-6); this is the courtesy on
  // top of it, and 04_UX_SPEC.md §6 puts validation at the point of action.
  assert.match(source, /typed\.value\.trim\(\) !== backup\.file_name/);
  assert.match(source, /go\.disabled = true/, 'and it starts disabled');
  // Not a checkbox: a checkbox is ticked without reading, and the date on the file is
  // the thing that has to be read.
  assert.equal(/type: 'checkbox'/.test(source), false);
  assert.match(source, /class: 'danger'/, 'the most destructive button looks like one');
});

test('OPS-007: the undismissible alerts get no dismiss control on any screen', () => {
  for (const file of ['js/reports/dashboard.js', 'js/admin/backup.js', 'js/admin/health.js']) {
    const source = codeOf(file);
    // Every screen renders the dismiss control conditionally on the server's flag, or
    // renders none at all. None of them decides for itself which alerts are dismissible.
    const hardCoded = /BACKUP_OVERDUE|CLOCK_ANOMALY|BACKUP_UNVERIFIED/.test(source);
    assert.equal(hardCoded, false, `${file} decides dismissibility for itself`);
  }
  assert.match(codeOf('js/reports/dashboard.js'), /a\.dismissible\s*\n?\s*\?/);
});

test('OPS-006: SCR-705 renders all six figures', () => {
  const source = codeOf('js/admin/health.js');
  for (const [figure, pattern] of [
    ['schema version', /schema\.version/],
    ['database size', /size_display/],
    ['row counts', /row_counts/],
    ['last successful backup', /last_successful_at/],
    ['last export', /last_export_at/],
    ['last integrity check', /last_integrity_check_at/],
  ]) assert.match(source, pattern, `SCR-705 shows the ${figure}`);

  // And it reads the panel, which is the endpoint that carries them.
  assert.match(source, /api\.get\('\/health\/panel'\)/);
});

test('NFR_4.3: the admin controls are touchable', () => {
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'reports.css'), 'utf8');
  for (const selector of ['.admin-tab', '.admin-head button', '.confirm-filename',
    '.dialog-actions button', '.backup-list .restore']) {
    const rule = cssRule(css, selector);
    assert.ok(rule, `${selector} has a rule`);
    assert.match(rule, /min-height:\s*var\(--touch\)|min-height:\s*44px/, `${selector} is ≥ 44 px`);
  }
});

// ── SCR-201 – SCR-204 (TASK-036) ────────────────────────────────────────────

test('TC-UI-02: cost is absent from the catalogue, not disabled', () => {
  // TX-412 makes cost owner-only. The server omits it from the payload entirely, so
  // the editor is built from what arrived rather than from a role check here — the
  // version that stays right when the matrix changes. A greyed-out cost field would
  // still tell a cashier the margin exists and roughly where.
  const editor = codeOf('js/catalogue/editor.js');
  assert.match(editor, /'avg_cost_centavos' in product/, 'the tab is built from the payload');
  assert.equal(/disabled:.*cost/i.test(editor), false, 'and never merely disabled');
  // Stronger than checking the role test is absent: the view has no session in scope
  // at all, so there is nothing for a future change to start branching on.
  assert.equal(/\bsession\b/.test(editor), false, 'the editor holds no session to branch on');

  // The list shows retail, never cost.
  const list = codeOf('js/catalogue/list.js');
  assert.equal(/avg_cost|cost_centavos/.test(list), false, 'the list carries no cost at all');
  assert.match(list, /retail_price_centavos/);
});

test('TC-UI-03: the base unit is locked once stock has moved, and says why', () => {
  const source = proseOf('js/catalogue/editor.js');

  assert.match(source, /product\.base_unit_locked/, 'the lock comes from the server');
  // UOM-003's whole point: a locked field with no explanation is a support call, and
  // the correction path is a new product rather than an edit.
  assert.match(source, /every one of those movements is recorded in this unit/);
  assert.match(source, /create a new product/);
  assert.match(source, /UOM-003/);
});

test('INV-108: an adjustment reason is chosen from a list, never typed', () => {
  const source = codeOf('js/catalogue/adjustment.js');

  // An adjustment justified by whatever somebody typed is the audit hole the rule
  // closes: every such row reads differently and none of them can be counted.
  assert.match(source, /reasons\.map\(\(r\) => h\('option'/, 'the reasons are a select');
  assert.equal(
    /h\('input',[^)]*aria-label: 'Reason'/.test(source), false,
    'the reason is never a free-text input'
  );
  assert.match(source, /notes/, 'notes are separate, and optional');
});

test('AUD-603: the adjustment screen uses the shared authorisation panel', () => {
  const source = codeOf('js/catalogue/adjustment.js');

  // The same panel the POS screen uses. A second one would drift, and the day they
  // disagreed the counter and the stockroom would each be sure they were right.
  assert.match(source, /ui\.authorisationPanel\(/);
  assert.equal(/authorisation-actions|approverPassword/.test(source), false, 'not a second panel');

  // The approver authenticates as themselves, so the row records two distinct actors.
  assert.match(source, /api\.post\('\/auth\/login'/);
  // And submit stays disabled until they have.
  assert.match(source, /disabled: Boolean\(refusal\) && !approver/);
});

test('INV-101: no catalogue screen lets anyone type an on-hand figure', () => {
  // On hand is derived from the ledger. A screen with an editable on-hand box is a
  // screen that would need a code path writing it directly, which FR_2.4 forbids.
  for (const file of ['js/catalogue/editor.js', 'js/catalogue/list.js', 'js/catalogue/adjustment.js']) {
    const source = codeOf(file);
    assert.equal(
      /h\('input'[^;]*qty_on_hand/.test(source), false,
      `${file} offers an editable on-hand field`
    );
  }
  assert.match(proseOf('js/catalogue/editor.js'), /On hand comes from the stock ledger and cannot be typed/);
});

test('NFR_4.3: the catalogue controls are touchable', () => {
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'catalogue.css'), 'utf8');
  for (const selector of ['.catalogue-search', '.row-action', '.pager button',
    '.editor-actions button', '.catalogue-controls select']) {
    const rule = cssRule(css, selector);
    assert.ok(rule, `${selector} has a rule`);
    assert.match(rule, /min-height:\s*var\(--touch\)|min-height:\s*44px/, `${selector} is ≥ 44 px`);
  }

  // 04_UX_SPEC §3's two row treatments.
  assert.match(cssRule(css, '.catalogue-list tr.is-low'), /border-left-color/);
  assert.match(cssRule(css, '.catalogue-list tr.is-inactive'), /color/);
});

// ── SCR-501 – SCR-503 (TASK-038) ────────────────────────────────────────────

test('TC-UI-04: the close never pre-fills a counted figure from the expected one', () => {
  // POS-510 forbids a silent forced balance, and one line — `value: expected` — would
  // be the whole of the control this screen exists to provide. A pre-filled count is a
  // count nobody made, and the temptation is strongest at seven in the evening when
  // the drawer is ₱200 short.
  const source = codeOf('js/shift/view.js');

  assert.match(source, /value: typed === undefined \? '' : typed/, 'the input shows what was typed');
  assert.equal(
    /value:\s*(money\()?\s*expected|value:\s*expectedCentavos/.test(source), false,
    'nothing seeds a counted field from an expected figure'
  );
  // And the intent is written down, so a future edit has to argue with it.
  assert.match(commentsOf('js/shift/view.js'), /a count nobody made/);
});

test('TC-UI-05: CREDIT is shown, explained, and carries no counted input', () => {
  const source = codeOf('js/shift/view.js');

  // A credit sale takes no money, so there is nothing to count against it. Asking
  // would ask for a count nobody can make, and would count the same peso twice — once
  // as credit given today, once as cash collected next week.
  assert.match(source, /COUNTED = \['CASH', 'GCASH', 'QRPH'\]/);
  assert.match(source, /!COUNTED\.includes\(method\.method\)/, 'unreconcilable rows branch early');
  assert.match(commentsOf('js/shift/view.js'), /CREDIT takes no money/i);

  // The summary renders the same distinction from the server's own flag.
  assert.match(codeOf('js/shift/summary.js'), /line\.reconcilable/);
});

test('OPS-002: the close summary states what happened to the backup', () => {
  const source = proseOf('js/shift/summary.js');

  // A close whose backup failed has to say so on the screen that closed it. In the
  // alert centre only, the person who could still plug the drive back in before going
  // home never sees it.
  assert.match(source, /it is not backed up/);
  assert.match(source, /Tell the owner before you go home/);
  assert.match(source, /opened.*and checked/i, 'and says verified, not merely written');
  assert.match(codeOf('js/shift/summary.js'), /backup\.ok/);
});

test('POS-511: the closed summary offers no way to change anything', () => {
  const source = codeOf('js/shift/summary.js');

  // It is a read. A button implying otherwise would be a button the server refuses.
  assert.equal(/api\.(post|put|del)\(/.test(source), false, 'the summary writes nothing');
  assert.equal(/<input|h\('input'/.test(source), false, 'and offers no field');
  assert.match(proseOf('js/shift/summary.js'), /cannot be changed \(POS-511\)/);
});

test('POS-501: there is exactly one place a shift is opened', () => {
  // The POS screen used to carry its own float form. Two forms that open a shift are
  // two places for POS-503's confirmation tick to drift apart.
  const shell = codeOf('js/shell/app.js');
  assert.equal(/openingFloatCentavos/.test(shell), false, 'the shell no longer opens shifts');
  assert.match(shell, /onAction: \(\) => showShift\(\)/, 'the POS empty state routes to SCR-501');

  const opens = walkFiles(path.join(root, 'public', 'js'))
    .filter((f) => f.endsWith('.js'))
    .filter((f) => /openingFloatCentavos/.test(codeOf(path.relative(path.join(root, 'public'), f))));
  assert.deepEqual(
    opens.map((f) => path.basename(f)), ['view.js'],
    'only the shift view posts an opening float'
  );
});

test('NFR_4.3: the shift controls are touchable', () => {
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'shift.css'), 'utf8');
  for (const selector of ['.shift-close input', '.variance-reason']) {
    const rule = cssRule(css, selector);
    assert.ok(rule, `${selector} has a rule`);
    assert.match(rule, /min-height:\s*var\(--touch\)|min-height:\s*44px/, `${selector} is ≥ 44 px`);
  }
  // The variance column is coloured per row, as 04_UX_SPEC §3 asks.
  assert.match(cssRule(css, '.shift-close .variance.down'), /color/);
  assert.match(cssRule(css, '.shift-close .variance.up'), /color/);
});

// ── SCR-701 (TASK-040) ──────────────────────────────────────────────────────

test('TC-UI-06: no password or PIN is ever rendered back into the DOM', () => {
  // SEC-1 keeps hashes on the server; this is the renderer's half. The fields are
  // write-only: never given a `value`, cleared after use, and never read back into a
  // re-render — a password that survives a re-render is a password sitting in the DOM
  // of a machine on a shop counter.
  const source = codeOf('js/admin/users.js');

  assert.match(source, /const password = h\('input', \{ type: 'password', autocomplete: 'new-password' \}\)/);
  assert.equal(/value: (password|pin)\.value/.test(source), false, 'neither is echoed back');
  assert.equal(/password\.value = user|pin\.value = user/.test(source), false, 'nor seeded from a user');
  assert.match(source, /password\.value = '';/, 'and both are cleared after use');
  assert.match(source, /pin\.value = '';/);

  // The list renders no secret-shaped field at all.
  assert.equal(/password_hash|pin_hash/.test(source), false);
});

test('VR-503: the last-owner guard is explained, not greyed out', () => {
  const source = commentsOf('js/admin/users.js');

  // A disabled control teaches nobody why the store must keep an owner. The screen
  // offers the action and renders the server's refusal, which names the rule.
  assert.match(source, /greyed-out button teaches nobody/);
  assert.match(codeOf('js/admin/users.js'), /err\.ruleId/, 'the refusal names its rule');
});

test('AUD-606: the screen deactivates rather than deletes, and says why', () => {
  const source = proseOf('js/admin/users.js');

  assert.match(source, /deactivated, never deleted/);
  assert.match(source, /AUD-606/);
  assert.equal(/api\.del\(/.test(codeOf('js/admin/users.js')), false, 'there is no delete call');
});

test('SEC-2: the PIN is described as a screen unlock, not a way to sign in', () => {
  // The distinction matters: a PIN that reads as a login is a four-digit password on a
  // machine anyone in the shop can reach.
  assert.match(proseOf('js/admin/users.js'), /It is not a way to sign in \(SEC-2\)/);
});

test('NFR_4.3: the user form is touchable', () => {
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'reports.css'), 'utf8');
  const rule = cssRule(css, '.user-form input');
  assert.ok(rule, '.user-form input has a rule');
  assert.match(rule, /min-height:\s*var\(--touch\)/);
});

// ── SCR-702 (TASK-039) ──────────────────────────────────────────────────────

test('TC-UI-07: the settings screen holds no copy of the registry', () => {
  // OPS-005 says an operator-owned figure lives in the registry and nowhere else. A
  // screen that knew the keys, the bounds or the labels independently would be the
  // second place the rule exists to prevent — and the day the two disagreed, the
  // screen would validate against figures the server had stopped using.
  const source = codeOf('js/admin/settings.js');

  // Not one registered key is named in the view, bar the single branch that decides
  // where the print-test button belongs.
  const settingsService = require(path.join(root, 'src', 'services', 'settingsService.js'));
  const named = settingsService.KEYS.filter((key) => source.includes(`'${key}'`));
  assert.deepEqual(named, ['printer_transport'],
    'the view names a setting key, which means it knows the registry');

  // No group labels either: they come from the server's GROUPS.
  for (const label of Object.values(settingsService.GROUPS)) {
    assert.equal(source.includes(label), false, `the view hard-codes the group label "${label}"`);
  }

  // And no bounds. Every limit is the server's, and the refusal is what surfaces.
  assert.match(source, /setting\.min/, 'bounds are read from the declaration');
  assert.match(source, /setting\.one_of/, 'and so is the enumeration');
  assert.match(source, /groups\[group\]/, 'and the group label');
});

test('OPS-005: every field carries its rule id, visibly', () => {
  const source = codeOf('js/admin/settings.js');
  assert.match(source, /class: 'setting-rule', text: setting\.rule_id/);

  // Visible, not a tooltip. The whole value of the id is somebody reading it aloud.
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'reports.css'), 'utf8');
  const rule = cssRule(css, '.setting-rule');
  assert.ok(rule, '.setting-rule has a rule');
  assert.equal(/display:\s*none/.test(rule), false, 'and it is not hidden');
});

test('TAX-001: the consequence is stated before the control, not after the click', () => {
  const source = proseOf('js/admin/settings.js');

  // Past sales keep the mode they were made under, and reports spanning the change
  // report both. That is not undoable, so it is said where somebody reads it first.
  assert.match(source, /report that spans the change reports two modes at once/);
  assert.match(source, /it cannot be undone/);
  assert.match(codeOf('js/admin/settings.js'), /TX-425/);
});

test('INT-1: the print test tells the reader to look at the paper', () => {
  // A width set wrong does not error on a thermal head — it wraps a peso figure onto
  // two lines. The screen cannot show that; only the paper can.
  const source = proseOf('js/admin/settings.js');
  assert.match(source, /Read the paper, not the screen/);
  assert.match(codeOf('js/admin/settings.js'), /api\.post\('\/print\/test'/);
});

test('NFR_4.3: the settings controls are touchable', () => {
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'reports.css'), 'utf8');
  const rule = cssRule(css, '.setting input[type="text"]');
  assert.ok(rule, 'the text inputs have a rule');
  assert.match(rule, /min-height:\s*var\(--touch\)/);
});

// ── SCR-401 – SCR-403 (TASK-037) ────────────────────────────────────────────

test('TC-UI-08: no customer screen computes a balance of its own', () => {
  // CR-103 derives the balance from the transactions. A screen that added up its own
  // would eventually disagree with the ledger, and that is the one disagreement a
  // credit system cannot survive.
  const profile = codeOf('js/customers/profile.js');
  const list = codeOf('js/customers/list.js');

  for (const [name, source] of [['profile', profile], ['list', list]]) {
    assert.equal(
      /balance_centavos\s*[-+]\s*|reduce\(/.test(source), false,
      `the ${name} does arithmetic on a balance`
    );
  }
  assert.match(profile, /money\(credit\.balance_centavos\)/, 'it renders the server’s figure');
  assert.match(profile, /money\(row\.balance_after_centavos\)/, 'and the ledger’s running balance');
});

test('TC-UI-08: the collection preview is labelled an estimate, and the result is not', () => {
  const source = codeOf('js/customers/collection.js');

  // The preview subtracts, because a cashier needs to see the consequence before
  // committing. What matters is that it says so, and that the figure quoted afterwards
  // is the server's.
  assert.match(source, /credit\.balance_centavos - paid/, 'the preview is arithmetic');
  assert.match(commentsOf('js/customers/collection.js'), /an estimate, and labelled as one/);
  assert.match(source, /result\.balance_centavos/, 'and the result renders the server’s figure');
  assert.equal(
    /result\.balance_centavos\s*[-+]/.test(source), false,
    'which is never adjusted here'
  );
});

test('CR-204: an overpayment tick starts off and names the excess first', () => {
  const source = codeOf('js/customers/collection.js');

  // A tick that defaults to on is not explicit, and the rule asks for explicit.
  assert.match(source, /let acceptOverpayment = false;/);
  assert.match(source, /checked: acceptOverpayment/);
  // Submit is refused while the excess is unacknowledged.
  assert.match(source, /excess > 0 && !acceptOverpayment/);
  // And the amount is named in the label, not merely "there is an overpayment".
  assert.match(proseOf('js/customers/collection.js'), /more than they owe/);
  assert.match(source, /keep the extra \$\{money\(excess\)\}/);
});

test('CR-205: the screen warns that a cash collection opens the drawer', () => {
  // A cashier who does not expect the drawer will not have it ready.
  assert.match(proseOf('js/customers/collection.js'), /the drawer opens/);
  assert.match(codeOf('js/customers/collection.js'), /CR-205/);
});

test('CR-106: the credit limit is its own action, not a field on the customer form', () => {
  // Folding it into the customer form would let a TX-413 holder raise a limit as a
  // side effect of correcting a phone number, which is why the API separates them.
  const list = codeOf('js/customers/list.js');
  const profile = codeOf('js/customers/profile.js');

  assert.equal(/credit-limit/.test(list), false, 'the create form does not set a limit endpoint');
  assert.match(profile, /api\.put\(`\/customers\/\$\{customerId\}\/credit-limit`/);
  assert.match(profile, /TX-414/);
});

test('NFR_4.3: the customer and collection controls are touchable', () => {
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'customers.css'), 'utf8');
  for (const selector of ['.customer-form input, .customer-form select',
    '.collection input, .collection select', '.limit-form input']) {
    const rule = cssRule(css, selector) ?? cssRule(css, selector.split(',')[0].trim());
    assert.ok(rule, `${selector} has a rule`);
    assert.match(rule, /min-height:\s*var\(--touch\)/);
  }
  // CR-107's overdue treatment.
  assert.match(cssRule(css, '.tag.overdue'), /color/);
});

// ── SCR-703 (TASK-041) ──────────────────────────────────────────────────────

test('TC-UI-09: the audit viewer holds no action list, and writes nothing', () => {
  const source = codeOf('js/admin/audit.js');
  const auditService = require(path.join(root, 'src', 'services', 'auditService.js'));

  // The filter is built from what the endpoint returns, so an action added to the
  // ACTIONS registry appears with no edit — and one removed cannot linger as a choice
  // the server would refuse.
  const named = auditService.ACTION_NAMES.filter((action) => source.includes(action));
  assert.deepEqual(named, [], 'the viewer names an audit action, which means it knows the registry');
  assert.match(source, /body\.actions/, 'the actions come from the server');
  assert.match(source, /body\.actors/, 'and so do the actors');

  // AUD-605: the trail has no update or delete path anywhere in the product, so this
  // screen has no control that implies one.
  assert.equal(/api\.(post|put|del)\(/.test(source), false, 'nothing on the screen writes');
  assert.match(proseOf('js/admin/audit.js'), /Nothing here can be changed or removed/);
});

test('AUD-603: an override row shows both actors', () => {
  const source = codeOf('js/admin/audit.js');
  // An override that names one person is an override nobody authorised.
  assert.match(source, /row\.approver/);
  assert.match(source, /approved by \$\{row\.approver\.username\}/);
});

test('AUD-606: a row opens to before and after, side by side', () => {
  const source = codeOf('js/admin/audit.js');

  // "Price changed" answers nothing. The rule is that the change is legible
  // afterwards, which needs both figures where a reader can compare them.
  assert.match(source, /text: 'Before'/);
  assert.match(source, /text: 'After'/);
  assert.match(source, /row\.before === null \? '—' : format\(row\.before\)/);

  const css = fs.readFileSync(path.join(root, 'public', 'css', 'reports.css'), 'utf8');
  assert.match(cssRule(css, '.detail-grid'), /grid-template-columns:\s*1fr 1fr/);
});

test('TX-429: the export is read-permission, and the screen says it is recorded', () => {
  const source = proseOf('js/admin/audit.js');

  // Exporting the trail is reading the trail, so it is not TX-426. And a copy of
  // who-did-what leaving the machine is exactly the event somebody would want to find.
  assert.match(source, /The export is on the trail itself/);
  assert.match(codeOf('js/admin/audit.js'), /api\.download\(`\/audit\/export/);
});

test('NFR_4.3: the audit filters are touchable', () => {
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'reports.css'), 'utf8');
  for (const selector of ['.audit-filter select, .audit-filter input', '.audit-filters button']) {
    const rule = cssRule(css, selector) ?? cssRule(css, selector.split(',')[0].trim());
    assert.ok(rule, `${selector} has a rule`);
    assert.match(rule, /min-height:\s*var\(--touch\)/);
  }
});

// ── SCR-301's discount rules (TASK-023) ─────────────────────────────────────

test('PR-206: the counter says which discount applied and why the other did not', () => {
  const source = codeOf('js/pos/view.js');

  // The applied figure is the server's choice, not the typed one. A screen that showed
  // `line.discountCentavos` would show one number while the till charged another the
  // moment an automatic discount beat it.
  assert.match(source, /pricedLine\.line_discount_centavos/);
  assert.match(source, /discount_choice/);
  assert.match(source, /choice\.suppressed/);

  // And the sentence is the server's too — a screen that wrote its own would be a
  // second place PR-206 lives, and the two would drift.
  assert.match(source, /text: choice\.why/);
  assert.equal(/do not add together/.test(source), false, 'the explanation is fetched, not written here');
});

test('PR-106: the tier is named on the rail, and the label comes from the registry', () => {
  const source = codeOf('js/pos/view.js');

  // "Why is there ₱300 off" is a question the customer asks at the counter.
  assert.match(source, /transaction_tier\?\.applies/);
  assert.match(source, /priced\.transaction_tier\.band\.label/);
  assert.match(source, /transaction_discount_choice\?\.suppressed/);

  // OPS-005 / requirement 7: not one band, threshold or percentage is written here.
  assert.equal(/min_subtotal_centavos\s*[:=]\s*\d/.test(source), false,
    'the screen holds no copy of a band');
  assert.equal(/discount_bp\s*[:=]\s*\d/.test(source), false, 'nor of a rate');
});

test('TC-UI-07: a structured JSON setting is rendered from the server’s own entry_shape', () => {
  const source = codeOf('js/admin/settings.js');

  // PR-106's bands are objects, and "one per line" has nothing to put on a line. Which
  // shape a list has is the server's answer — a screen that guessed by inspecting the
  // value would render "[object Object]" the first time it met a structured list, and
  // one that knew the key would be the copy of the registry this case forbids.
  assert.match(source, /setting\.entry_shape === 'OBJECT'/);
  assert.match(source, /JSON\.parse\(event\.target\.value\)/);
  assert.equal(source.includes('transaction_discount_tiers'), false,
    'the screen does not name the setting it is rendering');

  // A half-typed band is not staged as broken: the server would refuse it, and Save
  // silently skipping the one field somebody was editing is worse than a message.
  assert.match(source, /setCustomValidity/);
});

test('requirement 7: the counter reads the discount rules from the policy endpoint', () => {
  const source = codeOf('js/pos/view.js') + codeOf('js/pos/cart.js') + codeOf('js/payment/view.js');

  // The whole of PR-106 and PR-202 arrives through /sales/price-check and
  // /sales/pricing-policy. No screen names a category cap or a tier of its own.
  assert.equal(/max_discount_bp\s*[:=]\s*\d/.test(source), false);
  assert.equal(/PR-106'\s*:/.test(source), false);

  const css = fs.readFileSync(path.join(root, 'public', 'css', 'pos.css'), 'utf8');
  // Both explanations are quiet: the figures above them are what the eye should land
  // on, and a rule note in the error colour beside every discounted line would be read
  // as a problem rather than as an answer.
  assert.match(cssRule(css, '.rail-tier-why'), /color:\s*var\(--muted\)/);
  assert.match(cssRule(css, '.cart-line-discount .discount-why'), /color:\s*var\(--muted\)/);
});

// ── PR-103 and PR-104 on the screens (TASK-024) ─────────────────────────────

test('PR-101: the counter names the resolved level in words a cashier can repeat', () => {
  const source = codeOf('js/pos/view.js');

  // "QUANTITY_BREAK" is a column value, not a reason somebody can give a customer
  // standing at the counter. The label is the screen's — presentation, not policy —
  // and every fact in it is the server's.
  assert.match(source, /price_level === 'CUSTOMER_SPECIFIC'/);
  assert.match(source, /price_level === 'QUANTITY_BREAK'/);
  assert.match(source, /pricedLine\.quantity_band/);
  assert.match(source, /pricedLine\.customer_price_note/);

  // And the screen resolves no price of its own: it renders which level won, never
  // works out which should have.
  assert.equal(/customerPriceAt|quantityBreaksAt|min_qty_milli\s*<=/.test(source), false);
});

test('PR-104: bands are edited as a set, and the rule is the server’s sentence', () => {
  const source = codeOf('js/catalogue/editor.js');

  // A whole set per level, saved with one PUT. A band added on its own is a set nobody
  // validated — which is the only level at which PR-104's rules exist.
  assert.match(source, /api\.put\(`\/products\/\$\{product\.id\}\/quantity-breaks`/);
  assert.match(source, /priceLevel: breakLevel, bands/);
  assert.match(source, /Saving replaces every band at this level/);

  // The explanation comes from GET /products/:id/quantity-breaks. "To the whole line,
  // not marginally" is the half somebody setting one gets wrong, and it is not the
  // screen's to phrase.
  assert.match(source, /text: breaks\.note/);
  assert.equal(source.includes('not marginally'), false, 'the note is fetched, not written here');

  // The rows being typed survive a render. Rebuilding them from the server's copy on
  // every render made "Add a band" appear and vanish in the same frame — which every
  // unit guard here would have passed, and the browser found in one click.
  assert.match(source, /if \(bandDraft === null\)/);
  assert.match(source, /bandDraft\.push\(\{ qty: '', price: '' \}\)/);
  assert.match(source, /breakLevel = event\.target\.value; bandDraft = null/,
    'a different level is a different set');

  const css = fs.readFileSync(path.join(root, 'public', 'css', 'catalogue.css'), 'utf8');
  assert.match(cssRule(css, '.breaks-table input'), /min-height:\s*var\(--touch\)/);
});

test('PR-103: the customer profile shows what was agreed, in the server’s own words', () => {
  const source = codeOf('js/customers/profile.js');

  assert.match(source, /api\.get\(`\/customers\/\$\{customerId\}\/prices`\)/);
  assert.match(source, /text: agreedPrices\.note/);
  assert.equal(source.includes('overrides every other level'), false,
    'the sentence about PR-103 is the server’s');

  // Shown even when empty: "this customer has no agreed prices" is an answer somebody
  // comes to the page for.
  assert.match(source, /agreedPrices\.prices\.length === 0/);

  // And it fails quietly — a profile that will not render because the price list is
  // unreachable is worse than a profile without the block.
  assert.match(source, /\/prices`\)\.catch\(\(\) => null\)/);
});

// ── SCR-205 (TASK-022) ──────────────────────────────────────────────────────

test('INV-110: the sheet labels the frozen figure as frozen, and says what that means', () => {
  const source = codeOf('js/catalogue/count.js');

  // "Expected" on its own is the word that makes a shopkeeper think the count sets the
  // shelf. The column says what the figure actually is.
  assert.match(source, /text: 'Expected at freeze'/);
  assert.equal(/text: 'Expected'/.test(source), false, 'never the bare word');

  // And the sentence itself is the server's, shown on the sheet and again after
  // posting — the two moments a store would otherwise report a lost sale as a bug.
  assert.match(source, /s\.variance_basis/);
  assert.match(source, /result\.session\.variance_basis/);
  assert.equal(/counted_milli - .*expected|expected_milli/.test(source.replace(/expected_display/g, '')), false,
    'the screen computes no variance of its own');
});

test('INV-111: a blank is not a zero, and the screen cannot be made to confuse them', () => {
  const source = codeOf('js/catalogue/count.js');

  // An empty field clears the line rather than storing 0 — which is also the only way
  // back from a mis-key, and therefore the only reason the two can stay distinct.
  assert.match(source, /text === '' \? null : Math\.round/);
  assert.match(source, /placeholder: 'not counted'/);

  // Three row treatments, and the uncounted one is visually distinct from the matched
  // one. A sheet that rendered them alike is a sheet somebody posts half-finished.
  assert.match(source, /if \(!line\.is_counted\) return 'is-uncounted'/);
  assert.match(source, /return 'is-matched'/);

  const css = fs.readFileSync(path.join(root, 'public', 'css', 'catalogue.css'), 'utf8');
  const uncounted = cssRule(css, '.count-sheet tr.is-uncounted');
  assert.ok(uncounted, 'the uncounted row has a rule of its own');
  assert.match(uncounted, /repeating-linear-gradient/, 'and does not merely differ in colour');
  assert.ok(cssRule(css, '.count-sheet tr.is-matched'));
});

test('INV-111: the counter is told how many are still blank, before and after posting', () => {
  const source = codeOf('js/catalogue/count.js');

  // While there is still time to go and count them...
  assert.match(source, /uncounted_count > 0/);
  assert.match(source, /not counted — those write nothing/);

  // ...and again on the summary, where "nothing happened to 320 products" is the half
  // a reader has to be able to check.
  assert.match(source, /p\.uncounted_products > 0/);
  assert.match(source, /counted and correct — no movement written/);
});

test('INV-112 / INV-113: the rules are explained before they refuse, and the panel is shared', () => {
  const source = codeOf('js/catalogue/count.js');

  // INV-112 is a person somebody has to fetch, so the sheet says so while the counting
  // is still going on rather than at the end.
  assert.match(source, /one person doing both is the shape/);
  assert.match(source, /approval_waived/, 'and a one-user store is told the rule was waived');

  // INV-113 arrives as a refusal naming the rule, and opens §4's panel — the same one
  // SCR-803, SCR-305 and SCR-304 use. A second panel would drift from the first.
  assert.match(source, /err\.ruleId === 'INV-113'/);
  assert.match(source, /ui\.authorisationPanel/);
  assert.match(source, /api\.post\('\/auth\/login'/);
  assert.match(source, /disabled: posting \|\| \(Boolean\(refusal\) && !approver\)/);
});

test('NFR_4.3: the count sheet is touchable, and wide enough to scroll on its own', () => {
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'catalogue.css'), 'utf8');
  for (const selector of ['.count-sheet .count-input', '.count-actions .editor-actions button',
    '.count-controls input, .count-controls select']) {
    const rule = cssRule(css, selector) ?? cssRule(css, selector.split(',')[0].trim());
    assert.ok(rule, `${selector} has a rule`);
    assert.match(rule, /min-height:\s*var\(--touch\)/);
  }
  assert.match(cssRule(css, '.stock-count .count-sheet'), /min-width/);
});

test('TX-407: the stocktake hangs off the products list, not off a rail item of its own', () => {
  const shell = codeOf('js/shell/app.js');
  const list = codeOf('js/catalogue/list.js');

  // A count is a thing done *to* the catalogue, and TX-407's roles are the ones
  // already on that section — so it needs no new grant and no new rail entry.
  assert.match(list, /text: 'Stock count', onclick: \(\) => onCount\(\)/);
  assert.match(shell, /onCount: \(\) => showStockCount\(\)/);
  assert.match(shell, /renderRail\('products'\)/);
});

// ── SCR-304's void (TASK-021) ───────────────────────────────────────────────

test('POS-402 / POS-403: the receipt asks the server whether a void is possible, and never decides', () => {
  const source = codeOf('js/receipt/view.js');

  // Both conditions are fetched. A screen that worked out for itself whether a shift
  // was still open would offer the button after a close and explain the refusal
  // afterwards — by which time the cashier has told the customer it can be undone.
  assert.match(source, /\/sales\/\$\{[a-zA-Z.]+\}\/voidable/);
  assert.match(source, /voidable\.can_void/);
  assert.match(source, /voidable\.self_authorised/);
  assert.equal(/status === 'VOIDED'|shift\.status/.test(source), false,
    'the screen keeps no copy of what makes a sale voidable');

  // POS-402's refusal is shown where the button would have been. A control that is
  // simply absent is the one thing worse than a refusal.
  assert.match(source, /voidable\.refusal\.message/);
  assert.match(source, /voidable\.refusal\.rule_id/);
});

test('POS-401: the void asks for a reason, and will not submit without one', () => {
  const source = codeOf('js/receipt/view.js');

  // The reason is what survives on the row, and the button stays dead until there is
  // one. Four characters is the same floor the service applies — the screen agrees
  // with the refusal rather than pre-empting a different one.
  assert.match(source, /reason\.trim\(\)\.length >= 4/);
  assert.match(source, /aria-label': 'Reason for voiding this sale'/);

  // And the state is **re-evaluated as it is typed**. `disabled` is computed when the
  // panel is built, so a field that only assigns to `reason` leaves the button dead
  // however much the cashier types — which is exactly what the browser smoke found,
  // and what asserting the expression alone would never have caught.
  assert.match(source, /oninput: \(event\) => \{ reason = event\.target\.value; refreshVoidSubmit\(\); \}/);
  assert.match(source, /button\.disabled = !voidReady\(\)/);
});

test('POS-403: a cashier gets the panel, a manager does not, and the submit waits for it', () => {
  const source = codeOf('js/receipt/view.js');

  assert.match(source, /ui\.authorisationPanel/);
  assert.match(source, /api\.post\('\/auth\/login'/);
  assert.match(source, /voidable\.self_authorised \|\| Boolean\(approver\)/,
    'the submit is disabled until somebody with the authority has signed in');
  assert.match(source, /err\.ruleId === 'POS-403'/, 'and a refusal reopens the panel');
});

test('POS-404: the screen says the number is kept, rather than leaving it to be noticed', () => {
  const prose = proseOf('js/receipt/view.js');
  const source = codeOf('js/receipt/view.js');

  // The cashier should not go looking for the receipt number to come back, and the
  // customer should not be told the sale "disappeared".
  assert.match(source, /keeps its receipt/);
  assert.match(source, /sequence has no gap \(POS-404\)/);
  assert.match(source, /out of the day/);
  assert.match(prose, /the customer is still standing there/);
});

test('POS-507: Enter starts the next sale, except while the void panel is open', () => {
  const source = codeOf('js/receipt/view.js');

  // The receipt screen binds Enter to "new sale". Leaving that live under a panel the
  // cashier is typing a reason into would fire a destructive action mid-sentence.
  assert.match(source, /event\.key === 'Enter' && !voiding/);
});

test('NFR_4.3: the void controls are touchable, and read as destructive', () => {
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'pos.css'), 'utf8');
  for (const selector of ['.void-panel .void-reason', '.void-panel .editor-actions button']) {
    const rule = cssRule(css, selector);
    assert.ok(rule, `${selector} has a rule`);
    assert.match(rule, /min-height:\s*var\(--touch\)/);
  }
  assert.match(cssRule(css, '.void-panel'), /var\(--error\)/);

  // `.danger` itself is defined once, beside OPS-004's restore — the two destructive
  // controls in this product read alike because they share the rule.
  const reports = fs.readFileSync(path.join(root, 'public', 'css', 'reports.css'), 'utf8');
  assert.match(cssRule(reports, '.danger'), /background:\s*var\(--error\)/);
});

// ── SCR-305 (TASK-020) ──────────────────────────────────────────────────────

test('POS-304: the screen shows the rule’s own sentence, and warns only on the exception', () => {
  const source = codeOf('js/returns/view.js');

  // The sentence explaining the write-off default is the server's — `default_reason`
  // off GET /sales/:id/returnable — because a screen that wrote its own could soften
  // it, and softening this one is how a returned bottle of antibiotic gets resold.
  assert.match(source, /spec\.default_reason/);
  assert.equal(/is batch-tracked/.test(source), false,
    'the reason is fetched, not spelled out in the renderer');

  // Two different treatments, and the difference is the point: the default is stated
  // quietly, and the warning appears only once somebody has overridden it.
  assert.match(source, /default_disposition === 'WRITE_OFF'/);
  assert.match(source, /line\.disposition === 'RESTOCK'/);
  assert.match(source, /must authorise putting this back \(POS-304\)/);

  const css = fs.readFileSync(path.join(root, 'public', 'css', 'returns.css'), 'utf8');
  assert.match(cssRule(css, '.return-table .default-why'), /color:\s*var\(--muted\)/);
  assert.match(cssRule(css, '.return-table .override-note'), /var\(--warn-ink\)/);
});

test('POS-301 / POS-307: the limit and the window are the server’s answers, not the screen’s', () => {
  const source = codeOf('js/returns/view.js');

  // Every rule on this screen arrives from the endpoint. A renderer that computed the
  // remaining quantity or decided whether a sale was late would eventually disagree
  // with the refusal it then got, and the cashier would hold the difference.
  assert.match(source, /\/sales\/\$\{[a-zA-Z.]+\}\/returnable/);
  assert.match(source, /view\.window\.beyond/);
  assert.match(source, /spec\.remaining_qty_milli/);
  assert.match(source, /up to \$\{spec\.remaining_display\}/);

  // POS-307 is answered on load rather than as a refusal at the end: authorising a
  // late return means asking somebody to walk over.
  assert.match(proseOf('js/returns/view.js'), /before the goods come out of the bag/);

  // POS-302's list is served too, so a reason added on SCR-702 appears with no edit.
  assert.match(source, /view\.reasons\.map/);
});

test('POS-301: the lookup asks the server which sales still have something on them', () => {
  const source = codeOf('js/returns/view.js');

  // `returnable=true` rather than the screen filtering by status. Offering a voided
  // sale and refusing it two clicks later teaches people to distrust the buttons.
  assert.match(source, /\/sales\?returnable=true/);
  assert.equal(/'VOIDED'|'PARTIALLY_RETURNED'/.test(source), false,
    'the screen keeps no copy of which statuses POS-301 admits');
});

test('POS-305: the refund preview says how it will be paid, and admits it is an estimate', () => {
  const source = codeOf('js/returns/view.js');

  // Being handed store credit instead of notes is not a thing to discover afterwards.
  assert.match(source, /POS-305/);
  assert.match(source, /POS-306/);
  assert.match(source, /sold_on_credit/);

  // And the same admission SCR-403's balance preview carries: the figures that count
  // are the server's, on the slip the return prints.
  assert.match(source, /this screen’s arithmetic/);
});

test('AUD-603: the approver authenticates, and the submit stays disabled until they have', () => {
  const source = codeOf('js/returns/view.js');

  // The same shape SCR-803 uses: /auth/login issues no session header, so the cashier
  // stays signed in and the trail records two distinct actors.
  assert.match(source, /ui\.authorisationPanel/);
  assert.match(source, /api\.post\('\/auth\/login'/);
  assert.match(source, /disabled: posting \|\| \(Boolean\(refusal\) && !approver\)/);
  assert.match(source, /\['POS-304', 'POS-307'\]\.includes\(err\.ruleId\)/);
});

test('NFR_4.3: the return screen’s controls are touchable', () => {
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'returns.css'), 'utf8');
  for (const selector of ['.returns .field-row input', '.returns .field-row button',
    '.returns .editor-field select']) {
    const rule = cssRule(css, selector);
    assert.ok(rule, `${selector} has a rule`);
    assert.match(rule, /min-height:\s*var\(--touch\)/);
  }

  // §4: a wide table scrolls inside its own container, never the page. Seven columns
  // on a 1366-wide store PC is exactly the case the rule is written for.
  assert.match(cssRule(css, '.return-table'), /min-width/);
});

test('TX-406: the rail shows Returns to the roles that hold it, and to nobody else', () => {
  const source = codeOf('js/shell/app.js');
  assert.match(source, /id: 'returns', label: 'Returns', tx: 'TX-406', screen: 'SCR-305'/);
  assert.match(source, /'TX-406': \['OWNER', 'MANAGER', 'CASHIER'\]/);

  // §2: an item the role cannot reach is hidden, and the route is refused server-side
  // regardless — the hiding is a courtesy, the refusal is the control.
  const permissions = require(path.join(root, 'src', 'services', 'permissions.js'));
  assert.deepEqual(permissions.rolesHolding('TX-406').sort(), ['CASHIER', 'MANAGER', 'OWNER']);
});

// ── SCR-706 (TASK-025) ──────────────────────────────────────────────────────

test('OPS-102: the import button waits for the validation, and cannot be pressed first', () => {
  const source = codeOf('js/admin/data.js');

  // The rule is a sequence — validate, present, confirm — and the screen enforces it
  // by having no import call reachable until a report says `ok`.
  assert.match(source, /api\.post\('\/data\/import\/validate'/);
  assert.match(source, /disabled: busy \|\| !checked\.ok/);
  assert.match(source, /checked \? summaryBlock\(\) : null/);

  // OPS-104: one choice for the run, and changing it re-validates — what it does to
  // the overlap is part of the summary, not a footnote.
  assert.match(source, /mode = event\.target\.value; if \(file\) validate\(\)/);
  assert.match(source, /applies to the whole import, not row/);
});

test('OPS-103: the pre-import backup is named on screen, before and after', () => {
  const source = codeOf('js/admin/data.js');

  assert.match(source, /A full backup is taken first/);
  assert.match(source, /result\.pre_import_backup\.file_name/);
  assert.match(source, /Restore it from the Backups tab/);
});

test('SEC-1: the export screen says what an archive does not contain', () => {
  const source = codeOf('js/admin/data.js');

  // Said where somebody is about to make the file, not where they later try to use it.
  assert.match(source, /Passwords and PINs are never exported/);
  assert.match(source, /before anybody can sign in/);
});

// ── SCR-706, the opening load (TASK-026) ────────────────────────────────────

test('OPS-105: the load button waits for the row check, and cannot be pressed first', () => {
  const source = codeOf('js/admin/data.js');

  // The same sequence the import half enforces — check, present, confirm — because an
  // operator learns one screen, not two.
  assert.match(source, /api\.post\('\/data\/opening\/validate'/);
  assert.match(source, /disabled: busy \|\| !report\.ok/);
  assert.match(source, /opening\.checked \? openingSummaryBlock\(\) : null/);

  // Choosing a different file drops the last report: it described another spreadsheet.
  assert.match(source, /opening\.checked = null;\s*\n\s*render\(\);/);
});

test('OPS-105: a rejected row is shown with the line number, not just a count', () => {
  const source = codeOf('js/admin/data.js');

  // The only part of the report an owner can act on. Against a 500-row catalogue,
  // "3 rows are invalid" sends nobody anywhere.
  assert.match(source, /`Row \$\{p\.line\}: \$\{p\.message\} \(\$\{p\.rule_id\}\)`/);
  assert.match(source, /Will load/);
  assert.match(source, /Rejected/);
});

test('requirement 2: the templates are offered on the screen that needs them', () => {
  const source = codeOf('js/admin/data.js');

  assert.match(source, /\/data\/opening\/template\/\$\{kind\}/);
  assert.match(source, /Start from a template/);
  // OPS-106 named where the column is asked for, not only where it is refused.
  assert.match(source, /what it cost \(OPS-106\)/);
});

test('OPS-107: the screen asks for the cutover date, and says what it dates', () => {
  const source = codeOf('js/admin/data.js');

  assert.match(source, /Cutover date/);
  assert.match(source, /The day the notebook was closed/);
  assert.match(source, /cutoverAt: opening\.cutoverAt \|\| null/);
});

test('OPS-103: the pre-load backup is named after the load, as the import’s is', () => {
  const source = codeOf('js/admin/data.js');

  assert.match(source, /done\.pre_load_backup\.file_name/);
  assert.match(source, /A full backup is taken first/);
  // Requirement 8: the reconciliation verdict is shown as the sentence it was written
  // as, because somebody signing off a cutover is not looking for `true`.
  assert.match(source, /done\.reconciliation\.statement/);
});

test('a served BOM survives the download helper, which text() would eat', () => {
  const api = codeOf('js/shell/api.js');

  // The opening templates are served with a BOM so Excel on a Philippine desktop reads
  // them as UTF-8. `response.text()` strips it per the encoding standard, which would
  // silently undo the fix at the last step.
  assert.match(api, /ignoreBOM: true/);
  assert.equal(/await response\.text\(\), blob: null/.test(api), false);
});

test('the object-URL save lives in the shell, once, and every caller uses it', () => {
  const api = codeOf('js/shell/api.js');
  assert.match(api, /export function saveAs/);
  // Revoked a tick late: revoking synchronously races the browser's own read in some
  // builds and silently produces an empty file.
  assert.match(api, /setTimeout\(\(\) => URL\.revokeObjectURL\(url\), 0\)/);

  for (const view of ['js/admin/data.js', 'js/admin/audit.js', 'js/reports/report.js']) {
    const source = codeOf(view);
    assert.match(source, /api\.saveAs\(/, `${view} saves through the shell`);
    assert.equal(/URL\.createObjectURL/.test(source), false,
      `${view} no longer rolls its own download`);
  }
});

test('TC-UI-10: every screen in 04_UX_SPEC.md §3 has a view', () => {
  // The screen gap, asserted rather than tracked in prose. It was thirteen missing
  // when TASK-036 started; this is the case that says when it is closed.
  const spec = fs.readFileSync(path.join(root, 'docs', '04_UX_SPEC.md'), 'utf8');
  const specified = [...new Set(spec.match(/SCR-\d{3}/g) || [])].sort();

  const sources = walkFiles(path.join(root, 'public'))
    .filter((f) => /\.(js|css|html)$/.test(f))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');

  const missing = specified.filter((screen) => !sources.includes(screen));
  assert.deepEqual(missing, [], `${missing.length} specified screen(s) have no view`);
  assert.ok(specified.length >= 26, `only ${specified.length} screens parsed from the spec`);
});
