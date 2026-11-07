-- Minuto Organic Marketing — scout daily cron.
--
-- 07:00 UTC daily. Sequencing within the daily window:
--   03:30 UTC: industry-intelligence-daily
--   04:30 UTC: meta-sync-daily        (refreshes meta_organic_posts)
--   05:00 UTC: organic-orchestrator   (Sun/Wed only)
--   06:00 UTC: ga4-sync-daily
--   07:00 UTC: scout-tick ← NEW (sees today's fresh Meta + industry data)
--
-- Scout runs daily but the heavy strategist still only runs Sun + Wed.
-- Scout's job: detect urgency between strategic cycles, surface ONE
-- focused dynamic_experiment per signal for the admin to approve.

SELECT cron.unschedule('scout-tick-daily')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'scout-tick-daily'
);

SELECT cron.schedule(
  'scout-tick-daily',
  '0 7 * * *',  -- 07:00 UTC daily
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/scout-tick',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      -- Worst case: 3 signals × Haiku synth (~3-5s) + supabase writes ≈ 30s.
      -- Cap at 120s for safety.
      timeout_milliseconds := 120000
    );
  $$
);
