'use strict';
// Google Play listing images: the real renderer at phone size, captured and framed with a
// headline, plus the icon and the feature graphic. Driven by run.sh; see listing.md.
//
// The phone window is 360 × 640 CSS pixels at 3× (1080 × 1920), Play's 9:16.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { app, BrowserWindow, nativeImage } = require('electron');

const PORT = Number(process.env.UI_PORT || 47896);
const USER = process.env.UI_USER;
const PASSWORD = process.env.UI_PASSWORD;
const CUSTOMER_ID = process.env.UI_CUSTOMER;
const OUT = process.env.OUT_DIR;
const ROOT = path.join(__dirname, '..', '..');
const SCALE = 3;

app.commandLine.appendSwitch('force-device-scale-factor', String(SCALE));
app.commandLine.appendSwitch('hide-scrollbars');
app.disableHardwareAcceleration();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One window for everything, resized as needed: under xvfb a second BrowserWindow in the
// same run fails every load with ERR_FAILED.
let shared = null;
function windowOf(width, height) {
  if (!shared) {
    shared = new BrowserWindow({
      width, height, useContentSize: true, show: true, frame: false,
      backgroundColor: '#ffffff', webPreferences: { contextIsolation: true, sandbox: true },
    });
  }
  shared.setContentSize(width, height);
  return shared;
}

