-- Track which advisor recommendations the user has completed/skipped/snoozed.
-- Promoted from frontend localStorage so the agents see this data on their
-- next run and stop recommending things the user already did (e.g. don't
-- recommend "write a macchiato blog post" if user already wrote one).
CREATE TABLE IF NOT EXISTS advisor_completed_actions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start      DATE NOT NULL,
  action_id       TEXT NOT NULL,        -- e.g. "org::seo::macchiato"
  action_label    TEXT,                 -- human-readable summary
  state           TEXT NOT NULL CHECK (state IN ('done','skipped','snoozed')),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(week_start, action_id)
);

ALTER TABLE advisor_completed_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY aca_select ON advisor_completed_actions FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY aca_insert ON advisor_completed_actions FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY aca_update ON advisor_completed_actions FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY aca_delete ON advisor_completed_actions FOR DELETE TO anon, authenticated USING (true);
