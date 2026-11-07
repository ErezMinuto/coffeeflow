-- Email automation goes live: change to 2-day delay, re-enable the trigger,
-- and schedule a daily cron that invokes the scheduler edge function.
--
-- Owner choices:
--   • Send 2 days after first order (was 3) — closer to delivery window,
--     beans likely still being explored
--   • Daily cron (frequent enough; sub-day granularity is overkill since
--     the eligibility window is days, not hours)
--   • Run at 10:00 UTC (~13:00 Israel) — afternoon, customers awake
--
-- Phase 1 deliberately had `enabled = false` so the trigger only fired
-- when invoked manually. Now the system is verified end-to-end (4 real
-- customers received the welcome email today) so we can flip it on and
-- let cron handle the steady state.

-- ────────────────────────────────────────────────────────────────────────
-- 1. Adjust trigger config: 2-day delay, keep 3-day lookback for grace
-- ────────────────────────────────────────────────────────────────────────
-- max_lookback_days stays at 3 even though delay is 2 — this gives the
-- system a 1-day grace window. If a cron run fails (network blip,
-- function deploy in progress), the next day's run still picks up
-- yesterday's missed customers because they're now 3 days old (still
-- within the 3-day lookback).
UPDATE email_automation_templates
SET delay_days = 2,
    enabled = true,
    updated_at = NOW()
WHERE trigger_type = 'first_purchase';

-- ────────────────────────────────────────────────────────────────────────
-- 2. Schedule the daily cron job
-- ────────────────────────────────────────────────────────────────────────
-- pg_cron + pg_net are already installed (verified before this migration).
-- Job posts an empty body to the scheduler — no auth header needed because
-- the function is deployed with --no-verify-jwt.
--
-- Idempotent: SELECT cron.unschedule first to clean up any prior version
-- of the same job, THEN re-register. Re-running this migration is safe.

SELECT cron.unschedule('email-automation-first-purchase-daily')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'email-automation-first-purchase-daily'
);

SELECT cron.schedule(
  'email-automation-first-purchase-daily',
  '0 10 * * *',  -- every day at 10:00 UTC (~13:00 Israel)
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/email-automation-scheduler',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $$
);

-- ────────────────────────────────────────────────────────────────────────
-- 3. Verify
-- ────────────────────────────────────────────────────────────────────────
-- Run manually after this migration:
--   SELECT * FROM cron.job WHERE jobname = 'email-automation-first-purchase-daily';
--   SELECT delay_days, enabled FROM email_automation_templates WHERE trigger_type='first_purchase';
