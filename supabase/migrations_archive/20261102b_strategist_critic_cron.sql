-- =============================================================================
-- Strategist closed loop: the draft critic's cron.
--
-- strategist-evaluator with {"action":"critique_draft"} grades up to 2 drafts in
-- 'awaiting_critique' per tick (Gemini Pro, ~30-90 s each) and moves them on.
-- Idle and cheap when nothing is waiting.
--
-- Schedule: minutes 7,17,27,37,47. No other job fires on those minutes
-- (20261018d_cron_jobs_snapshot.sql), keeping prod at <= 1 fork per minute
-- (20260920_cron_worker_pressure.sql).
--
-- Apply AFTER 20261102a_strategist_closed_loop.sql. Reads the service-role key
-- from vault like every other job; no key is stored here.
-- =============================================================================

SELECT cron.schedule('strategist-critic-tick', '7-47/10 * * * *', $cron$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/strategist-evaluator',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{"action":"critique_draft"}'::jsonb,
      timeout_milliseconds := 150000
    );
  $cron$);
