-- Handles for Gemini's explicit context caches.
--
-- Anthropic caching is INLINE: mark a block with cache_control and the prefix
-- is cached server-side, keyed by its own content. Nothing to store.
--
-- Gemini's is an OBJECT: you POST /v1beta/cachedContents once to get back a
-- name like `cachedContents/abc123`, then reference that name on later calls
-- and omit the cached parts. Edge functions are stateless between invocations,
-- so the name has to live somewhere — hence this table.
--
-- Why it matters: measured 2026-08-31 on handle-seo-chat, Claude read 35,981
-- tokens from cache and paid full price on 4, while Gemini paid full price on
-- all 79,484 — $0.169 vs $0.398 a call. The chat carries a 5-10K system prompt
-- plus 41 tool schemas on every single call, so the prefix is most of the bill.
CREATE TABLE IF NOT EXISTS gemini_prompt_cache (
  -- sha256 of model + system prompt + tool declarations. Any change to any of
  -- them yields a different key, so a stale cache can never be reused.
  cache_key   TEXT        PRIMARY KEY,
  -- Gemini's handle, e.g. 'cachedContents/abc123'.
  cache_name  TEXT        NOT NULL,
  model       TEXT        NOT NULL,
  token_count INT,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS gemini_prompt_cache_expiry_idx
  ON gemini_prompt_cache (expires_at);

ALTER TABLE gemini_prompt_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "gemini_prompt_cache_select" ON gemini_prompt_cache FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "gemini_prompt_cache_insert" ON gemini_prompt_cache FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "gemini_prompt_cache_update" ON gemini_prompt_cache FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "gemini_prompt_cache_delete" ON gemini_prompt_cache FOR DELETE TO anon, authenticated USING (true);
