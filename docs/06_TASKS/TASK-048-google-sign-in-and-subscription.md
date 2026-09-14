# TASK-048 — Google sign-in and a subscription checked online once a month

**Priority:** **P2**, a commercial decision rather than a store's need · **Blocks release:**
no · **Decided:** `L-1`–`L-6` (client, 2026-09-14) · **Status:** built; the licence server is deployed ·
**Going live waits on:** the prerequisites the owner provides (below) · **Rules:**
`LIC-001`–`LIC-004` · **Requirement:** amends `NFR_3.1`, `TC-E2E-08`

---

## Objective

Sell the product as a subscription. The owner signs in with a Google account, and the
installation proves its subscription is paid by reaching a licence server **at least once a
month**. The counter keeps working offline between checks.

## Context

The client asked:

> we need to set up google sso for subscription based system even if the system works
> online, it will require online login atleast once a month to check subscription?

**Yes, and the shape of it matters more than the sign-in button.** This product was designed to
never need the internet. `NFR_3.1` puts "core operations available with no internet" at 100%,
`TC-E2E-08` asserts the application reaches for no network, and `05_TECH_SPEC.md` §2 says every
dependency must survive being offline forever. A monthly check is compatible with all of that
**only if** it is designed as a signed licence that lives on the machine and is renewed, not as
a login that has to succeed before a sale.

**Google sign-in cannot happen inside the Electron window.** Google refuses OAuth in an
embedded browser (`disallowed_useragent`), and neither can it inside the Android WebView. The
proposal was the installed-app loopback flow; the build signs in on a web page instead, which
works the same on both (*As built*, below).

**Google is the owner's subscription identity, not the counter login.** Cashiers keep their
local username, password and PIN (`SEC-1`–`SEC-5`). A cashier without a Google account, on a day
with no internet, must still be able to open a shift.

## Decisions

| # | Question | Answer |
| :-: | :--- | :--- |
| `L-1` | Does only the **owner** sign in with Google, or every user? | **Owner only** (client, 2026-09-14). Google activates and renews the store's subscription; every user, the owner included, still signs in to the till with their local username, password or PIN |
| `L-2` | What does a **lapsed** licence do? | **Read-only from the next shift open** (client, 2026-09-14). A sale in progress and a shift already open are never interrupted. From the next shift open: reports, export, backup and restore still work, and no new sale, return or collection can be recorded |
| `L-3` | Grace period after 30 days offline | **7 days**, warned daily from day 23. Read-only from the next shift open after day 37 |
| `L-4` | How is the subscription paid? | **Google Play Store subscriptions** (Android, Play Billing) **and manual payment** (GCash, bank transfer), marked paid on an **admin page at `pos.chachisoftware.store`** |
| `L-5` | Where does the licence server run? | **On this server**, served at `pos.chachisoftware.store` |
| `L-6` | One licence per machine or per store? | **Per store.** A reinstall or a replacement device re-activates under the same subscription |

## As built

