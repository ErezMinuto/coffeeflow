// Runs migrations/20261125120000_catalog_visibility_listing_pages.sql on a real
// Postgres (PGlite) after the earlier crawl migration, twice, to check it is
// additive and safe to re-run.
//   deno run -A --node-modules-dir=none supabase/functions/strategist-brain/listing_migration_test.ts
import { PGlite } from 'npm:@electric-sql/pglite@0.2.17'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const base = Deno.readTextFileSync(new URL('../../migrations/20261124120000_seo_audit_data.sql', import.meta.url))
const mig = Deno.readTextFileSync(new URL('../../migrations/20261125120000_catalog_visibility_listing_pages.sql', import.meta.url))
const db = new PGlite()
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create function public.is_admin() returns boolean language sql as 'select true';
  create table public.strategic_briefs (id uuid primary key default gen_random_uuid(), summary text not null);
  create table public.woo_products (id bigserial primary key, user_id text not null, woo_id bigint not null, name text not null, permalink text, stock_status text, unique (user_id, woo_id));
  insert into public.woo_products (user_id, woo_id, name, permalink, stock_status) values ('u', 1, 'Existing', 'https://www.minuto.co.il/product/x/', 'instock');`)
await db.exec(base)
await db.exec(`insert into site_crawls default values`)
const crawl = (await db.query<{ id: string }>(`select id from site_crawls limit 1`)).rows[0].id
await db.exec(`insert into site_crawl_pages (crawl_id, url, status) values ('${crawl}', 'https://www.minuto.co.il/product-category/a/', 200)`)

let applied = true
try { await db.exec(mig) } catch (e) { applied = false; console.error(e) }
check('migration applies on top of the crawl tables', applied)
let reapplied = true
try { await db.exec(mig) } catch (e) { reapplied = false; console.error(e) }
check('migration re-runs cleanly', reapplied)

const p = (await db.query<{ name: string; catalog_visibility: string | null }>(`select name, catalog_visibility from woo_products`)).rows[0]
check('existing products kept, visibility null until the next sync', p?.name === 'Existing' && p.catalog_visibility === null)
await db.exec(`update woo_products set catalog_visibility = 'hidden' where woo_id = 1`)
check('visibility can be written', (await db.query<{ v: string }>(`select catalog_visibility as v from woo_products`)).rows[0].v === 'hidden')

const c = (await db.query<{ listing_pages: number | null; listing_issue: string | null }>(`select listing_pages, listing_issue from site_crawl_pages`)).rows[0]
check('existing crawl rows kept, new columns null', c && c.listing_pages === null && c.listing_issue === null)
await db.exec(`insert into site_crawl_pages (crawl_id, url, status, listing_pages, listing_issue) values ('${crawl}', 'https://www.minuto.co.il/product-category/b/', 200, 5, 'no_page_links')`)
check('new crawl rows carry the listing fields', (await db.query<{ n: number }>(`select listing_pages as n from site_crawl_pages where listing_issue = 'no_page_links'`)).rows[0].n === 5)

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
