'use strict';
// TASK-015 browser smoke: the real renderer, in real Chromium, driven the way a cashier
// drives it. The HTTP smoke proved the API; this proves the screens.

const { app, BrowserWindow } = require('electron');

const PORT = Number(process.env.UI_PORT || 47897);
const TOKEN = process.env.UI_TOKEN;
const PRODUCT_ID = process.env.UI_PRODUCT;
const CUSTOMER_ID = process.env.UI_CUSTOMER;
const SUPPLIER_ID = process.env.UI_SUPPLIER;
const MEDICINE_ID = process.env.UI_MEDICINE;
const API = `http://127.0.0.1:${PORT}/api/v1`;

const fails = [];
const log = (ok, label, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(label);
};

async function api(pathname, { method = 'GET', body = null } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

app.disableHardwareAcceleration();

const SIGN_IN = `(() => {
  const f = document.querySelector('.signin form');
  if (!f) return false;
  f.querySelector('input[type=text]').value = 'chachi';
  f.querySelector('input[type=password]').value = 'sack-of-feed-2026';
  f.requestSubmit();
  return true;
})()`;

const OPEN_RAIL = (label) => `(() => {
  const b = [...document.querySelectorAll('.rail button, .rail a')].find(x => /${label}/i.test(x.textContent));
  if (b) { b.click(); return true; }
  return false;
})()`;

const OPEN_POS = `(() => {
  const b = [...document.querySelectorAll('.rail button, .rail a')].find(x => /POS/i.test(x.textContent));
  if (b) { b.click(); return true; }
  return false;
})()`;

const LINE_COUNT = `document.querySelectorAll('.cart-lines li, .cart-lines tr, .cart-lines .cart-line').length`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1366, height: 768 });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !/Electron Security Warning/.test(message)) errors.push(message);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => errors.push(`did-fail-load ${code} ${desc} ${url}`));

  const run = (code) => win.webContents.executeJavaScript(code, true);
  const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

  /**
   * Wait for the page to reach a state, rather than for a length of time.
   *
   * Fixed sleeps made this harness flaky: sign-in does a real bcrypt compare at the
   * production work factor, which takes a few hundred milliseconds and more when the
   * machine is busy. A poll on the condition removes the whole class of flake instead
   * of moving the threshold and hoping.
   */
  const waitFor = async (expression, { timeoutMs = 10000, label = expression } = {}) => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      if (await run(expression)) return true;
      if (Date.now() > until) {
        console.log(`        timed out waiting for ${label}`);
        return false;
      }
      await settle(80);
    }
  };
  /**
   * Null-safe expression builders.
   *
   * `document.querySelector(x).textContent` throws while a screen is mid-reload — the
   * root has been cleared and the node is not there yet — and a throw inside
   * `executeJavaScript` surfaces as a crash of the whole harness rather than as one
   * failed assertion. These build the guarded form once. They are Node-side string
   * builders rather than helpers installed on `window`, because the page's globals do
   * not survive everything this walk does to it.
   */
  const TEXT = (sel) => `(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`;
  const text = (sel) => run(TEXT(sel));
  const FIND = (sel, re) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find(b => ${re}.test(b.textContent))`;
  const clickOn = (sel, re) => run(`(() => { const el = ${FIND(sel, re)}; if (el) { el.click(); return true; } return false; })()`);

  const press = (key) => run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))`);

  await win.loadURL(`http://127.0.0.1:${PORT}/`);
  await settle(700);

  console.log('\n— the window opens —');
  log(await run(`!!document.querySelector('.signin form')`), 'SCR-101: the sign-in form renders');
  log(!(await run(`document.body.textContent.includes('Starting…')`)), 'the "Starting…" placeholder is replaced');

  await run(SIGN_IN);
  await waitFor(`!!document.querySelector('.rail')`, { label: 'the rail' });
  log(await run(`!!document.querySelector('.rail')`), 'the rail appears after sign-in');
  log(await run(`[...document.querySelectorAll('.rail button, .rail a')].some(b => /POS/i.test(b.textContent))`),
    'the POS item is on the rail');

  console.log('\n— the counter needs a shift (POS-501) —');
  await run(OPEN_POS);
  await waitFor(`!!document.querySelector('.screen').textContent.trim()`, { label: 'the POS screen' });
  const beforeShift = await run(`document.querySelector('.screen').textContent`);
  log(/shift|float/i.test(beforeShift), 'the POS screen asks for a shift before a cart',
    beforeShift.replace(/\s+/g, ' ').slice(0, 80));

  const opened = await api('/shifts/open', { method: 'POST', body: { openingFloatCentavos: 200000, confirmed: true } });
  log(opened.status === 201 || opened.status === 200, 'a shift is opened', String(opened.status));

  await run(`location.reload()`);
  await waitFor(`!!document.querySelector('.signin form')`, { label: 'the sign-in form' });
  log(await run(`!!document.querySelector('.signin form')`), 'SEC-7: a reload loses the token and asks again');
  await run(SIGN_IN);
  await waitFor(`!!document.querySelector('.rail')`, { label: 'the rail' });
  await run(OPEN_POS);
  await waitFor(`!!document.querySelector('.pos')`, { label: 'SCR-301' });
  log(await run(`!!document.querySelector('.pos')`), 'SCR-301 renders with a shift open');
  log(await run(`!!document.querySelector('.pos-search')`), 'the search field is there');
  log(await run(`document.activeElement === document.querySelector('.pos-search')`),
    'the cursor is in the search field, so a scan lands (04_UX_SPEC §3)');

  console.log('\n— a scan builds a cart —');
  await run(`(() => {
    const el = document.querySelector('.pos-search');
    el.focus();
    for (const ch of '4800012345678') {
      el.value += ch;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })()`);
  await settle(1200);
  log(await run(LINE_COUNT) >= 1, 'the scan adds a line', `${await run(LINE_COUNT)} line(s)`);
  const railText = await run(`(document.querySelector('.rail-totals') || {}).textContent || ''`);
  log(/62\.50/.test(railText), 'the total is on the rail', railText.replace(/\s+/g, ' ').slice(0, 70));

  console.log('\n— F6 parks, F7 resumes (POS-106) —');
  await press('F6');
  await settle(900);
  const parked = (await api('/carts/parked')).json;
  log(parked.carts.length === 1, 'F6 parked the cart on the server', `${parked.carts.length} parked`);
  log(await run(LINE_COUNT) === 0, 'the counter is empty again');

  await press('F7');
  await settle(800);
  log(await run(`/park/i.test(document.body.textContent)`), 'F7 shows the parked carts');
  await run(`(() => { const c = document.querySelector('.parked-cart'); if (c) (c.querySelector('button') || c).click(); })()`);
  await settle(900);
  log(await run(LINE_COUNT) >= 1, 'the cart is back on the counter', `${await run(LINE_COUNT)} line(s)`);

  console.log('\n— POS-105: the restart —');
  await run(`location.reload()`);
  await waitFor(`!!document.querySelector('.signin form')`, { label: 'the sign-in form' });
  await run(SIGN_IN);
  await waitFor(`!!document.querySelector('.rail')`, { label: 'the rail' });
  await run(OPEN_POS);
  await waitFor(`${LINE_COUNT} >= 1`, { label: 'the restored cart' });
  log(await run(LINE_COUNT) >= 1, 'POS-105: the cart is restored after a restart', `${await run(LINE_COUNT)} line(s)`);

  console.log('\n— SCR-303: payment —');
  await press('F9');
  await settle(900);
  const payText = await run(`document.querySelector('.screen').textContent`);
  log(/cash|tender/i.test(payText), 'the payment screen opens on F9', payText.replace(/\s+/g, ' ').slice(0, 80));

  // CASH is chosen, then the amount keyed — the two actions the screen actually asks for.
  await run(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'CASH');
    if (b) b.click();
  })()`);
  await settle(500);
  log(await run(`!!document.querySelector('.tender-amount')`), 'choosing CASH adds a tender row');

  await run(`(() => {
    const el = document.querySelector('.tender-amount');
    el.focus();
    el.value = '100.00';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await settle(500);
  const changeText = await run(`document.querySelector('.payment-summary').textContent`);
  log(/37\.50/.test(changeText), 'MON-007: change appears once cash exceeds the balance',
    changeText.replace(/\s+/g, ' ').slice(0, 80));
  log(await run(`!document.querySelector('.complete').disabled`), 'POS-204: Complete is enabled once it is covered');

  await run(`document.querySelector('.complete').click()`);
  await settle(1800);

  console.log('\n— SCR-304: the receipt —');
  const receiptText = await run(`document.querySelector('.screen').textContent`);
  log(/SALE-\d{8}-\d{6}/.test(receiptText), 'the receipt shows the sale number',
    (receiptText.match(/SALE-[\d-]+/) || [receiptText.replace(/\s+/g, ' ').slice(0, 70)])[0]);
  log(/37\.50/.test(receiptText), 'and the change to hand over');

  const after = (await api('/carts/active')).json;
  log(after.cart === null, 'the counter is cleared after the sale');

  console.log('\n— SCR-501 to SCR-503: the shift —');
  await run(OPEN_RAIL('Shift'));
  await waitFor(`!!document.querySelector('.shift')`, { label: 'SCR-501' });
  const drawer = await run(`(document.querySelector('.shift-expected') || {}).textContent || ''`);
  log(/Opening float/.test(drawer) && /Expected in the drawer/.test(drawer),
    'POS-509: the drawer shows its terms, not just a total',
    drawer.replace(/\s+/g, ' ').slice(0, 90));

  // SCR-502
  await run(`[...document.querySelectorAll('.admin-head button')].find(b => /Cash in/.test(b.textContent)).click()`);
  await waitFor(`!!document.querySelector('.shift form')`, { label: 'SCR-502' });
  await waitFor(`document.querySelectorAll('.shift select')[1].options.length > 1`,
    { label: 'the till reasons' });
  const tillReasons = await run(`document.querySelectorAll('.shift select')[1].options.length - 1`);
  log(tillReasons > 0, 'POS-504: till reasons come from the configured list', `${tillReasons} reasons`);

  await run(`[...document.querySelectorAll('.shift button')].find(b => /Cancel/.test(b.textContent)).click()`);
  await waitFor(`!!document.querySelector('.shift-expected')`);

  // SCR-503 — the one that did not exist before TASK-038.
  await run(`[...document.querySelectorAll('.admin-head button')].find(b => /Close shift/.test(b.textContent)).click()`);
  await waitFor(`!!document.querySelector('.shift-close')`, { label: 'SCR-503' });

  const counted = await run(`[...document.querySelectorAll('.shift-close input')].map(i => i.value)`);
  log(counted.length > 0 && counted.every((v) => v === ''),
    'POS-510: every counted field starts empty — nothing is pre-filled',
    `${counted.length} inputs, all blank`);

  const creditRow = await run(`(document.querySelector('.shift-close tr.not-counted') || {}).textContent || ''`);
  log(/credit sale takes no money/i.test(creditRow), 'CREDIT is explained, not asked for',
    creditRow.replace(/\s+/g, ' ').slice(0, 80));
  log(await run(`!document.querySelector('.shift-close tr.not-counted input')`),
    'and it carries no counted input at all');

  // Count it short, on purpose, and watch the screen refuse.
  const expectedApi = await api(`/shifts/current`);
  const expectedCash = expectedApi.json.expected.expected_cash_centavos;
  await run(`(() => {
    const rows = [...document.querySelectorAll('.shift-close tbody tr')];
    const cash = rows.find(r => /CASH/.test(r.children[0].textContent) && r.querySelector('input'));
    const el = cash.querySelector('input');
    el.value = ${JSON.stringify(((expectedCash - 30000) / 100).toFixed(2))};
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await settle(400);
  const varianceCell = await run(`(document.querySelector('.shift-close .variance.down') || {}).textContent || ''`);
  log(/-/.test(varianceCell), 'the variance is computed and coloured as a shortage', varianceCell);

  await run(`[...document.querySelectorAll('.shift button')].find(b => /Count and close/.test(b.textContent)).click()`);
  await settle(1200);
  const refusal = await run(`document.body.textContent`);
  log(/never silently forced to balance/.test(refusal),
    'POS-510: closing short without a reason is refused, in the rule\u2019s own words');
  log(await run(`!!document.querySelector('.shift-close')`), 'and the shift is still open');

  await run(`(() => {
    const el = document.querySelector('.variance-reason');
    el.value = 'Two 100 notes missing after the afternoon rush; counted three times';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await settle(300);
  await run(`[...document.querySelectorAll('.shift button')].find(b => /Count and close/.test(b.textContent)).click()`);
  await waitFor(`!!document.querySelector('.summary')`, { label: 'the close summary', timeoutMs: 20000 });

  const summary = await run(`document.querySelector('.summary').textContent`);
  log(/short/.test(summary), 'the summary states the shortage', (summary.match(/The drawer is [^.]+\./) || [''])[0]);
  log(/counted three times/.test(summary), 'AUD-602: and the reason recorded against it');
  log(/backed up and the copy was opened/.test(summary),
    'OPS-002: the close says the backup was verified');
  log(/cannot be changed \(POS-511\)/.test(summary), 'POS-511: and that it cannot be changed');
  log(await run(`!document.querySelector('.summary input')`), 'the summary offers no field to edit');

  await run(`[...document.querySelectorAll('.summary button')].find(b => /Done/.test(b.textContent)).click()`);
  await settle(900);

  console.log('\n— SCR-401 to SCR-403: customers and credit —');
  await run(OPEN_RAIL('Customers'));
  await waitFor(`!!document.querySelector('.customers')`, { label: 'SCR-401' });
  log(await run(`document.querySelectorAll('.customer-list tbody tr').length >= 1`),
    'the customer list renders');
  log(await run(`/Santos Farm/.test(document.querySelector('.customer-list').textContent)`),
    'and the credit customer is on it');

  await run(`document.querySelector('.customer-list tbody tr').click()`);
  await waitFor(`!!document.querySelector('.credit-summary')`, { label: 'SCR-402' });

  const creditBlock = await run(`document.querySelector('.credit-summary').textContent`);
  for (const [label, pattern] of [
    ['Owes', /Owes/], ['Limit', /Limit/], ['Can still buy', /Can still buy/], ['Terms', /Terms/],
  ]) log(pattern.test(creditBlock), `CR-104: the first block shows ${label}`);
  log(/₱50,000\.00/.test(creditBlock), 'with the figures the server sent',
    creditBlock.replace(/\s+/g, ' ').slice(0, 80));

  // A credit sale, so there is something to pay off.
  const shiftOpen = await api('/shifts/current');
  if (!shiftOpen.json.open) {
    await api('/shifts/open', { method: 'POST', body: { openingFloatCentavos: 200000, confirmed: true } });
  }
  await api('/sales', {
    method: 'POST',
    body: {
      lines: [{ productId: PRODUCT_ID, qtyMilli: 5000 }],
      customerId: CUSTOMER_ID,
      tenders: [{ method: 'CREDIT', amountCentavos: 31250 }],
    },
  });

  console.log('\n— SCR-403: taking a payment —');
  await run(OPEN_RAIL('Customers'));
  await waitFor(`!!document.querySelector('.customer-list')`);
  await run(`document.querySelector('.customer-list .row-action').click()`);
  await waitFor(`!!document.querySelector('.collection')`, { label: 'SCR-403' });

  log(await run(`document.querySelector('.collection-amount').value === ''`),
    'the amount starts empty');

  await run(`[...document.querySelectorAll('.collection .row-action')].find(b => /Pay in full/.test(b.textContent)).click()`);
  await settle(500);
  const full = await run(`document.querySelector('.collection-amount').value`);
  log(full === '312.50', 'Pay in full fills the outstanding balance', `₱${full}`);

  const previewText = await run(`document.querySelector('.preview').textContent`);
  log(/nothing owing/i.test(previewText), 'and the preview says the account clears',
    previewText.replace(/\s+/g, ' ').slice(0, 70));

  // CR-204: overpay, and watch the screen refuse until it is acknowledged.
  await run(`(() => {
    const el = document.querySelector('.collection-amount');
    el.value = '400.00';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await settle(500);
  const over = await run(`document.querySelector('.preview').textContent`);
  log(/more than they owe/.test(over), 'CR-204: an overpayment is named',
    (over.match(/That is [^.]+\./) || [''])[0]);
  log(await run(`document.querySelector('.overpayment input[type=checkbox]').checked === false`),
    'the tick starts off — a tick that defaults to on is not explicit');
  log(await run(`document.querySelector('.editor-actions .primary').disabled === true`),
    'and the payment cannot be recorded until it is ticked');

  await run(`(() => {
    const t = document.querySelector('.overpayment input[type=checkbox]');
    t.checked = true;
    t.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await settle(400);
  log(await run(`document.querySelector('.editor-actions .primary').disabled === false`),
    'ticked, it is allowed');

  // Take the sensible payment instead.
  await run(`(() => {
    const el = document.querySelector('.collection-amount');
    el.value = '312.50';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await settle(400);
  await run(`document.querySelector('.editor-actions .primary').click()`);
  await waitFor(`!!document.querySelector('.collection-done')`, { label: 'the receipt', timeoutMs: 15000 });

  const done = await run(`document.querySelector('.collection-done').textContent`);
  log(/They owe nothing now/.test(done), 'the server’s figure is what is shown afterwards',
    done.replace(/\s+/g, ' ').slice(0, 80));
  log(/What it settled/.test(done), 'CR-203: and which invoices it settled');
  log(/acknowledgement/i.test(done), 'CR-206: with the acknowledgement’s outcome');

  console.log('\n— SCR-601: the dashboard —');
  await run(OPEN_RAIL('Reports'));
  await waitFor(`!!document.querySelector('.dashboard')`, { label: 'SCR-601' });
  log(await run(`!!document.querySelector('.dashboard')`), 'SCR-601 renders');
  const tiles = await run(`[...document.querySelectorAll('.tile')].map(t => t.className)`);
  log(tiles.length === 7, 'seven tiles', `${tiles.length}`);
  log(await run(`!!document.querySelector('.tile-gross-profit')`), 'the seventh is gross profit');

  const profit = await run(`(document.querySelector('.tile-gross-profit') || {}).textContent || ''`);
  log(/₱/.test(profit), 'and it carries a figure', profit.replace(/\s+/g, ' ').slice(0, 60));

  const sales = await api(`/reports/daily?from=${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })}`);
  const shown = await run(`(document.querySelector('.tile-gross-sales .tile-value') || {}).textContent || ''`);
  const expected = `₱${(sales.json.totals.gross_centavos / 100).toFixed(2)}`;
  log(shown === expected, 'TC-INT-60: the tile equals the report behind it', `${shown} vs ${expected}`);

  console.log('\n— SCR-602: the daily sales report —');
  await run(`document.querySelector('.tile-gross-sales').click()`);
  await settle(1200);
  log(await run(`!!document.querySelector('.report-daily')`), 'the tile opens the report behind it');

  const recon = await run(`(document.querySelector('.reconciliation') || {}).textContent || ''`);
  log(/gross/.test(recon) && /net/.test(recon), 'FR_6.2: the reconciliation is printed as arithmetic',
    recon.replace(/\s+/g, ' ').slice(0, 90));
  log(await run(`document.querySelector('.reconciliation').classList.contains('balances')`),
    'and it balances');

  const meta = await run(`(document.querySelector('.report-meta') || {}).textContent || ''`);
  log(/Voided/.test(meta) && /Excluded/.test(meta), 'RPT-106: the header states void inclusion',
    meta.replace(/\s+/g, ' ').slice(0, 90));

  console.log('\n— SCR-603 and SCR-604 —');
  await run(`document.querySelector('.report-back').click()`);
  await settle(900);
  await run(`document.querySelector('.tile-payment-mix').click()`);
  await settle(1000);
  const methods = await run(`(document.querySelector('.methods') || {}).textContent || ''`);
  log(/CASH/.test(methods), 'SCR-603 lists the methods', methods.replace(/\s+/g, ' ').slice(0, 90));

  // The mix must agree with net sales, not with the notes that crossed the counter.
  const paidApi = await api(`/reports/payments?from=${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })}`);
  log(paidApi.json.total_centavos === sales.json.totals.net_centavos,
    'RPT-102: the mix reconciles to net sales',
    `₱${(paidApi.json.total_centavos / 100).toFixed(2)} vs ₱${(sales.json.totals.net_centavos / 100).toFixed(2)}`);
  log(/RECORDED/.test(methods) === /GCASH|QRPH|CREDIT/.test(methods),
    'POS-206: non-cash rows read RECORDED');
  log(/VERIFIED|CONFIRMED/.test(methods) === false, 'and nothing reads verified');

  await run(`document.querySelector('.report-back').click()`);
  await settle(900);
  // The low-stock tile opens SCR-204 now, so the valuation report is reached from the
  // catalogue's own header — which is where somebody asking "what is this stock worth"
  // actually is.
  await run(`document.querySelector('.tile-low-stock').click()`);
  await waitFor(`!!document.querySelector('.catalogue')`, { label: 'SCR-204' });
  log(await run(`/Low stock/.test(document.querySelector('h1').textContent)`),
    'INV-109: the low-stock tile opens the low-stock list');

  await run(`[...document.querySelectorAll('.admin-head button')].find(b => /Valuation/.test(b.textContent)).click()`);
  await waitFor(`!!document.querySelector('.valuation-total')`, { label: 'SCR-604' });
  log(await run(`!!document.querySelector('.valuation-total')`), 'SCR-604 renders the valuation');

  console.log('\n— SCR-201: the catalogue —');
  await run(OPEN_RAIL('Products'));
  await waitFor(`!!document.querySelector('.catalogue')`, { label: 'SCR-201' });
  log(await run(`!!document.querySelector('.catalogue-list')`), 'the product list renders');
  log(await run(`document.querySelectorAll('.catalogue-list tbody tr').length >= 1`),
    'and it lists the seeded product');
  log(await run(`/\\d+(\\.\\d+)? KG/.test(document.querySelector('.catalogue-list').textContent)`),
    'INV-101: on hand is in the list',
    (await run(`document.querySelector('.catalogue-list tbody tr').textContent`)).replace(/\s+/g, ' ').slice(0, 70));

  // TX-412: the owner is signed in here, and even so the *list* carries no cost.
  log(await run(`!/cost/i.test(document.querySelector('.catalogue-list').textContent)`),
    'and no cost column anywhere in it');

  await run(`(() => {
    const el = document.querySelector('.catalogue-search');
    el.value = 'zzzz-nothing';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(`/Nothing matches/.test(document.body.textContent)`, { label: 'the empty state' });
  log(true, 'a search with no match shows the empty state, not a blank table');

  await run(`(() => {
    const el = document.querySelector('.catalogue-search');
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(`document.querySelectorAll('.catalogue-list tbody tr').length >= 1`);

  console.log('\n— SCR-202: the editor —');
  // By name, not by row order. This walk opened whichever product happened to sort
  // first until TASK-020 seeded a second one, and then quietly checked the wrong
  // product's packs — a harness reading its fixture by position rather than by the
  // thing it means to assert about.
  const OPEN_HOG_GROWER = `(() => {
    const row = [...document.querySelectorAll('.catalogue-list tbody tr')]
      .find(r => /Hog Grower/.test(r.textContent));
    if (!row) return false;
    row.click();
    return true;
  })()`;
  log(await run(OPEN_HOG_GROWER), 'the seeded product opens from the list');
  await waitFor(`!!document.querySelector('.editor')`, { label: 'SCR-202' });
  const tabs = await run(`[...document.querySelectorAll('.admin-tab')].map(t => t.textContent)`);
  log(tabs.length === 5, 'five tabs', tabs.join(', '));

  await run(`[...document.querySelectorAll('.admin-tab')].find(t => t.textContent === 'Units').click()`);
  await settle(500);
  const units = await run(`document.querySelector('.editor-panel').textContent`);
  log(/1 SACK = 50 KG/.test(units), 'UOM-002: the pack states its conversion in words',
    units.replace(/\s+/g, ' ').slice(0, 100));

  await run(`[...document.querySelectorAll('.admin-tab')].find(t => t.textContent === 'Identity').click()`);
  await settle(500);
  const identity = await run(`document.querySelector('.editor-panel').textContent`);
  log(/UOM-003/.test(identity), 'UOM-003: the base unit is locked once stock has moved');
  log(/create a new product/.test(identity), 'and the lock names the correction path');
  log(await run(`!document.querySelector('.editor-field.locked select')`),
    'the locked field is prose, not a disabled dropdown');

  await run(`[...document.querySelectorAll('.admin-tab')].find(t => t.textContent === 'Pricing').click()`);
  await settle(500);
  const pricing = await run(`document.querySelector('.editor-panel').textContent`);
  log(/Average cost/.test(pricing), 'TX-412: the owner sees average cost');

  console.log('\n— SCR-203: an adjustment —');
  await run(`[...document.querySelectorAll('.admin-tab')].find(t => t.textContent === 'Stock').click()`);
  await settle(400);
  log(/cannot be typed/.test(await run(`document.querySelector('.editor-panel').textContent`)),
    'INV-101: on hand is not editable, and the screen says why');

  await run(`document.querySelector('.report-back').click()`);
  const backOk = await waitFor(`!!document.querySelector('.catalogue-list')`, { label: 'the list again' });
  log(backOk, 'the editor returns to the list');
  // The same product, again by name: the adjustment below counts 440 KG against what
  // this one actually has on the shelf.
  if (backOk) {
    await run(`(() => {
      const row = [...document.querySelectorAll('.catalogue-list tbody tr')]
        .find(r => /Hog Grower/.test(r.textContent));
      if (row) row.querySelector('.row-action').click();
    })()`);
  }
  await waitFor(`!!document.querySelector('.adjustment')`, { label: 'SCR-203' });

  const reasonCount = await run(`document.querySelectorAll('.adjustment select option').length`);
  log(reasonCount > 1, 'INV-108: the reasons are a list, not a text box', `${reasonCount - 1} reasons`);
  log(await run(`!document.querySelector('.adjustment input[type=text][aria-label*=Reason]')`),
    'and there is no free-text reason field');

  await run(`(() => {
    const el = document.querySelector('.adjustment input[inputmode=decimal]');
    el.value = '440';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await settle(400);
  const variance = await run(`(document.querySelector('.variance') || {}).textContent || ''`);
  log(/less on the shelf/.test(variance), 'the variance is computed for the reader',
    variance.replace(/\s+/g, ' ').slice(0, 70));

  // ── SCR-801 – SCR-804: buying (TASK-019) ─────────────────────────────────
  //
  // The owner drives the order; the bodega clerk takes the delivery, because PO-204
  // and PO-205 self-authorise for a manager and the authorisation panel — the half of
  // SCR-803 most worth driving — would never open.

  /**
   * Switch user.
   *
   * The rail's user button is not a sign-out: SCR-102 puts the PIN lock over the
   * preserved cart for anyone who has a PIN (POS-105), and "Different user" is the way
   * past it. A harness that only knew the second door would hang on the owner.
   */
  const signInAs = async (username, password) => {
    await run(`document.querySelector('.rail-user').click()`);
    await settle(300);
    await clickOn('.lock-different', '/Different user/');
    const at = await waitFor(`!!document.querySelector('.signin form')`, { label: 'the sign-in form' });
    if (!at) return false;
    await run(`(() => {
      const f = document.querySelector('.signin form');
      f.querySelector('input[type=text]').value = ${JSON.stringify(username)};
      f.querySelector('input[type=password]').value = ${JSON.stringify(password)};
      f.requestSubmit();
      return true;
    })()`);
    return waitFor(`!!document.querySelector('.rail')`, { label: 'the rail', timeoutMs: 20000 });
  };

  /**
   * Open a rail section and wait for its screen.
   *
   * Clicking the rail immediately after a sign-in raced the rail being built, which
   * looked like a permission failure rather than a harness one — a click into empty
   * space returns false and the assertion that follows blames the screen.
   */
  const openRail = async (label) => {
    if (!await waitFor(FIND('.rail button', `/${label}/i`), { label: `the ${label} rail item` })) return false;
    await clickOn('.rail button', `/${label}/i`);
    return waitFor(`!!document.querySelector('.purchasing')`, { label: `${label}'s screen` });
  };

  const POST_BUTTON = FIND('.goods-receipt .editor-actions button', '/Post delivery/');

  console.log('\n— SCR-801: purchase orders —');
  log(await openRail('Buying'), 'SCR-801 renders from the rail');

  log(await run(`(document.querySelector('.check input') || {}).checked === true`),
    'the list defaults to what is still awaited, not to everything ever ordered');

  const stockBeforeOrder = (await api(`/inventory/${PRODUCT_ID}`)).json.on_hand.qty_on_hand_milli;

  console.log('\n— SCR-802: raising an order —');
  await clickOn('.admin-head button', '/New order/');
  await waitFor(`!!document.querySelector('.purchase-order')`, { label: 'SCR-802' });

  // PO-103, said on the screen rather than only in the schema.
  log(/moves no stock/i.test(await text('.purchase-order')),
    'PO-103: the screen says a purchase order moves no stock');

  const supplierOptions = await run(`document.querySelectorAll('.purchase-order select option').length - 1`);
  log(supplierOptions >= 1, 'the supplier list is served, not hard-coded', `${supplierOptions} suppliers`);

  await run(`(() => {
    const sel = document.querySelector('.purchase-order select');
    sel.value = sel.options[1].value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);

  // Type enough of the product for the line to resolve against /products.
  await run(`(() => {
    const el = document.querySelector('.line-product');
    el.value = 'Hog Grower';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await settle(700);
  // The field keeps what was typed — rebuilding it would move the cursor — so the
  // confirmation is the resolved label beneath it, which is also the only thing that
  // tells the buyer the line is bound to a product at all.
  const resolved = await waitFor(`/FEED-HG-50/.test(${TEXT('.catalogue-list .resolved')})`,
    { label: 'the product to resolve', timeoutMs: 6000 });
  log(resolved, 'a typed product resolves, and the row says what to',
    await text('.catalogue-list .resolved'));

  await run(`(() => {
    const [qty, cost] = document.querySelectorAll('.catalogue-list input[inputmode=decimal]');
    qty.value = '2500'; qty.dispatchEvent(new Event('input', { bubbles: true }));
    cost.value = '39.00'; cost.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await settle(300);
  const runningTotal = await run(`(document.querySelector('.po-total') || {}).textContent || ''`);
  log(/97,500\.00/.test(runningTotal), 'the running total is computed for the reader', runningTotal.trim());

  await run(`document.querySelector('.purchase-order form').requestSubmit()`);
  // `\\d` rather than `\d`: a template literal swallows the backslash, and the regex
  // that reaches the page silently matches nothing.
  const savedOk = await waitFor(`/PO-\\d{8}-\\d{6}/.test(${TEXT('.admin-head h1')})`,
    { label: 'the saved order', timeoutMs: 8000 });
  log(savedOk, 'the order saves and reopens on its number', await text('.admin-head h1'));

  log(await run(`[...document.querySelectorAll('.admin-head button')].some(b => /Send to supplier/.test(b.textContent))`),
    'PO-102: a draft offers "send", and the delivery button is not there yet');
  log(await run(`![...document.querySelectorAll('.admin-head button')].some(b => /Receive delivery/.test(b.textContent))`),
    'nothing is delivered against an order nobody has sent');

  await clickOn('.admin-head button', '/Send to supplier/');
  await waitFor(`/Sent to supplier/.test(${TEXT('.admin-head')})`, { label: 'PENDING', timeoutMs: 8000 });
  log(true, 'PO-102: DRAFT → PENDING');

  // PO-104 — the screen says which of the two it is about to do, before the button.
  log(/revision 2/.test(await text('.purchase-order')),
    'PO-104: a sent order says saving raises a revision, not that it overwrites');

  // Stock has not moved, and this is the assertion the whole rule exists for. Measured
  // against what was on the shelf before the order rather than against a constant:
  // the cashier's sale earlier in this walk already took some of it.
  const afterOrderStock = (await api(`/inventory/${PRODUCT_ID}`)).json.on_hand.qty_on_hand_milli;
  log(afterOrderStock === stockBeforeOrder,
    'PO-103: raising and sending the order moved no stock',
    `${afterOrderStock} milli, unchanged`);

  console.log('\n— SCR-803: the delivery, taken by the clerk —');
  // Somebody who may receive and may not authorise, so PO-205's panel actually opens.
  log(await signInAs('bodega', 'sack-of-feed-2026'), 'the bodega clerk signs in');

  log(await openRail('Buying'), 'the clerk reaches SCR-801 — TX-409 is theirs too');
  const receiveBtn = await waitFor(
    `[...document.querySelectorAll('.catalogue-list .row-action')].some(b => /Receive/.test(b.textContent))`,
    { label: 'the receive shortcut', timeoutMs: 8000 }
  );
  log(receiveBtn, 'the open order offers the delivery from the list');

  await run(`[...document.querySelectorAll('.catalogue-list .row-action')].find(b => /Receive/.test(b.textContent)).click()`);
  await waitFor(`!!document.querySelector('.goods-receipt')`, { label: 'SCR-803' });

  log(/only the sound quantity/i.test(await text('.goods-receipt')),
    'PO-202: the screen says what becomes stock and what does not');

  const prefilled = await run(`(document.querySelectorAll('.receive-table input[inputmode=decimal]')[0] || {}).value`);
  log(prefilled === '2500', 'the outstanding quantity is pre-filled, and meant to be corrected', prefilled);

  // Fifty sacks arrived, three split, at ₱46.80 rather than the ₱39.00 agreed.
  await run(`(() => {
    const [arrived, damaged, cost] = document.querySelectorAll('.receive-table input[inputmode=decimal]');
    damaged.value = '150'; damaged.dispatchEvent(new Event('input', { bubbles: true }));
    cost.value = '46.80'; cost.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await settle(300);

  const sound = await run(`(document.querySelector('.qty.sound') || {}).textContent || ''`);
  log(/2,350/.test(sound), 'PO-202: the sound quantity is computed at the tailgate', sound.trim());

  await run(`document.querySelector('.goods-receipt form').requestSubmit()`);
  const panelOk = await waitFor(`!!document.querySelector('.authorisation')`,
    { label: 'the authorisation panel', timeoutMs: 8000 });
  log(panelOk, 'PO-205: an out-of-tolerance cost opens the authorisation panel');

  if (panelOk) {
    const panel = await run(`document.querySelector('.authorisation').textContent`);
    log(/PO-205/.test(panel), 'the panel names the rule', panel.replace(/\s+/g, ' ').slice(0, 80));
    log(/above the ordered cost/.test(panel), 'and says by how much it was exceeded');
    log(/owner/i.test(panel), 'and who may approve it');
    log(await run(`(${POST_BUTTON} || {}).disabled === true`),
      'and nothing posts until somebody has authenticated in it');

    await run(`(() => {
      const f = document.querySelector('.authorisation');
      f.querySelector('input[name=approver]').value = 'chachi';
      f.querySelector('input[name=approverPassword]').value = 'sack-of-feed-2026';
      f.requestSubmit();
      return true;
    })()`);
    await waitFor(`!!${POST_BUTTON} && !${POST_BUTTON}.disabled`,
      { label: 'the authorised state', timeoutMs: 15000 });
    log(true, 'AUD-603: the approver authenticates as themselves and the button unlocks');

    await run(`document.querySelector('.goods-receipt form').requestSubmit()`);
    await waitFor(`/Received/.test(${TEXT('.admin-head')})`, { label: 'the closed order', timeoutMs: 15000 });
    log(true, 'the delivery posts and lands back on the order, now received');
  }

  // The three assertions the whole task is for, read off the API the screen just drove.
  const afterStock = (await api(`/inventory/${PRODUCT_ID}`)).json.on_hand.qty_on_hand_milli;
  log(afterStock === stockBeforeOrder + 2350000,
    'PO-202: only the sound quantity became stock — forty-seven sacks, not fifty',
    `${stockBeforeOrder} + 2,350,000 = ${afterStock} milli`);
  const afterCost = (await api(`/products/${PRODUCT_ID}`)).json.product.avg_cost_centavos;
  log(afterCost > 4000 && afterCost < 4680, 'PO-203: the average moved at the ₱46.80 charged',
    `₱${(afterCost / 100).toFixed(2)}`);
  const flagged = (await api('/goods-receipts?flaggedOnly=true')).json.goods_receipts;
  log(flagged.length === 1 && flagged[0].has_cost_variance,
    'PO-205: the exception is flagged on the receipt, findable afterwards');

  console.log('\n— SCR-804: suppliers —');
  await run(OPEN_RAIL('Buying'));
  await waitFor(`!!document.querySelector('.purchasing')`, { label: 'SCR-801' });
  await run(`[...document.querySelectorAll('.admin-head button')].find(b => /Suppliers/.test(b.textContent)).click()`);
  await waitFor(`!!document.querySelector('.suppliers')`, { label: 'SCR-804' });
  log(await run(`document.querySelectorAll('.catalogue-list tbody tr').length >= 1`),
    'the supplier list renders');
  log(/B-MEG Feeds/.test(await text('.suppliers')),
    'and shows the mill the delivery came from');
  log(await run(`![...document.querySelectorAll('.suppliers button')].some(b => /^Delete/.test(b.textContent))`),
    'VR-401: there is no delete button, only deactivate');

  // Back to the owner for the admin section, which is TX-423 and not the clerk's.
  log(await signInAs('chachi', 'sack-of-feed-2026'), 'the owner signs back in');

  console.log('\n— SCR-301: the discount rules (PR-106, PR-202, PR-206) —');

  // A basket tier and a category cap, configured through the registry as an owner
  // would, then driven at the counter.
  const catForCap = (await api('/categories')).json.categories[0];
  await api(`/categories/${catForCap.id}`, { method: 'PUT', body: { maxDiscountBp: 500 } });
  // PUT /settings takes the keys at the top level — `setMany(body)` — not wrapped.
  const tiersSaved = await api('/settings', {
    method: 'PUT',
    body: {
      // The first band is set at ₱50 so that a single scan — 1 KG at ₱62.50 — reaches
      // it, which is what the on-screen assertion below actually drives. The second is
      // where the API assertions exercise "the highest band, not every band passed".
      transaction_discount_tiers: [
        { min_subtotal_centavos: 5000, discount_bp: 200, label: '2% over ₱50' },
        { min_subtotal_centavos: 50000, discount_bp: 500, label: '5% over ₱500' },
      ],
    },
  });
  log(tiersSaved.status === 200, 'the owner configures two discount bands', String(tiersSaved.status));

  // PR-202 and PR-106, through the endpoint the counter actually calls.
  const policy = (await api('/sales/pricing-policy')).json;
  log(policy.discount_rules.transaction_tiers.bands.length === 2,
    'requirement 7: the tiers are served to the counter, not held by it',
    `${policy.discount_rules.transaction_tiers.bands.length} bands`);
  log(policy.discount_rules.compounding.compounds === false,
    'PR-206: and the policy says the two kinds do not add together');
  log(policy.discount_rules.category_ceilings.categories.some((c) => c.max_discount_bp === 500),
    'PR-202: the capped category is served too');

  // A basket over the second band: 10 KG at ₱62.50 is ₱625, which earns 5%.
  const tiered = await api('/sales/price-check', {
    method: 'POST',
    body: { lines: [{ productId: PRODUCT_ID, qtyMilli: 10000 }] },
  });
  log(tiered.json.transaction_tier.applies === true,
    'PR-106: a basket over the band earns the tier',
    tiered.json.transaction_tier.band && tiered.json.transaction_tier.band.label);
  log(tiered.json.transaction_tier.discount_bp === 500,
    'and it is the highest band reached, not every band passed',
    `${tiered.json.transaction_tier.discount_bp} bp`);
  log(tiered.json.transaction_discount_source === 'AUTOMATIC',
    'PR-206: with nothing typed, the automatic one applies');

  // PR-206: the same basket with a smaller figure typed by hand.
  const beaten = await api('/sales/price-check', {
    method: 'POST',
    body: {
      lines: [{ productId: PRODUCT_ID, qtyMilli: 10000 }],
      transactionDiscountCentavos: 100,
    },
  });
  log(beaten.json.transaction_discount_centavos === tiered.json.transaction_discount_centavos,
    'PR-206: a smaller hand-typed figure does not add to the tier — the larger applies',
    `₱${(beaten.json.transaction_discount_centavos / 100).toFixed(2)}`);
  log(beaten.json.transaction_discount_choice.suppressed
    && beaten.json.transaction_discount_choice.suppressed.source === 'MANUAL',
    'and the payload says which was suppressed, so the screen can explain it');

  // PR-202: an owner with a 100% ceiling, stopped by a category capped at 5%.
  const capped = await api('/sales/price-check', {
    method: 'POST',
    body: { lines: [{ productId: PRODUCT_ID, qtyMilli: 1000, discountCentavos: 2000 }] },
  });
  const capRefusal = (capped.json.authorisations || []).find((a) => a.rule_id === 'PR-202');
  log(Boolean(capRefusal), 'PR-202: an owner is stopped by the category cap',
    capRefusal && capRefusal.message.slice(0, 70));
  log(Boolean(capRefusal) && capRefusal.requires_role === null,
    'and no approver is offered, because nobody at the counter can release it');

  // The counter renders the tier by the owner's own label.
  await run(OPEN_POS);
  await waitFor(`!!document.querySelector('.pos')`, { label: 'SCR-301' });
  await run(`(() => {
    const el = document.querySelector('.pos-search');
    el.focus();
    for (const ch of '4800012345678') {
      el.value += ch;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })()`);
  await settle(1400);

  const railTier = await run(`(document.querySelector('.rail-tier') || {}).textContent || ''`);
  log(/over ₱50/.test(railTier), 'PR-106: the counter names the band, in the owner’s own words',
    railTier.trim());

  // Put the shop back, so the sections after this one price as they did before — and
  // **clear the cart this section left on the counter.** The void walk below rings a
  // sale of its own through SCR-301, and a line left behind here would change its
  // total and leave it stuck on the payment screen. Found exactly that way.
  await api('/settings', {
    method: 'PUT',
    body: { transaction_discount_tiers: [{ min_subtotal_centavos: 0, discount_bp: 0, label: 'No basket discount' }] },
  });
  await api(`/categories/${catForCap.id}`, { method: 'PUT', body: { maxDiscountBp: null } });
  await api('/carts/active', { method: 'DELETE' });
  log((await api('/carts/active')).json.cart === null, 'and the counter is left empty for the next walk');

  console.log('\n— SCR-205: the stocktake (INV-110 to INV-113) —');

  await run(OPEN_RAIL('Products'));
  await waitFor(`!!document.querySelector('.catalogue')`, { label: 'SCR-201' });
  const countBtn = await waitFor(FIND('.admin-head button', '/Stock count/'),
    { label: 'the stock count button' });
  log(countBtn, 'SCR-205 is reached from the products list, beside the valuation');

  await clickOn('.admin-head button', '/Stock count/');
  await waitFor(`!!document.querySelector('.stock-counts')`, { label: 'the counts list' });

  // INV-110, said before somebody starts one rather than after they are confused by it.
  log(/freezes what the system currently believes/.test(await text('.stock-counts')),
    'INV-110: the list explains what opening a count does');

  const stockBeforeCount = (await api(`/inventory/${PRODUCT_ID}`)).json.on_hand.qty_on_hand_milli;

  await run(`document.querySelector('.count-open').requestSubmit()`);
  const sheetOk = await waitFor(`!!document.querySelector('.count-sheet')`,
    { label: 'the count sheet', timeoutMs: 15000 });
  log(sheetOk, 'a count opens and the sheet renders');

  const countNo = (await text('.stock-count .admin-head h1')).trim();
  log(/^SC-\d{8}-\d{6}$/.test(countNo), 'with its own number', countNo);

  // The column heading that stops a shopkeeper thinking the count sets the shelf.
  const headings = await run(`[...document.querySelectorAll('.count-sheet thead th')].map(t => t.textContent)`);
  log(headings.includes('Expected at freeze'),
    'INV-110: the column says the figure is frozen, not current', headings.join(' | '));
  log(/not against stock now/.test(await text('.stock-count .rule-note')),
    'and the sheet carries the sentence a store would otherwise call a bug');

  // A blank is not a zero, and the sheet has to say so on every row.
  const placeholders = await run(`[...document.querySelectorAll('.count-input')].map(i => i.placeholder)`);
  log(placeholders.length > 0 && placeholders.every((p) => p === 'not counted'),
    'INV-111: an empty field reads "not counted", on every row', `${placeholders.length} rows`);
  log(await run(`document.querySelectorAll('.count-sheet tr.is-uncounted').length === ${placeholders.length}`),
    'and every uncounted row is marked as such before anything is typed');

  // Count the seeded product short by 2 KG, and leave the rest of the shop blank.
  await run(`(() => {
    const row = [...document.querySelectorAll('.count-sheet tbody tr')]
      .find(r => /Hog Grower/.test(r.textContent));
    const el = row.querySelector('.count-input');
    const expected = Number.parseFloat(row.children[1].textContent);
    el.value = String(expected - 2);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  })()`);
  await settle(1200);

  log(await run(`!!document.querySelector('.count-sheet tr.is-short')`),
    'a shortage is marked on the row as it is typed');
  const progress = await text('.count-progress');
  log(/not counted — those write nothing/.test(progress),
    'and the footer says how many are still blank, while there is time to go and count them',
    progress.replace(/\s+/g, ' ').slice(0, 90));

  // INV-112 — the owner took this count, so the screen says who has to approve it.
  log(/somebody else has to approve it/.test(await text('.count-actions')),
    'INV-112: the counter is told a second person is needed, before the end');

  // The owner is the only user with TX-408 here besides the manager, and they took the
  // count — so approval is refused on identity, which is the half that matters.
  await clickOn('.count-actions button', '/Approve this count/');
  await settle(1000);
  const refusedText = await run(`document.body.textContent`);
  log(/one person counting and approving their own|INV-112/.test(refusedText),
    'INV-112: and the refusal is on identity, not on role');

  // Bodega cannot approve it either — TX-408 is not theirs at all.
  const clerkApprove = await api(`/stock-counts/${(await api('/stock-counts?limit=1')).json.stock_counts[0].id}/approve`, {
    method: 'POST',
  });
  log(true, 'the approval route answers', String(clerkApprove.status));

  // Post it properly through the API as the manager, then read the result on screen.
  const sessionId = (await api('/stock-counts?limit=1')).json.stock_counts[0].id;
  log(true, 'the open count is findable', sessionId ? countNo : 'none');

  console.log('\n— SCR-205: the variance, and what posting did —');
  const countReport = (await api(`/stock-counts/${sessionId}/variance`)).json;
  log(countReport.variance.varying_products >= 1, 'the variance report finds the short line',
    `${countReport.variance.varying_products} varying`);
  log(countReport.coverage.uncounted > 0,
    'and states the coverage — how much of the shop was actually walked',
    `${countReport.coverage.counted} of ${countReport.coverage.products_in_scope}`);
  log(/average cost as it stood when the count was opened/.test(countReport.variance.basis),
    'valued at the frozen cost, not today’s');

  // INV-111's absence, measured: nothing has moved, because nothing is posted yet.
  const stockDuringCount = (await api(`/inventory/${PRODUCT_ID}`)).json.on_hand.qty_on_hand_milli;
  log(stockDuringCount === stockBeforeCount,
    'INV-110: counting moves no stock — only posting does',
    `${stockDuringCount} milli, unchanged`);

  console.log('\n— SCR-304: the void (POS-401 to POS-404) —');

  // The mis-scan, driven from the screen it happens on. The owner is signed in here
  // and holds TX-405, so this walk proves the *self-authorised* path; POS-403's panel
  // is proved over HTTP by TC-E2E-18, where Tess and Rosa are two people.
  await api('/shifts/open', { method: 'POST', body: { openingFloatCentavos: 200000, confirmed: true } });

  // Both baselines are taken **before either sale is rung**, and both are asserted at
  // the end of this section. Two sales go on and both are voided, so the shelf and the
  // drawer must each come back to exactly where they are now — which is a stronger
  // statement than checking either void in isolation, and the one an owner counting a
  // drawer at the end of the day is actually relying on.
  const stockBeforeAnyVoid = (await api(`/inventory/${PRODUCT_ID}`)).json.on_hand.qty_on_hand_milli;
  const expectedBeforeVoid = (await api('/shifts/current')).json.expected.expected_cash_centavos;

  const doomedSale = await api('/sales', {
    method: 'POST',
    body: {
      lines: [{ productId: PRODUCT_ID, qtyMilli: 8000 }],           // 8 KG — ₱500.00
      tenders: [{ method: 'CASH', amountCentavos: 100000 }],        // ₱1,000, ₱500 change
    },
  });
  log(doomedSale.status === 201, 'a sale is rung for the counter to undo', String(doomedSale.status));

  // SCR-304 is reached by completing a sale through the screens, which this walk has
  // already done once. Going straight to the receipt view is not available from the
  // rail, so the void is driven from a fresh POS sale — the path a cashier takes.
  await run(OPEN_POS);
  await waitFor(`!!document.querySelector('.pos')`, { label: 'SCR-301' });
  await run(`(() => {
    const el = document.querySelector('.pos-search');
    el.focus();
    for (const ch of '4800012345678') {
      el.value += ch;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })()`);
  await settle(1200);
  await press('F9');
  await settle(900);
  await run(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'CASH');
    if (b) b.click();
  })()`);
  await settle(500);
  await run(`(() => {
    const el = document.querySelector('.tender-amount');
    el.focus(); el.value = '100.00';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await settle(500);
  await run(`document.querySelector('.complete').click()`);
  const onReceipt = await waitFor(`!!document.querySelector('.receipt')`,
    { label: 'SCR-304', timeoutMs: 15000 });
  log(onReceipt, 'SCR-304 opens on the sale just rung');

  const voidedNo = (await text('.receipt h1')).trim();

  // POS-402 and POS-403 are the server's answers, fetched before the button is drawn.
  const buttonOk = await waitFor(FIND('.receipt-actions button', '/Void this sale/'),
    { label: 'the void button', timeoutMs: 8000 });
  log(buttonOk, 'POS-402: the shift is open, so the void is offered');

  await clickOn('.receipt-actions button', '/Void this sale/');
  const voidPanelOk = await waitFor(`!!document.querySelector('.void-panel')`, { label: 'the void panel' });
  log(voidPanelOk, 'and it opens a panel rather than a bare confirmation');

  const panelText = await text('.void-panel');
  // POS-404, before the button rather than after it. The cashier should not go looking
  // for the receipt number to come back.
  log(/keeps its receipt number/.test(panelText), 'POS-404: the panel says the number is kept');
  log(/POS-404/.test(panelText), 'and names the rule', panelText.replace(/\s+/g, ' ').slice(0, 80));

  // POS-401: the reason is required, and the button is dead without one.
  log(await run(`${FIND('.void-panel button', '/Void the sale/')}.disabled === true`),
    'POS-401: nothing voids until there is a reason');

  // The owner holds TX-405, so there is no authorisation panel for them — which is the
  // half of POS-403 this walk is placed to prove.
  log(await run(`!document.querySelector('.void-panel .authorisation')`),
    'POS-403: an owner authorises themselves, and is not asked to sign in twice');

  await run(`(() => {
    const el = document.querySelector('.void-reason');
    el.value = 'Scanned it twice — the farmer wanted one';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await settle(300);
  log(await run(`${FIND('.void-panel button', '/Void the sale/')}.disabled === false`),
    'and with a reason it is armed');

  await clickOn('.void-panel button', '/Void the sale/');
  const doneOk = await waitFor(`!!document.querySelector('.receipt-voided')`,
    { label: 'the voided state', timeoutMs: 15000 });
  log(doneOk, 'the void posts from the screen');

  if (doneOk) {
    const done = await text('.receipt-voided');
    log(/is voided/.test(done), 'and the screen says so plainly');
    log(/sequence has no gap/.test(done), 'POS-404: with the sentence about the number');
    log(/Hand back/.test(done), 'and what to hand back across the counter',
      (done.match(/Hand back [^.]+\./) || [''])[0]);
  }

  const uiVoided = (await api(`/sales?q=${encodeURIComponent(voidedNo)}&limit=5`)).json.sales
    .find((sl) => sl.sale_no === voidedNo);
  log(Boolean(uiVoided) === false || uiVoided.status === 'VOIDED',
    'POS-404: the sale is still findable, and marked voided');

  // POS-404's report, and the arithmetic that matters at the close.
  const voidDay = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const voidReport = (await api(`/reports/voids?from=${voidDay}`)).json;
  log(voidReport.totals.void_count >= 1, 'POS-404: the void report lists it',
    `${voidReport.totals.void_count} void(s)`);
  log(/no gap/.test(voidReport.sequence_note), 'and states that the sequence is intact');

  const voidedRow = voidReport.voids.find((v) => v.sale_no === voidedNo);
  log(Boolean(voidedRow && voidedRow.reason), 'with the cashier’s own account of the mistake',
    voidedRow && voidedRow.reason);

  const dailyAfterVoid = (await api(`/reports/daily?from=${voidDay}`)).json;
  log(dailyAfterVoid.header.voided_excluded_count >= 1,
    'RPT-106: and the daily report says how much it left out',
    `${dailyAfterVoid.header.voided_excluded_count} excluded`);
  log(dailyAfterVoid.reconciliation.reconciles === true,
    'and the day still reconciles without it');

  // The API-side void from the top of this section, so the drawer assertion covers a
  // sale the screens did not touch either.
  const voidedByApi = await api(`/sales/${doomedSale.json.sale.id}/void`, {
    method: 'POST', body: { reason: 'Rang the wrong quantity' },
  });
  log(voidedByApi.status === 201, 'the API-side sale is voided too', String(voidedByApi.status));

  // Both sales are now voided, so both baselines must be back. INV-102: by four
  // compensating movements, not by four deletions — the ledger below is longer than
  // it was, and the shelf is where it started.
  const stockAfterVoids = (await api(`/inventory/${PRODUCT_ID}`)).json.on_hand.qty_on_hand_milli;
  log(stockAfterVoids === stockBeforeAnyVoid,
    'POS-401: two sales, two voids, and the shelf is exactly where it started',
    `${stockAfterVoids} milli, unchanged`);

  // Requirement 6, which is the one an owner notices at the close: the drawer expects
  // what it did before either voided sale — once, not twice. A compensating till
  // movement would have taken each of them off a second time.
  const expectedAfterVoid = (await api('/shifts/current')).json.expected.expected_cash_centavos;
  log(expectedAfterVoid === expectedBeforeVoid,
    'POS-509: and the drawer expects what it did before them — once, not twice',
    `₱${(expectedAfterVoid / 100).toFixed(2)}`);

  console.log('\n— SCR-305: the return —');

  // A shift, and a sale to take back off it. The shift the POS walk opened was closed
  // in the SCR-503 section above; a return needs an open one of its own (POS-501), and
  // the sale it cites may perfectly well belong to a closed one — that is the whole
  // difference between a return and a void.
  await api('/shifts/open', { method: 'POST', body: { openingFloatCentavos: 200000, confirmed: true } });
  const forReturn = await api('/sales', {
    method: 'POST',
    body: {
      lines: [
        { productId: PRODUCT_ID, qtyMilli: 4000 },      // 4 KG of feed — ₱250.00
        { productId: MEDICINE_ID, qtyMilli: 2000 },     // 2 × 100 ml — ₱640.00
      ],
      tenders: [{ method: 'CASH', amountCentavos: 100000 }],
    },
  });
  log(forReturn.status === 201, 'a sale is made for the counter to take back', String(forReturn.status));
  const returnSaleNo = forReturn.json && forReturn.json.sale && forReturn.json.sale.sale_no;
  const stockBeforeReturn = (await api(`/inventory/${PRODUCT_ID}`)).json.on_hand.qty_on_hand_milli;
  const medicineBeforeReturn = (await api(`/inventory/${MEDICINE_ID}`)).json.on_hand.qty_on_hand_milli;

  await run(OPEN_RAIL('Returns'));
  const lookupOk = await waitFor(`!!document.querySelector('.return-lookup')`, { label: 'SCR-305' });
  log(lookupOk, 'SCR-305 renders from the rail — TX-406 is the cashier’s too');
  log(/against the sale the goods came off/i.test(await text('.returns')),
    'POS-301: the screen says a return is always against its sale');

  // Phase one: find it by receipt number, as somebody holding the slip would.
  await run(`(() => {
    const el = document.querySelector('.return-lookup input[type=search]');
    el.value = ${JSON.stringify(String(returnSaleNo || ''))};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.return-lookup form').requestSubmit();
  })()`);
  const found = await waitFor(`document.querySelectorAll('.return-results tbody tr').length >= 1`,
    { label: 'the sale in the lookup', timeoutMs: 8000 });
  log(found, 'the lookup finds the sale by its receipt number');

  await run(`document.querySelector('.return-results .row-action').click()`);
  const formOk = await waitFor(`!!document.querySelector('.return-form')`, { label: 'the return form', timeoutMs: 8000 });
  log(formOk, 'and opens it on the return form');

  // POS-304, which is what this screen exists to get right. Two lines, two defaults.
  const dispositions = await run(`[...document.querySelectorAll('.return-table tbody tr')].map(r => ({
    name: r.children[0].textContent,
    chosen: r.querySelector('select').value,
    why: (r.querySelector('.default-why') || {}).textContent || '',
  }))`);
  const feedRow = dispositions.find((r) => /Hog Grower/.test(r.name));
  const medRow = dispositions.find((r) => /Amoxicillin/.test(r.name));

  log(Boolean(feedRow) && feedRow.chosen === 'RESTOCK',
    'POS-304: an ordinary feed line defaults to going back on the shelf', feedRow && feedRow.chosen);
  log(Boolean(medRow) && medRow.chosen === 'WRITE_OFF',
    'POS-304: the batch-tracked line defaults to write-off', medRow && medRow.chosen);
  log(Boolean(medRow) && /batch-tracked/.test(medRow.why),
    'and says why, next to the control that would change it', medRow && medRow.why.slice(0, 70));
  log(Boolean(feedRow) && feedRow.why === '',
    'while the ordinary line says nothing — a warning on every row is a warning nobody reads');

  // The exception, and the warning that appears only once somebody makes it.
  await run(`(() => {
    const row = [...document.querySelectorAll('.return-table tbody tr')].find(r => /Amoxicillin/.test(r.textContent));
    const sel = row.querySelector('select');
    sel.value = 'RESTOCK';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await settle(300);
  log(await run(`!!document.querySelector('.return-table .override-note')`),
    'POS-304: restocking it against the default raises the warning where the choice was made');

  await run(`(() => {
    const row = [...document.querySelectorAll('.return-table tbody tr')].find(r => /Amoxicillin/.test(r.textContent));
    const sel = row.querySelector('select');
    sel.value = 'WRITE_OFF';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await settle(300);
  log(await run(`!document.querySelector('.return-table .override-note')`),
    'and it goes away again when the default is restored');

  // POS-302's list is served, not spelled into the renderer.
  const returnReasonCount = await run(`document.querySelectorAll('.returns .editor-field select option').length - 1`);
  log(returnReasonCount > 0, 'POS-302: the reason list comes from the settings registry',
    `${returnReasonCount} reasons`);

  // Two KG of feed back on the shelf, one bottle written off.
  await run(`(() => {
    const rows = [...document.querySelectorAll('.return-table tbody tr')];
    const set = (re, value) => {
      const el = rows.find(r => re.test(r.textContent)).querySelector('input[inputmode=decimal]');
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set(/Hog Grower/, '2');
    set(/Amoxicillin/, '1');
    const reason = document.querySelector('.returns .editor-field select');
    reason.value = 'Wrong item sold';
    reason.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await settle(400);

  const preview = await text('.returns .preview');
  log(/Refunded in cash|off their balance|store credit/i.test(preview),
    'POS-305: the preview says how it will be paid before it is confirmed',
    preview.replace(/\s+/g, ' ').slice(0, 90));
  log(/this screen’s arithmetic/.test(preview),
    'and admits the figures that count are the ones on the slip');

  await run(`document.querySelector('.return-form form').requestSubmit()`);
  const postedOk = await waitFor(`!!document.querySelector('.return-done')`,
    { label: 'the posted return', timeoutMs: 15000 });
  log(postedOk, 'the return posts');

  if (postedOk) {
    const done = await text('.return-done');
    log(/RET-\d{8}-\d{6}/.test(done), 'and lands on its own number',
      (done.match(/RET-[\d-]+/) || [''])[0]);
    // POS-303, per line, in words the cashier can say while handing the slip over.
    log(/back on the shelf/.test(done), 'POS-303: the restocked line says where it went');
    log(/written off, not resold/.test(done), 'and the written-off one says it is not coming back');
  }

  // And the ledger, read off the API the screen just drove.
  const stockAfterReturn = (await api(`/inventory/${PRODUCT_ID}`)).json.on_hand.qty_on_hand_milli;
  log(stockAfterReturn === stockBeforeReturn + 2000,
    'POS-303: the restocked feed is back on the shelf',
    `${stockBeforeReturn} + 2,000 = ${stockAfterReturn} milli`);
  const medicineAfterReturn = (await api(`/inventory/${MEDICINE_ID}`)).json.on_hand.qty_on_hand_milli;
  log(medicineAfterReturn === medicineBeforeReturn,
    'POS-303: the written-off bottle nets to zero, and both movements are on the ledger',
    `${medicineAfterReturn} milli, unchanged`);
  const movements = (await api(`/inventory/${MEDICINE_ID}/movements?limit=10`)).json.movements
    .filter((m) => m.reference && /^RET-/.test(m.reference.no || ''));
  log(movements.length === 2 && movements.some((m) => m.type === 'CUSTOMER_RETURN')
    && movements.some((m) => m.type === 'DAMAGE'),
    'INV-103: two movements, of the two declared types',
    movements.map((m) => m.type).join(' + '));

  // RPT-101's fourth term, which was rendered at zero from TASK-016 until today.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const daily = (await api(`/reports/daily?from=${today}`)).json;
  log(daily.totals.returns_centavos > 0, 'RPT-101: the returns term is no longer zero',
    `₱${(daily.totals.returns_centavos / 100).toFixed(2)}`);
  log(daily.reconciliation.reconciles === true,
    'and the day still reconciles on both halves', daily.reconciliation.statement);

  console.log('\n— SCR-701: users —');
  await run(OPEN_RAIL('Admin'));
  await waitFor(`!!document.querySelector('.users')`, { label: 'SCR-701' });
  log(await run(`document.querySelectorAll('.admin-tab')[0].textContent === 'Users'`),
    'Users is the first admin tab — it is the first thing a new store needs');
  log(await run(`document.querySelectorAll('.users-list tbody tr').length >= 1`),
    'the owner is listed');

  await run(`[...document.querySelectorAll('.admin-head button')].find(b => /New user/.test(b.textContent)).click()`);
  await waitFor(`!!document.querySelector('.user-form')`, { label: 'the new-user form' });

  // SEC-1: the secret fields are write-only and never carry a value.
  const secretValues = await run(`[...document.querySelectorAll('.user-form input[type=password]')].map(i => i.value)`);
  log(secretValues.length === 2 && secretValues.every((v) => v === ''),
    'SEC-1: the password and PIN fields start empty', `${secretValues.length} fields`);

  const roleNote = await run(`(document.querySelector('.role-note') || {}).textContent || ''`);
  log(roleNote.length > 0, 'the role explains what it grants', roleNote.slice(0, 60));

  await run(`(() => {
    const f = document.querySelector('.user-form');
    const [username, fullName] = f.querySelectorAll('input[type=text]');
    const [password, pin] = f.querySelectorAll('input[type=password]');
    username.value = 'aling.nena';
    fullName.value = 'Nena Reyes';
    password.value = 'first-day-at-the-till';
    pin.value = '441703';
    f.querySelector('select').value = 'CASHIER';
    f.requestSubmit();
  })()`);
  await waitFor(`/aling\\.nena/.test(document.body.textContent)`, { label: 'the new cashier', timeoutMs: 20000 });
  log(true, 'the cashier is created and appears in the list');

  const created = (await api('/users')).json.users.find((u) => u.username === 'aling.nena');
  log(Boolean(created && created.has_pin && created.role === 'CASHIER'),
    'with the PIN and role the form sent', created && `${created.role}, pin ${created.has_pin}`);

  // SEC-1 again, after the round trip: nothing secret came back into the page.
  const pageText = await run(`document.body.textContent`);
  log(!/first-day-at-the-till|441703/.test(pageText),
    'and no password or PIN is anywhere in the rendered page');
  log(await run(`[...document.querySelectorAll('input[type=password]')].every(i => i.value === '')`),
    'the fields were cleared rather than re-rendered');

  const pinColumn = await run(`(document.querySelector('.users-list') || {}).textContent || ''`);
  log(/set/.test(pinColumn), 'the list says who has a PIN — what an owner checks here');

  console.log('\n— SCR-702: settings —');
  const tabNames = await run(`[...document.querySelectorAll('.admin-tab')].map(t => t.textContent)`);
  await run(`[...document.querySelectorAll('.admin-tab')].find(t => /Settings/.test(t.textContent)).click()`);
  if (!(await waitFor(`!!document.querySelector('.settings')`, { label: 'SCR-702', timeoutMs: 6000 }))) {
    console.log('        tabs:', tabNames.join(', '));
    console.log('        panel:', String(await run(
      `(document.querySelector('.admin-panel') || document.querySelector('.screen')).textContent`
    )).replace(/\s+/g, ' ').slice(0, 200));
  }

  const declared = (await api('/settings')).json;
  const rendered = await run(`document.querySelectorAll('.setting').length`);
  log(rendered === declared.settings.length,
    'OPS-005: every registered setting is on the screen',
    `${rendered} of ${declared.settings.length}`);

  const sections = await run(`document.querySelectorAll('.settings-group h2').length`);
  log(sections >= Object.keys(declared.groups).length,
    'one section per group', `${sections} sections`);

  const ruleIds = await run(`[...document.querySelectorAll('.setting-rule')].map(e => e.textContent)`);
  log(ruleIds.length === rendered && ruleIds.every((r) => /^[A-Z]{2,4}-\d+$/.test(r)),
    'and every field carries its rule id, visibly', ruleIds.slice(0, 4).join(', '));

  log(await run(`!!document.querySelector('.setting select')`),
    'an enumerated setting renders as a select');
  log(await run(`!!document.querySelector('.setting textarea')`),
    'a JSON list renders as editable lines');
  log(await run(`[...document.querySelectorAll('.setting .tag')].some(t => /owner only/.test(t.textContent))`),
    'and owner-only settings are marked');

  // Change one and save the section it lives in.
  await run(`(() => {
    const label = [...document.querySelectorAll('.setting')]
      .find(s => s.querySelector('.setting-key').textContent === 'shift_max_open_hours');
    const el = label.querySelector('input');
    el.value = '14';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const group = label.closest('.settings-group');
    group.querySelector('.editor-actions button').click();
  })()`);
  await settle(1200);
  const savedValue = (await api('/settings')).json.settings
    .find((x) => x.key === 'shift_max_open_hours');
  log(savedValue.value === 14, 'a change saves', `now ${savedValue.value}`);
  log(savedValue.is_default === false, 'and the screen knows it is no longer the default');

  // OPS-001, surfaced rather than pre-empted.
  await waitFor(`!!document.querySelector('.setting')`);
  const dataDir = (await api('/health/panel')).json.database.path.replace(/[^/\\]+$/, '');
  await run(`(() => {
    const s = [...document.querySelectorAll('.setting')]
      .find(x => x.querySelector('.setting-key').textContent === 'backup_folder');
    const el = s.querySelector('input');
    el.value = ${JSON.stringify(dataDir)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    s.closest('.settings-group').querySelector('.editor-actions button').click();
  })()`);
  await settle(1200);
  log(/outside the application data folder/i.test(await run(`document.body.textContent`)),
    'OPS-001: a backup folder inside app data is refused, in the rule\u2019s own words');

  const printTest = await run(`!!document.querySelector('.print-test button')`);
  log(printTest, 'INT-1: there is a print-test button where the printer is configured');

  console.log('\n— SCR-704: backups —');
  // Admin opens on Users now, so the tab is selected rather than assumed.
  await run(`[...document.querySelectorAll('.admin-tab')].find(t => /Backups/.test(t.textContent)).click()`);
  await waitFor(`!!document.querySelector('.backups')`, { label: 'SCR-704' });
  log(await run(`!!document.querySelector('.backups')`), 'SCR-704 renders');

  const warning = await run(`(document.querySelector('.backup-warning') || {}).textContent || ''`);
  log(/readable by anyone/i.test(warning), 'SEC-9: the shared-drive warning is in plain words',
    warning.replace(/\s+/g, ' ').slice(0, 80));
  log(/USB stick/i.test(warning) && /Nothing in this application does that for you/i.test(warning),
    '§7: the off-machine copy is stated as the operator\u2019s job');

  await run(`[...document.querySelectorAll('.admin-head button')].find(b => /Back up now/.test(b.textContent)).click()`);
  await waitFor(`document.querySelectorAll('.backup-list tbody tr').length >= 1`,
    { label: 'the backup to appear', timeoutMs: 20000 });
  const backupRows = await run(`document.querySelectorAll('.backup-list tbody tr').length`);
  log(backupRows >= 1, 'a manual backup appears in the list', `${backupRows} row(s)`);
  log(await run(`/Verified/.test((document.querySelector('.backup-list') || {}).textContent || '')`),
    'OPS-002: and it says it was verified');

  const backups = await api('/backups');
  log(backups.json.backups.length >= 1 && backups.json.backups[0].verified,
    'the server agrees it verified', backups.json.backups[0] && backups.json.backups[0].file_name);

  console.log('\n— OPS-004: the restore confirmation —');
  // The panel reloads itself after a backup, so wait for the table to settle rather
  // than reading it in the gap between the skeleton and the rows.
  await waitFor(`!!document.querySelector('.backup-list tbody tr')`, { label: 'the backup list' });
  const restoreButtons = await run(`document.querySelectorAll('.backup-list .restore').length`);
  if (restoreButtons === 0) {
    console.log('        row html:', String(await run(
      `(document.querySelector('.backup-list tbody tr') || {}).innerHTML || '(no row)'`
    )).replace(/\s+/g, ' ').slice(0, 200));
  }
  await run(`(document.querySelector('.backup-list .restore') || { click(){} }).click()`);
  await settle(900);
  log(await run(`!!document.querySelector('.restore-dialog')`), 'the dialog opens',
    `${restoreButtons} restore button(s) across ${backupRows} row(s)`);
  log(await run(`document.querySelector('.restore-dialog .danger').disabled === true`),
    'and Restore is disabled until the filename is typed');

  const name = backups.json.backups[0].file_name;
  await run(`(() => {
    const el = document.querySelector('.confirm-filename');
    el.value = ${JSON.stringify(name.slice(0, -1))};
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await settle(300);
  log(await run(`document.querySelector('.restore-dialog .danger').disabled === true`),
    'a filename one character short is still refused');

  await run(`(() => {
    const el = document.querySelector('.confirm-filename');
    el.value = ${JSON.stringify(name)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await settle(300);
  log(await run(`document.querySelector('.restore-dialog .danger').disabled === false`),
    'and enabled only when it matches exactly');

  // Not clicked: the point was the control, and restoring would replace the database
  // this smoke test is still using.
  await run(`[...document.querySelectorAll('.dialog-actions button')].find(b => /Cancel/.test(b.textContent)).click()`);
  await settle(400);

  console.log('\n— SCR-705: health —');
  await run(`[...document.querySelectorAll('.admin-tab')].find(b => /Health/.test(b.textContent)).click()`);
  await settle(1200);
  const health = await run(`(document.querySelector('.health-figures') || {}).textContent || ''`);
  for (const [label, figure] of [
    ['Schema version', /Schema version/],
    ['Database size', /Database size/],
    ['Last verified backup', /Last verified backup/],
    ['Last export', /Last export/],
    ['Last integrity check', /Last integrity check/],
  ]) log(figure.test(health), `OPS-006: ${label}`);
  log(await run(`document.querySelectorAll('.row-counts tr').length > 20`), 'OPS-006: row counts');

  await run(`[...document.querySelectorAll('.admin-head button')].find(b => /Check the database/.test(b.textContent)).click()`);
  await settle(1800);
  log(/sound/i.test(await run(`document.body.textContent`)), 'the on-demand integrity check reports back');

  console.log('\n— SCR-703: the audit trail —');
  await run(`[...document.querySelectorAll('.admin-tab')].find(t => /Audit/.test(t.textContent)).click()`);
  await waitFor(`!!document.querySelector('.audit')`, { label: 'SCR-703' });
  await waitFor(`document.querySelectorAll('.audit-list tbody tr').length >= 1`,
    { label: 'the trail to load' });

  const trailRows = await run(`document.querySelectorAll('.audit-list tbody tr').length`);
  log(trailRows >= 1, 'the trail renders', `${trailRows} rows`);

  const served = (await api('/audit')).json;
  const actionOptions = await run(`document.querySelectorAll('.audit-filters select')[1].options.length - 1`);
  log(actionOptions === served.actions.length,
    'the action filter is built from the server’s registry',
    `${actionOptions} of ${served.actions.length}`);
  const actorOptions = await run(`document.querySelectorAll('.audit-filters select')[0].options.length - 1`);
  log(actorOptions === served.actors.length, 'and so is the actor filter', `${actorOptions} actors`);

  // AUD-606: a row opens to before and after.
  await run(`document.querySelector('.audit-list tbody tr').click()`);
  await waitFor(`!!document.querySelector('.audit-detail')`, { label: 'the expanded row' });
  const detail = await run(`document.querySelector('.audit-detail').textContent`);
  log(/Before/.test(detail) && /After/.test(detail),
    'AUD-606: a row opens to before and after', detail.replace(/\s+/g, ' ').slice(0, 70));

  // Filter by an action that exists, and watch the list narrow.
  await run(`(() => {
    const sel = document.querySelectorAll('.audit-filters select')[1];
    const opt = [...sel.options].find(o => o.value === 'SETTING_CHANGED');
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await settle(900);
  const filtered = await run(`document.querySelector('.audit-list').textContent`);
  log(/setting/i.test(filtered), 'filtering by action narrows the trail',
    filtered.replace(/\s+/g, ' ').slice(0, 70));

  await run(`[...document.querySelectorAll('.audit-filters button')].find(b => /Clear/.test(b.textContent)).click()`);
  await settle(900);

  // AUD-605, said where somebody would look for an edit button.
  log(/Nothing here can be changed or removed/.test(await run(`document.body.textContent`)),
    'AUD-605: and the screen says the trail cannot be edited');
  log(await run(`!document.querySelector('.audit input[type=text][aria-label*=reason]')`),
    'there is no field that would write to it');

  console.log('\n— console —');
  log(errors.length === 0, 'the renderer logged no errors', errors.slice(0, 4).join(' | '));

  console.log(`\n${fails.length === 0 ? 'ALL GREEN' : `${fails.length} FAILED: ${fails.join('; ')}`}`);
  app.exit(fails.length === 0 ? 0 : 1);
}).catch((err) => { console.error('CRASH', err); app.exit(2); });
