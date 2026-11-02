-- =============================================================================
-- Strategist closed loop: draft → critique → revise (max 2) → human queue.
-- Plan: docs/plans/2026-11-02-strategist-closed-loop.md (Part A).
--
-- Additive only: widens two CHECKs, adds nullable/defaulted columns, seeds one
-- ops_profile key. No row is changed, so the 35+ recommendations already
-- sitting in 'proposed' stay exactly where they are (auto-approve applies only
-- to rows the brain inserts AFTER it is switched on).
--
-- Apply BEFORE merging the code that writes the new statuses. The code reads
-- the 'strategist_loop' key and treats a missing key or a failed read as
-- "loop off", so code deployed ahead of this migration behaves as today.
--
-- New statuses:
--   awaiting_critique  draft content is in artifact_snapshot; critic picks it up
--   revising           critic rejected; executor re-drafts with the feedback
--   exporting          critic passed; executor writes it to WP / IG queue /
--                      campaigns / PAUSED ad. worker_id NULL = unclaimed
--   ready_for_review   exported; waiting for Erez (publish / send / activate)
--   needs_human        rejected after max revisions, or the critic kept
--                      crashing. NOTHING was exported. Erez can dismiss it or
--                      send it to drafts anyway (→ exporting).
-- =============================================================================

ALTER TABLE strategic_recommendations
  DROP CONSTRAINT IF EXISTS strategic_recommendations_status_check;
ALTER TABLE strategic_recommendations
  ADD CONSTRAINT strategic_recommendations_status_check
  CHECK (status IN (
    'proposed', 'approved', 'drafting', 'drafted', 'dismissed', 'failed',
    'awaiting_critique', 'revising', 'exporting', 'ready_for_review', 'needs_human'
  ));

ALTER TABLE strategic_recommendations
  DROP CONSTRAINT IF EXISTS strategic_recommendations_action_type_check;
ALTER TABLE strategic_recommendations
  ADD CONSTRAINT strategic_recommendations_action_type_check
  CHECK (action_type IN ('email_campaign', 'content_blog', 'content_ig', 'ad_meta', 'ad_google', 'none'));

ALTER TABLE strategic_recommendations
  ADD COLUMN IF NOT EXISTS revision_count    INT   NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS critique_attempts INT   NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS critique_log      JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS last_feedback     TEXT,
  ADD COLUMN IF NOT EXISTS artifact_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS auto_approved     BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN strategic_recommendations.artifact_snapshot IS
  'The draft under critique (text, spec, image URLs). Never base64: images are Storage URLs.';
COMMENT ON COLUMN strategic_recommendations.critique_log IS
  'Append-only list of critic verdicts: {at, revision, pass, issues[{severity,rule,detail}], feedback, model}.';

-- Critic and exporter poll these.
CREATE INDEX IF NOT EXISTS strategic_recommendations_loop_idx
  ON strategic_recommendations (status, created_at)
  WHERE status IN ('awaiting_critique', 'revising', 'exporting');

-- ── Loop switches ────────────────────────────────────────────────────────────
-- critique: run the critic for this action type. Safe: the loop itself never
--   publishes, sends or activates anything.
-- auto_approve: brain inserts as 'approved' instead of 'proposed' (skips the
--   planning gate). OFF everywhere. Erez switches these on one type at a time.
--   Paid ads are only ever created PAUSED; only Erez activates them.
INSERT INTO public.ops_profile (key, value, description) VALUES
  ('strategist_loop',
   '{
      "critique":     {"email_campaign": true,  "content_blog": true,  "content_ig": true,  "ad_meta": true,  "ad_google": true},
      "auto_approve": {"email_campaign": false, "content_blog": false, "content_ig": false, "ad_meta": false, "ad_google": false},
      "max_revisions": 2,
      "max_auto_approve_per_run": 5
    }'::jsonb,
   'Strategist closed loop switches. critique = run the draft critic; auto_approve = skip the planning gate. Paid ads are always created PAUSED and only Erez activates them.')
ON CONFLICT (key) DO NOTHING;
