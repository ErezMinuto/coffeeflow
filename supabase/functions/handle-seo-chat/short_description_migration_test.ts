// Applies migrations/20261123120000_site_change_log.sql and the Phase 2 types
// migration, then 20261126130000_site_change_log_short_description.sql twice, on a
// real Postgres (PGlite): the old rule is replaced (not duplicated), every existing
// row and value stays valid, product_short_description is accepted, anything else is refused.
//   deno run -A --node-modules-dir=none supabase/functions/handle-seo-chat/short_description_migration_test.ts
import { PGlite } from 'npm:@electric-sql/pglite@0.2.17'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const read = (f: string) => Deno.readTextFileSync(new URL(`../../migrations/${f}`, import.meta.url))
const db = new PGlite()
await db.exec(`create role anon; create role authenticated; create role service_role;
  create function public.is_admin() returns boolean language sql as 'select true';
  create table public.ops_profile (key text primary key, value jsonb, description text, updated_at timestamptz default now());`)
await db.exec(read('20261123120000_site_change_log.sql'))
await db.exec(read('20261125130000_site_change_log_phase2_types.sql'))

const checks = async () => (await db.query<{ conname: string; def: string }>(
  `select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.site_change_log'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%target_type%'`)).rows
const before = await checks()
check('the original rule has the name the migration drops', before.length === 1 && before[0].conname === 'site_change_log_target_type_check', JSON.stringify(before.map((c) => c.conname)))

const insert = (type: string) => db.exec(`insert into public.site_change_log (target_type, target_id, source_fn, status, after) values ('${type}', 1, 'test', 'proposed', '"x"'::jsonb)`)
await insert('post_faq')

const mig = read('20261126130000_site_change_log_short_description.sql')
let ok1 = true, ok2 = true
try { await db.exec(mig) } catch (e) { ok1 = false; console.error(e) }
try { await db.exec(mig) } catch (e) { ok2 = false; console.error(e) }
check('migration applies', ok1)
check('migration re-runs cleanly', ok2)
const after = await checks()
check('exactly one target_type rule afterwards (replaced, not added)', after.length === 1, JSON.stringify(after.map((c) => c.conname)))
check('existing rows kept', (await db.query<{ n: number }>(`select count(*)::int as n from public.site_change_log`)).rows[0].n === 1)

for (const t of ['post_faq', 'product_faq', 'product_description', 'post_content', 'post_featured_image', 'seo_meta', 'term_seo_meta', 'term_description', 'product_status', 'product_short_description']) {
  let accepted = true
  try { await insert(t) } catch { accepted = false }
  check(`accepts ${t}`, accepted)
}
let refused = false
try { await insert('anything_else') } catch { refused = true }
check('still refuses an unknown type', refused)

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
