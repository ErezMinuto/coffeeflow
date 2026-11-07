-- Minuto Organic Marketing — ai-visibility-probe weekly cron.
--
-- Schedule: Saturday 22:00 UTC weekly. Picked deliberately:
--   • Once a week is enough — LLM model responses don't change hour-to-hour
--   • Saturday late evening UTC = before Sunday 05:00 orchestrator tick,
--     so Sunday's planning sees fresh visibility data
--   • Avoid weekday business hours when admin might be probing manually
--
-- Cost per run (v1, Claude Sonnet only): ~13 queries × $0.005/query = $0.07/week.
-- Adding Perplexity/GPT-4 multiplies by N; still <$1/week.
--
-- Idempotent: unschedule first, then schedule.

SELECT cron.unschedule('ai-visibility-probe-weekly')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'ai-visibility-probe-weekly'
);

SELECT cron.schedule(
  'ai-visibility-probe-weekly',
  '0 22 * * 6',  -- Saturday 22:00 UTC (~5am Sunday Israel; before orchestrator's 05:00 UTC tick)
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/ai-visibility-probe',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      -- 13 queries × 1-3 providers × ~5s each ≈ 65-200s. Cap at 4 min.
      timeout_milliseconds := 240000
    );
  $$
);
