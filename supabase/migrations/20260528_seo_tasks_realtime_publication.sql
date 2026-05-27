-- Minuto SEO Agent — add seo_tasks (and friends) to the supabase_realtime
-- publication so the admin dashboard's left panel sees INSERT/UPDATE
-- events fired by the chat handler, orchestrator, and workers without a
-- manual page refresh.
--
-- Symptom that triggered this: SeoTaskQueue.tsx already subscribes via
--   supabase.channel('seo_tasks_queue')
--     .on('postgres_changes', { event:'*', schema:'public', table:'seo_tasks' }, …)
-- but the events never fire — because pg_notify-via-Realtime only emits
-- for tables explicitly added to the `supabase_realtime` publication.
-- chat_messages was already in there (briefings work), seo_tasks wasn't.
--
-- Same goes for seo_experiments (used by the metrics panel) and
-- seo_learnings (the cross-session memory; if we ever want a live
-- "rules" pane). Add all three so future panels don't hit the same
-- footgun.
--
-- REPLICA IDENTITY DEFAULT is enough for INSERT events (we only ship
-- the primary key) — UPDATE events would need REPLICA IDENTITY FULL
-- to ship old.*, but our subscribers just re-fetch on any change, so
-- DEFAULT is fine and avoids the write amplification of FULL.
--
-- Idempotent: ADD TABLE is a no-op if the table is already in the
-- publication, but PG raises an error on duplicate, so we guard with
-- DO blocks that check pg_publication_tables first.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'seo_tasks'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.seo_tasks;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'seo_experiments'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.seo_experiments;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'seo_learnings'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.seo_learnings;
  END IF;
END $$;

-- ── Verify (run manually after this migration applies) ────────────────
--   SELECT tablename FROM pg_publication_tables
--   WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
--   ORDER BY tablename;
-- Expect: chat_messages, seo_experiments, seo_learnings, seo_tasks at minimum.
