# TASK-064 — Review back-end.store (a restaurant POS) for integration and data migration

**Priority:** to be set after the review · **Status:** queued (asked for 2026-09-15, during TASK-063)

## The ask

The store owner: "review the back-end.store deployed on docker on this server. Can we
integrate that in this POS since it's also a POS for restaurants? And check if we can migrate
the data there into here."

## What is known before the review

- `back-end.store` is served by nginx from `/var/www/back-end.store`. Its API is proxied to
  `127.0.0.1:4210`, which is the container `mmcafe-api-1` (image `mmcafe-api`). Its database
  is `mmcafe-db-1`. The compose project is `/root/OrderingApp`.
- Separately, `dine.chachisoftware.store` runs `chachi-dine-api` (`/root/AdWebsite/CHACHI_DINE`)
  with its own Postgres. The review should say whether the two are related, since both look
  like restaurant ordering systems.

## What the review should answer

1. **What it is:**
   - its features: tables, orders, kitchen tickets, menu, modifiers, payments, users;
   - its stack and data model;
   - whether it is in use and by which store;
   - how much data it holds.
2. **Fit with Chachi POS.** Restaurants are not one of the four industries yet
   (`src/config/industries.js`). Which of its features Chachi POS already has, and which it
   lacks: dine-in tables, open tabs, kitchen printing, modifiers and add-ons, split bills,
   service charge.
3. **Integration options,** with the effort for each:
   - add a Restaurant industry to Chachi POS and retire back-end.store;
   - keep it as the ordering front end, feeding sales into Chachi POS;
   - leave it separate.
4. **Data migration.** For each of its tables, where the rows would go in Chachi POS: the
   products/menu, customers, sales history and users. State what cannot move. Then prove it
   on a copy of its database into a throwaway Chachi POS store, touching nothing live.
5. **Recommendation.**

## Guard rails

This is a shared server. The review reads and copies; it does not stop, restart or modify
`mmcafe-*` or `chachi-dine-*`, or their databases.
