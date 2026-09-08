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
  .replace(/"\s*\n\s*\+\s*"/g, '');

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
    lines: [{ productId: 'p1', qtyMilli: 1255, packUnitId: null, discountCentavos: 500 }],
  });
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
    'Delete', 'Escape', 'F1', 'F10', 'F12', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F9',
  ]);
  assert.equal(actionFor('F3'), 'quantity');
  assert.equal(actionFor('F9'), 'pay');
  assert.equal(actionFor('F10'), 'exactCash');
  assert.equal(actionFor('Delete'), 'removeLine');
  // §7: Escape cancels the current field and never the cart.
  assert.equal(actionFor('Escape'), 'cancelField');
  assert.equal(actionFor('F8'), null, 'F8 is not in the map');

  // Every helped key is mapped, and the bar renders from the map rather than a copy.
  for (const key of HELP_ORDER) assert.ok(KEYMAP[key], `${key} is in the help bar but not the map`);
});

test('the POS dispatches every action the map names', () => {
  const source = fs.readFileSync(path.join(root, 'public', 'js', 'pos', 'view.js'), 'utf8');
  const actions = [
    'search', 'customer', 'quantity', 'lineDiscount', 'txnDiscount',
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
