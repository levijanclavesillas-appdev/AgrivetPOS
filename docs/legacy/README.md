# Superseded documentation — do not cite as current

| File | Was | Superseded by | Date |
| :--- | :--- | :--- | :--- |
| `PRD_v1.1.md` | Single 2,483-line PRD covering product, rules, entities, phasing and a 17-document plan | `../01_PRODUCT_BRIEF.md`, `../02_PRD.md`, `../03_BUSINESS_RULES.md`, `../04_UX_SPEC.md`, `../05_TECH_SPEC.md`, `../06_TASKS/`, `../07_TEST_PLAN.md` | 2026-09-07 |

`PRD_v1.1.md` remains readable for history. It is **not** current: it predates the stack
decision, the release restructuring, and every rule ID. Its §91 "Recommended Development
Document Sequence" (17 documents) is superseded by `/root/AdWebsite/docs/docsrequirement.md`,
which mandates six documents plus `06_TASKS/`.

## Contradictions surfaced during consolidation

Recorded rather than silently resolved, per `docsrequirement.md` §6.

| # | Contradiction in `PRD_v1.1.md` | Resolution | Now owned by |
| :-: | :--- | :--- | :--- |
| 1 | §5 requires desktop **and** Android **and** tablet; §6 puts SQLite on "the device"; §84 defers multi-device sync to Phase 3. Mobile stock counting (§5.4) against a second local database is incoherent. | v1.0 is **one Windows PC**. Mobile deferred to v1.3 behind the same embedded HTTP server, so no re-architecture. | `05_TECH_SPEC.md` §1 |
| 2 | §60 puts profitability reports in the MVP; §61 makes costing "FIFO / batch-based"; §83 defers batch tracking to Phase 2. MVP COGS was therefore undefined. | v1.0 uses **moving weighted average** (`MON-004`); batch/FEFO costing arrives with batches in v1.2. | `03_BUSINESS_RULES.md` `MON-004` |
| 3 | §16 defines `1 Sack = 50 KG` but never states which unit stock is held in, so "10 sacks" and "500 KG" were both presented as the inventory figure. | All stock, movements and costing are held in a single **base unit** per product (`UOM-001`). Packs are sell-time conversions only. | `03_BUSINESS_RULES.md` `UOM-001` |
| 4 | §13 gives a product one `Barcode` field; §79 lists a `product_barcodes` table. | Many barcodes per product (`VR-205`); the single field is withdrawn. | `05_TECH_SPEC.md` §3 |
| 5 | §19 lists **Stock Transfer** as an inventory movement type, but no location or branch entity exists before Phase 3. | Withdrawn from v1.0–v1.2. Reinstated with multi-branch in v1.3. | `02_PRD.md` §7 |
| 6 | §3.6 promises fast-moving / slow-moving visibility; no report in §57–60 produces it. | `FT-602` added, v1.2. | `02_PRD.md` `FT-602` |
| 7 | §71 alerts on "Backup overdue" but §73 specifies only manual backups, so nothing could ever satisfy or trigger the alert. | Automatic scheduled backup is v1.0 (`FR_7.1`, `OPS-002`). | `02_PRD.md` `FR_7.1` |
| 8 | §52 offers "Refund / Customer Credit" as a return outcome, but §79 has no entity able to hold a customer credit balance. | Store credit is v1.1, arriving with returns, on `customer_credit_accounts.balance_centavos` going negative-capable. | `03_BUSINESS_RULES.md` `CR-108` |
| 9 | §82 MVP contained 27 modules — approximately the whole product — with no timeline, effort estimate or team size. | Restructured into v1.0 / v1.1 / v1.2 / v1.3. | `02_PRD.md` §7 |
| 10 | Tax is absent entirely, yet §60 computes gross profit and §65 prints a customer-facing document. | Three-mode tax model (`TAX-001`), because the client's registration status was answered "cater both non-VAT, VAT, and not registered". | `03_BUSINESS_RULES.md` `TAX-001` |

---

*Chachi's Software Development Service · DTI BN 8089738 · BIR OCN 111RC20260000002455 · TIN 752-951-092-00000*
