# 01 — Product Brief

**Product**: Chachi Agrivet POS — Agrivet Store POS & Inventory Management System
**Version**: 2.0 · **Date**: 2026-09-07 · **Supersedes**: `legacy/PRD_v1.1.md` §1–§4, §82–§84
**Status**: Approved for build

---

## 1. The problem

A single-branch agrivet store buys wholesale and sells mostly retail: animal feeds, veterinary
medicines, supplements, vitamins, and farm supplies. Its operating problems are ordinary and
expensive:

1. **Stock is unknown between counts.** Feed moves in sacks and in kilos, so the same product has
   two mental units and no reliable on-hand figure.
2. **Credit is on paper.** Farm customers buy on account. Balances live in a notebook, ageing is
   guesswork, and collection depends on someone remembering.
3. **The till never reconciles.** Cash, GCash and QR Ph arrive in one shift with no per-method
   expected total to check against.
4. **Margin is invisible.** Cost is known at purchase and forgotten at sale, so nobody can say
   which lines make money.

The store does not need an accounting system, an e-commerce site, or BIR filing. It needs the
counter to work, offline, on the machine it already owns.

## 2. Users

| User | Count | What they do | Where |
| :--- | :-- | :--- | :--- |
| Owner | 1 | Everything. Prices, costs, users, reports, credit limits, settings, backups. | Store + off-hours |
| Manager | 0–1 | Supervises the counter, approves over-limit credit and discounts, closes the day. | Store |
| Cashier | 1–3 | Sells, takes payment, records collections, opens and closes a shift. | Counter |
| Inventory staff | 0–1 | Receives deliveries, counts stock, records damage and expiry. | Stockroom |

In a store this size one person often holds several of these roles. The permission model
(`03_BUSINESS_RULES.md` §6) is therefore per-user, not per-person.

## 3. What this is

> A local-first, offline-capable Windows desktop application that runs one agrivet store's
> counter, stock, customer credit and daily cash position — installed as a `.exe`, holding its
> own SQLite database, requiring no internet to sell.

## 4. Business model

Sold as a one-off licensed installation with an optional support retainer, in the same shape as
**ChachiLoan / LendingStandard**. It is **not** a Chachi Central tenant product in v1 — see §7.

## 5. Scope

### In scope, v1.0 (the deployable release)

Products and stock · POS with barcode scanning · cash, GCash and QR Ph recording · customer
credit sales and collections · cashier shift with till cash in/out and end-of-day closing ·
low-stock alerts · automatic local backup · audit trail.

### In scope, later releases

Purchasing and goods receipt · returns and voids · stock counting · the discount rules engine ·
data import/export (v1.1) · batches, expiry and FEFO · statements and reconciliation (v1.2) ·
LAN multi-terminal, Android, PostgreSQL (v1.3+).

### Out of scope, permanently unless separately commissioned

- **BIR Official Receipts and tax invoices.** The system prints an internal transaction record.
  It must never present that document as an OR or a tax invoice (`TAX-006`).
- Public e-commerce, customer-facing ordering, or a customer portal.
- A general ledger, trial balance, or financial statements.
- Holding funds, card data, or any payment credential (`SEC-4`).
- BIR filing, eSales submission, or CAS accreditation.

## 6. Success metrics

| # | Metric | Target | Measured by |
| :-: | :--- | :--- | :--- |
| 1 | Store sells exclusively through the system for a full day | Day 1 of go-live | No paper sales tickets that day |
| 2 | End-of-day cash variance | ≤ ₱50 on 9 of 10 closings | `cashier_closings.variance_centavos` |
| 3 | Credit balances match the notebook at cutover | 100% of accounts | Cutover reconciliation sheet |
| 4 | Median sale completion, scan to receipt | ≤ 20 seconds | `TC-E2E-01` timing, then observation |
| 5 | Owner can state yesterday's gross profit without asking anyone | Week 1 | Dashboard |
| 6 | Unplanned data loss events | 0 | Backup log + `OPS-002` alert |

## 7. Recorded product decisions

| # | Decision | Rationale |
| :-: | :--- | :--- |
| D-1 | **Standalone product, not federated with Chachi Central in v1.** Users, roles and passwords are local to the installation. | The store is one machine, offline, with no platform tenancy. This mirrors **ChachiLoan / LendingStandard** and **Chachi Dance Studio**. See §8 for why this is not an `AC-1` violation. |
| D-2 | **One Windows PC in v1.0.** No LAN clients, no Android. | Fastest path to a store actually running on it. The embedded HTTP server means v1.3 adds clients without re-architecture. Resolves `legacy/README.md` contradiction 1. |
| D-3 | **Tax is a store-level mode**, covering unregistered, non-VAT and VAT-registered stores. | The client answered "cater both non-VAT, VAT, and not registered". Also makes the product resellable to other agrivet stores without a schema change. `TAX-001`. |
| D-4 | **Thin till-first MVP.** Purchasing, returns and stock counting ship in v1.1. | The store can buy stock on paper for a few weeks; it cannot sell on paper. Time-to-counter is the whole objective. |
| D-5 | **Money as integer centavos, quantity as integer thousandths of a base unit.** | Floating-point money in a credit ledger produces balances that never reach zero. `MON-001`. |

## 8. Platform boundary — stated explicitly

`product_auth_integration.md` **AC-1** forbids Chachi systems to create, store, accept or
transmit local account passwords **for platform access**. Chachi Agrivet POS v1 stores a local
bcrypt password per user. This is **not** an AC-1 violation, and the boundary is written here so
that a security review does not have to infer it:

- The local credential authenticates a user to **this installation only**. It confers no access
  to `chachisoftware.store`, the Admin Hub, the Client Portal, or any other Chachi product.
- The installation holds no platform tenancy, no `organization_id`, no product token, and makes
  no call to Central. There is no federated identity for it to bypass.
- If the store is later onboarded as a Central tenant, federation is a v1.3 work item and the
  local password path is retired at that point, not extended.

This is the same position **ChachiLoan / LendingStandard** occupies. Cite `SEC-1` in
`05_TECH_SPEC.md` for the implementation.

## 9. Open questions

| # | Question | Blocks | Owner |
| :-: | :--- | :--- | :--- |
| Q-1 | Is the store BIR VAT-registered, non-VAT, or unregistered *today*? Needed to set `tax_mode` at install, not to build it. | Go-live configuration only | Client |
| Q-2 | Does the store stock prescription-only veterinary drugs or vaccines requiring cold chain? | `FT-205` scope (v1.2) | Client |
| Q-3 | Does the store deliver feed to farms and charge for it? | `FT-306` (unscheduled) | Client |
| Q-4 | Existing product list and opening stock — what format, how many SKUs? | `TASK-026` sizing (v1.1, or pulled into v1.0 at cutover) | Client |

---

*Chachi's Software Development Service · Charlyn Embate Padilla, Proprietor · DTI BN 8089738 ·
BIR OCN 111RC20260000002455 · TIN 752-951-092-00000 · Koronadal City, South Cotabato*
