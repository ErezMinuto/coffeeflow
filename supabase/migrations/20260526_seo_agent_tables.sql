-- Minuto SEO Agent — task queue + metrics snapshots + chat history
--
-- Standalone schema for the SEO Agent system. Decoupled from advisor_reports
-- (the existing weekly-report table for the generic agents page); this lives
-- side-by-side so the SEO Agent can be sunset / rebuilt independently.
--
-- Three tables:
--   seo_tasks        — task queue, polled by cron-driven worker functions
--   seo_metrics      — append-only snapshots of GSC + business performance
--   chat_messages    — persistent chat history for the admin chat interface
--
-- All additive. Safe to apply on prod (no destructive changes).

-- ─────────────────────────────────────────────────────────────────────────
-- 1. seo_tasks — the task queue
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS seo_tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Task identity. task_type is free-form text (NOT an enum) so the
  -- orchestrator can emit novel "dynamic_experiment" subtypes that
  -- evolve over time without schema changes. Known canonical values:
  --   'text_generation'    — blog/article writing, picked up by seo-worker-writer
  --   'visual_generation'  — banner/IG image, picked up by seo-worker-visual
  --   'dynamic_experiment' — novel orchestrator-invented work; no auto-worker,
  --                          sits as pending for human review in /admin/seo-agent
  -- task_subtype is informational metadata for dynamic_experiment rows
  -- (e.g. 'technical_seo', 'content_optimization', 'pr_pitch').
  task_type       TEXT NOT NULL,
  task_subtype    TEXT,

  -- Lifecycle. Strict CHECK so workers can rely on the value set.
  status          TEXT NOT NULL DEFAULT 'pending',

  -- Retry semantics. attempts increments each time a worker picks the
  -- row up; max_attempts caps it (default 3). Once attempts >=
  -- max_attempts, status flips to 'failed' and the row needs human
  -- intervention.
  attempts        INT NOT NULL DEFAULT 0,
  max_attempts    INT NOT NULL DEFAULT 3,

  -- Dependency graph. parent_task_id is the immediate parent (e.g. a
  -- visual_generation task's parent is its text_generation task — same
  -- article, paired delivery). depends_on is the more general "this
  -- task can't start until these UUIDs are completed" — covers fan-in
  -- (e.g. a publish task that depends on both text + visual).
  parent_task_id  UUID REFERENCES seo_tasks(id) ON DELETE CASCADE,
  depends_on      UUID[] NOT NULL DEFAULT '{}',

  -- Payload. brief_data is the orchestrator's JSON instructions for the
  -- worker; result_data is what the worker writes back when done.
  -- See supabase/functions/seo-agent/types.ts for the per-task_type shapes.
  brief_data      JSONB NOT NULL,
  result_data     JSONB,
  error_msg       TEXT,

  -- Worker bookkeeping for SELECT FOR UPDATE SKIP LOCKED pickup.
  -- locked_until = "if this is in the past, the worker that grabbed the
  -- row has crashed; another worker can retry". worker_id = traceability.
  locked_until    TIMESTAMPTZ,
  worker_id       TEXT,

  -- Timing. scheduled_for allows the orchestrator to time-shift tasks
  -- (e.g. "publish this update 2 weeks after the original article").
  scheduled_for   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,

  -- Orchestrator audit. orchestrator_run_id groups every task spawned
  -- by one orchestrator invocation — useful for "show me what last
  -- Sunday's strategist run decided." rationale is the LLM's one-line
  -- justification, surfaced in the admin UI so we can read its thinking.
  orchestrator_run_id  UUID,
  rationale            TEXT,

  -- Bookkeeping.
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT seo_tasks_status_check
    CHECK (status IN ('pending','processing','completed','failed'))
);

-- Pickup index: workers query WHERE status='pending' AND scheduled_for <= NOW()
-- ORDER BY scheduled_for. Partial index keeps it small.
CREATE INDEX IF NOT EXISTS seo_tasks_pickup_idx
  ON seo_tasks (task_type, scheduled_for)
  WHERE status = 'pending';

-- Stuck-row recovery: a sweeper can find rows where locked_until is in
-- the past and reset them to 'pending' for retry.
CREATE INDEX IF NOT EXISTS seo_tasks_lock_expiry_idx
  ON seo_tasks (locked_until)
  WHERE status = 'processing';

-- Run lookup for the admin UI ("show all tasks from this run").
CREATE INDEX IF NOT EXISTS seo_tasks_run_idx
  ON seo_tasks (orchestrator_run_id)
  WHERE orchestrator_run_id IS NOT NULL;

