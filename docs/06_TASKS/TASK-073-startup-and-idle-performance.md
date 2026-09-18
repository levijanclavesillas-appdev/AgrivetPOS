# TASK-073 — The application is slow before it has anything to be slow about

**Priority:** **P1** · **Blocks release:** **yes** — `NFR_1.4` is a release criterion and is
measured on a machine slower than the one these figures came from · **Rules:** `SEC-1`,
`NFR_1.2`, `NFR_1.4`, `NFR_4.1`; `05_TECH_SPEC.md` §2 (no build step),
`07_TEST_PLAN.md` §6 (budgets, not assertions) ·
**Status:** specified 2026-09-18 · **items 1–5 built 2026-09-18**; 6–10 open

---

> **✅ Items 1–5 delivered 2026-09-18.** The five low-risk faults are fixed and the whole
> suite — 736 unit and integration, 208 e2e — passes unchanged.
>
> **Measured, on this machine:** `require('./src/app.js')` fell from **1474 ms to 798 ms**.
> That is the module-load half of the cold start, and `main.js:81` holds the window shut for
> all of it; on `NFR_4.1`'s reference PC expect two to four times the saving.
>
> **The surprise was in the licence throttle, and it is the line worth reading here.**
> Throttling the `max_seen_at` write on wall-clock time broke `LIC-001` and `LIC-002`, and the
> failure was not a test artefact: `max_seen_at` is **read back** by later `state()` calls that
> pass no `at` of their own — the shift gate among them — so the persisted value is load-bearing,
> not a record of one. A wall-clock throttle would let a clock that had genuinely moved months
> forward go unrecorded because the last write happened seconds ago, and a lapsed licence would
> have opened a shift. The throttle is now measured against the **stored** value on the domain
> clock, which needs no process state, survives a restart, and keeps the ratchet exact to within
> a minute. **Nothing here caches `state()` itself** — only the row's existence.
>
> **Still open:** items 6–10, which are where the remaining time is — the 57-module import
> graph, native bcrypt, and the `utilityProcess` move. No `boot.test.js` yet, so the import
> graph is still unguarded and a forty-fifth static import would pass review.

---

## The ask

The owner (2026-09-18): "we also need to optimize our process, im experiencing lag even theres no
product yet."

**That last clause is the whole finding.** Every performance budget in `07_TEST_PLAN.md` §6 is
about scale — a sale in 2 s at `NFR_2.1`'s catalogue size, a search in 500 ms over 5,000
products. None of them is about an empty store, and `src/tests/perf/startup.test.js:18` says so in
as many words:

> *an empty database starts fast no matter what is wrong with the start-up path*

The suite seeds to full scale on purpose, so **there is no case in it that can fail on what the
owner is describing.** The costs below are paid before the first product exists, and nearly all of
them are paid on every launch and every screen for the life of the installation.

## What was measured

On a development machine substantially faster than `NFR_4.1`'s reference store PC (4 GB, dual
core), using the repository's own dependency:

| Operation | Measured |
| :--- | ---: |
| `bcryptjs.hashSync(cost 12)` | **1358 ms** |
| `bcryptjs.compareSync(cost 12)` | **773 ms** |
| `bcryptjs.hashSync(cost 10)` | 153 ms |

`NFR_4.1`'s machine should be expected at two to four times those figures.

## The faults, in the order they cost the owner time

### 1. Password hashing is ~4.5× slower than the code says it is

`src/services/authService.js:28` sets cost 12, and the comment at `:36` states the assumption
plainly:

> *Cost 12 is deliberately expensive — roughly 300 ms a hash*

**300 ms is right for native `bcrypt`. The project depends on `bcryptjs`, which is pure
JavaScript.** The measurement above is 1358 ms. The code is not wrong about what it wants; the
dependency does not deliver it, and nothing in the suite compares the two.

Three costs follow:

