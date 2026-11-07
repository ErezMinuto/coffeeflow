// deno run --allow-read --allow-env supabase/functions/_shared/keyword_research_test.ts
import { checkBlogKeywordLive, gscResearch } from './keyword_research.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const out = gscResearch([
  { keyword: 'k1', clicks: 6, impressions: 400, ctr: 0.015, position: 17.54, days: 2, last_date: '2026-11-02' },
  { keyword: 'k2', clicks: 0, impressions: 50, ctr: 0, position: 4, days: 1, last_date: '2026-11-01' },
  { keyword: 'k3', clicks: 0, impressions: 0, ctr: 0, position: 30, days: 1, last_date: '2026-11-01' },
  { keyword: ' ', clicks: 0, impressions: 999, ctr: 0, position: 1, days: 1, last_date: '2026-11-01' },
])
const k1 = out.find(r => r.keyword === 'k1')!
check('totals carried over', k1.impressions === 400 && k1.clicks === 6)
check('position rounded to 1 decimal', k1.position === 17.5, String(k1.position))
check('no ranking page from Search Console', k1.ranking_page === null)
check('zero impressions → position null', out.find(r => r.keyword === 'k3')!.position === null)
check('blank keyword dropped', out.length === 3)
check('sorted by impressions desc', out[0].keyword === 'k1')
// Live gate with a fake DB and a fake WordPress check.
const gscTotals = [
  { keyword: 'מכונת קפה לבית', clicks: 9, impressions: 900, ctr: 0.01, position: 12, days: 1, last_date: '2026-11-02' },
  { keyword: 'מדריך v60', clicks: 4, impressions: 300, ctr: 0.013, position: 8, days: 1, last_date: '2026-11-02' },
]
const fakeDb = {
  from(_t: string) {
    const data = [{ keyword: 'פולי קפה', avg_monthly_searches: 4200, synced_at: '2026-11-03T10:00:00Z' }]
    const q: any = { select: () => q, order: () => q, range: async (from: number) => ({ data: from === 0 ? data : [], error: null }) }
    return q
  },
  rpc(_fn: string, _args: Record<string, unknown>) {
    const q: any = { order: () => q, range: async (from: number) => ({ data: from === 0 ? gscTotals : [], error: null }) }
    return q
  },
}
const clean = async () => ({ checked: true, conflicts: [] })
const failing = 'ניקוי אבנית ותחזוקת מכונת אספרסו'
const g1 = await checkBlogKeywordLive(fakeDb, { keyword: failing, research: { source: 'search_console', keyword: failing } }, 't', clean)
check('live gate: 2026-11-03 failing keyword blocked', !g1.ok && g1.reason.includes('not in the search_console'))
check('live gate: search_console keyword, no conflict passes', (await checkBlogKeywordLive(fakeDb, { keyword: 'מדריך v60', research: { source: 'search_console', keyword: 'מדריך v60' } }, 't', clean)).ok)
check('live gate: research keyword, no conflict passes', (await checkBlogKeywordLive(fakeDb, { keyword: 'פולי קפה', research: { source: 'google_ads', keyword: 'פולי קפה' } }, 't', clean)).ok)
const g3 = await checkBlogKeywordLive(fakeDb, { keyword: 'פולי קפה', research: { source: 'google_ads', keyword: 'פולי קפה' } }, 't',
  async () => ({ checked: true, conflicts: [{ id: 7, title: 'פולי קפה: המדריך', status: 'publish', link: 'https://www.minuto.co.il/blog/beans/' }] }))
check('live gate: WP conflict blocks with URL', !g3.ok && g3.reason.includes('https://www.minuto.co.il/blog/beans/'))
check('live gate: WP unreachable blocks', !(await checkBlogKeywordLive(fakeDb, { keyword: 'פולי קפה', research: { source: 'google_ads', keyword: 'פולי קפה' } }, 't', async () => ({ checked: false, conflicts: [], reason: 'HTTP 503' }))).ok)

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
