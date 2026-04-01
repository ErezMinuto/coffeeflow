-- Enable RLS on all public tables and add policies.
-- The app uses Clerk auth with the Supabase anon key (no JWT propagation),
-- so policies use (true) to allow anon-key access while blocking
-- unauthenticated HTTP requests without any API key.

-- ── Enable RLS ───────────────────────────────────────────────────────────────

ALTER TABLE origins                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE products                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE roasts                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE roasting_sessions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE operators                ENABLE ROW LEVEL SECURITY;
ALTER TABLE roast_profiles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE roast_profile_ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE roast_components         ENABLE ROW LEVEL SECURITY;
ALTER TABLE waiting_customers        ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees                ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedules                ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_assignments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_contacts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns                ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE packing_logs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_settings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE woo_products             ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_templates     ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_logs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchases                ENABLE ROW LEVEL SECURITY;

-- ── Policies (anon key required — blocks raw unauthenticated access) ─────────

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
      CREATE POLICY "anon_select" ON %I FOR SELECT TO anon USING (true);
      CREATE POLICY "anon_insert" ON %I FOR INSERT TO anon WITH CHECK (true);
      CREATE POLICY "anon_update" ON %I FOR UPDATE TO anon USING (true) WITH CHECK (true);
      CREATE POLICY "anon_delete" ON %I FOR DELETE TO anon USING (true);
    ', t, t, t, t);
  END LOOP;
END $$;
