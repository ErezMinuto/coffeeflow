// Runs migrations/20261105a_gsc_dedupe_nulls_not_distinct.sql on a real
// Postgres (PGlite, in-process, no server) seeded with the duplicate pattern
// found in prod, then checks the upsert the sync sends now updates in place.
//   deno run -A --node-modules-dir=none supabase/functions/google-search-sync/migration_test.ts
import { PGlite } from 'npm:@electric-sql/pglite@0.2.17'

const dir = new URL('../../migrations/', import.meta.url)
const base = Deno.readTextFileSync(new URL('20260408_google_search_console.sql', dir))
  .replace(/ALTER TABLE google_search_console ENABLE ROW LEVEL SECURITY;[\s\S]*$/, '') // no roles in PGlite
const mig = Deno.readTextFileSync(new URL('20261105a_gsc_dedupe_nulls_not_distinct.sql', dir))
const totalsMig = Deno.readTextFileSync(new URL('20261105b_gsc_keyword_totals.sql', dir))

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const db = new PGlite()
await db.exec(base)
// 2 keywords x 7 copies of the same day (NULL page, clicks = copy number, newest copy last),
// 2 distinct page rows, 1 keyword row with NULL synced_at.
await db.exec(`
  insert into google_search_console(date, keyword, page, clicks, impressions, synced_at)
    select '2026-11-01', 'k' || k, null, s, 10 * s, now() - (7 - s) * interval '1 hour'
    from generate_series(1, 2) k, generate_series(1, 7) s;
  insert into google_search_console(date, keyword, page, clicks, impressions, synced_at) values
    ('2026-11-01', '__page__', '/a', 5, 50, now()), ('2026-11-01', '__page__', '/b', 6, 60, now()),
    ('2026-11-02', 'k1', null, 1, 1, null);`)
const dry = mig.match(/-- Dry run[^\n]*\n((?:--[^\n]*\n)+)/)![1].replace(/^--\s?/gm, '')
const d = (await db.query<{ will_delete: number; will_keep: number }>(dry)).rows[0]
check('dry run counts', Number(d.will_delete) === 12 && Number(d.will_keep) === 5, JSON.stringify(d))

await db.exec(mig)
const rows = (await db.query<{ keyword: string; page: string | null; clicks: number; date: string }>(
  `select date::text, keyword, page, clicks from google_search_console order by 1, 2, 3`)).rows
check('5 rows left', rows.length === 5, String(rows.length))
check('kept the newest copy', rows.filter(r => r.date === '2026-11-01' && r.keyword.startsWith('k')).every(r => r.clicks === 7))
check('page rows untouched', rows.filter(r => r.keyword === '__page__').map(r => r.clicks).join() === '5,6')
const def = (await db.query<{ d: string }>(`select pg_get_constraintdef(oid) d from pg_constraint where conname = 'google_search_console_date_keyword_page_key'`)).rows
check('constraint is NULLS NOT DISTINCT', def.length === 1 && def[0].d === 'UNIQUE NULLS NOT DISTINCT (date, keyword, page)', JSON.stringify(def))

// The statement PostgREST sends for upsert(..., { onConflict: 'date,keyword,page' }).
await db.exec(`insert into google_search_console(date, keyword, page, clicks) values
  ('2026-11-01', 'k1', null, 99), ('2026-11-01', '__page__', '/a', 77), ('2026-11-03', 'new', null, 1)
  on conflict (date, keyword, page) do update set clicks = excluded.clicks`)
const after = (await db.query<{ n: number; k1: number; pa: number }>(`select count(*)::int n,
  max(clicks) filter (where date = '2026-11-01' and keyword = 'k1') k1,
  max(clicks) filter (where keyword = '__page__' and page = '/a') pa from google_search_console`)).rows[0]
check('upsert updates NULL-page row in place', after.n === 6 && after.k1 === 99 && after.pa === 77, JSON.stringify(after))
let msg = ''
try { await db.exec(`insert into google_search_console(date, keyword, page) values ('2026-11-01', 'k2', null)`) } catch (e) { msg = (e as Error).message }
check('plain duplicate insert now rejected', msg.includes('google_search_console_date_keyword_page_key'), msg)
await db.exec(mig)
check('re-running the migration is a no-op', (await db.query<{ n: number }>(`select count(*)::int n from google_search_console`)).rows[0].n === 6)

// ── 20261105b: gsc_keyword_totals sums in SQL what the readers used to sum in code
await db.exec(`create role anon; create role authenticated; create role service_role;`)
await db.exec(totalsMig)
await db.exec(`delete from google_search_console;
  insert into google_search_console(date, keyword, page, clicks, impressions, position) values
    ('2026-10-01', 'פולי קפה', null, 2, 100, 10), ('2026-10-02', 'פולי קפה', null, 1, 300, 6),
    ('2026-10-02', 'v60', null, 0, 0, 30), ('2026-10-03', 'v60', null, 0, 0, 20),
    ('2026-09-01', 'old', null, 9, 900, 1),
    ('2026-10-02', '__page__', '/a', 50, 5000, 1);`)
type T = { keyword: string; clicks: number; impressions: number; ctr: number; position: number; days: number; last_date: string }
const t = (await db.query<T>(`select keyword, clicks::int, impressions::int, ctr, position, days, last_date::text from gsc_keyword_totals('2026-10-01') order by keyword`)).rows
const by = Object.fromEntries(t.map(r => [r.keyword, r]))
check('totals: window and __page__ filter', t.length === 2 && !by['__page__'] && !by['old'], JSON.stringify(t.map(r => r.keyword)))
check('totals: sums', by['פולי קפה'].clicks === 3 && by['פולי קפה'].impressions === 400)
check('totals: impression-weighted position', by['פולי קפה'].position === 7, String(by['פולי קפה'].position))
check('totals: ctr', by['פולי קפה'].ctr === 3 / 400)
check('totals: 0 impressions → mean position, ctr 0', by['v60'].position === 25 && by['v60'].ctr === 0)
check('totals: days + last_date', by['פולי קפה'].days === 2 && by['פולי קפה'].last_date === '2026-10-02')
const until = (await db.query<T>(`select keyword from gsc_keyword_totals('2026-10-01', '2026-10-02')`)).rows
check('totals: p_until respected', until.length === 2)
const acl = (await db.query<{ anon: boolean; svc: boolean }>(`select has_function_privilege('anon', 'gsc_keyword_totals(date,date)', 'execute') anon,
  has_function_privilege('service_role', 'gsc_keyword_totals(date,date)', 'execute') svc`)).rows[0]
check('totals: anon cannot execute, service_role can', acl.anon === false && acl.svc === true, JSON.stringify(acl))
await db.exec(totalsMig)
check('totals: migration re-runs cleanly', true)

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
