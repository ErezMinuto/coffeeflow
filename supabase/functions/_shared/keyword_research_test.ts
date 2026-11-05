// deno run --allow-read --allow-env supabase/functions/_shared/keyword_research_test.ts
import { aggregateGsc, checkBlogKeywordLive } from './keyword_research.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const out = aggregateGsc([
  { keyword: 'k1', page: '/blog/a/', impressions: 100, clicks: 5, position: 10 },
  { keyword: 'k1', page: '/product/b/', impressions: 300, clicks: 1, position: 20 },
  { keyword: 'k2', page: '/blog/c/', impressions: '50', clicks: null, position: '4' },
  { keyword: ' ', page: '/x/', impressions: 999 },
])
const k1 = out.find(r => r.keyword === 'k1')!
check('sums impressions and clicks', k1.impressions === 400 && k1.clicks === 6)
check('impression-weighted position', k1.position === 17.5, String(k1.position))
check('ranking page = most impressions', k1.ranking_page === '/product/b/')
check('string metrics parsed, null clicks = 0', out.find(r => r.keyword === 'k2')!.impressions === 50 && out.find(r => r.keyword === 'k2')!.clicks === 0)
check('blank keyword dropped', out.length === 2)
check('sorted by impressions desc', out[0].keyword === 'k1')
// Live gate with a fake DB and a fake WordPress check.
const fakeDb = {
  from(t: string) {
    const data = t === 'google_search_console'
      ? [{ keyword: 'מכונת קפה לבית', page: 'https://www.minuto.co.il/product-category/m/', impressions: 900, clicks: 9, position: 12, date: '2026-11-02' },
         { keyword: 'מדריך v60', page: 'https://www.minuto.co.il/blog/v60/', impressions: 300, clicks: 4, position: 8, date: '2026-11-02' }]
      : [{ keyword: 'פולי קפה', avg_monthly_searches: 4200, synced_at: '2026-11-03T10:00:00Z' }]
    const q: any = { select: () => q, neq: () => q, gte: () => q, order: () => q, range: async (from: number) => ({ data: from === 0 ? data : [], error: null }) }
    return q
  },
}
const clean = async () => ({ checked: true, conflicts: [] })
const failing = 'ניקוי אבנית ותחזוקת מכונת אספרסו'
const g1 = await checkBlogKeywordLive(fakeDb, { keyword: failing, research: { source: 'search_console', keyword: failing } }, 't', clean)
check('live gate: 2026-11-03 failing keyword blocked', !g1.ok && g1.reason.includes('not in the search_console'))
check('live gate: research keyword, no conflict passes', (await checkBlogKeywordLive(fakeDb, { keyword: 'פולי קפה', research: { source: 'google_ads', keyword: 'פולי קפה' } }, 't', clean)).ok)
const g3 = await checkBlogKeywordLive(fakeDb, { keyword: 'פולי קפה', research: { source: 'google_ads', keyword: 'פולי קפה' } }, 't',
  async () => ({ checked: true, conflicts: [{ id: 7, title: 'פולי קפה: המדריך', status: 'publish', link: 'https://www.minuto.co.il/blog/beans/' }] }))
check('live gate: WP conflict blocks with URL', !g3.ok && g3.reason.includes('https://www.minuto.co.il/blog/beans/'))
check('live gate: WP unreachable blocks', !(await checkBlogKeywordLive(fakeDb, { keyword: 'פולי קפה', research: { source: 'google_ads', keyword: 'פולי קפה' } }, 't', async () => ({ checked: false, conflicts: [], reason: 'HTTP 503' }))).ok)
check('live gate: our blog already ranking in GSC blocks', !(await checkBlogKeywordLive(fakeDb, { keyword: 'מדריך v60', research: { source: 'search_console', keyword: 'מדריך v60' } }, 't', clean)).ok)

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
