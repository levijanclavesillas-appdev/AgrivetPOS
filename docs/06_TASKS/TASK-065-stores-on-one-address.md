# TASK-065 — Web stores at pos.chachisoftware.store/s/&lt;store&gt;/

**Priority:** **P1** · **Rules:** `SEC-7`, `SEC-8`, `SYNC-001` · **Tests:** `renderer.test.js`, `sync-url.test.js`, `licence-server/test/server.test.js` (TASK-065)

## The ask

Namecheap's DNS does not accept `*.pos`, so per-store subdomains would need a DNS record
for each store. The store owner (2026-09-16): "since we have a login as Google SSO, can we
just use pos.chachisoftware.store?", and then "build it with paths on pos.chachisoftware.store".

## As built

- **Addresses.** Every web store is at `https://pos.chachisoftware.store/s/<store>/`, on the
  licence site's host and certificate. A new store needs no DNS record and no certificate, and
  is on the internet the moment `web/store.sh create` finishes.
- **The POS works under any prefix.** Every page, script and sheet uses relative addresses:
  `api/v1`, `css/…`, `js/…`, `./`, and the `/index.html` redirect. A test fails on any absolute
  path. A PC or tablet still runs it at `/`, unchanged.
- **Device addresses keep their path.** `syncClient.normaliseHubUrl` keeps it however it was
  typed, so a device connects to `pos.chachisoftware.store/s/<store>`. The hub's "Connect a
  phone or PC" instructions show the store's own address.
- **The owner's front door.** `pos.chachisoftware.store/stores` asks for Google sign-in, the same
  Google account that links the subscription, and lists the owner's stores. Each web copy has
  **Open on the web**.
  - A web copy sends its address (`AGRIVET_PUBLIC_URL`) when its subscription is linked.
  - The licence server keeps it only if it is one of its own `/s/<store>` paths, so "Your
    stores" never links elsewhere.
  - Staff don't use Google; they open the store's address and sign in with their POS login.
  - The site menus have "Your stores". The web card now reads "Available", and the privacy
    notice names the stored address.
- **Keeping the licence site and the stores apart on one host.**
  - Each store's nginx location strips its prefix and every `Cookie` header, so a store never
    sees the licence site's sign-in.
  - The licence sign-in cookies are set only for the pages that read them (`/link`, `/stores`,
    `/logout`; `/admin`), and any old whole-site copy is cleared.
  - Those pages answer only a page load or a form: a browser request marked `Sec-Fetch-Site`
    with a mode other than `navigate` is refused.
  - A store's pages allow only their own scripts, and a store's sign-in is a token in page
    memory, valid for that store alone.
- **nginx.** `web/nginx-store-location.conf.template` is one store's location: the prefix
  redirect, sign-in rate-limited, restore uploads streamed at up to 600 MB, anything else at up
  to 80 MB. `store.sh` adds `include /etc/nginx/chachi-pos-stores/*.conf;` to the site once,
  keeping the previous file. It writes each store's file, checks `nginx -t` (putting the old
  file back if refused) and reloads.
- **Docker networks.** Creating a second store failed with "all predefined address pools have
  been fully subnetted": this server runs many compose projects, and each wants a network.
  Store containers now use Docker's default bridge (`network_mode: bridge`). The demo store was
  moved onto it, and its old network was freed.

## Tests

- `renderer.test.js`: no absolute path anywhere in `public/`; the wizard and shell assertions now
  expect relative paths.
- `sync-url.test.js`: a store address keeps its path however it was typed, plain http is allowed
  only to this machine, and an empty address is refused.
- `licence-server` (14 pass):
  - `/stores` offers Google when signed out;
  - sign-in returns there, with the owner cookie set only for `/link`, `/stores` and `/logout`,
    and the whole-site copy cleared;
  - a linked web copy is listed with Open on the web;
  - an address outside `/s/` is not kept;
  - `/stores`, `/link`, `/admin`, `/admin/login` and `/logout` refuse a browser script's fetch,
    and open as a page;
  - the API and public pages answer as before.

Deployed and checked over HTTPS on the server:

- `/s/demo` redirects to `/s/demo/`, which serves the wizard with its CSS and scripts. Its API
  answers, `/index.html` redirects within the store, and an unknown store is a 404. The licence
  site (`/`, `/guide`, `/link`, `/stores`, `/api/v1/health`) is unchanged.
- A throwaway store `pathtest` went through the whole path, then was removed completely
  (container, nginx file and data):
  1. `store.sh create` put it on the internet with no DNS step.
  2. It was set up with its code, and stocked.
  3. A device on this machine connected by typing `pos.chachisoftware.store/s/pathtest/`.
  4. The device sold `SALE-A-20260916-000001` and synced with nothing pending.
  5. The web copy showed the sale, stock 47 of 50, and the device "Path phone (A)".
  6. In a real browser at that address, the owner signed in and *Web & devices* listed the
     device.
