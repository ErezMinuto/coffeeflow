-- =============================================================================
-- Fix RLS for shared org-wide tables
--
-- The previous migration (20260402_clerk_jwt_rls.sql) applied strict per-user
-- policies to ALL tables, including shared org-wide ones. This means users
-- could only update/delete rows they personally created — breaking multi-user
-- workflows (roasting, packaging, stock management, etc.).
--
-- Shared tables: any authenticated team member may read and write all rows.
-- Per-user tables (cost_settings): keep strict per-user policies.
-- =============================================================================

DO $$ DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'origins', 'products', 'roasts', 'operators',
    'roast_profiles', 'roast_profile_ingredients', 'roast_components',
    'waiting_customers', 'employees', 'availability_submissions',
    'schedules', 'schedule_assignments',
    'marketing_contacts', 'campaigns', 'campaign_events',
    'packing_logs', 'woo_products',
    'automation_templates', 'automation_logs', 'purchases'
  ]) LOOP
    EXECUTE format('
      DROP POLICY IF EXISTS "auth_select" ON %I;
      DROP POLICY IF EXISTS "auth_insert" ON %I;
      DROP POLICY IF EXISTS "auth_update" ON %I;
      DROP POLICY IF EXISTS "auth_delete" ON %I;

      CREATE POLICY "auth_select" ON %I
        FOR SELECT TO authenticated
        USING (true);

      CREATE POLICY "auth_insert" ON %I
        FOR INSERT TO authenticated
        WITH CHECK (true);

      CREATE POLICY "auth_update" ON %I
        FOR UPDATE TO authenticated
        USING (true)
        WITH CHECK (true);

      CREATE POLICY "auth_delete" ON %I
        FOR DELETE TO authenticated
        USING (true);
    ', t, t, t, t, t, t, t, t);
  END LOOP;
END $$;
