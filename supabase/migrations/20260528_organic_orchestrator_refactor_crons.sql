-- Minuto Organic Marketing — cron migration for the orchestrator refactor.
--
-- Three operations, all idempotent:
--   1. Retire `organic-content-twice-weekly` — the OLD strategic planner
--      (marketing-advisor agent=organic_content). Its responsibilities
--      (IG content planning) are now subsumed by the unified organic
--      orchestrator. marketing-advisor's other modes (weekly report)
--      are untouched.
--   2. Retire `seo-orchestrator-twice-weekly` — renamed function
--      (seo-orchestrator → organic-orchestrator). Old cron stays running
--      otherwise it'd POST to a dead URL.
--   3. Schedule `organic-orchestrator-twice-weekly` — same Sun + Wed
--      05:00 UTC slot, POSTing to the new function name.
--   4. Schedule `organic-worker-instagram-tick` — every 2 min, drains
--      instagram_post tasks that the orchestrator emits.
--
-- After this migration, there is ONE strategic planner (organic-orchestrator)
-- that emits ALL content task types. Workers (writer / visual / instagram)
-- execute. The chat agent still handles ad-hoc admin requests.

-- 1. Retire old strategic planner (only the cron — code stays in
--    marketing-advisor for now; admin can still hit it manually).
SELECT cron.unschedule('organic-content-twice-weekly')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'organic-content-twice-weekly'
);

-- 2. Retire old orchestrator cron (function renamed).
SELECT cron.unschedule('seo-orchestrator-twice-weekly')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'seo-orchestrator-twice-weekly'
);

-- 3. Schedule the unified organic orchestrator. Same Sun + Wed 05:00 UTC
--    slot — ran 1h after the old organic-content cron previously, now
--    runs first instead. Trigger=cron so logs distinguish autonomous
--    runs from manual ones.
SELECT cron.schedule(
  'organic-orchestrator-twice-weekly',
  '0 5 * * 0,3',
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/organic-orchestrator',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{"trigger":"cron"}'::jsonb,
      timeout_milliseconds := 240000
    );
  $$
);

-- 4. Schedule the IG worker tick. Every 2 min, same cadence as the
--    writer + visual workers — most IG tasks land within 4 min of the
--    orchestrator firing (visual task generates first, then IG worker
--    finds parent ready on its next tick).
SELECT cron.schedule(
  'organic-worker-instagram-tick',
  '*/2 * * * *',
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/organic-worker-instagram',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      -- 3 min — IG container creation + publish typically lands in 5-30s,
      -- but Reels (future) need server-side video processing up to 90s.
      timeout_milliseconds := 180000
    );
  $$
);

-- Verify post-apply:
--   SELECT jobname, schedule, active FROM cron.job
--   WHERE jobname IN (
--     'organic-content-twice-weekly',         -- expect: gone
--     'seo-orchestrator-twice-weekly',        -- expect: gone
--     'organic-orchestrator-twice-weekly',    -- expect: present, active
--     'organic-worker-instagram-tick'         -- expect: present, active
--   )
--   ORDER BY jobname;
