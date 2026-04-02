-- Fix roast_checklist_templates RLS to match the rest of the app.
--
-- The app sends requests with the Supabase anon key only (no JWT propagation),
-- so all tables need TO anon policies (same pattern as 20260401_enable_rls_all_tables.sql).
-- The previous migration used TO authenticated which caused 401 errors.

DROP POLICY IF EXISTS "auth_select" ON roast_checklist_templates;
DROP POLICY IF EXISTS "auth_insert" ON roast_checklist_templates;
DROP POLICY IF EXISTS "auth_update" ON roast_checklist_templates;
DROP POLICY IF EXISTS "auth_delete" ON roast_checklist_templates;

CREATE POLICY "anon_select" ON roast_checklist_templates FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert" ON roast_checklist_templates FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update" ON roast_checklist_templates FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_delete" ON roast_checklist_templates FOR DELETE TO anon USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON roast_checklist_templates TO anon;
