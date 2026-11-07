-- pg_cron jobs, prod only. Snapshot of cron.job on ytydgldyeygpzmlxvpvb, 2026-11-07.
--
-- NOT a migration, on purpose: every job POSTs to the prod functions URL (either
-- literally or via app.supabase_url(), which also returns the prod URL), so
-- installing these anywhere else would fire real calls at prod.
--
-- To apply, the session must opt in explicitly, in the same request:
--     SET coffeeflow.cron_target = 'ytydgldyeygpzmlxvpvb';
--     <this file>
-- and the database must hold the Vault entry the jobs authenticate with. Both
-- are required, so a stray copy of the key in another environment is not enough.
--
-- Keys are read from Vault at run time; nothing secret is stored in this file.
-- cron.schedule(name, ...) upserts by name, so re-running this file is safe.
-- To change a job: edit it here, apply this file to prod, commit.

DO $guard$
BEGIN
  IF coalesce(current_setting('coffeeflow.cron_target', true), '') <> 'ytydgldyeygpzmlxvpvb' THEN
    RAISE NOTICE 'coffeeflow.cron_target is not the prod ref: skipping cron jobs';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'cron_service_role_key') THEN
    RAISE NOTICE 'cron_service_role_key not in Vault: not prod, skipping cron jobs';
    RETURN;
  END IF;

  PERFORM cron.schedule(
    'coffeeflow-stock-check',
    '10 * * * *',
    $job$
  SELECT net.http_post(
    url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/woo-stock-check',
    headers := '{"Content-Type": "application/json"}'::jsonb || jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1)),
    body := '{}'::jsonb, timeout_milliseconds := 30000);
  $job$
  );

  PERFORM cron.schedule(
    'email-automation-first-purchase-daily',
    '0 10 * * *',
    $job$
    SELECT net.http_post(
      url := app.supabase_url() || '/functions/v1/email-automation-scheduler',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $job$
  );

  PERFORM cron.schedule(
    'attendance-reminder',
    '8-58/10 3-20 * * 0-5',
    $job$
    SELECT net.http_post(
      url := app.supabase_url() || '/functions/v1/attendance-reminder',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $job$
  );

  PERFORM cron.schedule(
    'health-watchdog-daily',
    '0 8 * * *',
    $job$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/health-watchdog',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000   -- watchdog is mostly DB queries; 60s is plenty
    );
  $job$
  );

  PERFORM cron.schedule(
    'organic-orchestrator-twice-weekly',
    '15 5 * * 0,3',
    $job$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/organic-orchestrator',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{"trigger":"cron"}'::jsonb,
      timeout_milliseconds := 240000
    );
  $job$
  );

  PERFORM cron.schedule(
    'industry-intelligence-daily',
    '30 3 * * *',
    $job$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/industry-intelligence-sync',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 240000
    );
  $job$
  );

  PERFORM cron.schedule(
    'meta-sync-daily',
    '0 4 * * *',
    $job$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/meta-sync?mode=performance',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000
    );
  $job$
  );

  PERFORM cron.schedule(
    'ga4-sync-daily',
    '0 6 * * *',
    $job$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/ga4-sync',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{"lookback_days":7}'::jsonb,
      timeout_milliseconds := 120000
    );
  $job$
  );

  PERFORM cron.schedule(
    'evaluator-tick-daily',
    '0 7 * * *',
    $job$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/evaluator-tick',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 240000
    );
  $job$
  );

  PERFORM cron.schedule(
    'scout-tick-daily',
    '15 7 * * *',
    $job$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/scout-tick',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $job$
  );

  PERFORM cron.schedule(
    'ai-visibility-probe-weekly',
    '0 22 * * 6',
    $job$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/ai-visibility-probe',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 240000
    );
  $job$
  );

  PERFORM cron.schedule(
    'mission-worker-tick',
    '3-53/10 * * * *',
    $job$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/mission-worker',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000
    );
  $job$
  );

  PERFORM cron.schedule(
    'woo-products-enrich-tick',
    '40 */4 * * *',
    $job$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/woo-products-enrich',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000
    );
  $job$
  );

  PERFORM cron.schedule(
    'woo-orders-sync-daily',
    '0 9 * * *',
    $job$ select net.http_post(url:='https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/woo-orders-sync', headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type','application/json'), body:='{}'::jsonb, timeout_milliseconds:=150000); $job$
  );

  PERFORM cron.schedule(
    'green-stock-alert-daily',
    '0 3 * * *',
    $job$
  SELECT net.http_post(
    url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/green-stock-alert',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type','application/json'),
    body := '{}'::jsonb, timeout_milliseconds := 60000);
$job$
  );

  PERFORM cron.schedule(
    'strategist-brain-kickoff-weekly',
    '45 7 * * 1',
    $job$
  SELECT net.http_post(
    url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/strategist-brain?mode=kickoff&trigger=cron',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
$job$
  );

  PERFORM cron.schedule(
    'employee-availability-reminder-weekly',
    '0 15 * * 3',
    $job$SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/employee-bot?action=remind',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type','application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000
    );$job$
  );

  PERFORM cron.schedule(
    'strategist-evaluator-daily',
    '30 7 * * *',
    $job$
  SELECT net.http_post(
    url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/strategist-evaluator',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000);
$job$
  );

  PERFORM cron.schedule(
    'opening-shift-confirm-evening',
    '0 17 * * *',
    $job$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/employee-bot?action=confirm-opening',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $job$
  );

  PERFORM cron.schedule(
    'opening-shift-confirm-followup',
    '15 3 * * *',
    $job$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/employee-bot?action=confirm-opening-followup',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $job$
  );

  PERFORM cron.schedule(
    'mflow-sells-sync',
    '5-50/15 * * * *',
    $job$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/stock-update',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{"action":"mflow_sync_sells","days":2,"apply":true}'::jsonb,
      timeout_milliseconds := 120000
    );
  $job$
  );

  PERFORM cron.schedule(
    'unified-plan-daily',
    '0 5 * * *',
    $job$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/marketing-advisor',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := jsonb_build_object(
        'agent', 'unified_marketing_plan',
        'week_start', (CURRENT_DATE - EXTRACT(DOW FROM CURRENT_DATE)::int)::text
      )
    );
  $job$
  );

  PERFORM cron.schedule(
    'purge-old-media-weekly',
    '45 3 * * 0',
    $job$ SELECT net.http_post(url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/purge-old-media', headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'), body := '{"commit": true}'::jsonb, timeout_milliseconds := 120000); $job$
  );

  PERFORM cron.schedule(
    'ga4-sync-paid-social',
    '15 6 * * *',
    $job$
        SELECT net.http_post(
          url     := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/ga4-sync',
          headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type','application/json'),
          body    := jsonb_build_object('channel_group', 'Paid Social', 'days', 7)
        );
      $job$
  );

  PERFORM cron.schedule(
    'ga4-sync-paid-search',
    '30 6 * * *',
    $job$
        SELECT net.http_post(
          url     := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/ga4-sync',
          headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type','application/json'),
          body    := jsonb_build_object('channel_group', 'Paid Search', 'days', 7)
        );
      $job$
  );

  PERFORM cron.schedule(
    'ga4-sync-direct',
    '45 6 * * *',
    $job$
        SELECT net.http_post(
          url     := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/ga4-sync',
          headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type','application/json'),
          body    := jsonb_build_object('channel_group', 'Direct', 'days', 7)
        );
      $job$
  );

  PERFORM cron.schedule(
    'ga4-sync-referral',
    '55 6 * * *',
    $job$
        SELECT net.http_post(
          url     := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/ga4-sync',
          headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type','application/json'),
          body    := jsonb_build_object('channel_group', 'Referral', 'days', 7)
        );
      $job$
  );

  PERFORM cron.schedule(
    'mflow-revenue-sync',
    '25 * * * *',
    $job$ SELECT net.http_post(url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/stock-update', headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type','application/json'), body := '{"action":"mflow_sync_revenue","days":3,"apply":true,"purge":true}'::jsonb, timeout_milliseconds := 150000); $job$
  );

  PERFORM cron.schedule(
    'reel-render-dispatch',
    '1-56/5 * * * *',
    $job$ SELECT public.reel_render_sweep(); $job$
  );

  PERFORM cron.schedule(
    'system-logs-purge-daily',
    '0 2 * * *',
    $job$ SELECT purge_system_logs(30); $job$
  );

  PERFORM cron.schedule(
    'chat-messages-purge-daily',
    '40 3 * * *',
    $job$ SELECT purge_chat_messages(60); $job$
  );

  PERFORM cron.schedule(
    'cron-run-details-purge-daily',
    '30 2 * * *',
    $job$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '14 days'$job$
  );

  PERFORM cron.schedule(
    'cf-dispatch-workers-a',
    '2-57/5 * * * *',
    $job$DO $w$ BEGIN PERFORM net.http_post(
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
 EXCEPTION WHEN OTHERS THEN RAISE WARNING 'cf-dispatch %: %', 'strategist-executor-tick', SQLERRM; END $w$;$job$
  );

  PERFORM cron.schedule(
    'cf-dispatch-workers-b',
    '4-59/5 * * * *',
    $job$DO $w$ BEGIN PERFORM net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/seo-worker-research',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000
    );
   EXCEPTION WHEN OTHERS THEN RAISE WARNING 'cf-dispatch %: %', 'seo-worker-research-tick', SQLERRM; END $w$;
DO $w$ BEGIN PERFORM net.http_post(url:='https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/seo-worker-techseo',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type','application/json'), body:='{}'::jsonb, timeout_milliseconds:=150000);
 EXCEPTION WHEN OTHERS THEN RAISE WARNING 'cf-dispatch %: %', 'seo-worker-techseo-tick', SQLERRM; END $w$;$job$
  );

  PERFORM cron.schedule(
    'weekly-market-research',
    '55 3 * * 1',
    $job$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/marketing-advisor',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1),
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object('trigger', 'cron', 'agent', 'market_research'),
      timeout_milliseconds := 300000
    );
  $job$
  );

  PERFORM cron.schedule(
    'rfm-sync-daily',
    '40 6 * * *',
    $job$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/rfm-sync',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1),
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object('trigger', 'cron'),
      timeout_milliseconds := 150000
    );
  $job$
  );

  PERFORM cron.schedule(
    'packing-logs-purge-daily',
    '50 3 * * *',
    $job$ SELECT purge_packing_logs(); $job$
  );

  PERFORM cron.schedule(
    'strategist-critic-tick',
    '7-47/10 * * * *',
    $job$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/strategist-evaluator',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1), 'Content-Type', 'application/json'),
      body := '{"action":"critique_draft"}'::jsonb,
      timeout_milliseconds := 150000
    );
  $job$
  );

  PERFORM cron.schedule(
    'innovation-scan-weekly',
    '40 6 * * 0',
    $job$
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
$job$
  );

END
$guard$;