async function waitFor(win, expr, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await win.webContents.executeJavaScript(`!!(${expr})`).catch(() => false)) return true;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${expr}`);
}

const run = (win, js) => win.webContents.executeJavaScript(js);
const clickText = (win, selector, pattern) => run(win, `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${pattern}.test(e.textContent));
  if (!el) return false; el.click(); return true;
})()`);

async function capture(win, file) {
  // Toasts are the moment's, not the screen's.
  await run(win, `document.querySelectorAll('.toast').forEach((t) => t.remove())`);
  // The display's pointer sits mid-window, over whatever button is there: park it in a corner.
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
  await sleep(600);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(file, image.toPNG());
  return image.getSize();
}

const PHONE = { width: 360, height: 760 };

async function phoneScreens(raw) {
  const win = windowOf(PHONE.width, PHONE.height);
  await win.loadURL(`http://127.0.0.1:${PORT}/`);
  await waitFor(win, `document.querySelector('.signin form')`);
  await run(win, `(() => {
    const f = document.querySelector('.signin form');
    f.querySelector('input[type=text]').value = ${JSON.stringify(USER)};
    f.querySelector('input[type=password]').value = ${JSON.stringify(PASSWORD)};
    f.requestSubmit();
  })()`);
  await waitFor(win, `document.querySelector('.rail')`);
  const open = async (label, ready) => {
    await run(win, `(() => { const b = [...document.querySelectorAll('.rail-item')].find((e) => e.getAttribute('aria-label') === ${JSON.stringify(label)}); b.click(); })()`);
    await waitFor(win, ready);
    await sleep(700);
  };
  const shot = async (name) => { const file = path.join(raw, `${name}.png`); await capture(win, file); return file; };
  const shots = {};

  // The counter, with a cart.
  await open('POS', `document.querySelector('.pos-search')`);
  for (const code of ['4800000100031', '4800000100031', '4800000100048', '4800000100062', '4800000100079', '4800000100093']) {
    // A scanner is a fast burst of keys ending in Enter (INT-3), as the browser smoke types it.
    await run(win, `(() => {
      const el = document.querySelector('.pos-search'); el.focus();
      for (const ch of ${JSON.stringify(code)}) {
        el.value += ch;
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
    await sleep(1200);
  }
  // Away and back: the cart is kept (POS-105), and the search list is closed.
  await open('Shift', `document.querySelector('.screen') && /drawer/i.test(document.querySelector('.screen').textContent)`);
  await open('POS', `document.querySelector('.pos-search') && document.querySelectorAll('.pos-line, .cart-line, [class*=line]').length > 0`);
  await run(win, `document.activeElement && document.activeElement.blur()`);
  await sleep(800);
  shots.counter = await shot('counter');

  // Payment, cash tendered.
  await clickText(win, 'button', /PAY/);
  await sleep(1200);
  await clickText(win, 'button', /^\s*CASH\s*$/);
  await sleep(800);
  shots.payment = await shot('payment');

  // The receipt.
  await clickText(win, 'button', /Complete/);
  await sleep(2000);
  shots.receipt = await shot('receipt');

  // The dashboard, its alerts put aside.
  await open('Reports', `document.querySelector('.screen') && /gross sales/i.test(document.querySelector('.screen').textContent)`);
  shots.dashboardWithAlerts = await shot('dashboard-alerts');
  await run(win, `document.querySelectorAll('.screen button[aria-label*="ismiss"]').forEach((b) => b.click())`);
  await sleep(800);
  shots.dashboard = await shot('dashboard');

  // A credit customer.
  await open('Customers', `document.querySelector('.screen') && /Health Center/.test(document.querySelector('.screen').textContent)`);
  await clickText(win, '.screen tr, .screen a, .screen button', /Health Center/);
  await sleep(1500);
  shots.customer = await shot('customer');

  // A product.
  await open('Products', `document.querySelector('.screen') && /Paracetamol 500/.test(document.querySelector('.screen').textContent)`);
  shots.products = await shot('products');
  await clickText(win, '.screen tr', /Paracetamol 500/);
  await sleep(1500);
  shots.product = await shot('product');

  // The shift.
  await open('Shift', `document.querySelector('.screen') && /drawer/i.test(document.querySelector('.screen').textContent)`);
  shots.shift = await shot('shift');

  return shots;
}

// ── Framing ────────────────────────────────────────────────────────────────

const BRAND = '#2563eb';
const INK = '#0f172a';
// Lucide "pill" (ISC), the app's own mark (android/…/ic_launcher_foreground.xml).
const PILL = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round"><path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z"/>'
  + '<path d="m8.5 8.5 7 7"/></svg>';
const FONT = 'font-family: Roboto, system-ui, sans-serif;';

// The framing pages and the raw captures, served from here: Chromium will not open a page of
// this size as a data: URL.
const pages = new Map();
let pageServer = null;
let rawDir = null;
async function serve() {
  if (pageServer) return pageServer.address().port;
  pageServer = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.slice(1));
    if (pages.has(name)) return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(pages.get(name));
    const file = path.join(rawDir, path.basename(name));
    if (name.endsWith('.png') && fs.existsSync(file)) return res.writeHead(200, { 'content-type': 'image/png' }).end(fs.readFileSync(file));
    return res.writeHead(404).end();
  });
  await new Promise((r) => pageServer.listen(0, '127.0.0.1', r));
  return pageServer.address().port;
}
const imageUrl = (file) => path.basename(file);

/** Renders a page of our own at a CSS size and saves it at exactly the pixel size Play asks for. */
async function renderPage(html, { width, height, outWidth, outHeight, file }) {
  const name = `${path.basename(file, '.png')}.html`;
  pages.set(name, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;${FONT}}</style>${html}`);
  const port = await serve();
  const win = windowOf(width, height);
  await win.loadURL(`http://127.0.0.1:${port}/${name}`);
  await sleep(800);
  let image = await win.webContents.capturePage();
  const size = image.getSize();
  if (size.width !== outWidth || size.height !== outHeight) {
    image = image.resize({ width: outWidth, height: outHeight, quality: 'best' });
  }
  fs.writeFileSync(file, image.toPNG());
  const out = nativeImage.createFromPath(file).getSize();
  if (out.width !== outWidth || out.height !== outHeight) throw new Error(`${file} is ${out.width}×${out.height}`);
  return file;
}

const SCREENS = [
  ['counter', 'Sell fast at the counter', 'Scan or search, by the piece or the box'],
  ['payment', 'Cash, GCash and QR Ph', 'Split payments, with the change worked out'],
  ['receipt', 'A receipt for every sale', 'On screen, or on your receipt printer'],
  ['dashboard', "Today's sales at a glance", 'Payments, credit and stock alerts'],
  ['customer', 'Customer credit, under control', 'Limits, terms, collections and statements'],
  ['product', 'Your products, your way', 'Generic names, photos, units and batches'],
  ['shift', 'Close the day with a count that adds up', 'Every peso over or short, explained'],
];

