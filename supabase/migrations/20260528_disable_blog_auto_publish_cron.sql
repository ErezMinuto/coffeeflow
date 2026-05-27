-- Minuto SEO Agent — deprecate the old blog-auto-publish cron.
--
-- Why: the new seo-orchestrator + seo-worker-writer pipeline supersedes
-- the old blog-auto-publish cron for blog drafting. Both ran on the same
-- Sun + Wed schedule and would otherwise produce duplicate drafts going
-- forward.
--
-- What stays untouched (intentionally):
--   • organic-content-twice-weekly — generates IG content recs + Google
--     search recs into advisor_reports. The new SEO agent doesn't replace
--     IG content generation yet. Out of scope here.
--   • blog-publish (the edge function itself) — still used by both the
--     legacy blog-auto-publish path AND the new seo-worker-writer. Not
--     deleted. Just stopping the auto-publish CRON.
--
-- This migration is reversible: re-create the cron job with the same
-- jobname + schedule from migration 20260523_organic_agent_twice_weekly_cron.sql
-- if the new pipeline turns out to be a regression.
--
-- Idempotent: `WHERE EXISTS` guard so re-applying is a no-op.

SELECT cron.unschedule('blog-auto-publish-twice-weekly')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'blog-auto-publish-twice-weekly'
);

-- Verify post-apply:
--   SELECT jobname FROM cron.job WHERE jobname = 'blog-auto-publish-twice-weekly';
--   -- expect: 0 rows
