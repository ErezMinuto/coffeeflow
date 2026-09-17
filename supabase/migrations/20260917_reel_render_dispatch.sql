-- Reel render dispatch: seo_tasks (task_type='reel_render') -> GitHub Actions.
--
-- The dashboard "צור רילס" button inserts a pending reel_render task. Postgres can't
-- render video, so this migration only DISPATCHES: it calls GitHub's workflow_dispatch
-- API for .github/workflows/render-reel.yml with the task id. The workflow claims the
-- task (pending -> processing), renders, uploads to marketing/ig-reels/, and marks it
-- completed with review_required=true. Nothing is published without a human click.
--
--   1. AFTER INSERT trigger  -> dispatches immediately (render starts within seconds)
--   2. pg_cron sweeper (5m)  -> re-dispatches tasks whose dispatch never got claimed,
--                               fails tasks out of attempts or stuck in processing
--
-- Secret: a fine-grained GitHub token (this repo only, Actions: read and write) stored
-- in Supabase Vault under the name 'github_reel_dispatch_token'. Without it, dispatch
-- is a logged no-op and tasks stay pending (the sweeper retries once it exists).
--
-- Additive only: two functions, one trigger, one cron job. No table changes.

-- ── dispatch one task ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reel_render_dispatch(p_task_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_token text;
  v_recent int;
BEGIN
  SELECT decrypted_secret INTO v_token
  FROM vault.decrypted_secrets
  WHERE name = 'github_reel_dispatch_token'
  LIMIT 1;

  IF v_token IS NULL THEN
    RAISE LOG 'reel_render_dispatch: vault secret github_reel_dispatch_token missing; task % left pending', p_task_id;
    RETURN;
  END IF;

  -- Runaway guard: seo_tasks is writable with the anon key, so cap GitHub runs.
  SELECT count(*) INTO v_recent
  FROM seo_tasks
  WHERE task_type = 'reel_render'
    AND attempts > 0
    AND updated_at > now() - interval '1 hour';
  IF v_recent >= 20 THEN
    RAISE LOG 'reel_render_dispatch: 20 dispatches in the last hour; task % deferred', p_task_id;
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://api.github.com/repos/ErezMinuto/coffeeflow/actions/workflows/render-reel.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'coffeeflow-reel-dispatch',
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('task_id', p_task_id::text)),
    timeout_milliseconds := 10000
  );

  -- locked_until = "give the workflow this long to claim it before re-dispatching"
  UPDATE seo_tasks
  SET attempts = attempts + 1,
      locked_until = now() + interval '15 minutes',
      updated_at = now()
  WHERE id = p_task_id AND status = 'pending';
END;
$$;

REVOKE ALL ON FUNCTION public.reel_render_dispatch(uuid) FROM PUBLIC, anon, authenticated;

-- ── trigger: dispatch on insert ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reel_render_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.reel_render_dispatch(NEW.id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS seo_tasks_reel_render_dispatch ON seo_tasks;
CREATE TRIGGER seo_tasks_reel_render_dispatch
  AFTER INSERT ON seo_tasks
  FOR EACH ROW
  WHEN (NEW.task_type = 'reel_render' AND NEW.status = 'pending')
  EXECUTE FUNCTION public.reel_render_on_insert();

-- ── sweeper: retries + timeouts ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reel_render_sweep()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  -- Rendering takes ~2 minutes; 45 minutes in processing means the run died
  -- before its finalize step could report.
  UPDATE seo_tasks
  SET status = 'failed',
      error_msg = 'render timed out (no result from GitHub Actions within 45 minutes)',
      updated_at = now()
  WHERE task_type = 'reel_render'
    AND status = 'processing'
    AND started_at < now() - interval '45 minutes';

  -- Dispatched max_attempts times and never claimed: stop retrying.
  UPDATE seo_tasks
  SET status = 'failed',
      error_msg = 'render never started after ' || attempts || ' dispatch attempts (check the GitHub token and the Render reel workflow)',
      updated_at = now()
  WHERE task_type = 'reel_render'
    AND status = 'pending'
    AND attempts >= max_attempts
    AND (locked_until IS NULL OR locked_until < now());

  FOR r IN
    SELECT id FROM seo_tasks
    WHERE task_type = 'reel_render'
      AND status = 'pending'
      AND attempts < max_attempts
      AND (locked_until IS NULL OR locked_until < now())
    ORDER BY created_at
    LIMIT 5
  LOOP
    PERFORM public.reel_render_dispatch(r.id);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.reel_render_sweep() FROM PUBLIC, anon, authenticated;

SELECT cron.unschedule('reel-render-dispatch')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reel-render-dispatch');

SELECT cron.schedule('reel-render-dispatch', '*/5 * * * *', $$ SELECT public.reel_render_sweep(); $$);

-- ── Verify ──────────────────────────────────────────────────────────────────
-- SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'reel-render-dispatch';
-- SELECT tgname FROM pg_trigger WHERE tgname = 'seo_tasks_reel_render_dispatch';
-- SELECT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'github_reel_dispatch_token') AS token_present;
-- After a dashboard request:
-- SELECT id, status, attempts, locked_until, error_msg, result_data->>'video_url'
--   FROM seo_tasks WHERE task_type = 'reel_render' ORDER BY created_at DESC LIMIT 5;
-- SELECT id, status_code, left(content, 200) FROM net._http_response ORDER BY created DESC LIMIT 5;
