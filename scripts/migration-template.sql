-- ─────────────────────────────────────────────────────────────────────────
-- Migration template — copy, rename to YYYYMMDD_<feature>.sql, fill in.
--
-- Naming: date prefix matches the day you'll apply, not the day you author.
-- All migrations should be additive unless owner signs off on destructive
-- changes (see CLAUDE.md — dev project is unreachable; prod is the only DB).
--
-- ─────────────────────────────────────────────────────────────────────────
-- DATA API EXPOSURE — REQUIRED FOR EVERY NEW TABLE
--
-- After Oct 30, 2026, Supabase no longer auto-grants new public-schema
-- tables to `anon` / `authenticated`. You must pick ONE of the two patterns
-- below and write it explicitly. There is no implicit default anymore.
-- ─────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════
-- PATTERN A — service-role-only (DEFAULT for new tables)
--
-- Use when: only edge functions touch this table. Dashboard never reads
-- it directly via supabase-js. Edge functions use service_role, which
-- bypasses RLS and ignores GRANTs — so we enable RLS without policies
-- and skip GRANTs entirely. Anon is denied at two layers.
--
-- Examples in repo: ga4_pages_daily, seo_learnings, seo_tasks, meta_ad_drafts.
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS my_table (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ...
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE my_table ENABLE ROW LEVEL SECURITY;
-- No GRANT, no policy. Service role bypasses both; anon is denied.


-- ═════════════════════════════════════════════════════════════════════════
-- PATTERN B — exposed to the dashboard (anon / authenticated)
--
-- Use when: dashboard code calls `.from('my_table')` via supabase-js.
-- The frontend connects with the anon key, so PostgREST needs explicit
-- table grants AND (if writing via an authenticated user) sequence grants.
-- Pair grants with an RLS policy that scopes rows correctly.
--
-- Examples in repo: pending_orders, contact_groups, attendance_settings.
-- ═════════════════════════════════════════════════════════════════════════

-- CREATE TABLE IF NOT EXISTS my_table (
--   id          BIGSERIAL PRIMARY KEY,
--   user_id     TEXT NOT NULL,
--   -- ...
--   created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
-- );
--
-- ALTER TABLE my_table ENABLE ROW LEVEL SECURITY;
--
-- -- Grants — PostgREST needs these to expose the table at all.
-- GRANT SELECT, INSERT, UPDATE, DELETE ON my_table          TO anon, authenticated;
-- GRANT USAGE,  SELECT                  ON SEQUENCE my_table_id_seq TO anon, authenticated;
--
-- -- Policy — gates which rows the role can actually see/touch.
-- -- (Replace with whatever scoping your table needs. "Allow all" is fine
-- -- for org-wide shared tables; per-user tables should filter on user_id.)
-- CREATE POLICY my_table_all ON my_table
--   FOR ALL TO anon, authenticated
--   USING (true) WITH CHECK (true);


-- ─────────────────────────────────────────────────────────────────────────
-- Verification block — paste expected results as a comment so post-apply
-- review is fast. The 20260528b migration is a good reference.
-- ─────────────────────────────────────────────────────────────────────────

-- Verify post-apply:
--   SELECT tablename, rowsecurity FROM pg_tables
--    WHERE schemaname = 'public' AND tablename = 'my_table';
--   -- expect rowsecurity = true
--
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_schema = 'public' AND table_name = 'my_table';
--   -- Pattern A: expect 0 rows for anon/authenticated
--   -- Pattern B: expect SELECT/INSERT/UPDATE/DELETE for anon + authenticated
