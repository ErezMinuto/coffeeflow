-- Roast checklist templates
CREATE TABLE IF NOT EXISTS roast_checklist_templates (
  id         BIGSERIAL PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT 'רשימת קלייה',
  variables  JSONB NOT NULL DEFAULT '[]',
  steps      JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE roast_checklist_templates ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read templates (shared team data)
CREATE POLICY "auth_select" ON roast_checklist_templates
  FOR SELECT TO authenticated
  USING (TRUE);

-- Only the owner can create/edit/delete
CREATE POLICY "auth_insert" ON roast_checklist_templates
  FOR INSERT TO authenticated
  WITH CHECK ((auth.jwt() ->> 'sub') = user_id);

CREATE POLICY "auth_update" ON roast_checklist_templates
  FOR UPDATE TO authenticated
  USING  ((auth.jwt() ->> 'sub') = user_id)
  WITH CHECK ((auth.jwt() ->> 'sub') = user_id);

CREATE POLICY "auth_delete" ON roast_checklist_templates
  FOR DELETE TO authenticated
  USING ((auth.jwt() ->> 'sub') = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON roast_checklist_templates TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE roast_checklist_templates_id_seq TO authenticated;
