-- =============================================================================
-- bean_sales_daily — adopt into git + switch to security_invoker
--
-- CONTEXT
-- ───────
-- This view was created directly against prod and never existed in a migration.
-- Supabase's linter flags it as "Security Definer View": like every Postgres
-- view it defaults to security_invoker = off, so it runs with the OWNER's
-- rights and evaluates RLS on the base tables as the owner, not as the caller.
--
-- Two things happen here:
--   1. The live definition (pulled from pg_views on 2026-09-07) is recorded so
--      prod and git stop drifting on this object.
--   2. security_invoker = on, which clears the lint.
--
-- WHY THIS IS SAFE
-- ────────────────
-- security_invoker only bites when a caller has weaker rights on the base
-- tables than the view owner. Verified on 2026-09-07 that anon can already
-- SELECT all three base tables (mflow_sell_lines, coffee_sales_daily,
-- product_sku_map) directly, so no caller loses rows. service_role bypasses
-- RLS regardless. The view is aggregate-only, so it is not auto-updatable and
-- the INSERT/UPDATE/DELETE grants on it were never usable.
--
-- NOT DONE HERE — see the PR/session notes: revoking SELECT from anon on this
-- view alone would be cosmetic, because anon can read the base tables and
-- recompute the same numbers. Locking down revenue data means tightening the
-- base tables, which needs a sweep of every consumer first.
-- =============================================================================

CREATE OR REPLACE VIEW public.bean_sales_daily
  WITH (security_invoker = on)
AS
 SELECT (l.transaction_date)::date AS day,
    'mflow'::text AS source,
    l.cf_product_id,
    l.sku,
    sum(l.quantity) FILTER (WHERE (l.line_revenue_exc_tax > (0)::numeric)) AS paid_units,
    sum(l.quantity) FILTER (WHERE (l.line_revenue_exc_tax <= (0)::numeric)) AS free_units,
    sum(l.quantity) AS bean_units,
    sum(l.line_revenue_exc_tax) AS revenue_ex_vat
   FROM mflow_sell_lines l
  WHERE ((l.status_class <> 'excluded'::text) AND (l.cf_product_id IS NOT NULL))
  GROUP BY ((l.transaction_date)::date), 'mflow'::text, l.cf_product_id, l.sku
UNION ALL
 SELECT c.day,
    'icount'::text AS source,
    m.product_id AS cf_product_id,
    c.sku,
    sum(c.bags) FILTER (WHERE (c.revenue > (0)::numeric)) AS paid_units,
    sum(c.bags) FILTER (WHERE (c.revenue <= (0)::numeric)) AS free_units,
    sum(c.bags) AS bean_units,
    sum(c.revenue) AS revenue_ex_vat
   FROM (coffee_sales_daily c
     LEFT JOIN product_sku_map m ON ((m.sku = c.sku)))
  GROUP BY c.day, 'icount'::text, m.product_id, c.sku;
