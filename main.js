'use strict';

// Electron main. The only file in the product that knows Electron exists — the
// server, the services and the repositories run identically under `npm start`,
// which is what keeps the v1.3 LAN client additive (05_TECH_SPEC.md §1).

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const server = require('./src/server');

const HOST = server.HOST;
const PORT = server.port();
const BASE = `http://${HOST}:${PORT}`;

let httpServer = null;
let window = null;

function iconOption() {
  const icon = path.join(__dirname, 'build', 'icon.png');
  return fs.existsSync(icon) ? { icon } : {};
}

function createWindow() {
  window = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 1024,      // 04_UX_SPEC.md §8: below this the rail collapses to icons
    minHeight: 700,
    show: false,
    backgroundColor: '#ffffff',
    ...iconOption(),
    webPreferences: {
      // The renderer is an ordinary HTTP client. It gets no Node, no remote module
      // and no shared context — SEC-6 puts authorisation on the server, and there is
      // nothing in the renderer worth reaching.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
    process.stdout.write('window ready\n');
  });
  window.on('closed', () => { window = null; });

  // Nothing in this product opens an external page; if something tries, hand it to
  // the OS browser rather than navigating the POS away from the counter.
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  window.loadURL(BASE);
  return window;
}

async function boot() {
  const log = (line) => process.stdout.write(`${line}\n`);
  // Probe, reuse-or-start and the readiness poll live in src/server.js so they are
  // reachable without Electron — and therefore testable.
  httpServer = await server.ensureStarted({ listenPort: PORT, log });

  if (!(await server.waitForHealth({ listenPort: PORT }))) {
    throw new Error(`the API did not answer on ${BASE}; the window was not opened`);
  }
  createWindow();
}

app.whenReady().then(boot).catch((err) => {
  process.stderr.write(`${err.message}\n`);
  app.exit(1);
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  // One store, one counter, one window: closing it closes the application.
  app.quit();
});

app.on('before-quit', async () => {
  if (httpServer) await server.stop(httpServer);
});