- **`src/services/authService.js:57` hashes `DUMMY_HASH` at module load.** Not on first use — at
  `require` time, reached from `src/server.js:66` → `createApp()` → `middleware/auth` →
  `authService`. That is ~1.3 s added to every cold start before the server listens, and
  `main.js:81` waits on `server.waitForHealth()` before creating the window, so the user is
  looking at nothing for the duration.
- **Every sign-in, PIN unlock, mid-sale manager approval and recovery-code check** pays 1–3 s
  (`authService.js:245`, `:283`, `:330`).
- **All of it blocks the Electron main process.** `main.js:10` starts Express in-process, so the
  window, IPC and every other request stall behind the hash.

**The fix is native `bcrypt` at the same cost 12, not a lower cost.** `SEC-1` requires ≥ 12 and
`TC-UT-01` asserts both that the production cost is ≥ 12 and that `workFactor()` refuses to lower
it outside a test run. Both stay exactly as they are. This is a dependency change that makes the
code meet its own documented budget — there is no security trade-off in it, and any proposal that
lowers `BCRYPT_COST` should be refused on sight.

**Its real cost is the build, and that is where the work is.** A native module must be rebuilt
for Electron's ABI and cross-compiled for the Android build. The pattern already exists —
`src/config/sqlite.js:30-33` carries a `nativeBinding` hook for `better-sqlite3` — so this follows
a road already built, but it is the reason this fault is not a one-line fix.

**Independently and immediately:** `DUMMY_HASH` becomes lazily computed on first use. It costs
nothing, changes no behaviour, and takes ~1.3 s off every cold start regardless of which bcrypt
wins.

### 2. Fifty-seven modules and 715 KB of JavaScript to draw a login box

`public/js/shell/app.js:14-51` statically imports **all 44 screen modules** — the POS view
(58 KB), the product editor (43 KB), reports, batches, recall, every admin tab — so the browser
fetches and parses the entire application before a cashier can type a username.

| | |
| :--- | ---: |
| JS modules in the static graph | **57** |
| JS bytes, unminified | **714,855** |
| Render-blocking stylesheets (`public/index.html:19-29`) | **11** (152 KB) |
| Requests before the sign-in screen | **68** |

There is no missing `defer` — the single `<script type="module">` at `index.html:40` is correct.
The cost is the import graph behind it.

`05_TECH_SPEC.md` §2 chose vanilla ES modules and no build step deliberately, and that decision is
not overturned here: **`import()` is vanilla ES modules.** Converting the 44 screen imports to
dynamic `import()` inside `show()` (`app.js:352-381`) keeps the architecture and loads a screen
when somebody opens it. A bundle-and-minify step is a separate, larger question and belongs under
*Open*, not in this task.

### 3. Static assets are served with no cache headers and no compression

`src/app.js:143`:

```js
app.use(express.static(PUBLIC_DIR));
```

No `maxAge`, no `immutable`, and no `compression` middleware anywhere — `package.json` carries
four dependencies and none of them is one. Every reload re-validates all 68 assets: 68 conditional
GETs and 68 `fs.stat` calls.

**The web build is worse.** `web/nginx-store-location.conf.template:38` proxies everything —
including all 715 KB of JavaScript — to Node, and neither `web/nginx-shared.conf` nor
`web/nginx-proxy.snippet` enables `gzip` or `expires`. `TASK-062`'s hosted stores pay this on
every page load, over the internet.

### 4. The counter search fires one request per keystroke

`public/js/pos/view.js:1282-1285` binds `input` straight to `lookup()` with no debounce and no
sequence guard. Typing *paracetamol* is ten HTTP requests, each paying §5's per-request overhead,
and the responses may arrive out of order.

**Every other screen already does this correctly** — `customers/list.js:75`, `catalogue/list.js:153`,
`purchasing/orders.js:81`, `purchasing/suppliers.js:76`, `catalogue/prices.js:161`,
`shell/picker.js:177`, all at 120 ms. `SCR-301` is the one screen that does not, and it is the
screen a cashier uses all day. `NFR_1.2` governs it.

### 5. Work repeated on every API request

