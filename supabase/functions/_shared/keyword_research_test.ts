// deno run --allow-read --allow-env supabase/functions/_shared/keyword_research_test.ts
import { aggregateGsc } from './keyword_research.ts'

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
if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
