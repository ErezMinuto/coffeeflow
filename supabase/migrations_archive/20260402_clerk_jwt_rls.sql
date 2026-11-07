-- =============================================================================
-- Clerk JWT + Supabase RLS — proper per-user security
--
-- HOW IT WORKS
-- ─────────────
-- 1. The React app attaches a Clerk-signed JWT (template "supabase") to every
--    Supabase request as the Authorization header.
-- 2. Supabase verifies the JWT with its JWT secret (configured in Clerk's
--    "supabase" JWT template signing key).
-- 3. auth.jwt() becomes available inside SQL.  We read auth.jwt() ->> 'sub'
--    which equals the Clerk user ID (e.g. "user_2abc...").
-- 4. Every policy checks  (auth.jwt() ->> 'sub') = user_id  so a user can
--    only see / change their own rows.
--
-- WHY NOT auth.uid()?
-- ─────────────────────
-- auth.uid() returns a UUID.  Clerk user IDs are strings ("user_xxx"), not
-- UUIDs, so auth.uid() is always NULL with Clerk JWTs.  We use
-- auth.jwt() ->> 'sub' instead.
--
-- CHILD TABLES (no user_id column)
-- ──────────────────────────────────
-- roast_profile_ingredients → joins via profile_id → roast_profiles.user_id
-- roast_components          → joins via roast_id   → roasts.user_id
-- availability_submissions  → joins via employee_id → employees.user_id
-- schedule_assignments      → joins via schedule_id → schedules.user_id
-- =============================================================================


-- ── 1. Drop all previous INSECURE anon policies ──────────────────────────────

DO $$ DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'origins','products','roasts','roasting_sessions','operators',
    'roast_profiles','roast_profile_ingredients','roast_components',
    'waiting_customers','employees','availability_submissions',
    'schedules','schedule_assignments','marketing_contacts',
    'campaigns','campaign_events','packing_logs','cost_settings',
    'woo_products','automation_templates','automation_logs','purchases'
  ]) LOOP
    EXECUTE format('
      DROP POLICY IF EXISTS "anon_select" ON %I;
      DROP POLICY IF EXISTS "anon_insert" ON %I;
      DROP POLICY IF EXISTS "anon_update" ON %I;
      DROP POLICY IF EXISTS "anon_delete" ON %I;
    ', t, t, t, t);
  END LOOP;
END $$;

-- Also clean up user_roles
DROP POLICY IF EXISTS "anon_select"     ON user_roles;
DROP POLICY IF EXISTS "anon_insert"     ON user_roles;
DROP POLICY IF EXISTS "anon_update"     ON user_roles;
DROP POLICY IF EXISTS "anon_delete"     ON user_roles;
DROP POLICY IF EXISTS "auth_select_own" ON user_roles;
DROP POLICY IF EXISTS "auth_insert_own" ON user_roles;


-- ── 2. SECURITY DEFINER helper — safe user info upsert ───────────────────────
--
-- Called from context.jsx as  supabase.rpc('upsert_own_user_info', {...})
-- Runs as the function owner (postgres) → bypasses RLS on user_roles.
-- A user can only ever upsert their OWN row (enforced by sub from JWT).

CREATE OR REPLACE FUNCTION public.upsert_own_user_info(
  p_email     TEXT,
  p_full_name TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id TEXT;
BEGIN
  v_user_id := auth.jwt() ->> 'sub';

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'upsert_own_user_info: not authenticated (no sub in JWT)';
  END IF;

  INSERT INTO public.user_roles (user_id, email, full_name)
  VALUES (v_user_id, p_email, p_full_name)
  ON CONFLICT (user_id) DO UPDATE
    SET email     = EXCLUDED.email,
        full_name = EXCLUDED.full_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_own_user_info(TEXT, TEXT) TO authenticated;


-- ── 3. RLS on user_roles ─────────────────────────────────────────────────────

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_own" ON public.user_roles;
CREATE POLICY "auth_select_own" ON public.user_roles
  FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'sub') = user_id);


-- ── 4. Direct user_id tables — full CRUD for own rows ────────────────────────

