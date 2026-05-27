-- Minuto Organic Marketing — learning quality / self-evaluation.
--
-- Adds evidence_score so the experiment evaluator can incrementally
-- update each learning's reliability as new data lands:
--   +1 when a new experiment winner CONFIRMS the rule
--   -1 when a new experiment winner CONTRADICTS the rule
--   0 when uncorrelated
--
-- When evidence_score drops below the auto-supersede threshold (default
-- -2), the evaluator auto-marks the learning as superseded with reason
-- 'auto-superseded: contradicted by N subsequent experiments'.
--
-- SAFETY: auto-supersede ONLY applies to learnings where
-- created_by='orchestrator' (i.e. self-written autonomous rules).
-- Admin-recorded learnings (created_by='chat_agent' or 'admin_manual')
-- are NEVER auto-superseded — only manual via supersede_learning tool.
-- This prevents the evaluator from silently erasing rules an admin
-- explicitly taught it.
--
-- All additive. Safe to apply on prod.

ALTER TABLE seo_learnings
  ADD COLUMN IF NOT EXISTS evidence_score NUMERIC NOT NULL DEFAULT 0;

-- Track WHICH experiments contributed to the score so the audit trail is
-- queryable. Each entry is { experiment_id, direction: 'confirm'|'contradict', winner_label, recorded_at }.
ALTER TABLE seo_learnings
  ADD COLUMN IF NOT EXISTS evidence_log JSONB NOT NULL DEFAULT '[]';

-- Index for "find learnings that may be at risk of supersede" — used
-- by the evaluator + dashboards.
CREATE INDEX IF NOT EXISTS seo_learnings_evidence_score_idx
  ON seo_learnings (evidence_score)
  WHERE superseded_at IS NULL;

-- Verify:
--   SELECT id, scope, evidence_score FROM seo_learnings ORDER BY evidence_score LIMIT 5;
--   SELECT column_name FROM information_schema.columns WHERE table_name='seo_learnings' AND column_name IN ('evidence_score', 'evidence_log');
