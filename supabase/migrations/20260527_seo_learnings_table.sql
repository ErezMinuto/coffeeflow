-- Minuto SEO Agent — cross-session learnings.
--
-- Persists structured insights surfaced during admin chat conversations
-- (or written by the orchestrator on its own) so they survive across
-- sessions and shape future planning. The chat agent itself has no
-- memory between sessions — by recording an insight here, the admin's
-- "I don't like X" becomes durable system knowledge.
--
-- Wiring:
--   • chat agent injects last N learnings as a "STANDING INSIGHTS"
--     context block at the top of its system prompt (per session)
--   • orchestrator injects scope-filtered learnings into the
--     strategist user message so the next planning cycle applies them
--   • workers don't read learnings directly — they get them indirectly
--     via the briefs the orchestrator emits
--
-- Soft-supersede pattern (not hard-delete):
--   When an insight becomes obsolete, set superseded_at + superseded_reason
--   instead of deleting the row. The audit trail survives — useful when
--   the strategist looks back at why an old recommendation was retracted.
--
-- All additive. Safe to apply on prod.

CREATE TABLE IF NOT EXISTS seo_learnings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Loose taxonomy — NOT an enum so new scopes can emerge organically.
  -- Known values today:
  --   'visual_style'      — image preferences (no hands, no scattered beans, etc.)
  --   'brand_voice'       — tone/copy rules surfaced via chat
  --   'render_strategy'   — when bag_hero vs no_bag works/doesn't
  --   'content_topic'     — which topics resonate, which don't
  --   'qa_pattern'        — recurring QA fail modes worth pre-empting
  --   'other'             — anything that doesn't fit
  scope               TEXT        NOT NULL,

  -- One- to three-sentence insight in plain English. The chat agent
  -- writes these from conversations; the orchestrator could write
  -- summaries of its own self_reflection too (future).
  insight             TEXT        NOT NULL,

  -- Optional: which seo_tasks rows triggered this learning. Useful when
  -- reviewing why a learning was recorded — admin can dig into the
  -- specific cases that led to the insight.
  evidence_task_ids   UUID[]      NOT NULL DEFAULT '{}',

  -- Provenance — who/what recorded the insight.
  --   'chat_agent'     — recorded via handle-seo-chat tool call
  --   'orchestrator'   — recorded by the strategist (future)
  --   'admin_manual'   — recorded by an admin direct UI action (future)
  created_by          TEXT        NOT NULL,

  -- Soft-supersede. NULL = active learning, included in future prompts.
  -- When set, the row is preserved for audit but NOT injected into
  -- chat/orchestrator context.
  superseded_at       TIMESTAMPTZ,
  superseded_reason   TEXT,
  -- Optional: the new learning that replaced this one (e.g. when an
  -- evolving stance refines a prior insight).
  superseded_by       UUID        REFERENCES seo_learnings(id),

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Active learnings, newest first — the primary read path (chat prompt
-- + orchestrator user message).
CREATE INDEX IF NOT EXISTS seo_learnings_active_recent_idx
  ON seo_learnings (created_at DESC)
  WHERE superseded_at IS NULL;

-- Scoped lookup for the orchestrator when it wants only specific scopes
-- (e.g. visual_style + render_strategy for visual planning).
CREATE INDEX IF NOT EXISTS seo_learnings_scope_active_idx
  ON seo_learnings (scope, created_at DESC)
  WHERE superseded_at IS NULL;

-- Service-role-only: writes via edge functions using the service_role
-- key, which bypasses RLS. No anon access path. RLS on with no policy
-- = service role keeps full access, anon fully denied.
ALTER TABLE seo_learnings ENABLE ROW LEVEL SECURITY;

-- Sanity verification (run manually post-apply):
--   SELECT COUNT(*) FROM seo_learnings;  -- expect 0
--   SELECT indexname FROM pg_indexes WHERE tablename = 'seo_learnings';
