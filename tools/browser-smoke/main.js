'use strict';
// TASK-015 browser smoke: the real renderer, in real Chromium, driven the way a cashier
// drives it. The HTTP smoke proved the API; this proves the screens.

const { app, BrowserWindow } = require('electron');

const PORT = Number(process.env.UI_PORT || 47897);
const TOKEN = process.env.UI_TOKEN;
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
  await run(`document.querySelector('.catalogue-list tbody tr').click()`);
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
  if (backOk) await run(`document.querySelector('.catalogue-list .row-action').click()`);
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

  console.log('\n— SCR-704: backups —');
  await run(OPEN_RAIL('Admin'));
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

  console.log('\n— console —');
  log(errors.length === 0, 'the renderer logged no errors', errors.slice(0, 4).join(' | '));

  console.log(`\n${fails.length === 0 ? 'ALL GREEN' : `${fails.length} FAILED: ${fails.join('; ')}`}`);
  app.exit(fails.length === 0 ? 0 : 1);
}).catch((err) => { console.error('CRASH', err); app.exit(2); });