async function framed(raw, shots) {
  const files = [];
  for (const [i, [key, title, sub]] of SCREENS.entries()) {
    const file = path.join(OUT, `phone-${i + 1}-${key}.png`);
    await renderPage(`
      <div style="position:absolute;inset:0;background:linear-gradient(160deg,${BRAND} 0%,#1d4ed8 55%,${INK} 100%)"></div>
      <div style="position:absolute;left:24px;right:24px;top:30px;color:#fff;text-align:center">
        <div style="font-size:25px;font-weight:700;line-height:1.2;letter-spacing:-.2px">${title}</div>
        <div style="font-size:14px;margin-top:8px;opacity:.9">${sub}</div>
      </div>
      <div style="position:absolute;left:50%;top:138px;width:262px;height:560px;margin-left:-131px;border-radius:30px;
                  background:${INK};padding:9px;box-sizing:border-box;box-shadow:0 18px 40px rgba(0,0,0,.35)">
        <div style="width:100%;height:100%;border-radius:22px;overflow:hidden;background:#fff">
          <img src="${imageUrl(shots[key])}" style="width:100%;display:block">
        </div>
      </div>`, { width: 360, height: 640, outWidth: 1080, outHeight: 1920, file });
    files.push(file);
  }
  return files;
}

async function icon() {
  return renderPage(`<div style="width:512px;height:512px;background:${BRAND};display:grid;place-items:center">
    <div style="width:260px;height:260px">${PILL.replace('<svg ', '<svg width="260" height="260" ')}</div></div>`,
  { width: 512, height: 512, outWidth: 512, outHeight: 512, file: path.join(OUT, 'icon-512.png') });
}

async function featureGraphic(shots) {
  return renderPage(`
    <div style="position:absolute;inset:0;background:linear-gradient(120deg,${BRAND} 0%,#1d4ed8 60%,${INK} 100%)"></div>
    <div style="position:absolute;left:64px;top:0;bottom:0;width:560px;display:flex;flex-direction:column;justify-content:center;color:#fff">
      <div style="display:flex;align-items:center;gap:18px">
        <div style="width:84px;height:84px;border-radius:22px;background:rgba(255,255,255,.16);display:grid;place-items:center">
          ${PILL.replace('<svg ', '<svg width="50" height="50" ')}</div>
        <div style="font-size:60px;font-weight:800;letter-spacing:-1px">Chachi POS</div>
      </div>
      <div style="font-size:30px;font-weight:600;margin-top:26px;line-height:1.25">Point of sale and inventory<br>for small stores</div>
      <div style="font-size:19px;margin-top:16px;opacity:.9">Pharmacies · agrivet stores · cafés · shops</div>
    </div>
    <div style="position:absolute;right:70px;top:46px;width:250px;height:520px;border-radius:30px;background:${INK};padding:9px;
                box-sizing:border-box;transform:rotate(-6deg);box-shadow:0 18px 40px rgba(0,0,0,.4)">
      <div style="width:100%;height:100%;border-radius:22px;overflow:hidden;background:#fff">
        <img src="${imageUrl(shots.counter)}" style="width:100%;display:block"></div>
    </div>`,
  { width: 1024, height: 500, outWidth: 1024, outHeight: 500, file: path.join(OUT, 'feature-graphic.png') });
}

app.whenReady().then(async () => {
  try {
    const raw = fs.mkdtempSync(path.join(require('os').tmpdir(), 'chachi-listing-raw-'));
    fs.mkdirSync(raw, { recursive: true });
    rawDir = raw;
    const shots = await phoneScreens(raw);
    const made = [...await framed(raw, shots), await icon(), await featureGraphic(shots)];
    fs.rmSync(raw, { recursive: true, force: true });
    console.log(`MADE ${made.map((f) => path.basename(f)).join(' ')}`);
    app.exit(0);
  } catch (err) {
    console.error('CAPTURE FAILED', err);
    app.exit(1);
  }
});
