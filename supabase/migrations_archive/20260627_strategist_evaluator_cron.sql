-- Minuto Strategist Brain — Phase 3: thesis evaluator cron.
--
-- Daily at 07:00 UTC, checks for strategic_theses whose check_date has arrived
-- and grades each against the revenue north-star (validated/refuted/inconclusive),
-- writing the outcome back so the next brain run learns from it. Idle + cheap on
-- days nothing is due (one indexed SELECT, no model call).
--
-- Deploy the function with --no-verify-jwt. Idempotent: unschedule then schedule.

SELECT cron.unschedule('strategist-evaluator-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'strategist-evaluator-daily');

SELECT cron.schedule(
  'strategist-evaluator-daily',
  '0 7 * * *',
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/strategist-evaluator',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000
    );
  $$
);

-- Verify:
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'strategist-evaluator-daily';
