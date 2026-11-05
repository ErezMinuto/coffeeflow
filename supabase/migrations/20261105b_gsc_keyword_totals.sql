-- gsc_keyword_totals: per-keyword Search Console totals for a date window,
-- summed in the database.
--
-- Why: since the sync stores every query (PR #490), a 90-day window is about
-- 80,000 keyword-day rows. The agents' readers fetched those rows 1,000 at a
-- time and summed them in code: ~80 requests per call against the Micro DB.
-- This returns one row per keyword instead (~9,000 for 90 days).
--
-- Additive: creates a function, changes no data. SECURITY INVOKER, so callers
-- see only what the table's RLS lets them see (the agents use the service key).
-- PostgREST still caps an RPC response at max-rows, so callers either order +
-- limit (top N) or page with .range() ordered by keyword (unique per row).

CREATE OR REPLACE FUNCTION public.gsc_keyword_totals(p_since date, p_until date DEFAULT NULL)
RETURNS TABLE (
  keyword     text,
  clicks      bigint,
  impressions bigint,
  ctr         double precision,
  "position"  double precision,   -- impression-weighted; plain mean when a keyword has 0 impressions
  days        integer,
  last_date   date
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT g.keyword,
         sum(g.clicks)::bigint,
         sum(g.impressions)::bigint,
         CASE WHEN sum(g.impressions) > 0 THEN sum(g.clicks)::double precision / sum(g.impressions) ELSE 0 END,
         CASE WHEN sum(g.impressions) > 0
              THEN sum(g.position * g.impressions) / sum(g.impressions)
              ELSE avg(g.position) END,
         count(DISTINCT g.date)::integer,
         max(g.date)
  FROM google_search_console g
  WHERE g.keyword <> '__page__'           -- page rows are stored under this sentinel
    AND g.date >= p_since
    AND (p_until IS NULL OR g.date <= p_until)
  GROUP BY g.keyword
$$;

REVOKE ALL ON FUNCTION public.gsc_keyword_totals(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gsc_keyword_totals(date, date) TO authenticated, service_role;

-- No new index: the unique key (date, keyword, page) already leads with date.
