// deno run --allow-read supabase/functions/_shared/loop_ads_client_test.ts
import { callLoopAds } from './loop_ads_client.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const calls: Array<{ url: string; body: any }> = []
const fakeFetch = (async (url: string, init: RequestInit) => {
  calls.push({ url, body: JSON.parse(String(init.body)) })
  return new Response(JSON.stringify({ ok: true, campaign_id: '123' }), { status: 200 })
}) as unknown as typeof fetch
const deps = { supabaseUrl: 'https://x.supabase.co', serviceKey: 'k', fetchFn: fakeFetch }
const spec = { campaign_name: 'n', daily_budget_ils: 50, duration_days: 14 }
const ok = { idea_id: 'srec:abc', spec }

async function refuses(name: string, p: () => Promise<unknown>) {
  const before = calls.length
  try { await p(); check(name, false, 'did not throw') } catch { check(name, calls.length === before, 'refused before any network call') }
}

await refuses('update_campaign refused', () => callLoopAds(deps, 'meta', 'update_campaign' as any, ok))
await refuses('delete refused', () => callLoopAds(deps, 'google', 'delete' as any, ok))
await refuses('unknown platform refused', () => callLoopAds(deps, 'tiktok' as any, 'create', ok))
await refuses('campaign_id in body refused', () => callLoopAds(deps, 'meta', 'create', { ...ok, campaign_id: '999' }))
await refuses('status nested in spec refused', () => callLoopAds(deps, 'meta', 'create', { idea_id: 'srec:a', spec: { ...spec, status: 'ACTIVE' } }))
await refuses('status inside an array refused', () => callLoopAds(deps, 'google', 'create', { idea_id: 'srec:a', spec: { ...spec, ads: [{ status: 'ENABLED' }] } }))
await refuses('existing_post refused', () => callLoopAds(deps, 'meta', 'create', { ...ok, existing_post: { id: '1' } }))
await refuses('body cannot set action', () => callLoopAds(deps, 'meta', 'create', { ...ok, action: 'update_campaign' }))
await refuses('idea_id must be srec:', () => callLoopAds(deps, 'meta', 'create', { idea_id: 'x', spec }))

{
  const r = await callLoopAds(deps, 'meta', 'create', ok)
  const last = calls[calls.length - 1]
  check('create reaches meta-ads-draft', last.url.endsWith('/functions/v1/meta-ads-draft') && last.body.action === 'create' && r.campaign_id === '123')
}
{
  await callLoopAds(deps, 'google', 'create', { ...ok, validate_only: true })
  const last = calls[calls.length - 1]
  check('google validate = create + validate_only', last.url.endsWith('/google-ads-draft') && last.body.validate_only === true)
}
{
  const errFetch = (async () => new Response(JSON.stringify({ error: 'monthly cap would be exceeded' }), { status: 400 })) as unknown as typeof fetch
  try { await callLoopAds({ ...deps, fetchFn: errFetch }, 'meta', 'create', ok); check('error response throws', false) }
  catch (e) { check('error response throws with the reason', String(e).includes('monthly cap')) }
}
{
  const softFail = (async () => new Response(JSON.stringify({ success: false, error: 'x' }), { status: 200 })) as unknown as typeof fetch
  try { await callLoopAds({ ...deps, fetchFn: softFail }, 'meta', 'dry_run', ok); check('200 with success:false throws', false) }
  catch { check('200 with success:false throws', true) }
}

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
