-- Minuto SEO Agent — autonomous A/B experimentation + self-rewriting rules.
--
-- The reinforcement loop has 3 surfaces:
--   1. seo_tasks gains experiment_id + variation_label so workers can map
--      a published artifact back to its experimental cohort.
--   2. seo_experiments holds the experiment-level metadata: hypothesis,
--      sample-size + lookback requirements, lifecycle status, winner.
--   3. seo_learnings (already exists) gains a new scope value
--      'experiment_winner' for orchestrator-written rules. The orchestrator
--      writes via the recordLearning() helper with created_by='orchestrator'.
--
-- Lifecycle of an experiment (status field):
--   • 'collecting'    — variations queued; waiting for ≥ min_lookback_days
--   • 'evaluating'    — orchestrator picked it up this cycle to score
--   • 'evaluated'     — winner identified, learning recorded, done
--   • 'inconclusive'  — no statistically meaningful winner; no rule written
--   • 'cancelled'     — admin manually killed the experiment
--
-- Sample-size guardrails are stored on the experiment so the orchestrator
-- doesn't auto-write a "winner" rule from one impression on each variation.

CREATE TABLE IF NOT EXISTS seo_experiments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Human-readable hypothesis the strategist wants to test.
  -- e.g. "Technical hooks convert better than emotional hooks for V60 articles."
  hypothesis          TEXT NOT NULL,

  -- One of: 'text_generation' | 'visual_generation' | 'instagram_post'.
  -- All variations within one experiment share this type. Multi-channel
  -- experiments (blog + IG) get separate experiment rows that reference
  -- each other via the optional parent_experiment_id below.
  task_type           TEXT NOT NULL,

  -- Which metric the orchestrator scores variations on. Primary signal.
  --   'ga4_conversions'       — best for text_generation
  --   'ga4_conversion_value'  — when revenue per page is meaningful
  --   'meta_engagement_rate'  — best for instagram_post
  --   'meta_reach'            — IG awareness experiments
  primary_metric      TEXT NOT NULL,

  -- Minimum days of post-publish data before the orchestrator scores.
  -- 7 for IG (engagement settles fast), 14 for SEO (attribution lag).
  min_lookback_days   INTEGER NOT NULL DEFAULT 7,

  -- Minimum per-variation sample size required before declaring a winner.
  -- e.g. for ga4_conversions: at least N sessions per variation.
  min_sample_size     INTEGER NOT NULL DEFAULT 50,

  -- Win-margin threshold. Winner's metric must be ≥ this × runner-up's.
  -- 1.5 = winner needs ~50% lead. Tunable per experiment.
  win_margin_multiplier NUMERIC NOT NULL DEFAULT 1.5,

  -- Lifecycle
  status              TEXT NOT NULL DEFAULT 'collecting'
                      CHECK (status IN ('collecting','evaluating','evaluated','inconclusive','cancelled')),
  winner_task_id      UUID REFERENCES seo_tasks(id),
  evaluation_summary  JSONB,   -- full comparison table + Claude's synthesized rule
  recorded_learning_id UUID REFERENCES seo_learnings(id),

  -- Optional: cross-experiment chaining. e.g. a 'multi-channel' parent
  -- experiment groups one blog-text experiment + one IG experiment that
  -- share a theme. Out of scope for v1; column reserved.
  parent_experiment_id UUID REFERENCES seo_experiments(id),

  orchestrator_run_id UUID,                            -- which run created it
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  evaluated_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS seo_experiments_collecting_idx
  ON seo_experiments (created_at) WHERE status = 'collecting';

CREATE INDEX IF NOT EXISTS seo_experiments_status_idx
  ON seo_experiments (status);

ALTER TABLE seo_experiments ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────
-- Hook seo_tasks into the experiment framework.
-- ─────────────────────────────────────────────────────────────────────────

-- experiment_id: nullable so non-experimental tasks (manual chat-queued,
-- ad-hoc dynamic experiments) still work. A task belongs to AT MOST one
-- experiment. Workers don't need to read this; they just preserve it
-- through to result_data for the evaluator to find later.
ALTER TABLE seo_tasks
  ADD COLUMN IF NOT EXISTS experiment_id   UUID REFERENCES seo_experiments(id),
  ADD COLUMN IF NOT EXISTS variation_label TEXT;

-- Find all variations of an experiment cheaply.
CREATE INDEX IF NOT EXISTS seo_tasks_experiment_idx
  ON seo_tasks (experiment_id) WHERE experiment_id IS NOT NULL;

-- Verify post-apply:
--   SELECT COUNT(*) FROM seo_experiments;          -- expect 0
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name='seo_tasks' AND column_name IN ('experiment_id','variation_label');
--   SELECT indexname FROM pg_indexes WHERE tablename IN ('seo_experiments','seo_tasks')
--     AND indexname LIKE '%experiment%';
