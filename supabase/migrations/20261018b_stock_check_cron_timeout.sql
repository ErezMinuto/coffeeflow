-- coffeeflow-stock-check: give the call 30 s instead of pg_net's 5 s default.
--
-- It was the one gated cron job with no timeout_milliseconds. woo-stock-check
-- takes ~2.3 s (Woo stock lookups), and since it checks its caller (#404) the
-- vault key's Auth check adds to that, so the 18:10 and 19:10 UTC runs on
-- 2026-10-17 hit "Timeout of 5000 ms reached" in net._http_response. The
-- function still ran; only the response was lost. 30 s matches
-- attendance-reminder.
--
-- Edits the existing command in place (only the body := … ) part), so the
-- schedule, URL and vault-key header stay exactly as they are. Idempotent:
-- skipped once a timeout is present.

SELECT cron.alter_job(
  job_id  := jobid,
  command := regexp_replace(command, $re$('\{\}'::jsonb)\s*\)$re$, $rep$\1, timeout_milliseconds := 30000)$rep$)
)
FROM cron.job
WHERE jobname = 'coffeeflow-stock-check'
  AND command !~ 'timeout_milliseconds';
