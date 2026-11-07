-- Async sync pattern: edge functions return 202 immediately and continue
-- work in background via EdgeRuntime.waitUntil. The frontend polls sync_log
-- to know when work is done. This migration extends sync_log with the
-- columns needed for that flow.
--
-- Why: google-sync (and meta-sync) routinely exceed Supabase's wall-clock
-- limit because they run 10+ paginated GAQL queries serially. Result was
-- HTTP 546 (worker timeout) at the client with no error in logs (the
-- timeout kills the worker before any catch block fires). We can't make
-- the API calls themselves faster, but we can return immediately and let
-- the work finish in the background — the client just polls for status.

-- 1. Add `stats` jsonb so the per-block row counts (campaign_rows,
--    keyword_rows, errors, etc.) are visible without a side table.
ALTER TABLE sync_log
  ADD COLUMN IF NOT EXISTS stats JSONB;

-- 2. Allow 'running' and 'partial' statuses (was 'success' | 'error' only).
--    No CHECK constraint exists today; documenting the new vocabulary in a
--    comment is enough for now.
COMMENT ON COLUMN sync_log.status IS
  'one of: running, success, partial, error. Frontend polls until != running.';

-- 3. Index on (platform, started_at DESC) so the dashboard can quickly find
--    the most recent run per platform without scanning the full table.
CREATE INDEX IF NOT EXISTS idx_sync_log_platform_started
  ON sync_log (platform, started_at DESC);
