-- =============================================================================
-- Admin-only writes on employees table
--
-- Before this migration, the employees table had wide-open RLS: any authenticated
-- or anon request could INSERT, UPDATE, or DELETE. That meant any logged-in user
-- could approve a pending employee, change another employee's role, or delete
-- an employee outright. The user asked for this to be admin-only.
--
-- New rules:
--   SELECT       → anyone authenticated (so non-admin users can still see the
--                  employees list in the dashboard)
--   INSERT       → admin only (dashboard-driven). The employee-bot still creates
--                  pending registration records because it uses the service role
--                  key which bypasses RLS entirely.
--   UPDATE       → admin only. Covers approval (flipping active=true), role
--                  changes, name/phone edits, telegram_id rebind via dashboard.
--   DELETE       → admin only.
--
-- Admin = user_roles.role = 'admin' for the caller's Clerk sub.
-- Uses the existing public.is_admin() function.
--
-- The employee-bot's own registration write path is unaffected: it uses the
-- service role key which bypasses all RLS. Only dashboard-originated writes
-- (through the anon/authenticated role path) are gated.
-- =============================================================================

-- 1. Drop all existing policies on employees. They were a mix of "shared_*"
--    and "anon_*" variants, all with USING true / CHECK true (no real check).
DROP POLICY IF EXISTS "shared_select"          ON employees;
DROP POLICY IF EXISTS "shared_insert"          ON employees;
DROP POLICY IF EXISTS "shared_update"          ON employees;
DROP POLICY IF EXISTS "shared_delete"          ON employees;
DROP POLICY IF EXISTS "anon_insert_employees"  ON employees;
DROP POLICY IF EXISTS "anon_update_employees"  ON employees;
DROP POLICY IF EXISTS "anon_delete_employees"  ON employees;

-- 2. New SELECT policy — any authenticated session can read the list. This is
--    needed so the schedule page, employee picker, and contact tab can all
--    render the roster for non-admin staff too. If you ever want to hide the
--    list entirely from non-admins, change this to USING (public.is_admin()).
CREATE POLICY "employees_select_all"
  ON employees FOR SELECT
  TO anon, authenticated
  USING (true);

-- 3. Admin-only writes. All three use public.is_admin() which reads
--    user_roles.role = 'admin' for the current Clerk sub (auth.jwt() ->> 'sub').
--    If the caller isn't authenticated, auth.jwt() is NULL and is_admin() returns
--    false — so anon requests are also blocked from writing.
CREATE POLICY "employees_insert_admin_only"
  ON employees FOR INSERT
  TO anon, authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY "employees_update_admin_only"
  ON employees FOR UPDATE
  TO anon, authenticated
  USING     (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY "employees_delete_admin_only"
  ON employees FOR DELETE
  TO anon, authenticated
  USING (public.is_admin());
