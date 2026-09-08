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
  const press = (key) => run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))`);

  await win.loadURL(`http://127.0.0.1:${PORT}/`);
  await settle(700);

  console.log('\n— the window opens —');
  log(await run(`!!document.querySelector('.signin form')`), 'SCR-101: the sign-in form renders');
  log(!(await run(`document.body.textContent.includes('Starting…')`)), 'the "Starting…" placeholder is replaced');

  await run(SIGN_IN);
  await settle(900);
  log(await run(`!!document.querySelector('.rail')`), 'the rail appears after sign-in');
  log(await run(`[...document.querySelectorAll('.rail button, .rail a')].some(b => /POS/i.test(b.textContent))`),
    'the POS item is on the rail');

  console.log('\n— the counter needs a shift (POS-501) —');
  await run(OPEN_POS);
  await settle(800);
  const beforeShift = await run(`document.querySelector('.screen').textContent`);
  log(/shift|float/i.test(beforeShift), 'the POS screen asks for a shift before a cart',
    beforeShift.replace(/\s+/g, ' ').slice(0, 80));

  const opened = await api('/shifts/open', { method: 'POST', body: { openingFloatCentavos: 200000, confirmed: true } });
  log(opened.status === 201 || opened.status === 200, 'a shift is opened', String(opened.status));

  await run(`location.reload()`);
  await settle(1000);
  log(await run(`!!document.querySelector('.signin form')`), 'SEC-7: a reload loses the token and asks again');
  await run(SIGN_IN);
  await settle(1000);
  await run(OPEN_POS);
  await settle(900);
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
  await settle(1000);
  await run(SIGN_IN);
  await settle(1100);
  await run(OPEN_POS);
  await settle(1000);
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

  console.log('\n— console —');
  log(errors.length === 0, 'the renderer logged no errors', errors.slice(0, 4).join(' | '));

  console.log(`\n${fails.length === 0 ? 'ALL GREEN' : `${fails.length} FAILED: ${fails.join('; ')}`}`);
  app.exit(fails.length === 0 ? 0 : 1);
}).catch((err) => { console.error('CRASH', err); app.exit(2); });
