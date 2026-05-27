-- Minuto Organic Marketing — system_config for tunable thresholds.
--
-- Single-table key-value store for runtime knobs. Functions check
-- system_config first; fall back to their hardcoded default if no row.
--
-- Knobs that should live here (initial set):
--   scout.meta_spike_multiplier         (default 2.0)
--   scout.industry_min_relevance        (default 0.85)
--   evaluator.auto_supersede_threshold  (default -2)
--   visual_worker.max_brief_regens      (default 2)
--   evaluator.default_win_margin        (default 1.5)
--   evaluator.default_min_sample_size   (default 50)
--   evaluator.default_min_lookback_days (default 7)
--
-- Per-experiment thresholds (on seo_experiments) take precedence over
-- the global defaults here — this table only sets the GLOBAL defaults
-- + the scout/watchdog/regen knobs that aren't per-experiment.
--
-- value column is JSONB so we can store numbers, strings, arrays, or
-- structured config in the same column. Readers cast as needed.

CREATE TABLE IF NOT EXISTS system_config (
  key           TEXT PRIMARY KEY,
  value         JSONB NOT NULL,
  description   TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    TEXT,                       -- 'admin_manual' | 'chat_agent' | 'orchestrator'
  reasoning     TEXT                        -- WHY this value (audit trail)
);

ALTER TABLE system_config ENABLE ROW LEVEL SECURITY;

-- Seed defaults. Functions ALSO have these as hardcoded fallbacks, so
-- the seeding is more for documentation/discoverability than necessity.
INSERT INTO system_config (key, value, description, updated_by, reasoning) VALUES
  ('scout.meta_spike_multiplier',          '2.0'::jsonb,  'Scout flags an IG post when engagement_rate ≥ N × 7d median', 'admin_manual', 'initial v1 default'),
  ('scout.industry_min_relevance',         '0.85'::jsonb, 'Scout flags an industry article when relevance ≥ N (0-1)', 'admin_manual', 'initial v1 default'),
  ('evaluator.auto_supersede_threshold',   '-2'::jsonb,   'Auto-supersede an orchestrator-written learning when evidence_score ≤ N', 'admin_manual', 'initial v1 default'),
  ('visual_worker.max_brief_regens',       '2'::jsonb,    'Max times a visual task can regen its brief before HITL', 'admin_manual', 'initial v1 default; 2 regens = 9 total image-gen attempts'),
  ('evaluator.default_win_margin',         '1.5'::jsonb,  'Default winner must be N× runner-up to count (per-experiment override allowed)', 'admin_manual', 'initial v1 default'),
  ('evaluator.default_min_sample_size',    '50'::jsonb,   'Default min per-variation sample size on the denominator field', 'admin_manual', 'initial v1 default'),
  ('evaluator.default_min_lookback_days',  '7'::jsonb,    'Default days before an experiment is eligible for evaluation', 'admin_manual', 'initial v1 default')
ON CONFLICT (key) DO NOTHING;
