-- =============================================================================
-- Innovation pitches: the strategist proposes new tools / methods / platform
-- changes it found in research, for Erez to approve or decline.
-- Plan: docs/plans/2026-11-02-strategist-closed-loop.md, Part B (B4).
--
-- A pitch is a strategist_signals row with kind 'innovation_pitch'. Approving
-- one BUILDS NOTHING: the fixer agent only claims bug_report / feature_idea /
-- capability_request (scripts/fixer/claim-signal.sh), so an approved pitch is a
-- recorded "yes, worth doing" that a separate, PR-gated task picks up.
--
-- Additive only: widens the kind CHECK, adds nullable / defaulted columns, one
-- CHECK that applies to pitch rows only, one partial unique index on pitch
-- rows only. Existing signals are untouched.
-- =============================================================================

ALTER TABLE strategist_signals DROP CONSTRAINT IF EXISTS strategist_signals_kind_check;
ALTER TABLE strategist_signals ADD CONSTRAINT strategist_signals_kind_check
  CHECK (kind IN ('capability_request', 'bug_report', 'feature_idea', 'innovation_pitch'));

ALTER TABLE strategist_signals
  ADD COLUMN IF NOT EXISTS sources              JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{url, title, published}]
  ADD COLUMN IF NOT EXISTS implementation_steps JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [string]
  ADD COLUMN IF NOT EXISTS effort               TEXT,                                 -- small | medium | large
  ADD COLUMN IF NOT EXISTS cost_estimate        TEXT,                                 -- free text, e.g. "free tier" / "$20/month"
  ADD COLUMN IF NOT EXISTS check_metric         TEXT;                                 -- fixed list below

-- A pitch must be grounded and testable: at least one source, at least one
-- step, a known effort, and a metric the business snapshot actually tracks
-- (so strategist-evaluator can grade an adopted pitch later). ROI is a
-- hypothesis on one of these metrics, never an invented number.
ALTER TABLE strategist_signals DROP CONSTRAINT IF EXISTS strategist_signals_pitch_shape_check;
ALTER TABLE strategist_signals ADD CONSTRAINT strategist_signals_pitch_shape_check
  CHECK (
    kind <> 'innovation_pitch' OR (
      jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) > 0
      AND jsonb_typeof(implementation_steps) = 'array' AND jsonb_array_length(implementation_steps) > 0
      -- IS NOT NULL is required: x IN (...) is NULL for a NULL x, and a CHECK
      -- that evaluates to NULL passes.
      AND effort IS NOT NULL AND effort IN ('small', 'medium', 'large')
      AND check_metric IS NOT NULL AND check_metric IN ('bean_revenue', 'orders', 'repeat_purchase_rate', 'roas', 'cpa', 'email_ctr', 'organic_sessions')
      AND dedupe_key IS NOT NULL AND length(dedupe_key) > 0
    )
  );

-- The same idea is never pitched twice, including after Erez declined it
-- (declined rows keep their dedupe_key).
CREATE UNIQUE INDEX IF NOT EXISTS strategist_signals_pitch_dedupe_uidx
  ON strategist_signals (dedupe_key) WHERE kind = 'innovation_pitch';

COMMENT ON COLUMN strategist_signals.check_metric IS
  'innovation_pitch only: the metric the pitch should move. One of bean_revenue, orders, repeat_purchase_rate, roas, cpa, email_ctr, organic_sessions.';