| Where | What |
| :--- | :--- |
| `src/services/setupService.js:52` | `isComplete()` runs **two uncached `COUNT` queries** on every request, forever, to answer a question that changes once in the life of an installation |
| `src/middleware/sync.js:32,46` | `syncService.isDevice()` twice per request, uncached |
| `src/middleware/auth.js:64,67` | a JWT verify **and a fresh JWT sign** on every authenticated reply |
| 347 sites across `src/repositories` and `src/services` | `db.get().prepare(sql).…` — **every query re-parses its SQL**. `productRepository.js` alone has 34. A grep for `cachedStatement` or `stmtCache` returns nothing |

Individually small; paid five to ten times per screen, on the same thread that owns the window.

### 6. Screens re-fetch reference data on every visit

`public/js/shell/api.js` has no caching layer — `get`/`post` are bare `fetch` — and `host()`
(`app.js:196`) clears the DOM on each `show()`, so every screen remounts from nothing:

- **Products** fetches `/categories` *serially before* the product list, every visit
  (`catalogue/list.js:39-41`).
- **POS** makes roughly five sequential round trips per entry — `/shifts/current`,
  `/sales/pricing-policy`, `/quick-keys`, `/open-orders`, `/carts/active` — each paying §5, and on
  an empty store each returning nothing.

### 7. `GET /licence` writes twice on a read path

`src/services/licenceService.js:71-74` calls `licenceRepository.ensure()` (an upsert) and then
updates `max_seen_at` on **every** call, plus a `crypto.randomUUID()` and an ed25519 verify. The
dashboard calls it on every mount.

## What was ruled out

Worth recording, so nobody re-investigates them:

- **SQLite configuration is correct.** `src/config/database.js:15-20` — WAL, `synchronous=NORMAL`,
  `foreign_keys=ON`, `busy_timeout=5000`, one shared memoised connection. `cache_size`,
  `mmap_size` and `temp_store` are unset, which matters at scale and not on an empty store.
- **Migrations do not run at startup unless pending** (`upgradeService.js:71-101`), and
  `PRAGMA integrity_check` is **not** run at launch — only in backup verification.
- **The licence server is not on any request path.** `renewIfDue()` is rate-limited to once per
  12 h and returns without awaiting. *But* `REQUEST_TIMEOUT_MS = 15000` (`licenceService.js:40`)
  will make the three explicit licence buttons feel dead on an offline machine — a separate,
  smaller fault worth fixing while here.
- **No timer explains idle lag on a standalone install.** The only always-on one is
  `scheduleService.js:92` at 60 s, doing a handful of indexed reads. The 15 s sync client and the
  20 s shell poll are `DEVICE`-only; `main.js` has no timers at all.
- **CSS is not a suspect** — one `backdrop-filter`, one keyframe animation, no infinite animations.

## The work, in order

| # | Change | Where | Risk | |
| :-: | :--- | :--- | :--- | :-- |
| 1 | `DUMMY_HASH` computed lazily, not at module load | `src/services/authService.js` | none | **✅ built** |
| 2 | Cache headers on static assets; `gzip` in nginx for the hosted build | `src/app.js`, `web/nginx-shared.conf` | low | **✅ built** |
| 3 | Debounce the counter search to 120 ms with a sequence guard | `public/js/pos/view.js` | low | **✅ built** |
| 4 | Memoise `isComplete()` against the database generation | `src/services/setupService.js`, `src/config/database.js` | low | **✅ built** |
| 5 | `ensure()` once per connection; throttle the `max_seen_at` write | `src/services/licenceService.js` | low | **✅ built** |
| 6 | The 44 screen imports become dynamic `import()` inside `show()` | `public/js/shell/app.js:14-51`, `:352-381` | medium — mechanical, but touches every screen's entry |
| 7 | Hoist prepared statements to module-level lazily-built maps | 347 sites; start with `productRepository`, `settingsRepository` | medium — large diff, no behaviour change |
| 8 | Native `bcrypt` at cost 12, rebuilt for Electron and Android | `src/services/authService.js:12`, `package.json`, the Android build | **high — the build, not the code** |
| 9 | Move the server into a `utilityProcess` so DB and hashing never block the window | `main.js:81`, `src/server.js` | **high — architectural** |
| 10 | A client cache for `/categories`, `/settings`, `/sales/pricing-policy`, `/store-profile` | `public/js/shell/api.js` | medium |

