// deno run -A supabase/functions/google-sync/keyword_agg_test.ts
import { addKeywordRow, metric, type KeywordTotals } from './keyword_agg.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

check('string metric parsed', metric('16') === 16)
check('number metric kept', metric(2.5) === 2.5)
check('missing / unreadable → 0', metric(undefined) === 0 && metric(null) === 0 && metric('x') === 0)

// The real failing case: daily impressions for "פולי קפה איכותיים" arrive as strings.
const agg = new Map<string, KeywordTotals>()
for (const imp of ['16', '27', '1', '1', '5', '1']) addKeywordRow(agg, 'פולי קפה איכותיים', 'PHRASE', { impressions: imp, clicks: '1', costMicros: '2500000' })
const a = agg.get('פולי קפה איכותיים')!
check('impressions are summed, not glued together', a.impressions === 51, String(a.impressions))
check('impressions stay a number', typeof a.impressions === 'number')
check('clicks summed', a.clicks === 6, String(a.clicks))
check('cost in currency units', Math.abs(a.cost - 15) < 1e-9, String(a.cost))
check('match type kept from the first row', a.matchType === 'PHRASE')

addKeywordRow(agg, 'b', 'EXACT', { impressions: 3, searchImpressionShare: 0.4 })
addKeywordRow(agg, 'b', 'EXACT', { impressions: '2', searchImpressionShare: 0.6 })
addKeywordRow(agg, 'b', 'EXACT', undefined)
const b = agg.get('b')!
check('mixed number/string rows sum', b.impressions === 5)
check('impression share averaged over rows that have it', b.impShareN === 2 && Math.abs(b.impShare / b.impShareN - 0.5) < 1e-9)
check('a row without metrics adds nothing', b.clicks === 0 && b.cost === 0)
check('sort by impressions is numeric', [...agg.entries()].sort((x, y) => y[1].impressions - x[1].impressions)[0][0] === 'פולי קפה איכותיים')

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
