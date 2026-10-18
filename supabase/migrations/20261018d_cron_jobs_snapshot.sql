-- Snapshot of every pg_cron job as it runs in prod (2026-10-18).
--
-- The repo's older migrations no longer match prod: several jobs were
-- re-pointed or given the vault service-role key by hand or by later fixes
-- (e.g. 20260709_opening_shift_confirmation_crons.sql still shows the
-- employee-bot jobs with no Authorization header, while prod sends the key).
-- A database rebuilt from git would get the stale versions, and since the
-- caller gates (#404) a cron call without the key is refused. This file
-- records prod's exact commands so git and prod agree.
--
-- cron.schedule(job_name, ...) updates a job of that name in place (same
-- jobid, history kept), so applying this is a no-op on prod and idempotent
-- anywhere. Commands read the key from vault (cron_service_role_key); no key
-- is stored here. Regenerate this file rather than editing jobs by hand.

SELECT cron.schedule('ai-visibility-probe-weekly', '0 22 * * 6', $cron$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/ai-visibility-probe',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 240000
    );
  $cron$);

SELECT cron.schedule('attendance-reminder', '8-58/10 3-20 * * 0-5', $cron$
    SELECT net.http_post(
      url := app.supabase_url() || '/functions/v1/attendance-reminder',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $cron$);

SELECT cron.schedule('cf-dispatch-workers-a', '2-57/5 * * * *', $cron$DO $w$ BEGIN PERFORM net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/organic-worker-instagram',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      -- 3 min — IG container creation + publish typically lands in 5-30s,
      -- but Reels (future) need server-side video processing up to 90s.
      timeout_milliseconds := 180000
    );
   EXCEPTION WHEN OTHERS THEN RAISE WARNING 'cf-dispatch %: %', 'organic-worker-instagram-tick', SQLERRM; END $w$;
DO $w$ BEGIN PERFORM net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/seo-worker-visual',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      -- Most renders finish in 20-60s (Gemini Image) or 30-90s (Vertex
      -- composite). Cap at 4 min so a stuck render doesn't block the
      -- next tick from running. The worker's internal lock_until (10
      -- min by default in claimNextTask) plus the sweeper guarantee a
      -- crashed/timeout-killed row is eventually re-claimable.
      timeout_milliseconds := 240000
    );
   EXCEPTION WHEN OTHERS THEN RAISE WARNING 'cf-dispatch %: %', 'seo-worker-visual-tick', SQLERRM; END $w$;
DO $w$ BEGIN PERFORM net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/seo-worker-writer',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000   -- 2.5min; matches Supabase edge gateway cap
    );
   EXCEPTION WHEN OTHERS THEN RAISE WARNING 'cf-dispatch %: %', 'seo-worker-writer-tick', SQLERRM; END $w$;
DO $w$ BEGIN PERFORM net.http_post(
    url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/strategist-brain?mode=advance',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000);
 EXCEPTION WHEN OTHERS THEN RAISE WARNING 'cf-dispatch %: %', 'strategist-brain-advance', SQLERRM; END $w$;
DO $w$ BEGIN PERFORM net.http_post(
    url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/strategist-executor',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
 EXCEPTION WHEN OTHERS THEN RAISE WARNING 'cf-dispatch %: %', 'strategist-executor-tick', SQLERRM; END $w$;$cron$);

SELECT cron.schedule('cf-dispatch-workers-b', '4-59/5 * * * *', $cron$DO $w$ BEGIN PERFORM net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/seo-worker-research',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000
    );
   EXCEPTION WHEN OTHERS THEN RAISE WARNING 'cf-dispatch %: %', 'seo-worker-research-tick', SQLERRM; END $w$;
DO $w$ BEGIN PERFORM net.http_post(url:='https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/seo-worker-techseo',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type','application/json'), body:='{}'::jsonb, timeout_milliseconds:=150000);
 EXCEPTION WHEN OTHERS THEN RAISE WARNING 'cf-dispatch %: %', 'seo-worker-techseo-tick', SQLERRM; END $w$;$cron$);

SELECT cron.schedule('chat-messages-purge-daily', '40 3 * * *', $cron$ SELECT purge_chat_messages(60); $cron$);

SELECT cron.schedule('coffeeflow-stock-check', '10 * * * *', $cron$
  SELECT net.http_post(
    url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/woo-stock-check',
    headers := '{"Content-Type": "application/json"}'::jsonb || jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1)),
    body := '{}'::jsonb, timeout_milliseconds := 30000);
  $cron$);

SELECT cron.schedule('cron-run-details-purge-daily', '30 2 * * *', $cron$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '14 days'$cron$);

SELECT cron.schedule('email-automation-first-purchase-daily', '0 10 * * *', $cron$
    SELECT net.http_post(
      url := app.supabase_url() || '/functions/v1/email-automation-scheduler',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $cron$);

SELECT cron.schedule('employee-availability-reminder-weekly', '0 15 * * 3', $cron$SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/employee-bot?action=remind',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type','application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000
    );$cron$);

SELECT cron.schedule('evaluator-tick-daily', '0 7 * * *', $cron$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/evaluator-tick',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 240000
    );
  $cron$);

SELECT cron.schedule('ga4-sync-daily', '0 6 * * *', $cron$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/ga4-sync',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{"lookback_days":7}'::jsonb,
      timeout_milliseconds := 120000
    );
  $cron$);

