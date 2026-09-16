# TASK-067 — A one-time licence, and Chachi's admin setting a store's plan by hand

**Priority:** **P1**, a commercial decision: the owner is about to sell the software this way ·
**Blocks release:** no · **Rules:** `LIC-001`–`LIC-004`, `LIC-005`–`LIC-007` (new, `PHARMACY_EDITION.md` §6) ·
**Follows:** [TASK-048](TASK-048-google-sign-in-and-subscription.md) (the subscription) ·
**Tests:** `licence-server/test/server.test.js`, `src/tests/integration/licence.test.js`

---

## The ask

The store owner (2026-09-16):

> i plan to include a one time payment for the software not just subscription and admin could
> manually set a client to be of one time payment and also set the client to have paid already
> giving it access

So there are two ways to pay, and Chachi's admin can set either one by hand:

- **Subscription.** The store pays monthly, as now.
- **One-time payment.** The store pays once and keeps access for good.
- **Admin override.** On the admin page, the admin sets a store's plan and marks it paid. The
  store then has access at its next check, with no Google Play and no payment in the app.

## Before starting — 3 answers are needed

**1. Does a one-time store still check in online once a month?** Recommended: **yes.**

- **Why check.** A licence the server can never withdraw cannot be taken back after a refund, a
  chargeback or a copied installation. With the check, the admin can revoke a one-time store and
  its devices stop at the next check plus grace, just as a subscription does.
- **What the store feels.** Almost nothing: renewal is silent whenever the internet is there
  (TASK-048).
- **The alternative.** No check: the licence never ends once issued. Then `LIC-002`'s 30-day
  `valid_until` is lifted for this plan, and revoking only stops new devices from linking.

**2. What does "one-time" include?** Recommended: **the store's software for good, on every
device it links (`L-6`, per store), with updates.**

- **Other choices.** A device limit, or updates for a year only.
- **Why it matters.** Either choice needs a column and a rule this task does not otherwise have,
  so decide before building.

**3. Can the admin set a store up before its owner links it?** Recommended: **yes.**

- **Today.** A store exists on the licence server only after its owner approves a link with
  Google (TASK-048), and it starts on a 14-day trial. The admin can override it only after that.
- **What it would allow.** A client who paid in cash before installing is registered in advance
  under the owner's Google e-mail. The first link by that e-mail then uses the registered store,
  already paid, instead of creating a trial store.

## Objective

Chachi's admin can mark any store as **one-time paid** or **subscribed until a date**. The POS
honours that at its next check and says which plan the store is on.

## Context

- **What exists** (TASK-048, live at `pos.chachisoftware.store`):
  - **The store row.** `stores.plan` already exists, but it is always `'monthly'`.
    `stores.paid_until` is the only thing that grants access.
  - **The admin page.** `/admin/stores/:id` records a *manual payment* of 1–36 months
    (`service.recordPayment`), which only extends `paid_until`.
  - **The payments table.** `payments.method` is `MANUAL`, `PLAY` or `TRIAL`.
  - **The licence.** It carries `plan` and `paid_until`. The POS (`licenceService`) ends it at
    the earlier of `paid_until` and `valid_until`, and shows *Paid until …* on `SCR-707`.
- **What is missing:**
  - a plan other than monthly;
  - a way to grant access without saying how many months;
  - a way to take a plan back;
  - a way to register a store before it links.
- **Old POS builds must keep working.** A licence for a one-time store must still verify and
  count as paid on a POS built before this task. That holds if a one-time licence carries a
  far-future `paid_until`: the old build shows an odd date, and nothing breaks.

## Requirements

1. **Two plans.** A store's plan is `MONTHLY` or `ONE_TIME`.
   - **Existing stores.** `monthly` rows become `MONTHLY`.
   - **Trials.** A trial is a `MONTHLY` store whose `paid_until` came from a `TRIAL` payment, as
     now.
2. **Setting one-time paid.** On a store's admin page, **Set as one-time paid** takes an optional
   amount, reference and note, and a required confirmation.
   - **The store.** `plan = ONE_TIME` and `paid_until = 9999-12-31T00:00:00.000Z` (the
     "for good" date).
   - **The record.** One `payments` row with method `ONE_TIME` and the dates before and after.
3. **Setting paid until a date.** **Set paid until** takes a date and a required note.
   - **What it does.** It sets `plan = MONTHLY` and that `paid_until`, earlier or later than
     now. It is the override for a free month, a correction or a lapsed store.
   - **What it records.** A `payments` row with method `OVERRIDE`.
   - **Record a payment** (1–36 months) stays as it is, and on a `ONE_TIME` store it is refused.
4. **Taking back a one-time plan.** **Revoke one-time** needs a note. It sets the store back to
   `MONTHLY` with `paid_until` = now, and records an `OVERRIDE` payment.
   - **With the monthly check** (answer 1): every device lapses after its grace.
   - **Without it:** only new links are refused.
5. **Every change is recorded.** Each change on the admin page shows in the store's payment
   history: method, amount, reference, note, before, after, who and when. Nothing is edited in
   place.
6. **The stores list.** It shows each store's plan. For a one-time store, *Paid until* reads
   **One-time**.
