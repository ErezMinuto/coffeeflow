// Runs migrations/20261124120000_seo_audit_data.sql on a real Postgres
// (PGlite, in-process) twice, to check it applies and is safe to re-run.
//   deno run -A --node-modules-dir=none supabase/functions/strategist-brain/seo_audit_migration_test.ts
import { PGlite } from 'npm:@electric-sql/pglite@0.2.17'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const mig = Deno.readTextFileSync(new URL('../../migrations/20261124120000_seo_audit_data.sql', import.meta.url))
const db = new PGlite()
// What the migration relies on from the real database.
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create function public.is_admin() returns boolean language sql as 'select true';
  create table public.strategic_briefs (id uuid primary key default gen_random_uuid(), summary text not null);
  insert into public.strategic_briefs (summary) values ('existing brief');`)

let applied = true
try { await db.exec(mig) } catch (e) { applied = false; console.error(e) }
check('migration applies', applied)
let reapplied = true
try { await db.exec(mig) } catch (e) { reapplied = false; console.error(e) }
check('migration re-runs cleanly', reapplied)

const existing = (await db.query<{ seo_audit: unknown }>(`select seo_audit from strategic_briefs`)).rows[0]
check('existing briefs get an empty audit, not null', JSON.stringify(existing?.seo_audit) === '{}')

await db.exec(`insert into gsc_query_page (period_end, period_days, query, page, clicks, impressions) values ('2026-11-23', 28, 'q', 'p', 1, 10)`)
let dupRefused = false
try { await db.exec(`insert into gsc_query_page (period_end, period_days, query, page) values ('2026-11-23', 28, 'q', 'p')`) } catch { dupRefused = true }
check('one row per window + search + page', dupRefused)

const crawl = (await db.query<{ id: string }>(`insert into site_crawls default values returning id`)).rows[0].id
await db.exec(`insert into site_crawl_pages (crawl_id, url, status, schema_types, internal_links) values ('${crawl}', 'https://www.minuto.co.il/', 200, '{WebSite}', '{/a/,/b/}')`)
await db.exec(`delete from site_crawls where id = '${crawl}'`)
const left = (await db.query<{ n: number }>(`select count(*)::int as n from site_crawl_pages`)).rows[0].n
check('deleting a crawl removes its pages', left === 0)

let badStatus = false
try { await db.exec(`insert into site_crawls (status) values ('weird')`) } catch { badStatus = true }
check('crawl status is checked', badStatus)

const rls = (await db.query<{ relname: string; relrowsecurity: boolean }>(`select relname, relrowsecurity from pg_class where relname in ('gsc_query_page','site_crawls','site_crawl_pages','page_speed','gsc_url_inspection')`)).rows
check('row-level security on all five tables', rls.length === 5 && rls.every((r) => r.relrowsecurity), JSON.stringify(rls))
const policies = (await db.query<{ n: number }>(`select count(*)::int as n from pg_policies where policyname like '%_admin_read'`)).rows[0].n
check('an admin read policy per table', policies === 5, String(policies))

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
