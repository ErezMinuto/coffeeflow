-- Restore anon-key access for all tables.
--
-- The 20260402_clerk_jwt_rls migration dropped anon policies and added
-- authenticated-only policies, but the app uses the Supabase anon key
-- for all requests (no JWT). This broke SELECT/INSERT/UPDATE/DELETE on
-- every table. Restore the anon policies to match 20260401_enable_rls_all_tables.sql.

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
      CREATE POLICY "anon_select" ON %I FOR SELECT TO anon USING (true);
      CREATE POLICY "anon_insert" ON %I FOR INSERT TO anon WITH CHECK (true);
      CREATE POLICY "anon_update" ON %I FOR UPDATE TO anon USING (true) WITH CHECK (true);
      CREATE POLICY "anon_delete" ON %I FOR DELETE TO anon USING (true);
    ', t, t, t, t, t, t, t, t);
  END LOOP;
END $$;

-- user_roles: anon needs SELECT to resolve roles on login
DROP POLICY IF EXISTS "anon_select" ON user_roles;
CREATE POLICY "anon_select" ON user_roles FOR SELECT TO anon USING (true);