7. **The POS.**
   - **`SCR-707`.** It reads *One-time licence: no subscription to renew* for `ONE_TIME`, and
     *Subscribed until …* as now for `MONTHLY`.
   - **Warnings.** The dashboard warns of an unpaid end only when one can come.
   - **Audit.** A change of plan at a check is audited like a paid-until change
     (`LICENCE_RENEWED`, with `plan` before and after).
8. **Answer 1: yes.** A one-time licence still ends at `valid_until` when the POS has not
   checked in for 30 days, plus 7 days' grace (`LIC-002`, unchanged).
9. **Answer 3: yes.**
   - **Registering.** **Add a store** on the admin page takes a store name, the owner's Google
     e-mail and a plan.
   - **Linking.** When that e-mail approves a link, the approval page offers the registered
     store first, and linking it creates no trial.
   - **An unused store.** A registered store no one has linked can be deleted.
10. **Google Play.** A Play purchase never shortens `paid_until` (as now) and never changes a
    `ONE_TIME` store.

## Business rules

The new rules go in `PHARMACY_EDITION.md` §6, beside `LIC-001`–`LIC-004`:

| ID | Rule |
| :--- | :--- |
| `LIC-005` | A store is on one plan, `MONTHLY` or `ONE_TIME`. A `ONE_TIME` store is paid for good, and no monthly payment or Play purchase changes it |
| `LIC-006` | Only Chachi's admin sets a plan, grants or takes access by hand. Each change needs a note and is kept in the store's payment history. A licence is never edited in place |
| `LIC-007` | A one-time licence is still renewed online at least every 30 days, and revoking it lapses every device after its grace (subject to answer 1) |

The existing rules still apply:

- `LIC-001`: no new shift without a valid licence.
- `LIC-002`: the licence ends at `valid_until`, with warning and grace.
- `LIC-003`: signature and clock checks.
- `LIC-004`: only the owner links or checks.

## Technical requirements

| Area | Detail |
| :--- | :--- |
| Licence server schema | `db.js`: `stores.plan` values become `MONTHLY`/`ONE_TIME`, with existing rows updated once. `payments.method` gains `ONE_TIME` and `OVERRIDE`: SQLite cannot alter a CHECK, so the table is rebuilt once with the same columns and rows copied. For answer 3, `stores.owner_sub` may be null until first link, which also means a rebuild |
| Licence server service | `service.js`: `setOneTime`, `setPaidUntil`, `revokeOneTime`, `registerStore`, `deleteUnlinkedStore`. `recordPayment` refuses a `ONE_TIME` store; `applyPlayPurchase` leaves one alone; `approveLink` prefers a registered store for the owner's e-mail |
| Licence server admin | `app.js`, `pages.js`: `POST /admin/stores/:id/one-time`, `/paid-until`, `/revoke-one-time`, `POST /admin/stores` and `/admin/stores/:id/delete`. The same bcrypt session, CSRF token and no-script pages as the existing forms, and a confirmation step on anything that takes access away |
| Licence | `licence.js` is unchanged in format (`CPL1`). The payload's `plan` carries the new value; `paid_until` is the far-future date for `ONE_TIME` |
| POS | `src/services/licenceService.js` reads `plan` (lower-case `monthly` from older licences counts as `MONTHLY`), shows a one-time licence without an unpaid end date, and audits a plan change. `public/js/admin/licence.js` changes the wording. No migration: `licence_state` keeps the token |
| Deployment | The `chachi-licence` Compose project on this server (`licence-server/README.md`). Back up its database file before the schema change |
| Old builds | A POS without this task treats a one-time licence as paid until 9999-12-31. Nothing to update before the server change goes live |

## Acceptance criteria

- [ ] The admin sets a trial store to one-time paid. At its next check the POS shows *One-time
      licence* and opens a shift. The store's history shows the `ONE_TIME` row.
- [ ] A one-time store refuses *Record a payment*, and a Play purchase leaves it one-time.
- [ ] The admin sets a lapsed monthly store paid until next month with a note. It opens a shift
      after its next check.
- [ ] The admin sets a store paid until yesterday. After the check plus grace, no new shift opens.
- [ ] Revoking one-time lapses its devices after the grace (answer 1: yes).
- [ ] A one-time POS that has been offline for 38 days opens no new shift (answer 1: yes).
- [ ] A store registered by the admin for `owner@example.com`, then linked by that Google account,
      is linked with its plan and has no trial row (answer 3: yes).
- [ ] Every admin form refuses a missing CSRF token, and every change needs a signed-in admin.
- [ ] A POS built before this task verifies a one-time licence and opens a shift.
- [ ] The existing licence tests still pass.

## Tests

- **`licence-server/test/server.test.js`:**
  - set one-time;
  - payment and Play refused on a one-time store;
  - set paid until earlier and later;
  - revoke;
  - register and link, with no trial;
  - delete an unlinked store, and a linked one refused;
  - CSRF and sign-in on each new form;
  - the schema upgrade of an existing database file (monthly rows, old payment rows kept).
- **`src/tests/integration/licence.test.js`:**
  - a one-time licence from the real server in-process: active, shown as one-time, a shift opens;
  - a plan change audited;
  - offline past 37 days lapses (answer 1);
  - an old-format `monthly` licence still read as `MONTHLY`.
- **`renderer.test.js`:** `SCR-707`'s wording for each plan.
