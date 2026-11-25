// Applies the change log migrations up to the merges migration (twice) on a real
// Postgres (PGlite): redirect and post_status are accepted, every older value
// still is, the bundle columns exist, the switch is seeded OFF and not
// overwritten on a re-run.
//   deno run -A --node-modules-dir=none supabase/functions/handle-seo-chat/merges_migration_test.ts
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
await db.exec(`insert into public.site_change_log (target_type, target_id, source_fn, status, after) values ('seo_meta', 1, 'test', 'applied', '{}'::jsonb)`)

const mig = read('20261127120000_site_change_merges.sql')
let ok1 = true, ok2 = true
try { await db.exec(mig) } catch (e) { ok1 = false; console.error(e) }
await db.exec(`update public.ops_profile set value = '{"enabled": true}'::jsonb where key = 'seo_merge_proposals'`)
try { await db.exec(mig) } catch (e) { ok2 = false; console.error(e) }
check('migration applies', ok1)
check('migration re-runs cleanly', ok2)
const rules = (await db.query<{ n: number }>(`select count(*)::int as n from pg_constraint where conrelid = 'public.site_change_log'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%target_type%'`)).rows[0].n
check('exactly one target_type rule (replaced, not added)', rules === 1, String(rules))
check('existing rows kept', (await db.query<{ n: number }>(`select count(*)::int as n from public.site_change_log`)).rows[0].n === 1)
for (const t of ['post_faq', 'product_faq', 'product_description', 'post_content', 'post_featured_image', 'seo_meta', 'term_seo_meta', 'term_description', 'product_status', 'product_short_description', 'redirect', 'post_status']) {
  let accepted = true
  try { await db.exec(`insert into public.site_change_log (target_type, target_id, source_fn, status, after, bundle_id, bundle_seq) values ('${t}', 2, 'test', 'proposed', 'null'::jsonb, gen_random_uuid(), 1)`) } catch { accepted = false }
  check(`${t} accepted (with bundle columns)`, accepted)
}
let refused = false
try { await db.exec(`insert into public.site_change_log (target_type, target_id, source_fn, status) values ('delete_page', 1, 'test', 'proposed')`) } catch { refused = true }
check('an unknown type is still refused', refused)
const sw = (await db.query<{ value: { enabled: boolean } }>(`select value from public.ops_profile where key = 'seo_merge_proposals'`)).rows[0]?.value
check('switch seeded, and a re-run keeps the owner\'s value', sw?.enabled === true, JSON.stringify(sw))
const fresh = new PGlite()
await fresh.exec(`create role anon; create role authenticated; create role service_role; create function public.is_admin() returns boolean language sql as 'select true';
  create table public.ops_profile (key text primary key, value jsonb, description text, updated_at timestamptz default now());`)
for (const f of ['20261123120000_site_change_log.sql', '20261125130000_site_change_log_phase2_types.sql', '20261126130000_site_change_log_short_description.sql', '20261127120000_site_change_merges.sql']) await fresh.exec(read(f))
check('switch seeded OFF', (await fresh.query<{ value: { enabled: boolean } }>(`select value from public.ops_profile where key = 'seo_merge_proposals'`)).rows[0]?.value?.enabled === false)

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
