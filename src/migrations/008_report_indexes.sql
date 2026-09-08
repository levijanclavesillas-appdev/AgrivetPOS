-- 008_report_indexes.sql — the reporting reads
-- Conventions in 05_TECH_SPEC.md §3.1 are binding.
--
-- Forward-only. Once this file has been applied anywhere it is never edited (§8.9).
--
-- No table. TASK-016 is entirely reads over rows TASK-011 to TASK-013 already wrote;
-- what it needs is for those reads to stay inside NFR_1.5's 3 seconds at NFR_2.1 scale
-- (60,000 sales a year, ~100,000 sale lines).
--
-- ## What the task asked for, and what was actually missing
--
-- TASK-016 names four indexes: `sales(sold_at)`, `sale_items(sale_id)`,
-- `sale_tenders(sale_id, method)` and `inventory_movements(product_id, occurred_at)`.
-- Three of the four already exist and the fourth is a column that does not:
--
--   * `sales(sold_at)`                    — the column is `occurred_at`, and
--                                           `idx_sales_date` has covered it since 006
--   * `sale_items(sale_id)`               — served by UNIQUE (sale_id, line_no)'s
--                                           implicit index since 006
--   * `sale_tenders(sale_id, method)`     — `idx_tender_sale` covers the join; the
--                                           method is grouped after the range narrows
--   * `inventory_movements(product_id, …)`— `idx_move_product` since 003
--
-- EXPLAIN QUERY PLAN on all five reporting statements confirms it: every one already
-- resolves through an index, and none of them scans a table. Adding the four named
-- indexes would have added nothing but bytes, so they are not added.
--
-- ## What the measurement actually showed
--
-- The cost that remained was not the search but the fetch: for each sale in range,
-- SQLite seeks into `sale_items` by `sale_id` and then reads the row off the table to
-- get the four figures the aggregate sums. Covering those columns in the index removes
-- the table read entirely. Measured at 25,000 sales over 90 days (100,000 lines):
--
--   daily report, whole range     1128 ms  ->  720 ms
--   payments report, whole range   493 ms  ->  118 ms
--   dashboard, one day              95 ms  ->  113 ms   (unchanged within noise)
--
-- A third, wider covering index on `sales` itself was measured and **rejected**: it
-- moved the whole-range report from 720 ms to 798 ms — slightly worse — and cost 9 MB.
-- It is recorded here because the next person to look at this file will have the same
-- idea, and the measurement is the answer.
--
-- The write cost was measured too, because the sale is the one path that must not get
-- slower (NFR_1.1). Over 300 three-line cash sales the median was unchanged within
-- noise and the database grew 1.7%.

-- The daily report and the profit figure: sum four columns per line, grouped by
-- product. With these columns in the index the table is never touched.
CREATE INDEX idx_saleitems_report ON sale_items (
  sale_id, product_id, qty_milli, line_total_centavos,
  tax_centavos, unit_cost_centavos, discount_centavos
);

-- The payments report (RPT-102) and RPT-101's tender side.
CREATE INDEX idx_tender_report ON sale_tenders (sale_id, method, amount_centavos);