DO $$ DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'origins','products','roasts','roasting_sessions','operators',
    'roast_profiles','waiting_customers','employees',
    'schedules','marketing_contacts','campaigns','campaign_events',
    'packing_logs','cost_settings','woo_products',
    'automation_templates','automation_logs','purchases'
  ]) LOOP
    EXECUTE format('
      DROP POLICY IF EXISTS "auth_select" ON %I;
      DROP POLICY IF EXISTS "auth_insert" ON %I;
      DROP POLICY IF EXISTS "auth_update" ON %I;
      DROP POLICY IF EXISTS "auth_delete" ON %I;

      CREATE POLICY "auth_select" ON %I
        FOR SELECT TO authenticated
        USING ((auth.jwt() ->> ''sub'') = user_id);

      CREATE POLICY "auth_insert" ON %I
        FOR INSERT TO authenticated
        WITH CHECK ((auth.jwt() ->> ''sub'') = user_id);

      CREATE POLICY "auth_update" ON %I
        FOR UPDATE TO authenticated
        USING  ((auth.jwt() ->> ''sub'') = user_id)
        WITH CHECK ((auth.jwt() ->> ''sub'') = user_id);

      CREATE POLICY "auth_delete" ON %I
        FOR DELETE TO authenticated
        USING ((auth.jwt() ->> ''sub'') = user_id);
    ', t, t, t, t, t, t, t, t);
  END LOOP;
END $$;


-- ── 5. Child tables — access via parent row's user_id ────────────────────────

-- roast_profile_ingredients (profile_id → roast_profiles.user_id)
DROP POLICY IF EXISTS "auth_select" ON roast_profile_ingredients;
DROP POLICY IF EXISTS "auth_insert" ON roast_profile_ingredients;
DROP POLICY IF EXISTS "auth_update" ON roast_profile_ingredients;
DROP POLICY IF EXISTS "auth_delete" ON roast_profile_ingredients;

CREATE POLICY "auth_select" ON roast_profile_ingredients
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM roast_profiles p
    WHERE p.id = profile_id
      AND (auth.jwt() ->> 'sub') = p.user_id
  ));
CREATE POLICY "auth_insert" ON roast_profile_ingredients
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM roast_profiles p
    WHERE p.id = profile_id
      AND (auth.jwt() ->> 'sub') = p.user_id
  ));
CREATE POLICY "auth_update" ON roast_profile_ingredients
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM roast_profiles p
    WHERE p.id = profile_id
      AND (auth.jwt() ->> 'sub') = p.user_id
  ));
CREATE POLICY "auth_delete" ON roast_profile_ingredients
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM roast_profiles p
    WHERE p.id = profile_id
      AND (auth.jwt() ->> 'sub') = p.user_id
  ));

-- roast_components (roast_id → roasts.user_id)
DROP POLICY IF EXISTS "auth_select" ON roast_components;
DROP POLICY IF EXISTS "auth_insert" ON roast_components;
DROP POLICY IF EXISTS "auth_update" ON roast_components;
DROP POLICY IF EXISTS "auth_delete" ON roast_components;

CREATE POLICY "auth_select" ON roast_components
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM roasts r
    WHERE r.id = roast_id
      AND (auth.jwt() ->> 'sub') = r.user_id
  ));
CREATE POLICY "auth_insert" ON roast_components
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM roasts r
    WHERE r.id = roast_id
      AND (auth.jwt() ->> 'sub') = r.user_id
  ));
CREATE POLICY "auth_update" ON roast_components
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM roasts r
    WHERE r.id = roast_id
      AND (auth.jwt() ->> 'sub') = r.user_id
  ));
CREATE POLICY "auth_delete" ON roast_components
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM roasts r
    WHERE r.id = roast_id
      AND (auth.jwt() ->> 'sub') = r.user_id
  ));

-- availability_submissions (employee_id → employees.user_id)
DROP POLICY IF EXISTS "auth_select" ON availability_submissions;
DROP POLICY IF EXISTS "auth_insert" ON availability_submissions;
DROP POLICY IF EXISTS "auth_update" ON availability_submissions;
DROP POLICY IF EXISTS "auth_delete" ON availability_submissions;

CREATE POLICY "auth_select" ON availability_submissions
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM employees e
    WHERE e.id = employee_id
      AND (auth.jwt() ->> 'sub') = e.user_id
  ));
CREATE POLICY "auth_insert" ON availability_submissions
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM employees e
    WHERE e.id = employee_id
      AND (auth.jwt() ->> 'sub') = e.user_id
  ));
CREATE POLICY "auth_update" ON availability_submissions
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM employees e
    WHERE e.id = employee_id
      AND (auth.jwt() ->> 'sub') = e.user_id
  ));
CREATE POLICY "auth_delete" ON availability_submissions
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM employees e
    WHERE e.id = employee_id
      AND (auth.jwt() ->> 'sub') = e.user_id
  ));

-- schedule_assignments (schedule_id → schedules.user_id)
DROP POLICY IF EXISTS "auth_select" ON schedule_assignments;
DROP POLICY IF EXISTS "auth_insert" ON schedule_assignments;
DROP POLICY IF EXISTS "auth_update" ON schedule_assignments;
DROP POLICY IF EXISTS "auth_delete" ON schedule_assignments;

CREATE POLICY "auth_select" ON schedule_assignments
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM schedules s
    WHERE s.id = schedule_id
      AND (auth.jwt() ->> 'sub') = s.user_id
  ));
CREATE POLICY "auth_insert" ON schedule_assignments
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM schedules s
    WHERE s.id = schedule_id
      AND (auth.jwt() ->> 'sub') = s.user_id
  ));
CREATE POLICY "auth_update" ON schedule_assignments
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM schedules s
    WHERE s.id = schedule_id
      AND (auth.jwt() ->> 'sub') = s.user_id
  ));
CREATE POLICY "auth_delete" ON schedule_assignments
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM schedules s
    WHERE s.id = schedule_id
      AND (auth.jwt() ->> 'sub') = s.user_id
  ));
