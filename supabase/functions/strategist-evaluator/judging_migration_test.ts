// Applies the change-log migrations, then 20261126150000_change_judging.sql twice,
// on PGlite: the four columns are added, the verdict rule accepts the four
// verdicts (and NULL) and refuses anything else, existing rows are kept, and
// the switch is seeded OFF without overwriting an existing value.
//   deno run -A --node-modules-dir=none supabase/functions/strategist-evaluator/judging_migration_test.ts
import { PGlite } from 'npm:@electric-sql/pglite@0.2.17'

let failures = 0
function check(name: string, ok: boolean) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) failures++ }
const read = (f: string) => Deno.readTextFileSync(new URL(`../../migrations/${f}`, import.meta.url))
const db = new PGlite()
await db.exec(`create role anon; create role authenticated; create role service_role;
  create function public.is_admin() returns boolean language sql as 'select true';
  create table public.ops_profile (key text primary key, value jsonb, description text, updated_at timestamptz default now());`)
for (const f of ['20261123120000_site_change_log.sql', '20261125130000_site_change_log_phase2_types.sql', '20261126130000_site_change_log_short_description.sql', '20261126140000_weekly_release.sql']) await db.exec(read(f))
await db.exec(`insert into public.site_change_log (target_type, target_id, source_fn, status, after) values ('product_description', 1, 'test', 'applied', '"x"'::jsonb)`)
const mig = read('20261126150000_change_judging.sql')
let ok1 = true, ok2 = true
try { await db.exec(mig) } catch (e) { ok1 = false; console.error(e) }
await db.exec(`update public.ops_profile set value = '{"enabled": true, "file_undo": true}'::jsonb where key = 'seo_change_judge'`)
try { await db.exec(mig) } catch (e) { ok2 = false; console.error(e) }
check('migration applies', ok1)
check('migration re-runs cleanly', ok2)
const cols = (await db.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'site_change_log' and column_name in ('baseline','result','verdict','judged_at')`)).rows.map((r) => r.column_name).sort().join(',')
check('baseline, result, verdict, judged_at added', cols === 'baseline,judged_at,result,verdict')
check('existing rows kept', (await db.query<{ n: number }>(`select count(*)::int as n from public.site_change_log`)).rows[0].n === 1)
const set = async (v: string) => { try { await db.exec(`update public.site_change_log set verdict = ${v}`); return true } catch { return false } }
for (const v of ["'win'", "'loss'", "'neutral'", "'too_little_data'", 'null']) check(`verdict accepts ${v}`, await set(v))
check('verdict refuses anything else', !(await set("'great'")))
const sw = (await db.query<{ value: { enabled: boolean } }>(`select value from public.ops_profile where key = 'seo_change_judge'`)).rows[0]?.value
check('switch seeded, a re-run keeps the owner\'s value', sw?.enabled === true)
if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
