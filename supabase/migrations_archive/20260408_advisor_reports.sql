-- AI Marketing Advisor — weekly report storage
-- One row per (agent_type, week_start). Each run upserts.

CREATE TABLE IF NOT EXISTS advisor_reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_type  TEXT NOT NULL,        -- 'paid_ads' | 'organic_content'
  week_start  DATE NOT NULL,        -- Monday of the advised week
  status      TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'running' | 'done' | 'error'
  report      JSONB,
  error_msg   TEXT,
  model       TEXT,
  tokens_used INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_type, week_start)
);

-- RLS: org-wide shared table (same pattern as all other shared tables)
ALTER TABLE advisor_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "advisor_reports_shared_select" ON advisor_reports
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "advisor_reports_shared_insert" ON advisor_reports
  FOR INSERT TO anon, authenticated WITH CHECK (true);

CREATE POLICY "advisor_reports_shared_update" ON advisor_reports
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

CREATE POLICY "advisor_reports_shared_delete" ON advisor_reports
  FOR DELETE TO anon, authenticated USING (true);
