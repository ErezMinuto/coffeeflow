-- CoffeeFlow — take the public anon key off customer, employee and outbound
-- email data. Follow-up to 20261017_admin_only_sensitive_tables.sql.
--
-- WHAT WAS WRONG (audit 2026-10-17)
-- With the anon key, which ships in both frontend bundles, anyone could read,
-- change or delete: 3,619 marketing contacts, 1,464 Woo orders, form
-- submissions and RFM scores (customer personal data); employees, attendance,
-- availability and shift assignments (employee personal data); the email
-- automations, templates and campaigns the system sends to customers from
-- Minuto's domain (a ready-made phishing channel); and products / SKU map
-- (stock that MFlow syncs against).
--
-- TWO TIERS
--   ADMIN ONLY — customer data and outbound email. Only the admin dashboard
--     reads them; every edge function uses the service role (bypasses RLS).
--   KNOWN STAFF — the main app's operational tables. Every role uses them
--     (admin, schedule_manager, employee), so each existing policy is kept and
--     ANDed with is_staff(): the caller's Clerk id has a user_roles row.
--     In-app permissions are unchanged (e.g. employees insert/delete stay
--     admin-only, updates stay admin-or-scheduler). What goes away is anon,
--     and strangers who sign themselves up on the open Clerk instance.
--
-- Checked before writing: no edge function reaches these with the anon key
-- (all service role); website forms go Cloudflare worker → forms-submit
-- (service role); both frontends send the Clerk token on HTTP and realtime
-- (#393/#395 dashboard, #397 main app). Every Clerk id seen in the data has a
-- role row except one inactive since 2026-02-27 (likely a test login).
--
-- ROLLBACK: previous policies are copied to ops.policy_backup_20261017b; the
-- restore query is in 20261017_admin_only_sensitive_tables.sql, and
-- GRANT SELECT, INSERT, UPDATE, DELETE ON public.<table> TO anon.

-- ── 0. Rollback point ──────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS ops;
REVOKE ALL ON SCHEMA ops FROM anon, authenticated;
CREATE TABLE IF NOT EXISTS ops.policy_backup_20261017b AS
  SELECT now() AS saved_at, p.*
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.tablename IN (
       'marketing_contacts','woo_orders','form_submissions','customer_rfm','contact_groups',
       'contact_group_members','campaigns','email_automations','email_automation_templates',
       'products','product_sku_map','employees','attendance_events','availability_submissions',
       'schedule_assignments','opening_shift_confirmations','waiting_customers','pending_orders');
REVOKE ALL ON ops.policy_backup_20261017b FROM anon, authenticated;

-- ── 1. is_staff(): the caller is someone the team has given a role ─────
-- SECURITY DEFINER like is_admin(), so it can read user_roles regardless of
-- that table's own policies.
CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = (auth.jwt() ->> 'sub'));
$$;
REVOKE ALL ON FUNCTION public.is_staff() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.is_staff() TO authenticated, service_role;

-- ── 2. Admin only ──────────────────────────────────────────────────────
DO $admin$
DECLARE
  t text;
  p record;
BEGIN
  FOREACH t IN ARRAY ARRAY['marketing_contacts','woo_orders','form_submissions','customer_rfm','contact_groups',
                           'contact_group_members','campaigns','email_automations','email_automation_templates'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t);
    END LOOP;
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin())',
      t || '_admin_only', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
  END LOOP;
END
$admin$;

-- ── 3. Known staff: keep every rule, add is_staff(), drop anon ─────────
DO $staff$
DECLARE
  t text;
  p record;
  using_clause text;
  check_clause text;
BEGIN
  FOREACH t IN ARRAY ARRAY['products','product_sku_map','employees','attendance_events','availability_submissions',
                           'schedule_assignments','opening_shift_confirmations','waiting_customers','pending_orders'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    FOR p IN
      SELECT * FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t
         AND roles && ARRAY['anon','authenticated','public']::name[]
    LOOP
      using_clause := CASE WHEN p.cmd = 'INSERT' THEN ''
                           ELSE format(' USING ((%s) AND public.is_staff())', coalesce(p.qual, 'true')) END;
      check_clause := CASE WHEN p.cmd IN ('INSERT','UPDATE','ALL')
                           THEN format(' WITH CHECK ((%s) AND public.is_staff())', coalesce(p.with_check, p.qual, 'true'))
                           ELSE '' END;
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t);
      EXECUTE format('CREATE POLICY %I ON public.%I AS %s FOR %s TO authenticated%s%s',
                     p.policyname, t, p.permissive, p.cmd, using_clause, check_clause);
    END LOOP;
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
  END LOOP;
END
$staff$;

-- ── Verify ─────────────────────────────────────────────────────────────
-- scripts/ci/critical_tables_check.sql (runs as anon / stranger / employee /
-- schedule manager / admin, always rolls back).