**1–5 are a sitting afternoon and are worth doing whatever happens to the rest.** 8 and 9 are the
two that make the application feel like a different program, and both are build or architecture
work rather than code.

## The test gap, which is the reason this was not caught

`07_TEST_PLAN.md` §6 is right that a figure from a build machine is not a result, and every case
in `src/tests/perf/` asserts only a 4–10× ceiling for that reason. That is sound. What is missing
is different in kind:

- **No boot-cost case at all.** No assertion on asset bytes, request count, or time-to-sign-in.
- **No empty-database case.** All four perf files seed to `NFR_2.1` scale.

A new `src/tests/perf/boot.test.js` should assert, on an **empty** database, things that are
machine-independent and therefore *can* be asserted rather than merely reported: the number of
modules in the static import graph, total bytes served before the sign-in screen, the request
count for a cold load, and the number of SQL statements executed per API request. **None of those
is a stopwatch figure**, so §6's objection does not apply to them, and each one fails loudly the
day somebody adds a forty-fifth static import.

## Acceptance criteria

- [ ] `NFR_1.4`'s 8 s start-up budget is met on `NFR_4.1`'s reference machine with an **empty** database
- [ ] No bcrypt hash is computed at module load
- [ ] `BCRYPT_COST` is still ≥ 12 and `TC-UT-01` still passes unchanged
- [ ] A sign-in on the reference machine completes within 500 ms of hashing
- [ ] The sign-in screen is interactive after fewer than 15 requests and under 150 KB
- [ ] Static assets are served compressed and with cache headers, by Express and by nginx
- [ ] Typing ten characters into the counter search issues at most two requests, and a late response never overwrites a newer one
- [ ] `setupService.isComplete()` issues no query on a warm request
- [ ] `boot.test.js` exists, runs against an empty database, and fails if a screen module is statically imported into `app.js`
- [ ] No behaviour changes: the full unit, integration and e2e suites pass unchanged

## Tests

| Where | What |
| :--- | :--- |
| `src/tests/perf/boot.test.js` (new) | the static import graph, bytes before sign-in, cold-load request count, SQL statements per API request — all on an empty database, all machine-independent |
| `src/tests/perf/startup.test.js` | a second case at empty-database scale beside the existing seeded one |
| `src/tests/unit/auth.test.js` | `TC-UT-01` unchanged; a new case asserting no hash is computed at `require` time |
| `src/tests/unit/renderer.test.js` | the counter search debounces and guards sequence, like every other screen |
| `docs/UAT_RECORD.md` | start-up, sign-in and a first sale timed on the store's own machine — the only figures §6 accepts |

## Open

1. **A bundle-and-minify step.** 715 KB unminified is perhaps 200 KB minified and 60 KB gzipped.
   It would overturn `05_TECH_SPEC.md` §2's no-build-step decision, which was taken for good
   reasons (a readable deployed tree, no toolchain on the store's machine). Dynamic `import()`
   plus compression may make it unnecessary; measure before deciding.
2. **The 15 s licence request timeout** makes Link, Activate and Renew feel dead on an offline
   machine. A shorter timeout with a clear "no internet" message is a small, separate fix.
3. **`cache_size`, `mmap_size`, `temp_store=MEMORY`.** Worth setting, but they matter at
   `NFR_2.1` scale and this task is about the empty store.
4. **Which of 8 and 9 comes first.** The `utilityProcess` move makes the bcrypt cost invisible
   rather than absent; native bcrypt makes it small but still on the main thread. Doing both is
   right; doing 9 first may make 8 feel unnecessary, which would be the wrong conclusion to draw
   on a machine four times faster than the store's.

---

*Chachi's Software Development Service · DTI BN 8089738 · BIR OCN 111RC20260000002455 · TIN 752-951-092-00000*
