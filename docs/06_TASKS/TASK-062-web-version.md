# TASK-062 — The web version

**Priority:** **P1** · **Rules:** `SEC-8`, `SEC-3`, `SEC-9`, `OPS-001`, `INT-1`, `POS-208`, `TAX-006`, `AUD-601` · **Tests:** `hosted.test.js`, `renderer.test.js`

## What was wrong

The store owner asked for a web version, and the POS could not be put online as it was:

| # | Fault |
| :-: | :--- |
| 1 | **It answered only its own machine.** `SEC-8` binds `127.0.0.1`, which is right on a store PC and unreachable from anywhere else |
| 2 | **The first visitor became the owner.** The setup wizard is open until a store exists. On a PC that is the person installing it; on the internet it is whoever finds the address first |
| 3 | **Printing happened on the server.** USB and LAN printing send bytes from the machine the POS runs on, and the server is not in the store |
| 4 | **Backups went to a folder typed into the browser.** That folder was inside a container nobody can see, and there was no way to get a copy out |
| 5 | **Nothing to deploy with.** There was no image, no per-store configuration and no vhost |

## As built

**Hosted mode** (`src/config/hosting.js`, on when `AGRIVET_HOSTED=1`). On a store's PC none of
the following applies, and a test says so.

- **Listening.** The server listens on `0.0.0.0` inside the container. Compose publishes it on
  the host's `127.0.0.1` only, and nginx with TLS is the way in.
- **Setup code.** The wizard needs a one-time code (`AGRIVET_SETUP_CODE`), which Chachi's sends
  the owner with the address.
  - It is checked on `POST /setup`, on `POST /setup/restore` (in `X-Setup-Code`, before the
    upload is read), and on `POST /setup/code` when the owner leaves step 1.
  - The comparison is constant-time, and case, spaces and dashes are forgiven.
  - Five wrong codes in fifteen minutes pause it (423).
  - Without a configured code, a hosted wizard refuses outright.
- **Backups.** They go to `AGRIVET_BACKUP_DIR` (`/backups`, its own volume, `OPS-001`). The
  wizard shows that instead of asking, and Settings refuses another folder. The
  overdue-backup warning says to download a copy, not to use a USB stick.
- **Printing.** The printer defaults to `BROWSER`.

**`BROWSER` printing**, an option for every edition.

- **What it does.** `printService` does not send bytes, and `outcome()` returns the document's
  text. `api.js` prints any response whose `printed` is `BROWSER` in one place, through
  `shell/print.js`: a `#print-sheet` holding the same monospaced record the ESC/POS printer
  receives, and the browser's print dialog. `css/print.css` hides everything else in print.
- **What it covers.** Receipts, reprints (still stamped REPRINT, `POS-208`), collection and
  return acknowledgements, statements, closing summaries and the test page all go this way.
- **The cash drawer.** A pulse refuses with "open it with its key".
- **On a PC.** A PC whose receipt printer has a Windows driver can use it too.

**Backup downloads.** `GET /backups/:id/download` (`TX-427`, owner) streams a verified backup
and is audited `BACKUP_DOWNLOADED`. It appears as **Download** on the Backups tab, in every
edition.

**Headers.** Every response carries `X-Frame-Options: DENY`,
`Content-Security-Policy: frame-ancestors 'none'`, `nosniff` and `Referrer-Policy: no-referrer`.
The wizard page now has the same `<meta>` CSP as the shell.

**Deployment** (`web/`):

- **Image.** `Dockerfile` (Node 20, production dependencies only, non-root, healthcheck).
  `.dockerignore` keeps the image to `package*.json`, `src` and `public`.
- **One store.** `compose.yml` runs a store as a container on `127.0.0.1:<port>`, with `data`
  and `backups` volumes.
- **nginx.** `nginx-store.conf.template` is one store's vhost:
  - sign-in and the setup code are rate-limited per address;
  - restore uploads are streamed at up to 600 MB;
  - anything else is limited to 80 MB.

  `nginx-shared.conf` holds the rate-limit zone and `nginx-proxy.snippet` the shared proxy
  lines. Both were checked with `nginx -t` on the server.
- **Operation.** `store.sh` has `build`, `create <store>`, `nginx <store>`, `list`,
  `code <store>`, `upgrade` and `logs`. It writes a vhost only once the store's name
  resolves to the server, and rolls it back if `nginx -t` refuses it. There is no remove
  command, because removing deletes a business's records.
- **Docs.** `DEPLOYMENT.md` §11, the tech spec's `SEC-8` row and the new routes.

## Tests

`hosted.test.js` starts the real server the way the container does:

- the headers;
- the wizard page's CSP;
- setup refused without the code, and the restore refused before its upload;
- a wrong code, a forgiving right one, and five wrong codes locking even the right one;
- setup with the code: backups go to the volume, not the typed folder, and the printer is
  `BROWSER`;
- Settings refusing another backup folder;
- a sale's response carrying the receipt text, with the store name and `TAX-006`'s line;
- a reprint's text stamped REPRINT;
- the owner downloading the exact backup file, a manager refused, and the download audited;
- none of this on a PC.

`renderer.test.js` checks the single print hook, the print CSS and the wizard's code field and
header.

Built the image and walked the real container in Chromium (the harness) on
`127.0.0.1:47937`:

- **Wizard.** It showed the setup code field first, refused a wrong code in step 1, and
  accepted `test code 2026 web1`. The backup step was read-only on `/backups`.
- **Sale.** The rest of setup completed, and a sale came back as "Receipt sent to this device's
  print dialog". The dialog received the receipt with the store's name, total and "This is not
  an official receipt". Rendered in print media, the page held only the receipt.
- **Backups.** Back up now worked. The row offered Restore… and Download, and the warning spoke
  of Chachi's server.
- **Licence server.** The container reached `https://pos.chachisoftware.store` for the
  subscription.

Then `web/store.sh create demo` made a real store on the server: healthy, hosted, on
`127.0.0.1:8801`. It is **not on the internet yet**: `demo.pos.chachisoftware.store` has no DNS
record, so the script left nginx alone and said which record to add.

## Left to do

- **DNS.** Add one wildcard record, `*.pos.chachisoftware.store` A `165.22.246.45`, then run
  `web/store.sh nginx demo`, which writes the vhost and gets the certificate.
- **Public site.** It still says "Web browser — coming soon". Change it once a store is live.
- **Server backups.** Copy `/var/lib/chachi-pos` off the server (a snapshot or off-site sync).