**The design changed in one place, and the change is the point of the build.** The proposal
opened Google's sign-in in the system browser and caught the answer on a `127.0.0.1` loopback
port. That works on Windows and not cleanly on Android, it puts a Google client on every
machine, and the POS would hold a Google token. The build uses a **device link** instead, the
shape a TV uses to sign in (OAuth's device grant):

1. **Admin → Subscription → Link this POS** (`SCR-707`, owner only). The POS asks the licence
   server for a code and shows it, `XXXX-XXXX`, good for 15 minutes.
2. The owner opens `pos.chachisoftware.store/link` — the button opens it in the machine's own
   browser (Electron hands `window.open` to the OS; Android has an `openExternal` bridge that
   accepts `https://` only), or they type it on their phone. They sign in with Google there
   (web auth code + PKCE; the ID token's signature, issuer, audience, expiry, nonce and
   verified e-mail are checked against Google's keys), pick the store or name a new one, and
   approve.
3. The POS, polling every 5 seconds, collects a **signed licence** and a **renewal secret**,
   once. From then on it renews with the secret, silently, at most every 12 hours when the
   internet is there. **Google never sees the POS, and the POS never holds a Google token.**

| Piece | Where |
| :--- | :--- |
| **Licence server** — its own small Express app, in this repository so the POS tests can run it | `licence-server/` (README there: configuration, deployment on this host, tests) |
| Owner pages: `/link`, Google sign-in, approve/deny | `licence-server/src/app.js`, `pages.js`, `google.js` |
| **Admin page** (`L-4`): stores, devices, paid-until; record a manual payment (1–36 months, extends from the later of today and the paid-until); remove a device. bcrypt password, CSRF on every form, no script on any page | `/admin` |
| Google Play: a purchase token is verified with the Play Developer API (`subscriptionsv2`) before it counts, and never shortens a paid-until | `POST /api/v1/play/purchase`, `play.js` |
| **Licence**: `CPL1.<payload>.<Ed25519 signature>`; payload `store_id, store_name, installation_id, owner_email, plan, paid_until, checked_at, valid_until, grace_days, warning_days` | `licence-server/src/licence.js`; verified offline in `src/services/licenceService.js` |
| POS state, one row | `901_licence.sql` (`licence_state`) |
| POS API: `GET /licence`, `POST /licence/link`, `/licence/link/poll`, `/licence/renew` | `src/routes/licence.js` |
| Screen `SCR-707` Subscription, and a line on the dashboard when there is something to say | `public/js/admin/licence.js` |

**Rules.**

| ID | Rule |
| :--- | :--- |
| `LIC-001` | **No new shift opens** on a POS that is not linked, or whose licence has lapsed. A shift already open is resumed and runs to its close. Every sale, return and collection needs an open shift (`POS-501`), so this *is* `L-2`'s "read-only from the next shift open": reports, export, backup and restore work throughout |
| `LIC-002` | The licence ends at the earlier of `paid_until` and `valid_until` (30 days after the last check). **Warning** for the last 7 days, **grace** for 7 days after, then **lapsed**. The windows come from the licence, so the server can change them without a POS release. A renewal that changes the paid-until is audited (`LICENCE_RENEWED`); one that changes nothing is not |
| `LIC-003` | A licence not signed by the build's key is no licence. The POS keeps the latest time it has seen (`max_seen_at`), so setting the clock back does not undo a lapse |
| `LIC-004` | Only the owner links the POS or asks for a check; any user can read the state. Linking is audited (`LICENCE_LINKED`) |

**Off until the build names a server.** `src/config/licence.js` holds `PRODUCTION_SERVER` and
`PRODUCTION_PUBLIC_KEY`, both empty. Until they are filled in (or `AGRIVET_LICENCE_SERVER` and
`AGRIVET_LICENCE_PUBLIC_KEY` are set), the POS enforces nothing and `SCR-707` says so. The test
suite and the browser smoke run with `AGRIVET_LICENSING=off`, so `TC-E2E-08` (no network)
stands as written for every build without a server.

**What leaves the machine:** the store name typed at linking, the app version, the installation
id and the renewal secret. **No customer, sale or stock data**, so `SEC-10` holds as written.

## Requirements, as amended

1. `NFR_3.1`: every core operation works with no internet **for the licence's validity plus
   grace** (30 + 7 days after the last check).
2. `TC-E2E-08`: a build with a licence server reaches the network only for that server, and
   only to link or renew. Google is reached by the owner's browser, never by the POS.
3. Signature verification is offline, with the public key compiled in.
4. A lapse never loses data and never blocks a backup, an export or a restore.

## Tests

- **Licence server** (`licence-server/test/server.test.js`, 10 cases, `npm test` there): the
  link end to end; refusal without a session or CSRF token; code expiry; one-time pickup;
  renewal, a wrong secret, a removed device; manual payment extension; Play not configured,
  and a Play purchase that would shorten; admin sign-in and the payment form; security headers
  and no script; Google ID-token verification.
- **POS** (`src/tests/integration/licence.test.js`, 9 cases, in the gate), against the real
  licence server in-process: `LIC-001` unlinked and lapsed; `LIC-004` a cashier cannot link;
  the link collected by the poll and audited; active → warning → grace → lapsed; the clock set
  back; an open shift resumed after the lapse while a new one is refused; a manual payment
  arriving with the next check; a forged licence; the server unreachable.
- Walked in the Electron window against a local licence server: the dashboard line, the code,
  the approve page, and `SCR-707` showing *Active, subscribed until …* after the 5-second poll.

## What the owner provides before it goes live

| Needed | Why | State |
| :--- | :--- | :--- |
| DNS for `pos.chachisoftware.store` | The licence server and the admin page answer there | **Done** — it resolves to this server |
| Deploying on this server | The licence server and the admin page | **Done** 2026-09-14 — Docker Compose project `chachi-licence` behind the host's nginx, HTTPS by Certbot (`licence-server/README.md`) |
| A Google Cloud **OAuth client of type Web application**, redirect URI `https://pos.chachisoftware.store/auth/google/callback` | Google sign-in on `/link`. One client serves Windows and Android, because the sign-in happens in a browser | **Done** 2026-09-14 — on the server, in `.env.production`; Google accepts the client and the redirect |
| A **Play Console** subscription product (`pos_monthly` unless named otherwise) and a service account with the Play Developer API | Play purchases verified with Google, never by trusting the phone | Waiting |
| The trial length | A new store's first days; 14 until the owner says otherwise (`TRIAL_DAYS`) | To confirm |

Google Play's policy requires Play Billing for a digital subscription bought inside an app
installed from Play. Manual payment is for stores on Windows or a sideloaded APK.

**Status — 2026-09-14:** **built, tested, and the licence server is live** at
`https://pos.chachisoftware.store` (Docker, behind nginx; the admin page signs in). The POS
builds do not use it yet. **Remaining:**

1. Fill `PRODUCTION_SERVER` (`https://pos.chachisoftware.store`) and `PRODUCTION_PUBLIC_KEY`
   (from `/api/v1/public-key`) in one commit — licensing starts with the builds from that
   commit. Google sign-in is configured, so a POS from that build can be linked.
2. If the Google consent screen is still in *Testing*, publish it, or only its listed test
   users can sign in on `/link`.
3. **Play Billing in the Android app** (the Play Billing library, a *Subscribe* button on
   `SCR-707`, posting the purchase token to `/api/v1/play/purchase`) — the server side is
   built; the app side needs the Play Console product first.
4. Play **real-time developer notifications**, so a cancellation or renewal on Play reaches the
   server before the POS next checks. Until then the server learns of a renewal when the app
   posts the new token.
