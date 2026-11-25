// deno run -A supabase/functions/_shared/change_judge_test.ts
import { checkDate, judge, pageStats } from './change_judge.ts'

let failed = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `  — ${detail}`}`)
  if (!ok) failed++
}
check('check date from the reason line', checkDate('Why: x\nExpected: y\nCheck on: 2026-12-22', '2026-11-24T10:00:00Z') === '2026-12-22')
check('no check line → 28 days after it went live', checkDate('Why: x', '2026-11-24T10:00:00Z') === '2026-12-22')
const rows = [
  { page: 'https://www.minuto.co.il/product/a/', clicks: 3, impressions: 100, position: 4 },
  { page: 'https://www.minuto.co.il/product/a', clicks: 1, impressions: 300, position: 8 },
  { page: 'https://www.minuto.co.il/product/b/', clicks: 9, impressions: 50, position: 2 },
]
const key = (u: string) => new URL(u).pathname.replace(/\/?$/, '/')
const s = pageStats(rows, '/product/a/', key)
check('page stats sum one page, weighted position', s.clicks === 4 && s.impressions === 400 && s.position === 7, JSON.stringify(s))
check('a page with no rows → zeros, no position', JSON.stringify(pageStats(rows, '/product/z/', key)) === JSON.stringify({ clicks: 0, impressions: 0, position: null }))

const B = { clicks: 20, impressions: 1000, position: 6 }
check('too little data', judge({ clicks: 1, impressions: 30, position: 9 }, { clicks: 2, impressions: 40, position: 9 }, 1000, 1000).verdict === 'too_little_data')
check('win: well above expectation', judge(B, { clicks: 40, impressions: 1200, position: 5 }, 1000, 1000).verdict === 'win')
check('loss: well below expectation', judge(B, { clicks: 8, impressions: 900, position: 6 }, 1000, 1000).verdict === 'loss')
check('neutral within the margin', judge(B, { clicks: 23, impressions: 1000, position: 6 }, 1000, 1000).verdict === 'neutral')
const season = judge(B, { clicks: 30, impressions: 1300, position: 6 }, 1000, 1500)
check('site-wide rise of 50% is not credited to the change (30 vs ~30 expected → neutral)', season.verdict === 'neutral' && season.expected_clicks === 30 && season.site_factor === 1.5, JSON.stringify(season))
const dip = judge(B, { clicks: 15, impressions: 800, position: 6 }, 1000, 600)
check('a site-wide dip is not blamed on the change (15 vs ~12 expected → neutral)', dip.verdict === 'neutral', JSON.stringify(dip))
check('loss: position 3+ worse on similar impressions, even with clicks held', judge(B, { clicks: 20, impressions: 900, position: 10 }, 1000, 1000).verdict === 'loss')
check('site factor is capped (no 10x expectations from a tiny base)', judge(B, { clicks: 30, impressions: 1000, position: 6 }, 100, 1000).site_factor === 2)

if (failed) { console.error(`\n${failed} FAILED`); Deno.exit(1) }
console.log('\nall passed')
