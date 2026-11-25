// Run: deno run -A supabase/functions/_shared/site_io_phase2_test.ts
// Readers and writers for the Phase 2 change types, against a fake site.
import {
  isProductStatus, pickSeoFields, readProductStatus, readSeoMeta, readTermDescription, seoSubset,
  writeProductStatus, writeSeoMeta, writeTermDescription, readProductShortDescription, writeProductShortDescription, type SiteEnv,
} from './site_io.ts'
import { isTargetType } from './site_change_log.ts'

let failed = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `  — ${detail}`}`)
  if (!ok) failed++
}

/** A fake site: records calls, answers from a queue of [status, body]. */
function fakeSite(answers: Array<[number, unknown]>) {
  const calls: Array<{ url: string; method: string; body: any; auth: string | null }> = []
  const fetchFn = ((url: string, init: RequestInit = {}) => {
    const h = new Headers(init.headers)
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null, auth: h.get('Authorization') })
    const [status, body] = answers.shift() ?? [200, {}]
    return Promise.resolve(new Response(JSON.stringify(body), { status }))
  }) as typeof fetch
  const env: SiteEnv = { wpUrl: 'https://www.minuto.co.il', wpUser: 'u', wpPass: 'p', wooKey: 'ck', wooSecret: 'cs', fetchFn }
  return { calls, env }
}

// ── value shapes ──
check('SEO fields picked', JSON.stringify(pickSeoFields({ title: 'T', description: '' })) === JSON.stringify({ title: 'T', description: '' }))
check('unknown SEO field refused', pickSeoFields({ titel: 'x' }) === null)
check('non-text SEO value refused', pickSeoFields({ title: 5 }) === null)
check('empty SEO change refused', pickSeoFields({}) === null && pickSeoFields(null) === null && pickSeoFields('x') === null)
check('before/after compare only the touched fields', JSON.stringify(seoSubset({ title: 'A', description: 'B', focus_keyword: 'C' }, { description: 'x' })) === JSON.stringify({ description: 'B' }))
check('product statuses', isProductStatus('draft') && isProductStatus('publish') && !isProductStatus('trash') && !isProductStatus(1))
check('change log accepts the four new types', ['seo_meta', 'term_seo_meta', 'term_description', 'product_status'].every(isTargetType) && !isTargetType('delete_page'))

// ── Rank Math SEO fields through the plugin ──
{
  const { calls, env } = fakeSite([[200, { success: true, id: 379, name: 'פולי קפה', url: 'https://www.minuto.co.il/product-category/x/', meta: { title: 'T', description: 'D', focus_keyword: '' } }]])
  const r = await readSeoMeta(env, 'product_cat', 379)
  check('category SEO read hits the plugin route', calls[0].url === 'https://www.minuto.co.il/wp-json/minuto-faq/v1/seo/product_cat/379' && calls[0].method === 'GET', calls[0].url)
  check('read is authenticated (Application Password)', (calls[0].auth ?? '').startsWith('Basic '))
  check('read returns the stored values', r.meta.title === 'T' && r.meta.description === 'D' && r.meta.focus_keyword === '' && r.name === 'פולי קפה')
}
{
  const { env } = fakeSite([[404, { code: 'rest_no_route', message: 'No route' }]])
  let msg = ''
  try { await readSeoMeta(env, 'post', 5) } catch (e) { msg = (e as Error).message }
  check('an older plugin on the site gives a clear error', msg.includes('v0.6.0'), msg)
}
{
  const { env } = fakeSite([[404, { code: 'minuto_seo_not_found', message: 'No post, page or product with id 5' }]])
  let msg = ''
  try { await readSeoMeta(env, 'post', 5) } catch (e) { msg = (e as Error).message }
  check('a missing item is reported as such, not as an old plugin', msg.includes('No post') && !msg.includes('v0.6.0'), msg)
}
{
  const { calls, env } = fakeSite([[200, { id: 12, name: 'n', url: 'u', meta: { title: 'New', description: '', focus_keyword: '' } }]])
  const r = await writeSeoMeta(env, 'post', 12, { title: 'New', description: '' })
  check('write POSTs only the fields sent', calls[0].method === 'POST' && JSON.stringify(calls[0].body) === JSON.stringify({ title: 'New', description: '' }))
  check('write returns what the site stored', r.meta.title === 'New')
}

// ── Category text through WooCommerce ──
{
  const { calls, env } = fakeSite([[200, { id: 379, name: 'פולי קפה', slug: 's', description: '<p>old</p>' }], [200, { id: 379, name: 'פולי קפה', slug: 's', description: '<p>new</p>' }]])
  const before = await readTermDescription(env, 379)
  const after = await writeTermDescription(env, 379, '<p>new</p>')
  check('category read', calls[0].url.includes('/wp-json/wc/v3/products/categories/379') && before.description === '<p>old</p>')
  check('category write sends only the description', calls[1].method === 'PUT' && JSON.stringify(calls[1].body) === JSON.stringify({ description: '<p>new</p>' }))
  check('category write returns the stored text', after.description === '<p>new</p>')
  check('Woo key goes in a header, not the URL', !calls[0].url.includes('consumer_key') && (calls[0].auth ?? '').startsWith('Basic '))
}

// ── Product status through WooCommerce ──
{
  const { calls, env } = fakeSite([[200, { id: 9, name: 'p', permalink: 'https://www.minuto.co.il/product/p/', status: 'publish' }], [200, { id: 9, status: 'draft' }]])
  const cur = await readProductStatus(env, 9)
  const stored = await writeProductStatus(env, 9, 'draft')
  check('status read', cur.status === 'publish' && cur.permalink.endsWith('/product/p/'))
  check('status write sends only the status', calls[1].method === 'PUT' && JSON.stringify(calls[1].body) === JSON.stringify({ status: 'draft' }))
  check('status write returns the stored status', stored === 'draft')
}
{
  const { env } = fakeSite([[401, { code: 'woocommerce_rest_cannot_edit', message: 'Sorry, you cannot edit' }]])
  let threw = false
  try { await writeProductStatus(env, 9, 'draft') } catch { threw = true }
  check('a refused write throws (so the change is logged as failed)', threw)
}

// ── product short description ──
{
  const { calls, env } = fakeSite([[200, { id: 68336, name: 'Solo', permalink: 'https://www.minuto.co.il/product/x/', short_description: '<p>old</p>' }], [200, { id: 68336, short_description: '<p>new</p>' }]])
  const cur = await readProductShortDescription(env, 68336)
  const stored = await writeProductShortDescription(env, 68336, '<p>new</p>')
  check('short description read', cur.short_description === '<p>old</p>' && cur.name === 'Solo')
  check('short description written as short_description (only that field)', calls[1].method === 'PUT' && JSON.stringify(calls[1].body) === JSON.stringify({ short_description: '<p>new</p>' }) && calls[1].url.includes('products/68336'), JSON.stringify(calls[1]))
  check('Woo key sent in a header, never in the URL', !!calls[1].auth && !/consumer_key|ck=/.test(calls[1].url))
  check('stored value returned', stored === '<p>new</p>')
  check('product_short_description is a known change type', isTargetType('product_short_description'))
  const { env: bad } = fakeSite([[401, { code: 'woocommerce_rest_cannot_edit' }]])
  let threw = false
  try { await writeProductShortDescription(bad, 68336, '<p>x</p>') } catch { threw = true }
  check('a refused short description write throws (logged as failed)', threw)
}

if (failed) { console.error(`\n${failed} FAILED`); Deno.exit(1) }
console.log('\nall passed')
