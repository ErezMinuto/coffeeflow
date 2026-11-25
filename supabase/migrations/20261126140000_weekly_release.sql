-- Phase 2: the weekly release. Approved site changes can wait in a queue
-- ('queued') and go live together once a week (Sunday 10:00 Israel), one change
-- per page per release, so each week's effect can be measured. Additive only:
--   * site_change_log.status gains 'queued' (every existing value stays allowed)
--   * site_change_log.release_id: the release that published a change
--   * site_releases: one row per release (and per dry run), what it published,
--     deferred to next week, or failed
--   * ops_profile 'seo_weekly_release': the switch, OFF until the owner turns it on
-- Safe to re-run.

ALTER TABLE public.site_change_log DROP CONSTRAINT IF EXISTS site_change_log_status_check;
ALTER TABLE public.site_change_log ADD CONSTRAINT site_change_log_status_check
  CHECK (status IN ('proposed', 'queued', 'applying', 'applied', 'rejected', 'failed', 'undone'));

CREATE TABLE IF NOT EXISTS public.site_releases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_date  date NOT NULL,                 -- Israel date of the release
  dry_run       boolean NOT NULL DEFAULT false,
  published     uuid[] NOT NULL DEFAULT '{}',  -- site_change_log ids written
  deferred      uuid[] NOT NULL DEFAULT '{}',  -- waiting for next week (one per page)
  failed        jsonb NOT NULL DEFAULT '[]',   -- [{ change_id, error }]
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- At most one real release per day; dry runs may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS site_releases_one_real_per_day ON public.site_releases (release_date) WHERE NOT dry_run;

ALTER TABLE public.site_change_log ADD COLUMN IF NOT EXISTS release_id uuid REFERENCES public.site_releases (id);
CREATE INDEX IF NOT EXISTS site_change_log_queued_idx ON public.site_change_log (approved_at) WHERE status = 'queued';

ALTER TABLE public.site_releases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_releases_admin_read ON public.site_releases;
CREATE POLICY site_releases_admin_read ON public.site_releases
  FOR SELECT TO authenticated USING (public.is_admin());
GRANT SELECT ON TABLE public.site_releases TO authenticated;
GRANT ALL ON TABLE public.site_releases TO service_role;

INSERT INTO public.ops_profile (key, value, description)
VALUES ('seo_weekly_release',
        '{"enabled": false, "weekday": 0, "hour": 10, "tz": "Asia/Jerusalem"}'::jsonb,
        'Weekly release of approved site changes. enabled:false = approving publishes at once (as before). enabled:true = approving queues the change; strategist-executor publishes the queue on weekday (0 = Sunday) at hour, Israel time, one change per page per release. "Publish now" in the inbox always publishes at once.')
ON CONFLICT (key) DO NOTHING;
