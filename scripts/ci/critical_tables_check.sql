-- Access test for 20261017b_critical_tables_staff_and_admin.sql.
--
-- For anon, a signed-in stranger, the employee, the schedule manager and an
-- admin (simulated JWT claims, no real tokens): how many rows each can read in
-- every table, and whether a no-op UPDATE of one row goes through. Ends with
-- RAISE, so the transaction always rolls back — the no-op updates, and any
-- trigger or pg_net request they cause, are discarded. Safe on prod.
--
-- Read the DRYRUN_RESULT line. Per table: "<rows readable>/<rows updatable>",
-- "all" when every row is visible, "DENIED" when the role has no grant.
-- Expected after the migration:
--   anon             DENIED everywhere
--   stranger         0/0 everywhere
--   employee         staff tables readable + writable (employees: read only,
--                    as before), admin tables 0/0
--   schedule_manager as employee, plus employees updatable
--   admin            all/1 everywhere
DO $t$
DECLARE
  r jsonb := '{}'::jsonb;
  who text;
  sub text;
  tbl text;
  col text;
  n bigint;
  u bigint;
  total bigint;
  cell text;
  tables text[] := ARRAY[
    'marketing_contacts','woo_orders','form_submissions','customer_rfm','contact_groups','contact_group_members',
    'campaigns','email_automations','email_automation_templates',
    'products','product_sku_map','employees','attendance_events','availability_submissions',
    'schedule_assignments','opening_shift_confirmations','waiting_customers','pending_orders'];
BEGIN
  FOREACH who IN ARRAY ARRAY['anon','stranger','employee','schedule_manager','admin'] LOOP
    r := r || jsonb_build_object(who, '{}'::jsonb);
    sub := CASE who
      WHEN 'stranger' THEN 'user_test_stranger'
      WHEN 'anon' THEN NULL
      ELSE (SELECT user_id FROM public.user_roles WHERE role = who ORDER BY created_at LIMIT 1) END;
    FOREACH tbl IN ARRAY tables LOOP
      EXECUTE format('SELECT count(*) FROM public.%I', tbl) INTO total;
      -- any updatable column: set it to itself
      SELECT column_name INTO col FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = tbl AND is_generated = 'NEVER' AND is_identity = 'NO'
       ORDER BY (column_name = 'id') DESC, ordinal_position LIMIT 1;
      IF who = 'anon' THEN
        PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true); EXECUTE 'SET LOCAL ROLE anon';
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('role','authenticated','sub',sub)::text, true);
        EXECUTE 'SET LOCAL ROLE authenticated';
      END IF;
      BEGIN
        EXECUTE format('SELECT count(*) FROM public.%I', tbl) INTO n;
        EXECUTE format('UPDATE public.%I SET %I = %I WHERE ctid = (SELECT ctid FROM public.%I LIMIT 1)', tbl, col, col, tbl);
        GET DIAGNOSTICS u = ROW_COUNT;
        cell := CASE WHEN n = total AND n > 0 THEN 'all' ELSE n::text END || '/' || u;
      EXCEPTION
        WHEN insufficient_privilege THEN cell := 'DENIED';
        WHEN others THEN cell := 'err:' || SQLSTATE;
      END;
      EXECUTE 'RESET ROLE';
      r := jsonb_set(r, ARRAY[who, tbl], to_jsonb(cell), true);
    END LOOP;
  END LOOP;
  RAISE EXCEPTION 'DRYRUN_RESULT %', r::text;
END
$t$;
