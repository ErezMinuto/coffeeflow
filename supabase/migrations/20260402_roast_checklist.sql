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

CREATE POLICY "Users manage own checklist templates"
  ON roast_checklist_templates
  FOR ALL
  USING  (user_id = (auth.jwt() ->> 'sub'))
  WITH CHECK (user_id = (auth.jwt() ->> 'sub'));
