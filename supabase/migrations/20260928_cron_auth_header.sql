-- CoffeeFlow — scheduled jobs log in, so worker functions keep verify_jwt ON.
--
-- WHAT WENT WRONG (2026-09-27/28)
-- Several pg_cron jobs call their edge function with no Authorization header.
-- That only works while the function is deployed with verify_jwt=false. The
-- 2026-09-27 `deploy-functions.sh --shared` redeploy turned verify_jwt back on
-- for ten of them, the gateway answered 401 to every tick, and mission-worker
-- (which queues the daily IG story) stopped at 2026-09-27 14:10 UTC. No story
-- went out on 2026-09-28.
--
-- Turning verify_jwt off again would work, but leaves each function callable by
-- anyone who knows its URL, and none of them checks its caller. Instead the
-- jobs now send the service-role key, as the cf-dispatch-workers-* jobs already
-- do, and the functions stay protected. A future deploy can no longer break them.
--
-- The key is NOT written into cron.job. Each job reads it from Vault at run
-- time (vault.decrypted_secrets, name 'cron_service_role_key'), so it never
-- appears in a command, a diff or a log. Create that secret once, before
-- applying (Dashboard → Integrations → Vault, or vault.create_secret), with
-- the JWT-format service_role key (eyJ…; the sb_secret_* format breaks writes).
--
-- Idempotent: a job whose command already mentions Authorization is skipped.

DO $auth$
DECLARE
  r        record;
  v_new    text;
  v_hdr    constant text :=
    $h$'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1)$h$;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'cron_service_role_key') THEN
    RAISE EXCEPTION 'Vault secret cron_service_role_key is missing — create it first (see header).';
  END IF;

  FOR r IN
    SELECT jobid, jobname, command
      FROM cron.job
     WHERE command ~ 'functions/v1/(mission-worker|industry-intelligence-sync|organic-orchestrator|organic-worker-instagram|seo-worker-research|scout-tick|evaluator-tick|strategist-evaluator|strategist-executor|ai-visibility-probe)\M'
       AND command !~* 'authorization'
  LOOP
    -- headers := jsonb_build_object(...)  →  prepend the Authorization pair
    v_new := regexp_replace(r.command,
               'headers\s*:=\s*jsonb_build_object\(\s*',
               'headers := jsonb_build_object(' || v_hdr || ', ', 'gi');
    -- headers := '{...}'::jsonb  →  merge the Authorization pair in
    IF v_new = r.command THEN
      v_new := regexp_replace(r.command,
                 'headers\s*:=\s*(''[^'']*''::jsonb)',
                 'headers := \1 || jsonb_build_object(' || v_hdr || ')', 'gi');
    END IF;

    IF v_new = r.command THEN
      RAISE WARNING 'cron auth: % — headers shape not recognised, left unchanged', r.jobname;
    ELSE
      PERFORM cron.alter_job(r.jobid, command := v_new);
      RAISE NOTICE 'cron auth: % now sends the service-role key', r.jobname;
    END IF;
  END LOOP;
END
$auth$;

-- ── Verify (run after applying) ────────────────────────────────────────
--   -- every job calling one of these functions should report has_auth = true:
--   SELECT jobname, command ~* 'authorization' AS has_auth
--     FROM cron.job WHERE command ~ 'functions/v1/' ORDER BY jobname;
