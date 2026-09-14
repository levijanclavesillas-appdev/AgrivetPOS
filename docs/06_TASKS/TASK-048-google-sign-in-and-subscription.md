# TASK-048 — Google sign-in and a subscription checked online once a month

**Priority:** **P2**, a commercial decision rather than a store's need · **Blocks release:**
no · **Blocked by:** decisions `L-3`–`L-6` below, a licence server that does not exist yet, and
a Google Cloud OAuth client · **Requirement:** amends `NFR_3.1`, `SEC-8`, `SEC-10`, `TC-E2E-08`

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
embedded browser (`disallowed_useragent`). A desktop app uses the installed-app flow: open the
system browser, receive the code on a `127.0.0.1` loopback port, and exchange it with PKCE. That
fits `SEC-8`, which binds to loopback anyway.

**Google is the owner's subscription identity, not the counter login.** Cashiers keep their
local username, password and PIN (`SEC-1`–`SEC-5`). A cashier without a Google account, on a day
with no internet, must still be able to open a shift.

## Proposed design (for the decisions below to confirm or change)

1. **Licence server** (new, hosted by Chachi's Software Development Service; not in this repo).
   It keeps store → subscription → paid-until. It signs a licence with an **Ed25519** private key
   that never leaves the server.
2. **Licence** = `{ store_id, installation_id, google_sub, email, plan, paid_until,
   checked_at, valid_until }`, signed. `valid_until` = `checked_at` + 30 days. The application
   ships the **public** key and verifies the signature offline.
3. **Activation**: the owner presses *Sign in with Google*; the system browser opens; the
   loopback callback gets the code; the app exchanges it (PKCE) and sends the Google ID token to
   the licence server, which returns a licence. It is stored in `settings`, audited.
4. **Renewal**: whenever the internet happens to be there, at most daily, the app renews
   silently. From day 23 without a renewal the dashboard warns; from day 30 the grace period
   `L-3` starts; after grace, the lapse behaviour `L-2` applies.
5. **What leaves the machine**: the Google ID token, the store id and an installation id.
   **No customer, sale or stock data**, so `SEC-10` holds as written.
6. **Clock tampering**: a licence also records the highest `occurred_at` the ledger had at
   check time. A clock set backwards below that is detected, because the ledger is append-only.

## Decisions

| # | Question | Answer |
| :-: | :--- | :--- |
| `L-1` | Does only the **owner** sign in with Google, or every user? | **Owner only** (client, 2026-09-14). Google activates and renews the store's subscription; every user, the owner included, still signs in to the till with their local username, password or PIN |
| `L-2` | What does a **lapsed** licence do? | **Read-only from the next shift open** (client, 2026-09-14). A sale in progress and a shift already open are never interrupted. From the next shift open: reports, export, backup and restore still work, and no new sale, return or collection can be recorded |

Still to decide:

| # | Question | Why it matters |
| :-: | :--- | :--- |
| `L-3` | Grace period after 30 days offline | Recommended: 7 days, warned daily |
| `L-4` | How is the subscription **paid**: PayMongo, Xendit, GCash manual, bank transfer? | Decides what the licence server integrates with, and who marks a store paid |
| `L-5` | Where is the licence server hosted, and who runs it? | It is a second product with its own uptime, backups and security |
| `L-6` | One licence per **machine** or per **store**? | Decides whether a reinstall or a second till needs a new activation |

## Requirements (once decided)

1. `NFR_3.1` is amended to: every core operation works with no internet **for the licence's
   validity plus grace**. `TC-E2E-08` becomes: the application reaches the network only for
   the licence endpoint and Google's OAuth endpoints, and only during activation or renewal.
2. Signature verification is offline, with the public key compiled in.
3. Activation, renewal, lapse and reinstatement are audited (`AUD-6xx`).
4. A lapse never loses data and never blocks a backup, an export or a restore.

## Tests (to be numbered when started)

Licence verification (valid, expired, tampered, wrong key, clock rolled back); the loopback
OAuth flow against a stub; lapse at shift open but not mid-shift; `TC-E2E-08` rewritten to
allow only the named endpoints.

**Status — 2026-09-14:** **not started.** `L-1` and `L-2` are answered; `L-3`–`L-6` and the
licence server are what stand between this and code.
