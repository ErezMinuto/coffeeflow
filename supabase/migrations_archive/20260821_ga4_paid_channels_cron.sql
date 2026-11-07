-- GA4: sync the PAID and other channels, not just Organic.
--
-- ga4-sync has always accepted a channel_group parameter but defaults to
-- 'Organic Search', and the only cron ever scheduled used that default. GA4
-- therefore held organic data exclusively, and the paid agent had no
-- independent view of whether its traffic arrived or converted — the one
-- measurement derived from neither the Meta pixel (12x inflated) nor our UTM
-- field (empty on 58% of orders).
--
-- One job per channel rather than one job looping: a failure on any single
-- channel then cannot take the others down with it, and each appears separately
-- in cron.job_run_details.
--
-- 06:10-06:40 UTC, staggered after the existing organic run at 06:00 so the
-- five never contend for the GA4 API quota at once.
DO $$
DECLARE
  ch   TEXT;
  mins INT := 10;
BEGIN
  FOREACH ch IN ARRAY ARRAY['Paid Social','Paid Search','Direct','Referral']
  LOOP
    PERFORM cron.unschedule('ga4-sync-' || lower(replace(ch,' ','-')))
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ga4-sync-' || lower(replace(ch,' ','-')));
    PERFORM cron.schedule(
      'ga4-sync-' || lower(replace(ch,' ','-')),
      mins || ' 6 * * *',
      format($cmd$
        SELECT net.http_post(
          url     := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/ga4-sync',
          headers := jsonb_build_object('Content-Type','application/json'),
          body    := jsonb_build_object('channel_group', %L, 'days', 7)
        );
      $cmd$, ch)
    );
    mins := mins + 10;
  END LOOP;
END $$;
