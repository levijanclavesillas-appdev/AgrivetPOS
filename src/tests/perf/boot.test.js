'use strict';

// TASK-073 — what the application costs before it has anything to be slow about.
//
// Every other file here seeds to NFR_2.1 scale, because "an empty database starts fast
// no matter what is wrong with the start-up path" (startup.test.js). That is true of
// the server's clock and false of everything else: the owner's "lag even theres no
// product yet" was paid on an empty store, and no case could fail on it.
//
// So this file runs against an **empty** store, and asserts only what does not depend
// on the machine — modules, bytes, requests and SQL statements, never milliseconds.
// 07_TEST_PLAN.md §6's objection to asserting a stopwatch figure does not apply to a
// count, and a count fails the day somebody adds a forty-first static import.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const server = require('../../server');
const db = require('../../config/database');
const authService = require('../../services/authService');
const temp = require('../helpers/tempdb');

const PUBLIC = path.join(__dirname, '..', '..', '..', 'public');
const PASSWORD = 'correct-horse-battery';

// The static graph behind the sign-in screen: 9 modules, 101 KB, down from 57 and
// 723 KB when every screen was imported up front. Room for a small shell module or
// two; not for a screen.
const MODULES_CEILING = 12;
const JS_BYTES_CEILING = 128 * 1024;
// Everything the browser fetches before the sign-in form: the page, its stylesheets,
// the static modules and the two calls mount() makes. 23 today. TASK-073's criterion is
// under 15, and what stands between is the eleven render-blocking stylesheets — a
// screen's CSS loading with its module is the next step, and this ceiling comes down
// with it.
const REQUESTS_CEILING = 23;

// SQL statements run by one **warm** request on an empty store, per endpoint the shell
// and the counter call on entry. Measured, not aspirational: a new query on one of these
// paths is paid on every screen for the life of the installation, and should be a
// decision somebody made rather than one that happened.
const STATEMENTS = {
  '/': 0,                              // setupService.isComplete(), memoised (§5)
  '/api/v1/setup': 2,
  '/api/v1/health': 0,
  '/api/v1/licence': 1,                // §7: ensure() once per connection, throttled ratchet
  '/api/v1/shifts/current': 4,
  '/api/v1/products': 3,
  '/api/v1/categories': 2,
  '/api/v1/sales/pricing-policy': 18,  // point reads of settings, one per figure served
  '/api/v1/quick-keys': 3,
  '/api/v1/carts/active': 3,
  '/api/v1/open-orders': 2,
  '/api/v1/sync/status': 7,
};

let instance;
let base;
let token;

test.before(async () => {
  temp.openEmpty('perf-boot');
  instance = await server.start({ listenPort: 0 });
  base = `http://127.0.0.1:${instance.address().port}`;
  // Installed, one owner, and nothing else: no category, no product, no sale.
  temp.seedStore({ withOwner: false });
  temp.seedUser({ username: 'owner', role: 'OWNER', password: PASSWORD });
  ({ token } = authService.login({ username: 'owner', password: PASSWORD }));
});

test.after(async () => {
  await new Promise((resolve) => instance.close(resolve));
  temp.cleanup();
});

/** Static imports only. `import()` is the point, so it is deliberately not matched. */
const staticImports = (code) => [...code.matchAll(
  /^\s*(?:import|export)\s[^;()]*?\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]|^\s*import\s+['"](\.{1,2}\/[^'"]+)['"]/gm
)].map((m) => m[1] || m[2]);

/** The module graph a browser loads for `entry`, as served — url → bytes. */
async function graph(entry) {
  const seen = new Map();
  const visit = async (url) => {
    if (seen.has(url)) return;
    seen.set(url, 0);
    const res = await fetch(url);
    assert.equal(res.status, 200, `${url} is served`);
    const code = await res.text();
    seen.set(url, Buffer.byteLength(code));
    for (const spec of staticImports(code)) await visit(new URL(spec, url).href);
  };
  await visit(entry);
  return seen;
}

