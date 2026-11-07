-- =============================================================================
-- schedule_manager role — scoped permission to run the work schedule
--
-- CONTEXT
-- ───────
-- Roles live in public.user_roles.role. Until now only two values were used:
--   'admin'    — full access
--   'employee' — default, dashboard + production only
-- This adds a third, 'schedule_manager', which the frontend grants access to
-- ONLY the Schedule page (see src/App.jsx ScheduleRoute + Navigation.jsx).
--
-- WHAT NEEDS A DB CHANGE
-- ──────────────────────
-- schedules + schedule_assignments already have fully-open RLS ("shared_*"
-- policies, qual/with_check = true), so building/editing the schedule needs
-- nothing here. The ONLY blocker is approving employees, which is an UPDATE on
-- public.employees gated by is_admin(). We widen just that one policy.
--
-- INSERT/DELETE on employees stay admin-only (adding/removing staff is an admin
-- action; approving = UPDATE active=true).
-- =============================================================================


-- ── 1. Helper — mirrors is_admin() but also matches schedule_manager ─────────
--
-- Same identity check as public.is_admin(): the Clerk user id arrives as the
-- JWT 'sub' claim and equals user_roles.user_id. SECURITY DEFINER so it reads
-- user_roles regardless of the caller's row-level restrictions.

CREATE OR REPLACE FUNCTION public.can_manage_schedule()
  RETURNS boolean
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = (auth.jwt() ->> 'sub')
      AND role IN ('admin', 'schedule_manager')
  );
$function$;

GRANT EXECUTE ON FUNCTION public.can_manage_schedule() TO anon, authenticated;


-- ── 2. Widen employees UPDATE — admins OR schedule managers ──────────────────
--
-- Replaces employees_update_admin_only. Row-level (not column-level): a
-- schedule_manager may update any field on an employee row, which is the
-- expected scope for someone running the team's schedule (approve, set skill
-- levels, etc.). Admins are still covered because can_manage_schedule() also
-- returns true for role='admin'.

DROP POLICY IF EXISTS employees_update_admin_only        ON public.employees;
DROP POLICY IF EXISTS employees_update_admin_or_scheduler ON public.employees;

CREATE POLICY employees_update_admin_or_scheduler
  ON public.employees FOR UPDATE
  TO anon, authenticated
  USING      (public.can_manage_schedule())
  WITH CHECK (public.can_manage_schedule());
