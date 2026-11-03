-- =============================================================================
-- Weekly innovation scan: a deep_research task the strategist reads before
-- its Monday run. Plan: docs/plans/2026-11-02-strategist-closed-loop.md, B2.
--
-- The job only INSERTS a seo_tasks row; seo-worker-research (already polled
-- every 5 min by cf-dispatch-workers-b) does the web research with sources.
-- No HTTP call, no key: plain SQL. The brain turns findings into
-- innovation_pitch signals (a later change), capped at 3 a week, for Erez.
--
-- Schedule: Sunday 06:40 UTC, ~25 h before strategist-brain-kickoff-weekly
-- (Mon 07:45). Minute 40 of hour 6 is free in the cron grid
-- (20261018d_cron_jobs_snapshot.sql), keeping prod at <= 1 fork per minute.
--
-- Idempotent: cron.schedule replaces a job of the same name; the insert is
-- skipped while an earlier scan is still pending or processing, so a stuck
-- worker never piles up scans.
-- =============================================================================

SELECT cron.schedule('innovation-scan-weekly', '40 6 * * 0', $cron$
  INSERT INTO public.seo_tasks (task_type, brief_data, rationale)
  SELECT 'deep_research',
         jsonb_build_object(
           'innovation_scan',  true,
           'scope',            'other',
           'expected_output',  'recommendations',
           'max_research_turns', 5,
           'question',
             'Innovation scan for Minuto Coffee, an Israeli specialty coffee roaster that sells roasted beans online '
             || '(WooCommerce on WordPress) and in its cafe, markets through Meta ads, Google Ads, Instagram, email and SEO. '
             || 'Find what changed or appeared in the LAST 30 DAYS that a small roaster could act on: '
             || 'Meta and Google ads platform changes, Instagram changes, WooCommerce / WordPress e-commerce tools, '
             || 'email marketing methods, AI search and AI shopping assistants. '
             || 'For EVERY finding give: what it is, why it matters for a small online specialty-coffee seller, '
             || 'the source URL and its publication date. Skip anything older than 90 days or without a source. '
             || 'Do not recommend competitor products or green / unroasted coffee.'
         ),
         '[innovation-scan] weekly research for the strategist'
  WHERE NOT EXISTS (
    SELECT 1 FROM public.seo_tasks
    WHERE task_type = 'deep_research'
      AND brief_data->>'innovation_scan' = 'true'
      AND status IN ('pending', 'processing')
  );
$cron$);