-- Parent traversal for the visual worker ("find my parent text task's result").
CREATE INDEX IF NOT EXISTS seo_tasks_parent_idx
  ON seo_tasks (parent_task_id)
  WHERE parent_task_id IS NOT NULL;

-- updated_at trigger — matches the convention used elsewhere in this DB.
CREATE OR REPLACE FUNCTION seo_tasks_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS seo_tasks_updated_at ON seo_tasks;
CREATE TRIGGER seo_tasks_updated_at
  BEFORE UPDATE ON seo_tasks
  FOR EACH ROW
  EXECUTE FUNCTION seo_tasks_set_updated_at();

-- RLS: org-wide single-tenant table. Permissive policies match the
-- convention of every other shared business table in this DB
-- (advisor_reports, woo_products, etc.).
ALTER TABLE seo_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "seo_tasks_shared_select" ON seo_tasks
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "seo_tasks_shared_insert" ON seo_tasks
  FOR INSERT TO anon, authenticated WITH CHECK (true);

CREATE POLICY "seo_tasks_shared_update" ON seo_tasks
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

CREATE POLICY "seo_tasks_shared_delete" ON seo_tasks
  FOR DELETE TO anon, authenticated USING (true);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. seo_metrics — append-only performance snapshots
-- ─────────────────────────────────────────────────────────────────────────
-- Every orchestrator run writes one snapshot row. Optionally other
-- jobs (a daily GSC sync, a weekly Woo summary) can write too. The
-- orchestrator's self-reflection prompt reads recent rows to spot
-- trends ("kapsulot moved from #15 to #8") instead of querying source
-- tables every time. Source field tags origin so we can filter.

CREATE TABLE IF NOT EXISTS seo_metrics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  logged_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Tag of where this snapshot came from so we can filter:
  --   'orchestrator_run' — full snapshot at orchestrator invocation
  --   'gsc_sync'         — daily GSC pull
  --   'woo_sync'         — sales / revenue
  --   'manual'           — admin entered something via the chat tool
  source          TEXT NOT NULL,

  -- Free-form payload. Shape varies by source; see seo-agent/types.ts.
  -- For source='orchestrator_run' expect:
  --   { gsc_top_keywords: [...], gsc_position_deltas: {...},
  --     blog_published_count_30d: N, organic_traffic_30d: N,
  --     woo_revenue_7d: N, top_landing_pages: [...] }
  metrics_payload JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS seo_metrics_logged_at_idx
  ON seo_metrics (logged_at DESC);

CREATE INDEX IF NOT EXISTS seo_metrics_source_idx
  ON seo_metrics (source, logged_at DESC);

ALTER TABLE seo_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "seo_metrics_shared_select" ON seo_metrics
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "seo_metrics_shared_insert" ON seo_metrics
  FOR INSERT TO anon, authenticated WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. chat_messages — admin chat history
-- ─────────────────────────────────────────────────────────────────────────
-- Persistent thread storage for the /admin/seo-agent chat interface.
-- session_id groups messages from one conversation; the front-end picks
-- a UUID per browser session (or per "thread" if the admin starts a
-- new one).

CREATE TABLE IF NOT EXISTS chat_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      TEXT NOT NULL,

  -- Role conforms to Anthropic Messages API shape, plus 'tool' for
  -- tool-call result rows.
  --   'user'      — admin's message
  --   'assistant' — Claude's message (may include tool_calls)
  --   'tool'      — result of a tool call (tool_call_id references which)
  --   'system'    — system-emitted notes ("orchestrator just ran", etc.)
  role            TEXT NOT NULL,

  -- Plain-text content. For role='assistant' that uses tool_calls, this
  -- may be empty and tool_calls carries the structured intent.
  content         TEXT NOT NULL DEFAULT '',

  -- When the assistant invokes one or more tools (e.g. queue_task,
  -- approve_experiment), this holds the structured calls. JSON shape:
  --   [{ id: "call_xyz", name: "queue_task", input: { ... } }, ...]
  tool_calls      JSONB,

  -- When role='tool', references the call this row answers.
  tool_call_id    TEXT,

  -- Free-form metadata (token counts, model used, latency, etc.).
  metadata        JSONB,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chat_messages_role_check
    CHECK (role IN ('user','assistant','tool','system'))
);

CREATE INDEX IF NOT EXISTS chat_messages_session_idx
  ON chat_messages (session_id, created_at);

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "chat_messages_shared_select" ON chat_messages
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "chat_messages_shared_insert" ON chat_messages
  FOR INSERT TO anon, authenticated WITH CHECK (true);

CREATE POLICY "chat_messages_shared_delete" ON chat_messages
  FOR DELETE TO anon, authenticated USING (true);
