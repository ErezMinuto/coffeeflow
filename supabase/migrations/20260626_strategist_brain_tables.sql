-- Minuto Strategist Brain — core tables
--
-- A strategist TIER above the existing content-planner (organic-orchestrator).
-- A single Opus-4.8 ReAct loop reads a revenue-first business snapshot + memory,
-- reasons over several steps, and emits a "State of Minuto" brief, revenue-graded
-- theses, and capability/bug/feature signals. Phase 1 is THINKING ONLY — these
-- tables hold the brain's runs, output, long-term memory, agent->team signals,
-- and a cost ledger. No publishing/spending power is granted here.
--
-- Conventions follow the rest of the repo: gen_random_uuid() PKs, created_at/
-- updated_at defaults, org-wide shared RLS (anon + authenticated, USING(true)),
-- soft-supersede audit pattern copied from seo_learnings.

-- ───────────────────────────────────────────────────────────────────────────
-- strategist_runs — one reasoning run (mirrors agent_missions: tick-based loop
-- with locking + checkpointed state, so the loop survives the edge wall-clock).
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS strategist_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status        TEXT NOT NULL DEFAULT 'thinking'
                  CHECK (status IN ('thinking', 'brief_ready', 'failed', 'cancelled')),
  trigger       TEXT NOT NULL DEFAULT 'cron',      -- 'cron' | 'manual' — why this run started (observability)
  week_start    DATE,                              -- the week this run reasons about (per-week dedup guard)
  -- Stable, key-sorted business snapshot assembled at kickoff. Stored on the
  -- row so every advance-tick reuses the SAME prefix (prompt-cache friendly).
  snapshot      JSONB NOT NULL DEFAULT '{}',
  -- Evolving working memory: { step, scratchpad: [], observations: [], drilldowns: [] }
  state         JSONB NOT NULL DEFAULT '{}',
  steps_taken   INT NOT NULL DEFAULT 0,
  max_steps     INT NOT NULL DEFAULT 12,          -- hard cap; run fails-safe if exceeded
  locked_until  TIMESTAMPTZ,                       -- expired-lock self-heal (same as agent_missions)
  worker_id     TEXT,
  brief_id      UUID,                              -- set when the run concludes (no FK: avoids circular create order)
  cost_tokens   JSONB NOT NULL DEFAULT '{}',       -- rolled-up token usage for this run
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- advance-worker claim query: active + unlocked, oldest first
CREATE INDEX IF NOT EXISTS strategist_runs_claim_idx
  ON strategist_runs (updated_at)
  WHERE status = 'thinking';

-- COST + CONCURRENCY GUARD: at most ONE run may be 'thinking' at a time, so a
-- cron firing over a stuck run can't spin up a second concurrent Opus run. A new
-- kickoff hits a unique violation and skips; clear the slot by letting the run
-- conclude/fail, or mark it 'cancelled'.
CREATE UNIQUE INDEX IF NOT EXISTS strategist_runs_single_active_idx
  ON strategist_runs ((status))
  WHERE status = 'thinking';

-- ───────────────────────────────────────────────────────────────────────────
-- strategic_briefs — the deliverable ("State of Minuto"). Surfaces in the
-- /admin/seo-agent dashboard and is emailed to Erez. Reviewed, never auto-acted.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS strategic_briefs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID REFERENCES strategist_runs(id),
  week_start      DATE NOT NULL,
  summary         TEXT NOT NULL,                   -- 1-2 sentence read of the cycle
  diagnosis       JSONB NOT NULL DEFAULT '[]',     -- cited observations: [{ claim, evidence }]
  top_thesis      TEXT,                            -- the single highest-leverage bet this cycle
  recommendations JSONB NOT NULL DEFAULT '[]',     -- in-scope (content/email), drafted for later approval
  out_of_hands    JSONB NOT NULL DEFAULT '[]',     -- moves outside the agent's hands, for Erez to consider
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'emailed', 'reviewed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS strategic_briefs_week_idx ON strategic_briefs (week_start DESC);
CREATE INDEX IF NOT EXISTS strategic_briefs_status_idx ON strategic_briefs (status);

