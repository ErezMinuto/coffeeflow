-- Minuto SEO Agent — persistent missions.
--
-- A "mission" is an open-ended objective the agent pursues AUTONOMOUSLY in
-- the background, across many cron ticks, long after the admin has closed
-- the browser. The mission-worker (cron, ~every 10 min) wakes up, looks at
-- the mission's progress + the results of sub-tasks it queued earlier, and
-- decides the SINGLE next action — queue more work, note progress, or
-- declare the objective met. All work it queues flows through the existing
-- seo_tasks pipeline and its publish gates (blog→drafts, IG→queue-for-
-- review, FAQ→review_required), so a mission can run hands-off without ever
-- publishing anything live without the admin.
--
-- Distinct from seo_tasks (one-shot units of work): a mission is long-lived,
-- stays 'active' across ticks, carries evolving working state, and is NOT
-- subject to seo_tasks' attempt-based failure model.

CREATE TABLE IF NOT EXISTS agent_missions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  objective       text        NOT NULL,
  status          text        NOT NULL DEFAULT 'active',   -- active | done | failed | paused | cancelled
  -- Evolving working memory the worker reads + rewrites each step:
  --   { progress_notes: string[], queued_task_ids: string[],
  --     observations: string[], next_action_hint?: string }
  state           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  steps_taken     int         NOT NULL DEFAULT 0,
  max_steps       int         NOT NULL DEFAULT 30,          -- hard cap → mission auto-stops
  -- Worker locking (same expired-lock self-heal semantics as seo_tasks).
  locked_until    timestamptz,
  worker_id       text,
  created_by      text        NOT NULL DEFAULT 'chat_agent',
  last_step_at    timestamptz,
  last_briefing_at timestamptz,
  result_summary  text,                                     -- set on done/failed
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_missions_active
  ON agent_missions (status, locked_until)
  WHERE status = 'active';

-- Permissive RLS to match the rest of the SEO-agent tables (dashboard reads
-- with the anon key; edge functions write with the service role).
ALTER TABLE agent_missions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_missions_all ON agent_missions;
CREATE POLICY agent_missions_all ON agent_missions
  FOR ALL TO anon, authenticated, service_role
  USING (true) WITH CHECK (true);

GRANT ALL ON agent_missions TO anon, authenticated, service_role;

-- Realtime so the dashboard can surface live mission progress later.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='agent_missions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_missions;
  END IF;
END $$;

-- ── Cron: mission-worker-tick (every 10 min) ──────────────────────────
-- Drains active missions one reasoning-step at a time. The worker self-
-- bounds each step to the edge wall-clock; missions span many ticks.
SELECT cron.unschedule('mission-worker-tick')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mission-worker-tick');

SELECT cron.schedule(
  'mission-worker-tick',
  '*/10 * * * *',
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/mission-worker',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000
    );
  $$
);

-- ── Verify ────────────────────────────────────────────────────────────
--   SELECT id, status, steps_taken, max_steps, left(objective,60) FROM agent_missions ORDER BY created_at DESC;
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname='mission-worker-tick';
