-- customer_rfm: full order history, bean-gram M, and a schedule again.
--
-- rfm-sync was only ever called by GitHub auto-sync.yml, whose schedule was
-- switched off on 2026-04-21 (WORKER_RESOURCE_LIMIT). customer_rfm has not
-- changed since, and the strategist brain kept reading it: its "83 big
-- spenders" were people with one Feb–Apr 2026 order.
--
-- rfm-sync now reads customer_orders (2023 onward, merged identities) and
-- scores M on lifetime Minuto bean grams. These columns carry that:
--   customer_id  the merged customer the row describes
--   bean_grams   lifetime Minuto bean grams (resold brands and green excluded)
-- Rows the new run does not write are marked segment='superseded', not deleted.
--
-- ORDER: deploy rfm-sync (and the seo-agent readers) first, then apply this.
-- The cron's first run then rebuilds the table. Additive + idempotent.

ALTER TABLE customer_rfm
  ADD COLUMN IF NOT EXISTS customer_id uuid,
  ADD COLUMN IF NOT EXISTS bean_grams  integer;

-- 06:40 UTC daily: a free minute on the cron grid, before the strategist brain
-- (Mon 07:45) and the 08:00 health watchdog.
SELECT cron.unschedule('rfm-sync-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rfm-sync-daily');

SELECT cron.schedule(
  'rfm-sync-daily',
  '40 6 * * *',
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/rfm-sync',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1),
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object('trigger', 'cron'),
      timeout_milliseconds := 150000
    );
  $$
);
