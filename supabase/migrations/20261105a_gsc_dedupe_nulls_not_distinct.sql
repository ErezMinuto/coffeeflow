-- google_search_console: remove duplicate rows and make NULL pages conflict.
--
-- Why: keyword rows are written with page = NULL, and the table's unique key
-- UNIQUE(date, keyword, page) was a plain one, where NULLs never equal each
-- other. So the sync's upsert (onConflict 'date,keyword,page') never matched an
-- existing keyword row and INSERTED a new copy on every run. On 2026-11-05 prod
-- had 35,829 rows for 4,870 distinct (date, keyword, page) keys, and every
-- reader that sums these rows (SEO agent, strategist, blog keyword gate,
-- marketing advisor) over-counted clicks and impressions about 7x.
--
-- (a) DELETES duplicates: for each (date, keyword, page), NULL pages counted as
--     equal, keeps the row with the latest synced_at (ties: the larger id) and
--     deletes the rest. Expected on 2026-11-05: about 30,959 rows deleted,
--     4,870 kept. All copies of a key come from the same Search Console
--     numbers re-fetched on different days; the newest is the most complete
--     (Search Console revises recent days for about 3 days).
-- (b) Replaces the unique constraint with UNIQUE NULLS NOT DISTINCT
--     (date, keyword, page), so the existing upsert updates the row in place.
--
-- One transaction: if (b) fails, (a) is rolled back too. The table is locked
-- against writes for the duration so a sync running at the same moment cannot
-- slip a new duplicate in between (a) and (b). It is a ~36k-row table; this
-- takes well under a second.
--
-- Dry run (read-only; how many rows (a) would delete / keep):
--   select count(*) - count(distinct (date, keyword, coalesce(page, E'\x01'))) as will_delete,
--          count(distinct (date, keyword, coalesce(page, E'\x01')))            as will_keep
--   from google_search_console;

BEGIN;

DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'UNIQUE NULLS NOT DISTINCT needs Postgres 15+, this is %', current_setting('server_version');
  END IF;
END $$;

LOCK TABLE google_search_console IN SHARE ROW EXCLUSIVE MODE;

-- (a) keep the newest row per key, NULL page equal to NULL page
DELETE FROM google_search_console g
USING (
  SELECT id,
         row_number() OVER (
           PARTITION BY date, keyword, page   -- window PARTITION BY groups NULLs together
           ORDER BY synced_at DESC NULLS LAST, id DESC
         ) AS rn
  FROM google_search_console
) ranked
WHERE g.id = ranked.id
  AND ranked.rn > 1;

-- (b) unique key where NULL pages conflict
ALTER TABLE google_search_console
  DROP CONSTRAINT IF EXISTS google_search_console_date_keyword_page_key;

ALTER TABLE google_search_console
  ADD CONSTRAINT google_search_console_date_keyword_page_key
  UNIQUE NULLS NOT DISTINCT (date, keyword, page);

-- Fail the whole migration if anything is still duplicated.
DO $$
DECLARE total bigint; keys bigint;
BEGIN
  SELECT count(*), count(DISTINCT (date, keyword, coalesce(page, E'\x01'))) INTO total, keys FROM google_search_console;
  IF total <> keys THEN
    RAISE EXCEPTION 'still duplicated after dedupe: % rows, % keys', total, keys;
  END IF;
END $$;

COMMIT;
