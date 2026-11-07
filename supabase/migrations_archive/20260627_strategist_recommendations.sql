-- Minuto Strategist Brain — Phase 2a: recommendations execution ledger.
--
-- Phase 1 wrote recommendations as free-text inside strategic_briefs.recommendations
-- (display only). Phase 2 makes them ACTIONABLE: each recommendation becomes a row
-- here with a machine-readable action_type/action_params, a structured (attributable)
-- success_metric, and a status the human drives via the dashboard. An executor claims
-- approved rows and DRAFTS the work (content task / email draft) — nothing sends or
-- publishes autonomously.
--
-- Conventions match the Phase 1 tables (gen_random_uuid PKs, shared RLS, inline
-- ENABLE RLS right after CREATE so the SQL-editor RLS linter doesn't block a
-- multi-statement run).

CREATE TABLE IF NOT EXISTS strategic_recommendations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_id       UUID REFERENCES strategic_briefs(id),
  run_id         UUID,
  thesis_id      UUID,                              -- links the drafted work back to the thesis it serves (Phase 3 grading)
  title          TEXT NOT NULL,
  rationale      TEXT,
  -- 'email_campaign' | 'content_blog' | 'content_ig' | 'none' (pure advice / out-of-hands)
  action_type    TEXT NOT NULL DEFAULT 'none'
                   CHECK (action_type IN ('email_campaign', 'content_blog', 'content_ig', 'none')),
  action_params  JSONB NOT NULL DEFAULT '{}',       -- type-specific draft inputs
  -- structured + attributable: { metric, source, baseline, check_date }
  success_metric JSONB NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'proposed'
                   CHECK (status IN ('proposed', 'approved', 'drafted', 'dismissed', 'failed')),
  draft_ref      TEXT,                              -- campaign_id or seo_task id of the drafted artifact
  draft_error    TEXT,
  locked_until   TIMESTAMPTZ,                        -- executor claim lock
  worker_id      TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE strategic_recommendations ENABLE ROW LEVEL SECURITY;

-- executor claim: approved + unlocked, oldest first
CREATE INDEX IF NOT EXISTS strategic_recommendations_claim_idx
  ON strategic_recommendations (created_at)
  WHERE status = 'approved';
-- dashboard read: by brief, newest first
CREATE INDEX IF NOT EXISTS strategic_recommendations_brief_idx
  ON strategic_recommendations (brief_id, created_at DESC);

CREATE POLICY "srec_sel" ON strategic_recommendations FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "srec_ins" ON strategic_recommendations FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "srec_upd" ON strategic_recommendations FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
