// Applies the change-log migrations, then 20261126140000_weekly_release.sql twice,
// on a real Postgres (PGlite): 'queued' becomes a valid status (the old rule is
// replaced, not duplicated), existing rows stay valid, site_releases allows one real
// release per date (dry runs may repeat), release_id links a change to its release,
// and the switch is seeded OFF without overwriting an existing value.
//   deno run -A --node-modules-dir=none supabase/functions/handle-seo-chat/weekly_release_migration_test.ts
import { PGlite } from 'npm:@electric-sql/pglite@0.2.17'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const read = (f: string) => Deno.readTextFileSync(new URL(`../../migrations/${f}`, import.meta.url))
const db = new PGlite()
await db.exec(`create role anon; create role authenticated; create role service_role;
  create function public.is_admin() returns boolean language sql as 'select true';
  create table public.ops_profile (key text primary key, value jsonb, description text, updated_at timestamptz default now());`)
for (const f of ['20261123120000_site_change_log.sql', '20261125130000_site_change_log_phase2_types.sql', '20261126130000_site_change_log_short_description.sql']) await db.exec(read(f))
const statusRules = async () => (await db.query<{ conname: string }>(`select conname from pg_constraint where conrelid = 'public.site_change_log'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%applying%'`)).rows
check('the original status rule has the name the migration drops', (await statusRules()).map((r) => r.conname).join() === 'site_change_log_status_check', JSON.stringify(await statusRules()))
await db.exec(`insert into public.site_change_log (target_type, target_id, source_fn, status, after) values ('product_description', 1, 'test', 'applied', '"x"'::jsonb)`)

const mig = read('20261126140000_weekly_release.sql')
let ok1 = true, ok2 = true
try { await db.exec(mig) } catch (e) { ok1 = false; console.error(e) }
await db.exec(`update public.ops_profile set value = '{"enabled": true}'::jsonb where key = 'seo_weekly_release'`)
try { await db.exec(mig) } catch (e) { ok2 = false; console.error(e) }
check('migration applies', ok1)
check('migration re-runs cleanly', ok2)
check('exactly one status rule afterwards', (await statusRules()).length === 1)
check('existing rows kept', (await db.query<{ n: number }>(`select count(*)::int as n from public.site_change_log`)).rows[0].n === 1)

const status = async (s: string) => { try { await db.exec(`insert into public.site_change_log (target_type, target_id, source_fn, status, after) values ('product_faq', 2, 'test', '${s}', '"x"'::jsonb)`); return true } catch { return false } }
check('accepts queued', await status('queued'))
for (const s of ['proposed', 'applying', 'applied', 'rejected', 'failed', 'undone']) check(`still accepts ${s}`, await status(s))
check('still refuses an unknown status', !(await status('approved')))

await db.exec(`insert into public.site_releases (release_date) values ('2026-11-29')`)
let dup = false
try { await db.exec(`insert into public.site_releases (release_date) values ('2026-11-29')`) } catch { dup = true }
check('one real release per date', dup)
let dry = true
try { await db.exec(`insert into public.site_releases (release_date, dry_run) values ('2026-11-29', true), ('2026-11-29', true)`) } catch { dry = false }
check('dry runs on the same date are allowed', dry)
const rel = (await db.query<{ id: string }>(`select id from public.site_releases where not dry_run limit 1`)).rows[0].id
let linked = true
try { await db.exec(`update public.site_change_log set release_id = '${rel}' where status = 'applied'`) } catch { linked = false }
check('a change can point to its release', linked)
const sw = (await db.query<{ value: { enabled: boolean } }>(`select value from public.ops_profile where key = 'seo_weekly_release'`)).rows[0]?.value
check('switch seeded, and a re-run does not overwrite the owner\'s value', sw?.enabled === true)

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
