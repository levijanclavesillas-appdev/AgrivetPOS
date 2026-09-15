# Chachi POS licence server — pos.chachisoftware.store

**TASK-048.** The one online piece of Chachi Pharmacy POS. It knows which stores exist, who owns
each, what each has paid until, and which devices belong to it, and it signs the licences the POS
checks offline. The POS works for 30 days between checks, plus 7 days' grace.

| Path | Who | What |
| :--- | :--- | :--- |
| `/`, `/privacy` | the public | The site that introduces Chachi POS, and the privacy notice. Static files in `site/`, no script |
| `/link` | a store owner | Enter the code the POS shows, sign in with Google, approve the device |
| `/admin` | Chachi's | Stores, devices, the date each is paid to; record a manual payment (GCash, bank transfer); remove a device |
| `POST /api/v1/device/start`, `/device/poll` | the POS | The device link |
| `POST /api/v1/licence/renew` | the POS | The silent check, with the device's renewal secret |
| `POST /api/v1/play/purchase` | the Android app | A Google Play subscription, verified with Google before it counts |
| `GET /api/v1/public-key` | the build | The key the POS verifies licences with |

## The public site

`site/index.html` and `site/privacy.html`, with their stylesheet, fonts, icons and images under
`site/static/` (served at `/static/`, cached for a day; the pages themselves are revalidated on every
visit). Plain HTML under the same CSP as every other page here, so no inline style, no script and
nothing from another host: the fonts (Inter, Plus Jakarta Sans — OFL) and the Lucide icon sprite
(ISC) are vendored. The screenshots are of the real Pharmacy edition with an invented demo store.

The privacy notice describes exactly what `src/db.js` stores; **change it when that changes.** Google's
OAuth consent screen takes `https://pos.chachisoftware.store/` as the home page and
`https://pos.chachisoftware.store/privacy` as the privacy policy.

After editing anything in `site/`, rebuild the container (`docker compose up -d --build`): the files
are copied into the image, not mounted. `npm test` fails if a page names a `/static/` file that is
not there.

## How a store gets a licence

1. On the POS, the owner opens **Admin → Subscription → Link this POS**. The POS shows a code.
2. The owner opens `pos.chachisoftware.store/link` (the POS has a button for it, or any phone
   works), signs in with the Google account that owns the store, and approves the device. A new
   store starts on the trial (`TRIAL_DAYS`, 14 by default).
3. The POS collects its licence and a renewal secret. From then on it renews silently, at most every
   12 hours, whenever it has the internet. Nobody signs in with Google again.
4. Payment extends `paid_until`: a Google Play subscription on Android, verified with Google, or a
   manual payment recorded on `/admin`.

## Configuration (environment)

| Variable | Default | |
| :--- | :--- | :--- |
| `HOST`, `PORT` | `127.0.0.1`, `8790` | The container sets `HOST=0.0.0.0` and publishes the port on the host's loopback only |
| `BASE_URL` | `http://127.0.0.1:8790` | `https://pos.chachisoftware.store` in production |
| `BEHIND_PROXY` | — | `1` behind nginx |
| `LICENCE_DATA_DIR` | `./data` | The database **and the signing key**. Back it up; losing the key means rebuilding every POS |
| `TRIAL_DAYS` | `14` | A new store's trial |
| `VALIDITY_DAYS`, `GRACE_DAYS`, `WARNING_DAYS` | `30`, `7`, `7` | TASK-048's L-3 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | — | A **Web** OAuth client; redirect URI `https://pos.chachisoftware.store/auth/google/callback` |
| `PLAY_SERVICE_ACCOUNT_FILE` | — | Service-account JSON with access to the Play Developer API |
| `PLAY_PACKAGE_NAME`, `PLAY_PRODUCTS` | `store.chachisoftware.pos`, `pos_monthly` | The app and its subscription product id(s) |
| `ADMIN_PASSWORD_HASH` | — | `node src/tools/hash-password.js`, then paste the hash |

Until Google is configured, `/link` says sign-in is not set up. Until Play is configured,
`/api/v1/play/purchase` answers 503. Until the admin hash is set, `/admin` cannot be signed into.
Nothing else waits on them.

## Deploying on this server

**Deployed 2026-09-14** as the Docker Compose project `chachi-licence`, like the other apps on
this host: the container publishes `127.0.0.1:8790` only, and the host's nginx terminates HTTPS
(Certbot) for `pos.chachisoftware.store` and proxies to it.

| What | Where |
| :--- | :--- |
| Container | `chachi-licence` (`docker compose` in this folder; `restart: unless-stopped`, health-checked) |
| Secrets | `licence-server/.env.production`, mode 600, git-ignored |
| Admin password (plain text, for the owner) | `/root/.config/chachi-licence/admin-password`, mode 600 |
| Database and signing key — **back this up** | `/var/lib/chachi-licence` (owned by uid 1000, the container's `node` user) |
| nginx site | `/etc/nginx/sites-available/pos.chachisoftware.store.conf`, certificate by Certbot |

```sh
cd /root/AdWebsite/AgrivetPOS/licence-server
docker compose up -d --build          # after a code change, or after editing .env.production
docker compose logs -f                # the first line says what is configured
node src/tools/hash-password.js       # a new admin password's hash, for ADMIN_PASSWORD_HASH
```

In `.env.production`, quote the bcrypt hash in single quotes, or Compose reads its `$` signs as
variables. A Play service-account file goes in `/var/lib/chachi-licence/` and is named as
`PLAY_SERVICE_ACCOUNT_FILE=/data/<file>.json`.

For a first install elsewhere: create the data folder owned by uid 1000, write
`.env.production`, `docker compose up -d --build`, then add an nginx site (a copy of this host's
`pos.chachisoftware.store.conf` without its Certbot lines) and run `certbot --nginx -d <host>`.

**The POS side.** `src/config/licence.js` names this server and carries the output of
`GET /api/v1/public-key` (since 2026-09-14). **The signing key and that constant change together
or not at all**: a new key on the server makes every licence it signs invalid on every POS
until a build carries the new public key. The gate runs with `AGRIVET_LICENSING=off`, except
`TC-E2E-08`, which signs its own licence.

## Tests

`npm test` here: the device link end to end, one-time pickup, code expiry, renewal and removal,
manual and Play payments, admin sign-in and CSRF, page security headers, and Google ID-token
verification (signature, issuer, audience, expiry, nonce). The POS's own
`src/tests/integration/licence.test.js` runs this server in-process and drives it from the POS.
