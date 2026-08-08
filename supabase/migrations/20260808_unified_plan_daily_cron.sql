-- Daily unified marketing plan refresh — the "once a day poll".
--
-- Runs the unified brain analysis every morning so /plan always shows a
-- fresh, data-grounded plan (including current campaign performance) without
-- anyone clicking "הפעל ניתוח". The action is async: this POST returns 202,
-- then the worker writes the plan to advisor_reports (agent_type='unified_plan').
--
-- Idempotent: unschedule first, then schedule (safe to re-run).
-- 05:00 UTC ≈ 08:00 Israel — a fresh plan waiting each morning, after the
-- overnight data syncs (meta / google / woo) have refreshed the numbers.

SELECT cron.unschedule('unified-plan-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'unified-plan-daily');

SELECT cron.schedule(
  'unified-plan-daily',
  '0 5 * * *',
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/marketing-advisor',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object(
        'agent', 'unified_marketing_plan',
        -- current week's Sunday (DOW: Sunday = 0), matching the app's week_start
        'week_start', (CURRENT_DATE - EXTRACT(DOW FROM CURRENT_DATE)::int)::text
      )
    );
  $$
);
