-- Phase 3 (judgment): every live site change is checked against what it was
-- expected to do. Additive only, safe to re-run:
--   baseline   the page's numbers when the change went live (Search Console
--              28-day window, site total, GA4 organic sessions for 28 days before)
--   result     the same after the change, plus the judgement
--   verdict    win | loss | neutral | too_little_data
--   judged_at  when it was judged
--   ops_profile 'seo_change_judge': OFF until the owner turns it on; file_undo
--   decides whether a loss files an undo proposal to the inbox.

ALTER TABLE public.site_change_log ADD COLUMN IF NOT EXISTS baseline  jsonb;
ALTER TABLE public.site_change_log ADD COLUMN IF NOT EXISTS result    jsonb;
ALTER TABLE public.site_change_log ADD COLUMN IF NOT EXISTS verdict   text;
ALTER TABLE public.site_change_log ADD COLUMN IF NOT EXISTS judged_at timestamptz;
ALTER TABLE public.site_change_log DROP CONSTRAINT IF EXISTS site_change_log_verdict_check;
ALTER TABLE public.site_change_log ADD CONSTRAINT site_change_log_verdict_check
  CHECK (verdict IS NULL OR verdict IN ('win', 'loss', 'neutral', 'too_little_data'));

INSERT INTO public.ops_profile (key, value, description)
VALUES ('seo_change_judge',
        '{"enabled": false, "file_undo": false}'::jsonb,
        'Phase 3: strategist-evaluator (daily) records each applied site change''s baseline and, on its check date, judges it (win / loss / neutral / too little data) against the page''s Search Console clicks, adjusted for the site-wide trend. enabled:false = measure nothing. file_undo:true = a loss files an undo proposal to the approvals inbox. Lessons go to seo_learnings.')
ON CONFLICT (key) DO NOTHING;