SELECT cron.schedule('ga4-sync-direct', '45 6 * * *', $cron$
        SELECT net.http_post(
          url     := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/ga4-sync',
          headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type','application/json'),
          body    := jsonb_build_object('channel_group', 'Direct', 'days', 7)
        );
      $cron$);

SELECT cron.schedule('ga4-sync-paid-search', '30 6 * * *', $cron$
        SELECT net.http_post(
          url     := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/ga4-sync',
          headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type','application/json'),
          body    := jsonb_build_object('channel_group', 'Paid Search', 'days', 7)
        );
      $cron$);

SELECT cron.schedule('ga4-sync-paid-social', '15 6 * * *', $cron$
        SELECT net.http_post(
          url     := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/ga4-sync',
          headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type','application/json'),
          body    := jsonb_build_object('channel_group', 'Paid Social', 'days', 7)
        );
      $cron$);

SELECT cron.schedule('ga4-sync-referral', '55 6 * * *', $cron$
        SELECT net.http_post(
          url     := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/ga4-sync',
          headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type','application/json'),
          body    := jsonb_build_object('channel_group', 'Referral', 'days', 7)
        );
      $cron$);

SELECT cron.schedule('green-stock-alert-daily', '0 3 * * *', $cron$
  SELECT net.http_post(
    url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/green-stock-alert',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type','application/json'),
    body := '{}'::jsonb, timeout_milliseconds := 60000);
$cron$);

SELECT cron.schedule('health-watchdog-daily', '0 8 * * *', $cron$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/health-watchdog',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000   -- watchdog is mostly DB queries; 60s is plenty
    );
  $cron$);

SELECT cron.schedule('industry-intelligence-daily', '30 3 * * *', $cron$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/industry-intelligence-sync',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 240000
    );
  $cron$);

SELECT cron.schedule('meta-sync-daily', '0 4 * * *', $cron$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/meta-sync?mode=performance',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000
    );
  $cron$);

SELECT cron.schedule('mflow-revenue-sync', '25 * * * *', $cron$ SELECT net.http_post(url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/stock-update', headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type','application/json'), body := '{"action":"mflow_sync_revenue","days":3,"apply":true,"purge":true}'::jsonb, timeout_milliseconds := 150000); $cron$);

SELECT cron.schedule('mflow-sells-sync', '5-50/15 * * * *', $cron$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/stock-update',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{"action":"mflow_sync_sells","days":2,"apply":true}'::jsonb,
      timeout_milliseconds := 120000
    );
  $cron$);

SELECT cron.schedule('mission-worker-tick', '3-53/10 * * * *', $cron$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/mission-worker',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000
    );
  $cron$);

SELECT cron.schedule('opening-shift-confirm-evening', '0 17 * * *', $cron$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/employee-bot?action=confirm-opening',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $cron$);

SELECT cron.schedule('opening-shift-confirm-followup', '15 3 * * *', $cron$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/employee-bot?action=confirm-opening-followup',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $cron$);

SELECT cron.schedule('organic-orchestrator-twice-weekly', '15 5 * * 0,3', $cron$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/organic-orchestrator',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{"trigger":"cron"}'::jsonb,
      timeout_milliseconds := 240000
    );
  $cron$);

SELECT cron.schedule('purge-old-media-weekly', '45 3 * * 0', $cron$ SELECT net.http_post(url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/purge-old-media', headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'), body := '{"commit": true}'::jsonb, timeout_milliseconds := 120000); $cron$);

SELECT cron.schedule('reel-render-dispatch', '1-56/5 * * * *', $cron$ SELECT public.reel_render_sweep(); $cron$);

SELECT cron.schedule('scout-tick-daily', '15 7 * * *', $cron$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/scout-tick',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $cron$);

SELECT cron.schedule('strategist-brain-kickoff-weekly', '45 7 * * 1', $cron$
  SELECT net.http_post(
    url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/strategist-brain?mode=kickoff&trigger=cron',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
$cron$);

SELECT cron.schedule('strategist-evaluator-daily', '30 7 * * *', $cron$
  SELECT net.http_post(
    url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/strategist-evaluator',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000);
$cron$);

SELECT cron.schedule('system-logs-purge-daily', '0 2 * * *', $cron$ SELECT purge_system_logs(30); $cron$);

SELECT cron.schedule('unified-plan-daily', '0 5 * * *', $cron$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/marketing-advisor',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := jsonb_build_object(
        'agent', 'unified_marketing_plan',
        'week_start', (CURRENT_DATE - EXTRACT(DOW FROM CURRENT_DATE)::int)::text
      )
    );
  $cron$);

SELECT cron.schedule('weekly-market-research', '55 3 * * 1', $cron$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/marketing-advisor',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1),
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object('trigger', 'cron', 'agent', 'market_research'),
      timeout_milliseconds := 300000
    );
  $cron$);

SELECT cron.schedule('woo-orders-sync-daily', '0 9 * * *', $cron$ select net.http_post(url:='https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/woo-orders-sync', headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type','application/json'), body:='{}'::jsonb, timeout_milliseconds:=150000); $cron$);

SELECT cron.schedule('woo-products-enrich-tick', '40 */4 * * *', $cron$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/woo-products-enrich',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000
    );
  $cron$);
