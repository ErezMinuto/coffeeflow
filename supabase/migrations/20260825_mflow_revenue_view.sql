-- mflow_revenue — the correct-by-default read surface over mflow_sell_lines.
--
-- WHY. mflow_sell_lines STORES documents it deliberately does not COUNT: price
-- quotes, cancelled docs, drafts, and הוחזר returns are all persisted with their
-- full line revenue and tagged status_class='excluded'. A naive
-- SUM(line_revenue_exc_tax) therefore overstates revenue. Measured over the
-- backfilled 13 months (2025-07 → 2026-08):
--
--   naive sum over the whole table   3,813,810
--   counted + return (correct)       3,536,528
--   excluded noise                     277,282   = 7.3%, over 313 rows
--
-- 7.3% is far too small to look obviously wrong and far too large to ignore,
-- which is the worst possible size for a silent error. Nothing reads this table
-- yet, so the trap is being closed BEFORE the first consumer rather than after.
-- The strategist's businessSnapshot is the obvious first one — it currently
-- reasons about revenue from woo_order_items_enriched, a small slice of the
-- money, and pointing it at MFlow is a known next step.
--
-- FILTER ON status_class, NEVER ON status. They disagree on purpose:
-- classifySell excludes a document when EITHER sell_status.status OR the raw
-- top-level status says 'draft'. Five rows currently carry status='Completed'
-- while being correctly excluded as drafts. status is the document's label;
-- status_class is the decision. Only the decision is safe to filter on.
--
-- 'return' is INCLUDED, not excluded: real credits carry negative quantities and
-- must net against sales (−9,050 across the 13 months). Dropping them would
-- overstate revenue in the other direction.
--
-- security_invoker = true is REQUIRED, not stylistic. mflow_sell_lines has RLS
-- enabled, and a view defaults to DEFINER semantics — it would run as its owner
-- and BYPASS the base table's row-level policies for every caller. With
-- security_invoker the view evaluates RLS as the querying role, so it can never
-- become a privilege-escalation hole. Postgres 15+; prod is on 17.
--
-- NOTE ON `SELECT *`: a view's column list is resolved at CREATE time, so a
-- column added to mflow_sell_lines later will NOT appear here until this view is
-- replaced. Re-run this migration (CREATE OR REPLACE) after any column change.

CREATE OR REPLACE VIEW mflow_revenue
WITH (security_invoker = true) AS
SELECT *
FROM mflow_sell_lines
WHERE status_class IN ('counted', 'return');

COMMENT ON VIEW mflow_revenue IS
  'Revenue-safe view of mflow_sell_lines: counted sales + real credits only. '
  'Quotes, cancelled, drafts and הוחזר returns are stored in the base table with '
  'full revenue and are filtered out here (7.3% of the naive total). Query this, '
  'not the base table, for any revenue figure. Filter on status_class, never status.';

GRANT SELECT ON mflow_revenue TO anon, authenticated, service_role;

-- Verify:
--   SELECT round(sum(line_revenue_exc_tax)::numeric,0) FROM mflow_revenue;   -- 3,536,528
--   SELECT round(sum(line_revenue_exc_tax)::numeric,0) FROM mflow_sell_lines; -- 3,813,810