-- ───────────────────────────────────────────────────────────────────────────
-- strategic_theses — the driver-hypothesis ledger (Reflexion long-term memory,
-- graded against the REVENUE north-star). The agent's evolving belief about what
-- actually moves Minuto's sales. Soft-supersede preserves the audit trail.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS strategic_theses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thesis            TEXT NOT NULL,                 -- "Espresso buyers churn after one bag; the lever is retention."
  lever             TEXT NOT NULL,                 -- reach | retention | aov | reactivation | conversion | ... (agent-owned, free-form)
  rationale         TEXT,
  evidence_snapshot JSONB NOT NULL DEFAULT '{}',   -- the data slice that supports it (cited)
  success_metric    TEXT NOT NULL,                 -- the measurable proxy it will be judged on
  metric_baseline   NUMERIC,                       -- value at thesis creation (for the later check)
  check_date        DATE,                          -- when to score it against revenue
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'validated', 'refuted', 'superseded')),
  outcome           TEXT,                          -- set when validated/refuted ("audience grew 15%, orders flat — wrong")
  superseded_by     UUID REFERENCES strategic_theses(id),
  run_id            UUID,                          -- the run that authored it
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- active theses are read back into every run's prompt
CREATE INDEX IF NOT EXISTS strategic_theses_active_idx
  ON strategic_theses (created_at DESC)
  WHERE status = 'active';
-- theses due for a revenue check (Phase 3)
CREATE INDEX IF NOT EXISTS strategic_theses_due_idx
  ON strategic_theses (check_date)
  WHERE status = 'active';

-- ───────────────────────────────────────────────────────────────────────────
-- strategist_signals — the agent -> team channel. When the brain discovers it
-- NEEDS a tool/data, or SPOTS a bug/feature, it informs Erez here. Evidence-gated
-- (a concrete blocked decision / confirmed anomaly, not a wishlist). dedupe_key +
-- read-back of declines stop it re-asking. The agent REPORTS, never self-fixes.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS strategist_signals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              TEXT NOT NULL
                      CHECK (kind IN ('capability_request', 'bug_report', 'feature_idea')),
  title             TEXT NOT NULL,
  detail            TEXT,
  evidence          JSONB NOT NULL DEFAULT '{}',   -- the data/anomaly that justifies it
  blocked_decision  TEXT,                          -- the concrete decision this gates (capability_request)
  leverage          TEXT,                          -- rough expected payoff if addressed
  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'approved', 'building', 'shipped', 'declined')),
  decline_reason    TEXT,
  dedupe_key        TEXT,                          -- stable hash; checked before re-emitting
  run_id            UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS strategist_signals_status_idx ON strategist_signals (status, kind);
CREATE INDEX IF NOT EXISTS strategist_signals_dedupe_idx ON strategist_signals (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- agent_cost_ledger — one row per callClaude() return across the agent stack.
-- Powers the monthly kill-switch and lets us design against a REAL spend number
-- ($150/mo ceiling). callClaude already returns the token counts.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_cost_ledger (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_fn              TEXT NOT NULL,            -- e.g. 'strategist-brain', 'organic-orchestrator'
  run_id                 UUID,
  model                  TEXT,
  input_tokens           INT NOT NULL DEFAULT 0,
  output_tokens          INT NOT NULL DEFAULT 0,
  cache_read_tokens      INT NOT NULL DEFAULT 0,
  cache_creation_tokens  INT NOT NULL DEFAULT 0,
  est_usd                NUMERIC(10,4) NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- monthly rollup for the kill-switch
CREATE INDEX IF NOT EXISTS agent_cost_ledger_created_idx ON agent_cost_ledger (created_at DESC);
CREATE INDEX IF NOT EXISTS agent_cost_ledger_function_idx ON agent_cost_ledger (source_fn, created_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- RLS — org-wide shared tables (anon key acts as the org API key; Clerk JWT =
-- authenticated). Mirrors 20260403_shared_tables_rls.sql exactly.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'strategist_runs', 'strategic_briefs', 'strategic_theses',
    'strategist_signals', 'agent_cost_ledger'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY "%1$s_shared_select" ON %1$I
      FOR SELECT TO anon, authenticated USING (true)$p$, t);
    EXECUTE format($p$CREATE POLICY "%1$s_shared_insert" ON %1$I
      FOR INSERT TO anon, authenticated WITH CHECK (true)$p$, t);
    EXECUTE format($p$CREATE POLICY "%1$s_shared_update" ON %1$I
      FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true)$p$, t);
    EXECUTE format($p$CREATE POLICY "%1$s_shared_delete" ON %1$I
      FOR DELETE TO anon, authenticated USING (true)$p$, t);
  END LOOP;
END $$;
