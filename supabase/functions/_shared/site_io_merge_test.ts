// Run: deno run -A supabase/functions/_shared/site_io_merge_test.ts
// Redirect and blog post status readers/writers, and the bundle apply order, against fakes.
import { isPostStatus, readPostStatus, readRedirect, writePostStatus, writeRedirect, type SiteEnv } from './site_io.ts'
import { isTargetType } from './site_change_log.ts'
import { applyBundle } from '../handle-seo-chat/site_changes.ts'

let failed = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `  — ${detail}`}`)
  if (!ok) failed++
}
function fakeSite(answers: Array<[number, unknown]>) {
  const calls: Array<{ url: string; method: string; body: any; auth: string | null }> = []
  const fetchFn = ((url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init.headers).get('Authorization') })
    const [status, body] = answers.shift() ?? [200, {}]
    return Promise.resolve(new Response(JSON.stringify(body), { status }))
  }) as typeof fetch
  const env: SiteEnv = { wpUrl: 'https://www.minuto.co.il', wpUser: 'u', wpPass: 'p', wooKey: 'ck', wooSecret: 'cs', fetchFn }
  return { calls, env }
}
const SRC = 'https://www.minuto.co.il/blog/%d7%9e%d7%94-%d7%96%d7%94-%d7%9e%d7%a7%d7%99%d7%90%d7%98%d7%95/'
const DST = 'https://www.minuto.co.il/blog/%D7%9E%D7%A7%D7%99%D7%90%D7%98%D7%95/'

check('types: redirect and post_status are change types', isTargetType('redirect') && isTargetType('post_status'))
check('post status: only publish or draft', isPostStatus('draft') && isPostStatus('publish') && !isPostStatus('trash') && !isPostStatus('private'))
{ const s = fakeSite([[200, { success: true, source: '/blog/מה-זה-מקיאטו/', target: null }]])
  const r = await readRedirect(s.env, SRC)
  check('read redirect: none → null; source in the query string, auth in a header', r.target === null && s.calls[0].url.includes('source=') && s.calls[0].auth?.startsWith('Basic ') === true && !s.calls[0].url.includes('p@'), JSON.stringify(s.calls[0])) }
{ const s = fakeSite([[200, { success: true, source: '/blog/x/', target: DST }]])
  const stored = await writeRedirect(s.env, SRC, DST)
  check('write redirect: POST source + target, returns what the site stored', stored === DST && s.calls[0].method === 'POST' && s.calls[0].body.source === SRC && s.calls[0].body.target === DST) }
{ const s = fakeSite([[200, { success: true, source: '/blog/x/', target: null }]])
  const stored = await writeRedirect(s.env, SRC, null)
  check('remove redirect (undo): target "" sent, null back', stored === null && s.calls[0].body.target === '') }
{ const s = fakeSite([[404, { code: 'rest_no_route', message: 'No route' }]])
  let msg = ''; try { await readRedirect(s.env, SRC) } catch (e) { msg = (e as Error).message }
  check('old plugin: clear message to install v0.7.0', /v0\.7\.0/.test(msg), msg) }
{ const s = fakeSite([[422, { code: 'minuto_redirect_invalid', message: 'chain' }]])
  let msg = ''; try { await writeRedirect(s.env, SRC, DST) } catch (e) { msg = (e as Error).message }
  check('refused by the plugin (e.g. a chain) → error, not silence', /422/.test(msg) && /chain/.test(msg), msg) }
{ const s = fakeSite([[200, { id: 5907, type: 'post', status: 'publish', link: SRC, title: { raw: 'מה זה מקיאטו' }, content: { raw: '' }, featured_media: 0 }]])
  const r = await readPostStatus(s.env, 5907)
  check('read post status', r.status === 'publish' && r.title === 'מה זה מקיאטו') }
{ const s = fakeSite([[200, { id: 9, type: 'product', status: 'publish', link: '', title: { raw: 'x' }, content: { raw: '' } }]])
  let msg = ''; try { await readPostStatus(s.env, 9) } catch (e) { msg = (e as Error).message }
  check('post status refuses a product (products use product_status)', /not a blog post/.test(msg), msg) }
{ const s = fakeSite([[200, { id: 5907, status: 'draft' }]])
  const st = await writePostStatus(s.env, 5907, 'draft')
  check('write post status → stored status', st === 'draft' && s.calls[0].url.endsWith('/wp/v2/posts/5907') && s.calls[0].body.status === 'draft') }

// Bundle apply order: steps in bundle_seq order, stop at the first failure.
const row = (id: string, seq: number, status = 'proposed') => ({ id, bundle_seq: seq, status, target_type: 'redirect', target_id: 1, after: 'x', approved_by: null }) as any
{ const order: string[] = []
  const r = await applyBundle([row('c', 3), row('a', 1), row('b', 2)], 'user_1', { writeValue: async (rw: any) => { order.push(rw.id); return { ok: true as const, change_id: rw.id } } })
  check('bundle: applied in step order', r.ok && order.join(',') === 'a,b,c', order.join(',')) }
{ const order: string[] = []
  const r = await applyBundle([row('a', 1), row('b', 2), row('c', 3)], 'user_1', { writeValue: async (rw: any) => { order.push(rw.id); return rw.id === 'b' ? { ok: false as const, error: 'site refused' } : { ok: true as const, change_id: rw.id } } })
  check('bundle: stops at the failed step; later steps are not written', !r.ok && order.join(',') === 'a,b' && r.failed === 'b' && r.applied.join(',') === 'a', JSON.stringify(r)) }
{ const order: string[] = []
  const r = await applyBundle([row('a', 1, 'applied'), row('b', 2), row('c', 3)], 'user_1', { writeValue: async (rw: any) => { order.push(rw.id); return { ok: true as const, change_id: rw.id } } })
  check('bundle: a retry continues after the steps already applied', r.ok && order.join(',') === 'b,c') }
{ const r = await applyBundle([row('a', 1), row('b', 2, 'rejected')], 'user_1', { writeValue: async (rw: any) => ({ ok: true as const, change_id: rw.id }) })
  check('bundle: a rejected step stops it', !r.ok && r.failed === 'b') }

if (failed) { console.error(`\n${failed} FAILED`); Deno.exit(1) }
console.log('\nall passed')
