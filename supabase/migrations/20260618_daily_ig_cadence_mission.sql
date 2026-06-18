-- Minuto SEO Agent — standing DAILY INSTAGRAM CADENCE mission.
--
-- Problem this fixes: nothing queued Instagram content autonomously. The
-- organic-orchestrator only runs Sun + Wed, so between cycles no IG posts were
-- planned unless the admin asked in chat. There was no mechanism to keep the
-- feed topped up day to day.
--
-- Fix: seed ONE persistent mission (state.kind = 'daily_ig_cadence') that the
-- existing mission-worker (cron, every 10 min) drives. The worker recognises
-- this kind, feeds it today's IG progress, paces it to the daily target, and
-- never lets it auto-complete (see mission-worker/index.ts). It tops Minuto's
-- Instagram up to 1 story + 3-4 feed posts per UTC day, resetting each midnight.
--
-- SAFETY: this ONLY drafts posts into the review queue. Every instagram_post it
-- queues flows through the queue_for_review gate (the IG worker hard-forces it),
-- so NOTHING publishes live without the admin clicking approve. Applying this
-- migration starts the autonomous QUEUING, not autonomous publishing.
--
-- To PAUSE the cadence later (stops all autonomous IG queuing immediately):
--   UPDATE agent_missions SET status = 'paused'
--    WHERE state->>'kind' = 'daily_ig_cadence';
-- To resume: set status back to 'active'.

-- Idempotent + safe to re-run: only seed if no daily_ig_cadence mission already
-- exists in a live state (active or paused), so re-applying the migration can't
-- spawn duplicates that would double the daily output.
INSERT INTO agent_missions (objective, status, state, max_steps, created_by)
SELECT
  'Keep Minuto''s Instagram topped up to a daily cadence of 1 story + 3-4 feed posts per UTC day. Each day, queue a varied mix grounded in real search demand and the Minuto coffee catalog; never repeat the same product/angle day over day. Story + feed each go through the normal visual->instagram_post pipeline and queue for review (never publish live). This is a standing cadence with no end.',
  'active',
  '{"kind": "daily_ig_cadence", "progress_notes": [], "queued_task_ids": []}'::jsonb,
  2000000000,   -- effectively unbounded; the worker also never finishes this kind on the step cap
  'system'
WHERE NOT EXISTS (
  SELECT 1 FROM agent_missions
  WHERE state->>'kind' = 'daily_ig_cadence'
    AND status IN ('active', 'paused')
);

-- ── Verify ────────────────────────────────────────────────────────────
--   SELECT id, status, steps_taken, left(objective,60)
--     FROM agent_missions WHERE state->>'kind' = 'daily_ig_cadence';
--   -- today's IG output (what the cadence paces against):
--   SELECT brief_data->>'media_type' AS media_type, count(*)
--     FROM seo_tasks
--    WHERE task_type = 'instagram_post' AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
--    GROUP BY 1;
