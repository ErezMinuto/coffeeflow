-- Auto-run the organic_content agent twice a week (Sun + Wed).
--
-- The agent's outputs are review-gated:
--   • IG posts — owner publishes manually from the dashboard.
--   • Blog post — pushed to WordPress as status='draft'; owner reviews +
--     hits Publish in WP admin.
-- So this cron creates work to review, never live content. The dashboard's
-- existing approval flow is the only thing that ships.
--
-- Cadence: Sun + Wed at 04:00 UTC.
--   • IL is UTC+2 (winter) / UTC+3 (summer DST) → arrives 06:00–07:00 IL.
--   • Twice/week is the owner's choice — frequent enough that GSC-fresh
--     recommendations don't go stale, slow enough that the agent isn't
--     drafting a flood of blog posts to review.
--   • Cannibalism guardrails (filterDuplicateRecommendations +
--     done-actions cross-check) are enforced inside the agent, so even
--     repeated runs against the same week_start won't double-target the
--     same keyword.
--
-- Idempotent: unschedule first, then schedule. Re-running this migration
-- is safe — it just refreshes the schedule entry.
--
-- pg_cron + pg_net are already installed in this project (verified via
-- the existing email_automation_daily_cron migration, 2026-04-28).

-- ── Job 1: research + recommendations + IG enrichment ─────────────────
SELECT cron.unschedule('organic-content-twice-weekly')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'organic-content-twice-weekly'
);

SELECT cron.schedule(
  'organic-content-twice-weekly',
  '0 4 * * 0,3',  -- 04:00 UTC every Sunday (0) and Wednesday (3)
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/marketing-advisor',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object('trigger', 'cron', 'agent', 'organic_content'),
      timeout_milliseconds := 600000   -- 10min; organic run typically 2-5min
    );
  $$
);

-- ── Job 2: blog draft + push to WP (status='draft') ───────────────────
-- Runs 90min after job 1 so the report row is settled before we read it.
-- Split from marketing-advisor because the full chain (research + enrich
-- + Sonnet blog draft + banner + WP push) exceeds the 150s edge-runtime
-- cap on a single invocation. blog-auto-publish reads the latest report,
-- drafts the top recommendation, generates a banner, and POSTs to WP as
-- status='draft'. Owner publishes manually in WP admin.
SELECT cron.unschedule('blog-auto-publish-twice-weekly')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'blog-auto-publish-twice-weekly'
);

SELECT cron.schedule(
  'blog-auto-publish-twice-weekly',
  '30 5 * * 0,3',  -- 05:30 UTC Sunday + Wednesday (90min after job 1)
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/blog-auto-publish',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,   -- defaults to current IL-week's Sunday
      timeout_milliseconds := 300000   -- 5min; typical run 2-3min
    );
  $$
);

-- ── Verify (run manually after this migration applies) ─────────────────
--   SELECT jobname, schedule, command FROM cron.job
--   WHERE jobname = 'organic-content-twice-weekly';
--
-- Watch a run:
--   SELECT * FROM cron.job_run_details
--   WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='organic-content-twice-weekly')
--   ORDER BY start_time DESC LIMIT 5;
