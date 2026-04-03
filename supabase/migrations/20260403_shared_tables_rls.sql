-- =============================================================================
-- Fix RLS for shared org-wide tables
--
-- Shared tables: any request carrying the anon key (or an authenticated Clerk
-- JWT) may read and write all rows. This matches the original working design
-- where the anon key acts as the org-level API key — without it you can't hit
-- the API at all, so raw unauthenticated access is still blocked.
--
-- Per-user tables (cost_settings, user_roles): NOT touched here — keep their
-- strict per-user policies.
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
      DROP POLICY IF EXISTS "anon_select" ON %I;
      DROP POLICY IF EXISTS "anon_insert" ON %I;
      DROP POLICY IF EXISTS "anon_update" ON %I;
      DROP POLICY IF EXISTS "anon_delete" ON %I;

      CREATE POLICY "shared_select" ON %I
        FOR SELECT TO anon, authenticated USING (true);

      CREATE POLICY "shared_insert" ON %I
        FOR INSERT TO anon, authenticated WITH CHECK (true);

      CREATE POLICY "shared_update" ON %I
        FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

      CREATE POLICY "shared_delete" ON %I
        FOR DELETE TO anon, authenticated USING (true);
    ', t, t, t, t, t, t, t, t, t, t, t, t);
  END LOOP;
END $$;
