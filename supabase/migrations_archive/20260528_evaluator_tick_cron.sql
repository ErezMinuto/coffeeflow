-- Minuto Organic Marketing — daily experiment-evaluator tick.
--
-- 06:30 UTC daily. Placement in the daily window:
--   03:30 UTC: industry-intelligence-daily
--   04:30 UTC: meta-sync-daily
--   05:00 UTC: organic-orchestrator             (Sun/Wed only)
--   06:00 UTC: ga4-sync-daily                   (fresh page-level metrics)
--   06:30 UTC: evaluator-tick                   ← NEW
--   07:00 UTC: scout-tick                        (urgency detection)
--
-- Runs daily but the heavy strategist still only fires Sun + Wed. Evaluator
-- catches experiments whose min_lookback_days elapses mid-week. Result:
-- by next Sun/Wed orchestrator run, any new winners are already in
-- seo_learnings + show up in STANDING LEARNINGS automatically.
--
-- On Sun/Wed the orchestrator at 05:00 already evaluates first; whatever
-- it processes leaves status='evaluated'|'inconclusive'. So 06:30 same-day
-- usually finds 0 newly-due — no risk of double-evaluation, just a no-op.

SELECT cron.unschedule('evaluator-tick-daily')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'evaluator-tick-daily'
);

SELECT cron.schedule(
  'evaluator-tick-daily',
  '30 6 * * *',  -- 06:30 UTC daily
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/evaluator-tick',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      -- 10 due experiments × Claude synth (~10-15s each) = ~150s worst case.
      -- Cap at 4 min.
      timeout_milliseconds := 240000
    );
  $$
);