/** What the shell's SCREENS table loads on demand — name → path under public/js/shell. */
function lazyScreens() {
  const code = fs.readFileSync(path.join(PUBLIC, 'js', 'shell', 'app.js'), 'utf8');
  return [...code.matchAll(/^\s+(create\w+): \(\) => import\('([^']+)'\),$/gm)]
    .map(([, name, spec]) => ({ name, spec, file: path.join(PUBLIC, 'js', 'shell', spec) }));
}

test('no screen is imported statically into the sign-in screen', async () => {
  const screens = lazyScreens();
  assert.ok(screens.length >= 39, `the SCREENS table was found (${screens.length} entries)`);

  const loaded = await graph(`${base}/js/boot.js`);
  const paths = [...loaded.keys()].map((url) => new URL(url).pathname);
  for (const { spec } of screens) {
    const served = `/js/${spec.replace(/^\.\.\//, '')}`;
    assert.ok(!paths.includes(served), `${served} is a screen and is loaded before anybody signs in`);
  }

  // app.js imports nothing from a screen's folder at all, not only the entry files.
  const shell = fs.readFileSync(path.join(PUBLIC, 'js', 'shell', 'app.js'), 'utf8');
  for (const spec of staticImports(shell)) {
    assert.match(spec, /^\.\/[\w-]+\.js$/, `app.js statically imports ${spec}, outside the shell`);
  }

  const bytes = [...loaded.values()].reduce((sum, n) => sum + n, 0);
  process.stdout.write(`    sign-in: ${loaded.size} modules, ${(bytes / 1024).toFixed(0)} KB of JavaScript\n`);
  assert.ok(loaded.size <= MODULES_CEILING, `${loaded.size} modules before sign-in (ceiling ${MODULES_CEILING})`);
  assert.ok(bytes <= JS_BYTES_CEILING, `${bytes} bytes of JavaScript before sign-in (ceiling ${JS_BYTES_CEILING})`);
});

test('every screen the shell loads on demand exists and exports what the shell calls', () => {
  // A static import that names a missing export fails when the page loads, in every
  // test that loads it. A lazy one fails only when somebody opens that screen — so the
  // table is checked here, where a typo costs a red test instead of a dead rail item.
  for (const { name, spec, file } of lazyScreens()) {
    assert.ok(fs.existsSync(file), `${spec} (for ${name}) exists`);
    const code = fs.readFileSync(file, 'utf8');
    assert.match(code, new RegExp(`export (?:async )?function ${name}\\b`), `${spec} exports ${name}`);
  }
});

test('the requests before the sign-in form', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
  const scripts = [...html.matchAll(/<script type="module" src="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1, 'one entry module');

  const modules = await graph(`${base}/${scripts[0]}`);
  let cssBytes = 0;
  for (const href of sheets) {
    const res = await fetch(`${base}/${href}`);
    assert.equal(res.status, 200, `${href} is served`);
    cssBytes += Buffer.byteLength(await res.text());
  }
  // mount(): /setup, then /health (app.js), before signIn() draws anything.
  const requests = 1 + sheets.length + modules.size + 2;
  process.stdout.write(
    `    ${requests} requests: the page, ${sheets.length} stylesheets (${(cssBytes / 1024).toFixed(0)} KB), `
    + `${modules.size} modules, 2 API calls — TASK-073's target is under 15\n`
  );
  assert.ok(requests <= REQUESTS_CEILING, `${requests} requests before sign-in (ceiling ${REQUESTS_CEILING})`);
});

test('SQL statements per warm request, on an empty store', async () => {
  // Counted at the connection: every statement prepared from here on reports each run.
  const handle = db.get();
  const prepare = handle.prepare;
  let count = 0;
  handle.prepare = function counted(sql) {
    const statement = prepare.call(this, sql);
    for (const method of ['get', 'all', 'run', 'iterate']) {
      const original = statement[method];
      statement[method] = function run(...args) { count += 1; return original.apply(this, args); };
    }
    return statement;
  };

  try {
    const call = async (url) => {
      count = 0;
      const res = await fetch(`${base}${url}`, { headers: { authorization: `Bearer ${token}` } });
      await res.arrayBuffer();
      assert.equal(res.status, 200, `${url} answers`);
      return count;
    };
    // The first round warms whatever is cached per connection; the second is the one
    // every later screen pays.
    for (const url of Object.keys(STATEMENTS)) await call(url);
    const report = [];
    for (const [url, ceiling] of Object.entries(STATEMENTS)) {
      const ran = await call(url);
      report.push(`${url.replace('/api/v1', '')} ${ran}`);
      assert.ok(ran <= ceiling, `${url} ran ${ran} statements on a warm request (ceiling ${ceiling})`);
    }
    process.stdout.write(`    statements per request: ${report.join(' · ')}\n`);
  } finally {
    handle.prepare = prepare;
  }
});
